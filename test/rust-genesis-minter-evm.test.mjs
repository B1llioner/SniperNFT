import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Contract, ContractFactory, FetchRequest, Interface, JsonRpcProvider, Transaction, Wallet, keccak256, parseEther, toBeHex, toQuantity } from 'ethers';
import solc from 'solc';
import { WebSocketServer } from 'ws';

// All keys, signatures and balances in this file belong to fresh non-forked
// local EVMs. These tests exercise the real Rust binary and production factory,
// while mocking only the OpenSea service and explicitly named RPC failures.
const KEY = `0x${'73'.repeat(32)}`;
const WALLET = new Wallet(KEY).address;
const API_KEY = 'local-fixture-api-key-do-not-log';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = process.env.RUST_GENESIS_MINTER_BIN ?? join(ROOT, 'rust-genesis-minter/target/debug/vinos-genesis');
const ARTIFACT = JSON.parse(await readFile(new URL('../artifacts/GenesisChildFactory.json', import.meta.url), 'utf8'));
const FACTORY_INTERFACE = new Interface(ARTIFACT.contracts.GenesisChildFactory.abi);
const BATCH_SELECTOR = FACTORY_INTERFACE.getFunction('mintBatch').selector;
const PREPARE_SELECTOR = FACTORY_INTERFACE.getFunction('prepareChildren').selector;
const SOURCE = 'contracts/GenesisChildFactory.sol';
const FIXTURE = 'contracts/test/GenesisChildFixtures.sol';
const sources = Object.fromEntries(await Promise.all([SOURCE, FIXTURE].map(async path => [path, {
  content: await readFile(join(ROOT, path), 'utf8'),
}])));
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: ARTIFACT.settings })));
assert.deepEqual(compiled.errors ?? [], []);
const fixtureArtifact = name => ({ abi: compiled.contracts[FIXTURE][name].abi,
  bytecode: '0x' + compiled.contracts[FIXTURE][name].evm.bytecode.object });
const TYPES = { MintParams: [
  ['mintPrice', 'uint256'], ['maxTotalMintableByWallet', 'uint256'], ['startTime', 'uint256'], ['endTime', 'uint256'],
  ['dropStageIndex', 'uint256'], ['maxTokenSupplyForStage', 'uint256'], ['feeBps', 'uint256'], ['restrictFeeRecipients', 'bool'],
].map(([name, type]) => ({ name, type })), SignedMint: [
  { name: 'nftContract', type: 'address' }, { name: 'minter', type: 'address' }, { name: 'feeRecipient', type: 'address' },
  { name: 'mintParams', type: 'MintParams' }, { name: 'salt', type: 'uint256' },
] };

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function available(t) {
  try { await access(BINARY); } catch { t.skip('Build rust-genesis-minter or set RUST_GENESIS_MINTER_BIN.'); return false; }
  const check = spawnSync(process.env.ANVIL_BIN ?? 'anvil', ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (check.error?.code === 'ENOENT') { t.skip('Anvil is required; set ANVIL_BIN.'); return false; }
  assert.equal(check.status, 0);
  return true;
}
async function anvil(t) {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const child = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663',
    '--hardfork', 'shanghai', '--timestamp', '1800000000', '--gas-limit', '200000000',
    '--gas-price', '50000000', '--base-fee', '50000000', '--silent'], { stdio: 'ignore' });
  let startupError;
  child.on('error', error => { startupError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const request = new FetchRequest(`http://127.0.0.1:${port}`); request.timeout = 3000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => {
    provider.destroy(); child.kill('SIGTERM'); await Promise.race([closed, delay(2000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
  });
  for (let i = 0; i < 60; ++i) {
    if (startupError) throw startupError;
    try {
      assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal(BigInt(await provider.send('eth_chainId', [])), 4663n);
      assert.equal(BigInt(await provider.send('eth_blockNumber', [])), 0n, 'Use a fresh non-forked EVM.');
      await provider.send('anvil_setBalance', [WALLET, toQuantity(parseEther('1'))]);
      await provider.send('evm_mine', []);
      return provider;
    } catch (error) { if (i === 59) throw error; await delay(40); }
  }
}
async function deploy(owner, artifact, args = []) {
  const value = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(...args, { gasLimit: 8_000_000 });
  await value.deploymentTransaction().wait();
  return value;
}
async function fixture(t, overrides = {}, { initialSupply = 0 } = {}) {
  const provider = await anvil(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vinos-genesis-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = await provider.getSigner(0);
  const fee = await (await provider.getSigner(1)).getAddress();
  const nft = await deploy(owner, fixtureArtifact('MockGenesisChildNFT'), [initialSupply, 1024]);
  const signer = Wallet.createRandom();
  const route = await deploy(owner, fixtureArtifact('MockGenesisChildSeaDrop'), [signer.address, fee]);
  await (await nft.setRoute(route.target)).wait();
  const context = { provider, directory, owner, nft, route, fee, signer, apiRequests: [], authRequests: [], submissions: [], calls: [],
    handlerFailures: [], hideReceipt: null, loseMintAck: false, apiStatus: 200, apiHook: null,
    authStatus: 201, authExpiresAt: null, authRateLimits: null, invocations: [], activeInvocation: null,
    headLag: null, activeHeadLag: null, laggedReceipts: new Set(), sentActions: new Map(),
    laggedHeads: [], runtimeReads: [], pendingNonceBehindBy: 0, nonceReads: [],
    factoryRuntimeFault: null, factoryRuntimeFaultReads: 0,
    rpcBeforeHook: null, rpcAfterHook: null, rpcResponseHook: null, eventHook: null, submissionHeads: [],
    finalSimulations: [], finalSimulationFault: null };
  const stateRoot = join(directory, 'registry');
  const statePath = join(stateRoot, `4663-${WALLET}`, 'state.json');
  const connections = new WeakMap();
  let nextConnection = 0;
  const rpcServer = createServer(async (req, res) => {
    let rpc;
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      rpc = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(rpc.jsonrpc, '2.0'); assert.ok(Array.isArray(rpc.params));
      if (!connections.has(req.socket)) connections.set(req.socket, ++nextConnection);
      context.calls.push({ route: req.url, method: rpc.method, connection: connections.get(req.socket),
        invocation: context.invocations.length });
      if (req.url === '/reader') assert.notEqual(rpc.method, 'eth_sendRawTransaction', 'Reader never broadcasts.');
      else assert.ok(['eth_chainId', 'eth_sendRawTransaction'].includes(rpc.method), 'Sender only warms/submits.');
      if (context.rpcResponseHook && await context.rpcResponseHook(rpc, req.url, res)) return;
      if (context.rpcBeforeHook) await context.rpcBeforeHook(rpc, req.url);
      let result;
      if (rpc.method === 'eth_sendRawTransaction') {
        const tx = Transaction.from(rpc.params[0]);
        assert.equal(tx.from, WALLET); assert.equal(tx.chainId, 4663n); assert.equal(tx.value, 0n);
        const saved = JSON.parse(await readFile(statePath, 'utf8'));
        assert.equal(saved.pending.hash, tx.hash, 'Intent must be durable before the network write.');
        assert.equal(saved.pending.nonce, tx.nonce);
        context.submissions.push(tx);
        context.sentActions.set(tx.hash, saved.pending.action.kind);
        context.submissionHeads.push({ action: saved.pending.action.kind,
          head: await provider.send('eth_getBlockByNumber', ['latest', false]) });
        result = await provider.send(rpc.method, rpc.params);
        if (context.loseMintAck && saved.pending.action.kind === 'mint') {
          context.hideReceipt = tx.hash;
          res.destroy(); return;
        }
      } else if (rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === context.hideReceipt) result = null;
      else result = await provider.send(rpc.method, rpc.params);
      if (rpc.method === 'eth_getTransactionReceipt' && result?.status === '0x1' && context.headLag
        && context.headLag.after === context.sentActions.get(rpc.params[0])
        && !context.laggedReceipts.has(rpc.params[0])) {
        context.laggedReceipts.add(rpc.params[0]);
        const before = toQuantity(BigInt(result.blockNumber) - 1n);
        context.activeHeadLag = { before: await provider.send('eth_getBlockByNumber', [before, false]),
          receiptBlock: result.blockNumber, remaining: context.headLag.staleReads };
      }
      if (rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === 'latest'
        && context.activeHeadLag?.remaining > 0) {
        const lag = context.activeHeadLag;
        --lag.remaining;
        result = lag.before;
        context.laggedHeads.push({ number: result.number, receiptBlock: lag.receiptBlock });
      }
      if (rpc.method === 'eth_getTransactionCount' && rpc.params[0].toLowerCase() === WALLET.toLowerCase()) {
        const actual = result;
        if (rpc.params[1] === 'pending' && context.pendingNonceBehindBy > 0) {
          assert.ok(BigInt(result) >= BigInt(context.pendingNonceBehindBy));
          result = toQuantity(BigInt(result) - BigInt(context.pendingNonceBehindBy));
        }
        context.nonceReads.push({ block: rpc.params[1], actual, returned: result });
      }
      if (rpc.method === 'eth_getCode') {
        if (context.factoryRuntimeFault?.address.toLowerCase() === rpc.params[0].toLowerCase()) {
          result = context.factoryRuntimeFault.code;
          ++context.factoryRuntimeFaultReads;
        }
        context.runtimeReads.push({ address: rpc.params[0], block: rpc.params[1], bytes: (result.length - 2) / 2,
          receiptFloor: context.activeHeadLag?.receiptBlock ?? null });
      }
      const call = rpc.params[0];
      if (rpc.method === 'eth_call' && call.gas && call.from?.toLowerCase() === WALLET.toLowerCase()
        && [BATCH_SELECTOR, route.interface.getFunction('mintSigned').selector,
          route.interface.getFunction('mintPublic').selector].includes(call.data?.slice(0, 10))) {
        // Only the final exact-gas transaction simulation is faulted. Every
        // per-child simulation and the gas estimate execute normally in Anvil.
        context.finalSimulations.push({ to: call.to, gas: call.gas, result });
        if (context.finalSimulationFault?.delayMs) await delay(context.finalSimulationFault.delayMs);
        if (context.finalSimulationFault?.result !== undefined) result = context.finalSimulationFault.result;
      }
      if (context.rpcAfterHook) await context.rpcAfterHook(rpc, result, req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      if (error.code !== 'CALL_EXCEPTION' && error.code !== 'UNKNOWN_ERROR') context.handlerFailures.push(error);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null,
        error: { code: -32000, message: 'Local fixture RPC error', data: error.data ?? error.info?.error?.data } }));
    }
  });
  // The fixture intentionally permits idle persistence beyond the CLI's 10 s
  // heartbeat. Node's default 5 s keepalive would independently close sockets.
  rpcServer.keepAliveTimeout = 60_000;
  const rpcPort = await listen(rpcServer); t.after(() => close(rpcServer));
  const apiServer = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (req.url === '/api/v2/auth/keys') {
        assert.equal(req.headers['x-api-key'], undefined, 'Creating an anonymous key needs no existing API key.');
        assert.equal(req.headers.authorization, undefined);
        assert.equal(raw, '');
        assert.equal(context.activeInvocation?.action, 'check-children');
        assert.equal(context.activeInvocation.privateKeyProvided, false,
          'The automatic-key request must complete before the fixture provides private-key input.');
        context.authRequests.push({ keyInputProvided: context.activeInvocation.privateKeyProvided,
          preparationTransactions: context.submissions.length });
        res.writeHead(context.authStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(context.authStatus === 201 ? {
          api_key: API_KEY,
          expires_at: context.authExpiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          rate_limits: context.authRateLimits ?? { read: '600/h', write: '30/h', fulfillment: '5/m' },
          name: 'local instant API key', upgrade_url: 'https://opensea.io/api-keys',
        } : { error: `private authentication failure ${API_KEY}` }));
        return;
      }
      assert.equal(req.url, '/api/v2/drops/rare-friends-genesis/mint');
      assert.equal(req.headers['x-api-key'], API_KEY);
      const request = JSON.parse(raw);
      assert.deepEqual(Object.keys(request).sort(), ['minter', 'quantity']); assert.equal(request.quantity, 1);
      context.apiRequests.push(request);
      if (context.apiStatus !== 200) {
        res.writeHead(context.apiStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `private API message ${API_KEY}` })); return;
      }
      const params = { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: 1, endTime: 2_000_000_000,
        dropStageIndex: 4, maxTokenSupplyForStage: 1024, feeBps: 1000, restrictFeeRecipients: true };
      const salt = context.apiRequests.length;
      const signature = await context.signer.signTypedData(
        { name: 'SeaDrop', version: '1.0', chainId: 4663, verifyingContract: route.target }, TYPES,
        { nftContract: nft.target, minter: request.minter, feeRecipient: fee, mintParams: params, salt });
      const body = { target: route.target, calldata: route.interface.encodeFunctionData('mintSigned',
        [nft.target, fee, request.minter, 1, params, salt, signature]) + '3d958fe2', value: '0' };
      if (context.apiHook) await context.apiHook(request, body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    } catch (error) {
      context.handlerFailures.push(error); res.writeHead(500); res.end('{}');
    }
  });
  const apiPort = await listen(apiServer); t.after(() => close(apiServer));
  const config = { wallet: WALLET, quantity: 10, minQuantity: 1, mode: 'signed', nft: nft.target,
    nftCodeHash: keccak256(await provider.getCode(nft.target)), routes: [{ seaDrop: route.target,
      codeHash: keccak256(await provider.getCode(route.target)), feeRecipient: fee }],
    readRpc: `http://127.0.0.1:${rpcPort}/reader`, sendRpcUrls: [`http://127.0.0.1:${rpcPort}/sender`],
    concurrency: 2, requestTimeoutMs: 1500, pollIntervalMs: 250, payloadRefreshMs: 1000,
    maxPayloadAgeMs: 15000, maxPreflightAgeMs: 5000, minSignatureRemainingSecs: 5, waitTimeoutSecs: 30,
    gasPerChild: 500000, maxGasCostEth: '0.1', maxTotalGasCostEth: '1', reserveEth: '0',
    maxFeePerGasGwei: '10', receiptTimeoutSecs: 2, ...overrides };
  Object.assign(context, { config, statePath, stateRoot, apiOrigin: `http://127.0.0.1:${apiPort}` });
  return context;
}
async function run(c, action, overrides = {}, extraArgs = []) {
  const configPath = join(c.directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...c.config, ...overrides }), { mode: 0o600 });
  const args = [action, '--config', configPath, '--state-dir', c.stateRoot, '--local-test',
    '--test-api-origin', c.apiOrigin, '--test-secrets-stdin'];
  if (!['recover', 'preflight'].includes(action)) args.push('--send');
  args.push(...extraArgs);
  const invocation = { action, privateKeyProvided: false };
  c.invocations.push(invocation); c.activeInvocation = invocation;
  const child = spawn(BINARY, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, eventBuffer = '';
  const eventTasks = [];
  child.stdout.on('data', data => {
    stdout += data;
    eventBuffer += data;
    const lines = eventBuffer.split('\n'); eventBuffer = lines.pop();
    for (const line of lines) {
      if (c.eventHook && line.startsWith('{')) {
        eventTasks.push(Promise.resolve().then(() => c.eventHook(JSON.parse(line)))
          .catch(error => c.handlerFailures.push(error)));
      }
    }
    if (stdout.length > 262144) child.kill('SIGKILL');
    if (action === 'check-children' && !invocation.privateKeyProvided
      && stdout.split('\n').slice(0, -1).some(line => line.startsWith('{') && line.endsWith('}')
        && JSON.parse(line).event === 'automatic_api_key_ready')) {
      // Keep stdin open and empty until the API key is ready. This proves key
      // creation cannot depend on reading a private key or an API-key line.
      invocation.privateKeyProvided = true;
      child.stdin.end(`${KEY}\n`);
    }
  });
  child.stderr.on('data', data => { stderr += data; if (stderr.length > 262144) child.kill('SIGKILL'); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
  child.stdin.on('error', () => {});
  if (action !== 'check-children') {
    invocation.privateKeyProvided = true;
    // Public mode must work with exactly one hidden wallet-key input and no
    // OpenSea credential, even for the full preparation/wait/mint command.
    child.stdin.end((overrides.mode ?? c.config.mode) === 'public' ? `${KEY}\n` : `${KEY}\n${API_KEY}\n`);
  }
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  await Promise.all(eventTasks);
  assert.equal(timedOut, false, `CLI timed out: ${stdout}\n${stderr}`);
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), 'Synthetic private key must remain hidden.');
  assert.ok(!stdout.includes(API_KEY) && !stderr.includes(API_KEY), 'API key/error body must remain hidden.');
  assert.deepEqual(c.handlerFailures, []);
  return { code, stdout, stderr, privateKeyProvided: invocation.privateKeyProvided,
    events: stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse) };
}
function success(result) { assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`); }
async function state(c) { return JSON.parse(await readFile(c.statePath, 'utf8')); }

async function checkedChildrenRemainUnspent(c) {
  const saved = await state(c);
  assert.notEqual(saved.factory, null); assert.equal(saved.pending, null);
  const factory = new Contract(saved.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
  assert.equal(await factory.childCount(), 2n);
  const children = [];
  for (let index = 0; index < 2; ++index) {
    const address = await factory.children(index);
    assert.notEqual(await c.provider.getCode(address), '0x');
    const child = new Contract(address, ARTIFACT.contracts.GenesisMintChild.abi, c.provider);
    assert.equal(await child.spent(), false, 'A simulation must leave each prepared child reusable.');
    assert.equal(await c.nft.balanceOf(address), 0n);
    assert.equal((await c.nft.getMintStats(address))[0], 0n);
    children.push(address);
  }
  assert.equal(new Set(children).size, 2);
  assert.equal(await c.nft.total(), 0n);
  assert.equal(await c.nft.balanceOf(WALLET), 0n);
  assert.equal(c.submissions.length, 2, 'Only deployment and child preparation may be submitted.');
  assert.equal(c.submissions[0].to, null);
  assert.equal(c.submissions[1].to.toLowerCase(), saved.factory.toLowerCase());
  assert.equal(c.submissions[1].data.slice(0, 10), PREPARE_SELECTOR);
  assert.equal(await c.provider.getTransactionCount(WALLET), 2);
  for (const path of [c.statePath, join(c.stateRoot, `4663-${WALLET}`, 'events.jsonl')]) {
    const persisted = await readFile(path, 'utf8');
    assert.ok(!persisted.includes(KEY) && !persisted.includes(API_KEY), 'Credentials must not be persisted.');
  }
  return { saved, children };
}

function checkedSuccess(result) {
  success(result);
  assert.equal(result.privateKeyProvided, true);
  const ready = result.events.filter(event => event.event === 'automatic_api_key_ready');
  assert.equal(ready.length, 1); assert.equal(ready[0].keySaved, false);
  assert.equal(ready[0].plannedMintApiRequests, 2);
  const checks = result.events.filter(event => event.event === 'child_check_result');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, true); assert.equal(checks[0].simulatedMintCount, 2);
  assert.equal(checks[0].mintSent, false);
  assert.equal(result.events.at(-1), checks[0], 'The final structured event must report the check outcome.');
}

test('Rust CLI check-children creates an automatic API key before private-key input and only sends two preparation transactions',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    const result = await run(c, 'check-children'); checkedSuccess(result);
    assert.deepEqual(c.authRequests, [{ keyInputProvided: false, preparationTransactions: 0 }]);
    const { children } = await checkedChildrenRemainUnspent(c);
    assert.equal(c.apiRequests.length, 2);
    assert.deepEqual(c.apiRequests.map(request => request.minter.toLowerCase()).sort(), children.map(address => address.toLowerCase()).sort());
    assert.equal(c.finalSimulations.length, 1);
    assert.equal(BigInt(c.finalSimulations[0].result), 2n, 'The real EVM must simulate both mints successfully.');
  });

test('Rust CLI repeated check-children reuses its factory and children with no additional preparation or mint transactions',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    checkedSuccess(await run(c, 'check-children'));
    const before = await checkedChildrenRemainUnspent(c);
    checkedSuccess(await run(c, 'check-children'));
    const after = await checkedChildrenRemainUnspent(c);
    assert.equal(after.saved.factory, before.saved.factory);
    assert.deepEqual(after.children, before.children);
    assert.ok(BigInt(before.saved.gas_cost_wei) > 0n);
    assert.equal(after.saved.gas_cost_wei, before.saved.gas_cost_wei);
    assert.deepEqual(c.authRequests, [
      { keyInputProvided: false, preparationTransactions: 0 },
      { keyInputProvided: false, preparationTransactions: 2 },
    ]);
    assert.equal(c.apiRequests.length, 4);
    assert.equal(c.finalSimulations.length, 2);
    assert.ok(c.finalSimulations.every(call => BigInt(call.result) === 2n));
  });

for (const scenario of [
  { name: 'denied', status: 403, expired: false, error: /403|authorization|authentication/i },
  { name: 'expired', status: 201, expired: true, error: /expired|expiry/i },
]) {
  test(`Rust CLI check-children stops on a ${scenario.name} automatic API key before reading a private key or preparing contracts`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { quantity: 2, minQuantity: 2 });
      c.authStatus = scenario.status;
      if (scenario.expired) c.authExpiresAt = new Date(Date.now() - 60_000).toISOString();
      const result = await run(c, 'check-children');
      assert.equal(result.code, 1); assert.match(result.stderr, scenario.error);
      assert.equal(result.privateKeyProvided, false, 'This failure must occur with stdin still open and empty.');
      assert.deepEqual(c.authRequests, [{ keyInputProvided: false, preparationTransactions: 0 }]);
      assert.equal(c.submissions.length, 0); assert.equal(c.apiRequests.length, 0);
      assert.equal(c.finalSimulations.length, 0);
      assert.equal((await state(c)).factory, null); assert.equal((await state(c)).pending, null);
      assert.equal(await c.provider.getTransactionCount(WALLET), 0);
      assert.equal(await c.nft.total(), 0n);
    });
}

test('Rust CLI check-children API 422 preserves both prepared children and sends no mint transaction',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 }); c.apiStatus = 422;
    const result = await run(c, 'check-children');
    assert.equal(result.code, 1); assert.equal(result.privateKeyProvided, true);
    assert.match(result.stderr, /CHILD_ELIGIBILITY_INCONCLUSIVE/);
    await checkedChildrenRemainUnspent(c);
    assert.equal(c.authRequests.length, 1);
    assert.equal(c.apiRequests.length, 2, 'Check both children once without eligibility retries.');
    assert.equal(c.finalSimulations.length, 0);
    const checks = result.events.filter(event => event.event === 'child_check_result');
    assert.equal(checks.length, 1); assert.equal(checks[0].passed, false); assert.equal(checks[0].mintSent, false);
  });

test('Rust CLI check-children rejects a one-request write quota before reading a private key or preparing contracts',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    c.authRateLimits = { read: '600/h', write: '1/h', fulfillment: '5/m' };
    const result = await run(c, 'check-children');
    assert.equal(result.code, 1); assert.match(result.stderr, /EPHEMERAL_API_QUOTA_TOO_SMALL/);
    assert.equal(result.privateKeyProvided, false);
    assert.deepEqual(c.authRequests, [{ keyInputProvided: false, preparationTransactions: 0 }]);
    assert.equal(c.apiRequests.length, 0); assert.equal(c.submissions.length, 0);
    assert.equal(c.finalSimulations.length, 0);
    assert.equal((await state(c)).factory, null); assert.equal((await state(c)).pending, null);
    assert.equal(await c.provider.getTransactionCount(WALLET), 0);
  });

test('Rust CLI check-children recovers a previous pending mint without reporting that the child check passed or sending again',
  { timeout: 90_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t);
    success(await run(c, 'prepare', { quantity: 12 }));
    c.loseMintAck = true;
    const first = await run(c, 'start');
    assert.equal(first.code, 1); assert.match(first.stderr, /UNRESOLVED_TRANSACTION/);
    assert.equal(await c.nft.balanceOf(WALLET), 10n);
    assert.equal((await state(c)).pending.action.kind, 'mint');
    const sent = c.submissions.length, requested = c.apiRequests.length;
    assert.equal(sent, 3); assert.equal(requested, 10);
    c.loseMintAck = false; c.hideReceipt = null;
    const result = await run(c, 'check-children', { quantity: 2, minQuantity: 2 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PENDING_MINT_RECOVERED_CHILD_CHECK_NOT_PERFORMED_RERUN_CHECK/);
    assert.equal(result.privateKeyProvided, false);
    assert.equal(c.authRequests.length, 0); assert.equal(c.apiRequests.length, requested);
    assert.equal(c.submissions.length, sent, 'Reconciliation cannot consume the two remaining unused children.');
    assert.equal((await state(c)).pending, null);
    assert.ok(result.events.some(event => event.event === 'recovered_existing_mint_no_new_submission'));
    assert.ok(!result.events.some(event => event.event === 'child_check_result' && event.passed));
    assert.equal(await c.nft.balanceOf(WALLET), 10n); assert.equal(await c.nft.total(), 10n);
    const factory = new Contract((await state(c)).factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
    assert.equal(await factory.childCount(), 12n);
    for (const index of [10, 11]) {
      const child = new Contract(await factory.children(index), ARTIFACT.contracts.GenesisMintChild.abi, c.provider);
      assert.equal(await child.spent(), false);
    }
  });

test('Rust CLI check-children rejects quantity one before any API or private-key input',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 1, minQuantity: 1 });
    const result = await run(c, 'check-children');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CHILD_CHECK_REQUIRES_QUANTITY_2_MINIMUM_2_SIGNED_MODE/);
    assert.equal(result.privateKeyProvided, false);
    assert.equal(c.authRequests.length, 0); assert.equal(c.apiRequests.length, 0);
    assert.equal(c.submissions.length, 0); assert.equal(c.calls.length, 0);
    assert.equal(await c.provider.getTransactionCount(WALLET), 0);
    assert.equal(await c.nft.total(), 0n);
  });

for (const action of ['deploy_factory', 'prepare_children']) {
  test(`Rust CLI check-children waits for a current latest block after confirmed ${action}`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { quantity: 2, minQuantity: 2 });
      c.headLag = { after: action, staleReads: 2 };
      const result = await run(c, 'check-children'); checkedSuccess(result);
      const { saved } = await checkedChildrenRemainUnspent(c);
      assert.equal(c.laggedHeads.length, 2, 'Both stale latest replies must be tolerated without using their pre-transaction state.');
      assert.ok(c.laggedHeads.every(head => BigInt(head.number) < BigInt(head.receiptBlock)));
      assert.equal(c.submissions.filter(tx => tx.to === null).length, 1, 'Head lag must not trigger another deployment.');
      assert.equal(c.apiRequests.length, 2); assert.equal(c.finalSimulations.length, 1);
      assert.ok(result.events.some(event => event.event === 'submission_complete'));
      const laterFactoryReads = c.runtimeReads.filter(read => read.receiptFloor
        && read.address.toLowerCase() === saved.factory.toLowerCase());
      assert.ok(laterFactoryReads.length > 0);
      assert.ok(laterFactoryReads.every(read => BigInt(read.block) >= BigInt(read.receiptFloor) && read.bytes > 0),
        'Runtime verification must keep its exact identity check and read at/after the confirmed transaction block.');
    });

  test(`Rust CLI check-children stops after three persistently stale heads following ${action} without another send`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { quantity: 2, minQuantity: 2 });
      c.headLag = { after: action, staleReads: Infinity };
      const result = await run(c, 'check-children');
      assert.equal(result.code, 1);
      assert.equal(c.laggedHeads.length, 3, 'A permanently lagging reader must stop after three failures.');
      assert.match(result.stderr, /READ_RPC_BEHIND_CONFIRMED_OR_OBSERVED_BLOCK/);
      assert.doesNotMatch(result.stderr, /FACTORY_RUNTIME_IDENTITY_MISMATCH|CHILD_PREPARATION_INCOMPLETE|panicked/);
      const saved = await state(c);
      assert.notEqual(saved.factory, null); assert.equal(saved.pending, null);
      const expectedSends = action === 'deploy_factory' ? 1 : 2;
      assert.equal(c.submissions.length, expectedSends);
      assert.equal(await c.provider.getTransactionCount(WALLET), expectedSends);
      assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
      const factory = new Contract(saved.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
      assert.equal(await factory.childCount(), action === 'deploy_factory' ? 0n : 2n);
      for (let index = 0; index < Number(await factory.childCount()); ++index) {
        const child = new Contract(await factory.children(index), ARTIFACT.contracts.GenesisMintChild.abi, c.provider);
        assert.equal(await child.spent(), false);
      }
      assert.ok(BigInt(saved.gas_cost_wei) > 0n, 'Confirmed preparation cost must stay durable despite reader lag.');
      assert.equal(c.apiRequests.length, 0); assert.equal(c.finalSimulations.length, 0);
      assert.equal(await c.nft.total(), 0n);
      assert.ok(!result.events.some(event => event.event === 'child_check_result' && event.passed));
    });
}

test('Rust CLI check-children preserves the confirmed read-block floor across process restarts',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    checkedSuccess(await run(c, 'check-children'));
    const before = await state(c);
    assert.ok(Number.isSafeInteger(before.last_receipt_block) && before.last_receipt_block > 0);
    c.activeHeadLag = {
      before: await c.provider.send('eth_getBlockByNumber', [toQuantity(before.last_receipt_block - 1), false]),
      receiptBlock: toQuantity(before.last_receipt_block), remaining: Infinity,
    };
    const result = await run(c, 'check-children');
    assert.equal(result.code, 1); assert.match(result.stderr, /READ_RPC_BEHIND_CONFIRMED_OR_OBSERVED_BLOCK/);
    assert.equal(c.laggedHeads.length, 3);
    assert.equal(result.privateKeyProvided, false, 'Restart must reject a lagging read before API/key input or preparation.');
    assert.equal(c.authRequests.length, 1); assert.equal(c.apiRequests.length, 2);
    const after = await state(c);
    assert.equal(after.last_receipt_block, before.last_receipt_block);
    assert.equal(after.factory, before.factory); assert.equal(after.pending, null);
    await checkedChildrenRemainUnspent(c);
  });

test('Rust CLI resumes a legacy factory-only registry without last_receipt_block and deploys no second factory',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    // Produce the real interrupted-mainnet shape: deployed factory, no children,
    // accounted gas, cleared pending; then remove only the newly added field.
    c.headLag = { after: 'deploy_factory', staleReads: Infinity };
    const initial = await run(c, 'prepare');
    assert.equal(initial.code, 1); assert.match(initial.stderr, /READ_RPC_BEHIND_CONFIRMED_OR_OBSERVED_BLOCK/);
    const legacy = await state(c);
    assert.notEqual(legacy.factory, null); assert.equal(legacy.pending, null);
    assert.ok(Number.isSafeInteger(legacy.last_receipt_block));
    assert.equal(c.submissions.length, 1);
    const factory = new Contract(legacy.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
    assert.equal(await factory.childCount(), 0n);
    delete legacy.last_receipt_block;
    await writeFile(c.statePath, JSON.stringify(legacy), { mode: 0o600 });
    c.headLag = null; c.activeHeadLag = null;
    checkedSuccess(await run(c, 'check-children'));
    const { saved } = await checkedChildrenRemainUnspent(c);
    assert.equal(saved.factory, legacy.factory);
    assert.ok(Number.isSafeInteger(saved.last_receipt_block), 'The new preparation receipt should populate the optional floor.');
    assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
    assert.equal(c.apiRequests.length, 2); assert.equal(c.finalSimulations.length, 1);
  });

test('Rust CLI refuses a stale pending nonce below the confirmed nonce without preparing more children',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    success(await run(c, 'prepare'));
    const before = await state(c), priorNonceReads = c.nonceReads.length;
    c.pendingNonceBehindBy = 1;
    const result = await run(c, 'prepare', { quantity: 3 });
    assert.equal(result.code, 1); assert.match(result.stderr, /PENDING_NONCE|NONCE.*CONFIRMED|NONCE.*BEHIND/);
    const reads = c.nonceReads.slice(priorNonceReads);
    assert.ok(reads.some(read => read.block === 'pending' && BigInt(read.actual) === 2n && BigInt(read.returned) === 1n));
    assert.ok(reads.some(read => /^0x[0-9a-f]+$/i.test(read.block) && BigInt(read.returned) === 2n),
      'The comparison must include the nonce at the exact fresh block, independently of pending.');
    const after = await state(c);
    assert.equal(after.factory, before.factory); assert.equal(after.pending, null);
    assert.equal(after.gas_cost_wei, before.gas_cost_wei);
    await checkedChildrenRemainUnspent(c);
    assert.equal(c.apiRequests.length, 0);
  });

test('Rust CLI still rejects a nonempty modified factory runtime at a fresh block immediately without any further send',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { quantity: 2, minQuantity: 2 });
    success(await run(c, 'prepare'));
    const before = await state(c);
    const genuine = await c.provider.getCode(before.factory);
    const altered = genuine.slice(0, -2) + (genuine.endsWith('00') ? '01' : '00');
    assert.notEqual(altered, genuine); assert.equal(altered.length, genuine.length);
    c.factoryRuntimeFault = { address: before.factory, code: altered };
    const result = await run(c, 'check-children');
    assert.equal(result.code, 1); assert.match(result.stderr, /FACTORY_RUNTIME_IDENTITY_MISMATCH/);
    assert.equal(c.factoryRuntimeFaultReads, 1, 'A real nonempty identity mismatch must not be retried or accepted as head lag.');
    const lastRead = c.runtimeReads.at(-1);
    assert.equal(lastRead.address.toLowerCase(), before.factory.toLowerCase());
    assert.ok(BigInt(lastRead.block) >= BigInt(before.last_receipt_block));
    assert.ok(lastRead.bytes > 0); assert.equal(c.laggedHeads.length, 0);
    assert.equal(result.privateKeyProvided, false);
    assert.equal(c.authRequests.length, 0); assert.equal(c.apiRequests.length, 0);
    assert.equal((await state(c)).factory, before.factory); assert.equal((await state(c)).pending, null);
    await checkedChildrenRemainUnspent(c);
    assert.equal(await c.provider.getCode(before.factory), genuine, 'Only the test RPC response was altered.');
  });

test('Rust CLI quantity1 uses a direct signed mint and deploys no factory', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { quantity: 1 });
  const result = await run(c, 'setup'); success(result);
  assert.equal(c.submissions.length, 1); assert.equal(c.submissions[0].to, c.route.target);
  assert.equal(await c.nft.ownerOf(1), WALLET); assert.equal((await state(c)).factory, null);
  assert.equal((await state(c)).pending, null); assert.equal(c.apiRequests.length, 1);
  assert.equal(c.apiRequests[0].minter.toLowerCase(), WALLET.toLowerCase());
});

test('Rust CLI setup creates one factory, ten reusable children, and mints ten individually signed NFTs', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t);
  const result = await run(c, 'setup'); success(result);
  assert.equal(c.submissions.length, 3); assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
  const saved = await state(c); assert.equal(saved.pending, null);
  const factory = new Contract(saved.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
  assert.equal(await factory.childCount(), 10n); assert.equal(await c.nft.balanceOf(WALLET), 10n);
  assert.equal(new Set(c.apiRequests.map(request => request.minter)).size, 10);
  for (let i = 0; i < 10; ++i) {
    assert.equal(await c.nft.ownerOf(i + 1), WALLET);
    assert.equal(await c.nft.balanceOf(await factory.children(i)), 0n);
  }
  assert.ok(result.events.some(event => event.event === 'mint_result' && event.minted === 10));
});

test('Rust CLI prepare then start reuses the saved factory without deployment or preparation transactions', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t);
  success(await run(c, 'prepare'));
  const before = await state(c); assert.equal(c.submissions.length, 2); assert.equal(c.apiRequests.length, 0);
  success(await run(c, 'start'));
  assert.equal(c.submissions.length, 3); assert.equal((await state(c)).factory, before.factory);
  assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
  assert.equal(await c.nft.balanceOf(WALLET), 10n);
});

async function publicDrop(c, start, end = start + 3600, extra = {}) {
  await (await c.route.setDrop({ mintPrice: 0, startTime: start, endTime: end,
    maxTotalMintableByWallet: 1, feeBps: 1000, restrictFeeRecipients: true, ...extra })).wait();
}
async function mineAt(c, timestamp) {
  await c.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await c.provider.send('evm_mine', []);
}
function isPublicDropRead(c, rpc) {
  return rpc.method === 'eth_call' && rpc.params[0].to?.toLowerCase() === c.route.target.toLowerCase()
    && rpc.params[0].data?.slice(0, 10) === c.route.interface.getFunction('getPublicDrop').selector;
}
function noOpenSea(c) {
  assert.equal(c.apiRequests.length, 0, 'Public mint parameters are constructed from approved onchain state.');
  assert.equal(c.authRequests.length, 0, 'Public mode needs no automatic API key.');
}

function exactMintSimulation(c, rpc) {
  const call = rpc.params[0];
  return rpc.method === 'eth_call' && call?.gas && call.from?.toLowerCase() === WALLET.toLowerCase()
    && [BATCH_SELECTOR, c.route.interface.getFunction('mintSigned').selector,
      c.route.interface.getFunction('mintPublic').selector].includes(call.data?.slice(0, 10));
}

test('Rust CLI reports actual public price, window, wallet limit, fee and supply changes with previous/current values',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 1 });
    const now = (await c.provider.getBlock('latest')).timestamp;
    const release = now + 300, movedStart = now + 150, movedEnd = now + 7200;
    let changed = false, restored = false;
    c.eventHook = async event => {
      if (event.event === 'waiting' && !changed) {
        changed = true;
        assert.equal(c.submissions.length, 0);
        await (await c.route.mintPublic(c.nft.target, c.fee, await c.owner.getAddress(), 1)).wait();
        await publicDrop(c, movedStart, movedEnd, { mintPrice: 1, maxTotalMintableByWallet: 2,
          feeBps: 2000, restrictFeeRecipients: false });
      }
      if (event.event === 'drop_state_changed' && event.current.publicWindows[0].mintPriceWei === '1' && !restored) {
        restored = true;
        assert.equal(c.submissions.length, 0, 'A paid or not-yet-open updated stage cannot trigger our free mint.');
        await publicDrop(c, movedStart, movedEnd, { maxTotalMintableByWallet: 2, feeBps: 2000, restrictFeeRecipients: false });
        await mineAt(c, release);
      }
    };
    const result = await run(c, 'start', { waitUntilTimestamp: release }); success(result);
    assert.equal(changed, true); assert.equal(restored, true);
    const changes = result.events.filter(event => event.event === 'drop_state_changed');
    const policyChange = changes.find(event => event.current.publicWindows[0].mintPriceWei === '1');
    assert.ok(policyChange, 'The changed storage must be reported despite an unchanged contract runtime.');
    const previous = policyChange.previous.publicWindows[0], current = policyChange.current.publicWindows[0];
    assert.equal(previous.mintPriceWei, '0'); assert.equal(current.mintPriceWei, '1');
    assert.equal(previous.start, 1); assert.equal(current.start, movedStart);
    assert.equal(previous.end, 281474976710655); assert.equal(current.end, movedEnd);
    assert.equal(previous.walletLimit, 1); assert.equal(current.walletLimit, 2);
    assert.equal(previous.feeBps, 1000); assert.equal(current.feeBps, 2000);
    assert.equal(previous.restrictFeeRecipients, true); assert.equal(current.restrictFeeRecipients, false);
    assert.equal(previous.free, true); assert.equal(current.free, false);
    assert.ok(changes.some(event => event.previous.remaining === 1024 && event.current.remaining === 1023));
    assert.equal(policyChange.previous.maxSupply, 1024); assert.equal(policyChange.current.maxSupply, 1024);
    assert.deepEqual(policyChange.previous.allowedSeaDrop, policyChange.current.allowedSeaDrop);
    assert.equal(policyChange.preparationDiscarded, true, 'The locally held old public batch must be invalidated.');
    assert.equal(c.submissions.length, 1); assert.equal(await c.nft.total(), 2n);
    assert.equal(await c.nft.ownerOf(1), await c.owner.getAddress()); assert.equal(await c.nft.ownerOf(2), WALLET);
    assert.ok(BigInt(c.submissionHeads[0].head.timestamp) >= BigInt(release)); noOpenSea(c);
    const journal = await readFile(join(c.stateRoot, `4663-${WALLET}`, 'events.jsonl'), 'utf8');
    assert.ok(journal.includes('drop_state_changed'));
    assert.ok(!journal.includes(KEY) && !journal.includes(API_KEY), 'Change notifications must never persist credentials.');
  });

async function watchFixture(t, c, { rejectSubscriptions = false } = {}) {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server });
  const connections = [];
  wss.on('connection', socket => {
    const connection = { socket, subscriptions: new Map() }; connections.push(connection);
    socket.on('message', message => {
      try {
        const rpc = JSON.parse(message.toString());
        assert.equal(rpc.jsonrpc, '2.0');
        if (rpc.method === 'eth_chainId') {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: '0x1237' })); return;
        }
        assert.equal(rpc.method, 'eth_subscribe'); assert.equal(rpc.params[0], 'logs');
        if (rejectSubscriptions) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
            error: { code: -32601, message: `private subscription error ${API_KEY}` } }));
          return;
        }
        const filter = rpc.params[1];
        let kind;
        if (typeof filter.address === 'string') {
          assert.equal(filter.address.toLowerCase(), c.nft.target.toLowerCase()); kind = 'nft';
        } else {
          assert.deepEqual(filter.address.map(value => value.toLowerCase()), [c.route.target.toLowerCase()]);
          assert.deepEqual(filter.topics, [null, '0x' + c.nft.target.slice(2).toLowerCase().padStart(64, '0')]);
          kind = 'route';
        }
        const subscription = kind === 'nft' ? '0x01' : '0x02';
        connection.subscriptions.set(kind, subscription);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: subscription }));
      } catch (error) { c.handlerFailures.push(error); socket.close(); }
    });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const connection of connections) connection.socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await close(server);
  });
  return { url: `ws://127.0.0.1:${port}`, connections,
    notify(log, kind = 'nft') {
      const connected = connections.filter(connection => connection.socket.readyState === 1);
      assert.equal(connected.length, 1, 'The test must use a live persistent watcher connection.');
      const { socket, subscriptions } = connected[0];
      assert.equal(subscriptions.size, 2, 'Both scoped subscriptions must be established before a notification.');
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription',
        params: { subscription: subscriptions.get(kind), result: log } }));
    } };
}

test('Rust CLI WSS NFT event wakes a distant ten-second public wait and rechecks real onchain settings before minting',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 1 });
    const watcher = await watchFixture(t, c);
    const now = (await c.provider.getBlock('latest')).timestamp;
    await publicDrop(c, now + 3600);
    let notifiedAt, mintedAt;
    c.eventHook = async event => {
      if (event.event === 'waiting' && event.pollIntervalMs === 10000 && notifiedAt === undefined) {
        notifiedAt = 0; // Arm once even if several structured events arrive together.
        assert.equal(c.submissions.length, 0); assert.equal(c.finalSimulations.length, 0);
        await publicDrop(c, 1, now + 7200);
        const competitor = await c.route.mintPublic(c.nft.target, c.fee, await c.owner.getAddress(), 1);
        const receipt = await competitor.wait();
        const rawReceipt = await c.provider.send('eth_getTransactionReceipt', [receipt.hash]);
        const log = rawReceipt.logs.find(entry => entry.address.toLowerCase() === c.nft.target.toLowerCase());
        assert.ok(log, 'Wake with a genuine local EVM NFT Transfer log.');
        await delay(100);
        notifiedAt = performance.now();
        watcher.notify(log);
      }
      if (event.event === 'mint_result') mintedAt = performance.now();
    };
    const result = await run(c, 'start', { watchRpc: watcher.url }); success(result);
    assert.ok(notifiedAt > 0 && mintedAt > notifiedAt, 'The event must arrive while the ten-second wait is armed.');
    assert.ok(mintedAt - notifiedAt < 4000, `WSS wake must interrupt the 10s timer; observed ${mintedAt - notifiedAt} ms.`);
    t.diagnostic(`Local WSS event to mint_result: ${Math.round(mintedAt - notifiedAt)} ms, including RPC checks, simulation and receipt.`);
    assert.equal(c.submissions.length, 1); assert.equal(c.finalSimulations.length, 1);
    assert.equal(await c.nft.ownerOf(1), await c.owner.getAddress());
    assert.equal(await c.nft.ownerOf(2), WALLET); noOpenSea(c);
  });

test('Rust CLI degrades after three rejected WSS subscriptions and continues one-second HTTP polling without duplicate sends',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 1 });
    const watcher = await watchFixture(t, c, { rejectSubscriptions: true });
    const start = (await c.provider.getBlock('latest')).timestamp + 3600;
    await publicDrop(c, start);
    let degraded = false;
    const fallbackReads = [];
    c.eventHook = event => {
      if (event.event === 'drop_watch' && event.status === 'degraded') {
        assert.equal(event.failures, 3); degraded = true;
      }
    };
    c.rpcAfterHook = async rpc => {
      if (!degraded || !isPublicDropRead(c, rpc) || fallbackReads.length >= 4) return;
      fallbackReads.push(performance.now());
      if (fallbackReads.length === 4) {
        assert.equal(c.submissions.length, 0); assert.equal(c.finalSimulations.length, 0);
        await mineAt(c, start);
      }
    };
    const result = await run(c, 'start', { watchRpc: watcher.url }); success(result);
    assert.equal(degraded, true); assert.equal(watcher.connections.length, 3);
    assert.equal(fallbackReads.length, 4);
    const gaps = fallbackReads.slice(1).map((time, index) => time - fallbackReads[index]);
    assert.ok(gaps.every(gap => gap < 2500), `Failed WSS must not retain a 10s poll: ${gaps}`);
    assert.ok(gaps.some(gap => gap >= 600), `A closed watch channel must not spin without a timer: ${gaps}`);
    assert.ok(result.events.some(event => event.event === 'waiting' && event.pollIntervalMs === 1000));
    assert.equal(c.submissions.length, 1); assert.equal(await c.nft.balanceOf(WALLET), 1n); noOpenSea(c);
  });

test('Rust CLI discards a public batch when a newer block moves the window after its final exact simulation',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 1 });
    let movedStart, invalidated = false;
    c.rpcAfterHook = async rpc => {
      if (movedStart !== undefined || !exactMintSimulation(c, rpc)) return;
      assert.equal(c.finalSimulations.length, 1); assert.equal(c.submissions.length, 0);
      movedStart = (await c.provider.getBlock('latest')).timestamp + 60;
      await publicDrop(c, movedStart);
    };
    c.eventHook = async event => {
      if (event.event !== 'preparation_invalidated' || invalidated) return;
      invalidated = true;
      assert.equal(c.submissions.length, 0, 'No old simulated transaction may escape before invalidation.');
      assert.ok(movedStart !== undefined);
      await mineAt(c, movedStart);
    };
    const result = await run(c, 'start'); success(result);
    assert.equal(invalidated, true); noOpenSea(c);
    assert.equal(c.finalSimulations.length, 2, 'A new current-state simulation must replace the discarded one.');
    assert.equal(c.submissions.length, 1); assert.equal(await c.nft.balanceOf(WALLET), 1n);
    assert.ok(BigInt(c.submissionHeads[0].head.timestamp) >= BigInt(movedStart));
    assert.equal((await state(c)).pending, null);
  });

test('Rust CLI replaces a signed payload when its signer is revoked in a newer block after the final simulation',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'signed', quantity: 1 });
    let rotated = false;
    c.rpcAfterHook = async rpc => {
      if (rotated || !exactMintSimulation(c, rpc)) return;
      rotated = true;
      assert.equal(c.apiRequests.length, 1); assert.equal(c.submissions.length, 0);
      c.signer = Wallet.createRandom();
      await (await c.route.setSigner(c.signer.address)).wait();
    };
    const result = await run(c, 'start'); success(result);
    assert.equal(rotated, true);
    assert.equal(c.submissions.length, 1, 'The revoked signature must never be submitted.');
    assert.equal(c.apiRequests.length, 2, 'The old payload must be discarded and replaced by the new signer.');
    assert.equal(c.finalSimulations.length, 2);
    assert.ok(result.events.some(event => event.event === 'preparation_invalidated'));
    assert.equal(await c.nft.balanceOf(WALLET), 1n); assert.equal((await state(c)).pending, null);
  });

for (const permanent of [false, true]) {
  test(`Rust CLI waiting reader ${permanent ? 'stops after three consecutive HTTP 503 failures with zero mint sends' : 'recovers a transient HTTP 503 and mints using the current window'}`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { mode: 'public', quantity: 2, waitTimeoutSecs: 15 });
      success(await run(c, 'prepare'));
      const saved = await state(c);
      const start = (await c.provider.getBlock('latest')).timestamp + 3600;
      await publicDrop(c, start);
      let armed = false, readerFailures = 0, recovered = false;
      c.eventHook = event => { if (event.event === 'waiting') armed = true; };
      c.rpcResponseHook = async (rpc, route, res) => {
        if (!armed || route !== '/reader' || rpc.method !== 'eth_getBlockByNumber' || rpc.params[0] !== 'latest') return false;
        if (permanent || readerFailures === 0) {
          ++readerFailures;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ diagnostic: `private reader response ${API_KEY}` }));
          return true;
        }
        if (!recovered) { recovered = true; await mineAt(c, start); }
        return false;
      };
      const result = await run(c, 'start');
      assert.equal(armed, true); noOpenSea(c); assert.equal((await state(c)).factory, saved.factory);
      assert.equal((await state(c)).pending, null);
      if (permanent) {
        assert.notEqual(result.code, 0); assert.equal(readerFailures, 3);
        assert.match(result.stderr, /READ.*(?:FAILED|FAILURE|STOPPED)|THREE_CONSECUTIVE/);
        assert.equal(c.submissions.length, 2); assert.equal(c.finalSimulations.length, 0);
        assert.equal(await c.nft.balanceOf(WALLET), 0n);
      } else {
        success(result); assert.equal(readerFailures, 1); assert.equal(recovered, true);
        assert.equal(c.submissions.length, 3); assert.equal(await c.nft.balanceOf(WALLET), 2n);
        assert.ok(BigInt(c.submissionHeads.at(-1).head.timestamp) >= BigInt(start));
      }
      assert.equal(c.submissions.filter(tx => tx.to === null).length, 1, 'A reader reconnect must not redeploy the factory.');
    });
}

test('Rust CLI public setup reuses two children, adds eight, waits for tomorrow onchain, and mints ten without an API key',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 10, minQuantity: 1 }, { initialSupply: 910 });
    success(await run(c, 'prepare', { quantity: 2 }));
    const saved = await state(c);
    const factory = new Contract(saved.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
    const existing = [await factory.children(0), await factory.children(1)];
    const start = (await c.provider.getBlock('latest')).timestamp + 86410;
    await publicDrop(c, start);
    let opened = false;
    c.rpcAfterHook = async rpc => {
      if (!opened && c.submissions.length === 3 && isPublicDropRead(c, rpc)) {
        // The first waiting snapshot remains at its genuine pre-opening block;
        // advance only the chain, so the next poll must discover the open stage.
        opened = true;
        assert.equal(c.finalSimulations.length, 0);
        assert.equal(await c.nft.balanceOf(WALLET), 0n);
        await mineAt(c, start);
      }
    };
    const result = await run(c, 'setup', { waitTimeoutSecs: 172800 }); success(result);
    assert.equal(opened, true); noOpenSea(c);
    assert.equal((await state(c)).factory, saved.factory);
    assert.equal(c.submissions.length, 4, 'Two original preparation transactions, eight extra children, one mint.');
    assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
    assert.equal(FACTORY_INTERFACE.decodeFunctionData('prepareChildren', c.submissions[2].data)[0], 8n);
    assert.deepEqual([await factory.children(0), await factory.children(1)], existing);
    assert.equal(await factory.childCount(), 10n); assert.equal(await c.nft.total(), 920n);
    for (let id = 911; id <= 920; ++id) assert.equal(await c.nft.ownerOf(id), WALLET);
    assert.ok(result.events.some(event => event.event === 'waiting' && event.pollIntervalMs === 1000
      && event.waitTimeoutSecs === 172800));
    assert.ok(result.events.some(event => event.event === 'mint_result' && event.minted === 10));
    const mintHeads = c.submissionHeads.filter(entry => entry.action === 'mint');
    assert.equal(mintHeads.length, 1); assert.ok(BigInt(mintHeads[0].head.timestamp) >= BigInt(start));
    assert.equal(c.finalSimulations.length, 1); assert.equal(BigInt(c.finalSimulations[0].result), 10n);
  });

test('Rust CLI public start discards a cached batch when the onchain window moves forward and waits without a failed preflight',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 2 });
    success(await run(c, 'prepare'));
    const release = (await c.provider.getBlock('latest')).timestamp + 5;
    const movedStart = release + 20;
    let dropReads = 0;
    c.rpcAfterHook = async rpc => {
      if (!isPublicDropRead(c, rpc)) return;
      ++dropReads;
      if (dropReads === 3) {
        // Main preflight, execute preflight, first waiting snapshot. Its public
        // payload is ready, but the local release boundary has not been reached.
        await publicDrop(c, movedStart);
        await mineAt(c, release);
      } else if (dropReads === 5) {
        assert.equal(c.submissions.length, 2, 'Reaching the old release time must not cause a mint.');
        assert.equal(c.finalSimulations.length, 0);
        await mineAt(c, movedStart);
      }
    };
    const result = await run(c, 'start', { waitUntilTimestamp: release }); success(result);
    noOpenSea(c); assert.ok(dropReads >= 5);
    assert.equal(c.submissions.length, 3); assert.equal(await c.nft.balanceOf(WALLET), 2n);
    assert.equal(result.events.filter(event => event.event === 'preparation_invalidated').length, 0,
      'A legitimate stage-time change is waiting, not a failed simulation attempt.');
    assert.ok(result.events.some(event => event.event === 'waiting' && event.pollIntervalMs === 250));
    const mint = c.submissionHeads.find(entry => entry.action === 'mint');
    assert.ok(BigInt(mint.head.timestamp) >= BigInt(movedStart));
  });

test('Rust CLI public setup stops before any paid preparation when already sold out', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { mode: 'public' }, { initialSupply: 1024 });
  const result = await run(c, 'setup'); assert.notEqual(result.code, 0);
  assert.match(result.stderr, /INSUFFICIENT_REMAINING_SUPPLY|SOLD_OUT/);
  assert.equal(c.submissions.length, 0); assert.equal((await state(c)).factory, null); noOpenSea(c);
});

for (const reason of ['paid', 'wallet limit zero', 'expired']) {
  test(`Rust CLI public setup rejects a ${reason} window before deploying any contracts`, { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', waitTimeoutSecs: 2 });
    const now = (await c.provider.getBlock('latest')).timestamp;
    await publicDrop(c, 1, reason === 'expired' ? now - 1 : now + 3600,
      reason === 'paid' ? { mintPrice: 1 } : reason === 'wallet limit zero' ? { maxTotalMintableByWallet: 0 } : {});
    const result = await run(c, 'setup'); assert.notEqual(result.code, 0);
    assert.match(result.stderr, /PUBLIC|ELIGIBLE|WINDOW/);
    assert.equal(c.submissions.length, 0, 'A known ineligible stage must not spend gas on preparation.');
    assert.equal((await state(c)).factory, null); noOpenSea(c);
  });
}

test('Rust CLI public start notices a competing last mint while waiting and leaves its child unspent',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 2 }, { initialSupply: 1023 });
    success(await run(c, 'prepare'));
    const saved = await state(c);
    const start = (await c.provider.getBlock('latest')).timestamp + 20;
    await publicDrop(c, start);
    let reads = 0, competitorMinted = false;
    c.rpcAfterHook = async rpc => {
      if (isPublicDropRead(c, rpc) && ++reads === 3) {
        await mineAt(c, start);
        await (await c.route.mintPublic(c.nft.target, c.fee, await c.owner.getAddress(), 1)).wait();
        competitorMinted = true;
      }
    };
    const result = await run(c, 'start'); assert.notEqual(result.code, 0);
    assert.equal(competitorMinted, true); assert.match(result.stderr, /SOLD_OUT_OR_BELOW_MINIMUM/);
    assert.equal(c.submissions.length, 2); assert.equal(c.finalSimulations.length, 0);
    assert.equal(await c.nft.total(), 1024n); assert.equal(await c.nft.balanceOf(WALLET), 0n);
    const factory = new Contract(saved.factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
    assert.equal(await factory.childCount(), 1n);
    const child = new Contract(await factory.children(0), ARTIFACT.contracts.GenesisMintChild.abi, c.provider);
    assert.equal(await child.spent(), false); assert.equal((await state(c)).pending, null); noOpenSea(c);
  });

test('Rust CLI public batch adapts when a competitor leaves only three NFTs after the final simulation',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 10, minQuantity: 1 }, { initialSupply: 1020 });
    let competitorMinted = false;
    c.rpcBeforeHook = async rpc => {
      if (rpc.method !== 'eth_sendRawTransaction') return;
      const tx = Transaction.from(rpc.params[0]);
      if (tx.data.slice(0, 10) !== BATCH_SELECTOR) return;
      assert.equal(c.finalSimulations.length, 1); assert.equal(BigInt(c.finalSimulations[0].result), 4n);
      await (await c.route.mintPublic(c.nft.target, c.fee, await c.owner.getAddress(), 1)).wait();
      competitorMinted = true;
    };
    const result = await run(c, 'setup'); success(result);
    assert.equal(competitorMinted, true); noOpenSea(c);
    assert.equal(c.submissions.length, 3); assert.equal(await c.nft.total(), 1024n);
    assert.equal(await c.nft.balanceOf(WALLET), 3n);
    assert.equal(await c.nft.ownerOf(1021), await c.owner.getAddress());
    for (let id = 1022; id <= 1024; ++id) assert.equal(await c.nft.ownerOf(id), WALLET);
    assert.ok(result.events.some(event => event.event === 'mint_result' && event.minted === 3 && event.requested === 10));
    const factory = new Contract((await state(c)).factory, ARTIFACT.contracts.GenesisChildFactory.abi, c.provider);
    assert.equal(await factory.childCount(), 4n);
    const unused = new Contract(await factory.children(3), ARTIFACT.contracts.GenesisMintChild.abi, c.provider);
    assert.equal(await unused.spent(), false);
    assert.equal((await state(c)).pending, null);
  });

test('Rust CLI public quantity override one mints directly without a factory or OpenSea key', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { mode: 'public', quantity: 10 });
  const result = await run(c, 'setup', {}, ['--quantity', '1']); success(result);
  assert.equal(c.submissions.length, 1); assert.equal(c.submissions[0].to, c.route.target);
  assert.equal(c.submissions[0].data.slice(0, 10), c.route.interface.getFunction('mintPublic').selector);
  assert.equal(await c.nft.ownerOf(1), WALLET); assert.equal((await state(c)).factory, null);
  assert.equal(c.finalSimulations.length, 1); noOpenSea(c);
});

for (const [secondsUntilStart, expectedPollMs] of [[31, 1000], [30, 250]]) {
  test(`Rust CLI public wait uses ${expectedPollMs} ms polling at the ${secondsUntilStart}-second opening boundary`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { mode: 'public', quantity: 1 });
      const dropBlockTime = (await c.provider.getBlock('latest')).timestamp + 1;
      const start = dropBlockTime + secondsUntilStart;
      await c.provider.send('evm_setNextBlockTimestamp', [dropBlockTime]);
      await publicDrop(c, start);
      assert.equal((await c.provider.getBlock('latest')).timestamp, dropBlockTime);
      let reads = 0;
      c.rpcAfterHook = async rpc => {
        if (isPublicDropRead(c, rpc) && ++reads === 3) await mineAt(c, start);
      };
      const result = await run(c, 'start'); success(result);
      const waiting = result.events.filter(event => event.event === 'waiting');
      assert.ok(waiting.length >= 1); assert.equal(waiting[0].pollIntervalMs, expectedPollMs);
      assert.equal(waiting[0].chainTimestamp, dropBlockTime);
      assert.equal(c.submissions.length, 1); assert.equal(await c.nft.ownerOf(1), WALLET); noOpenSea(c);
    });
}

test('Rust CLI public waiting keeps one sender connection through a transient heartbeat error and then mints',
  { timeout: 60_000 }, async t => {
    if (!await available(t)) return;
    const c = await fixture(t, { mode: 'public', quantity: 2, waitTimeoutSecs: 35 });
    success(await run(c, 'prepare'));
    const start = (await c.provider.getBlock('latest')).timestamp + 3600;
    await publicDrop(c, start);
    let healthChecks = 0;
    c.rpcBeforeHook = async (rpc, route) => {
      if (route !== '/sender' || rpc.method !== 'eth_chainId') return;
      ++healthChecks;
      if (healthChecks === 2) throw Object.assign(new Error('Synthetic temporary publisher failure'), { code: 'UNKNOWN_ERROR' });
      if (healthChecks === 3) await mineAt(c, start);
    };
    const result = await run(c, 'start'); success(result);
    assert.ok(healthChecks >= 3, 'Initial warmup, failed heartbeat, recovered heartbeat must all run.');
    const healthCalls = c.calls.filter(call => call.invocation === 2 && call.route === '/sender' && call.method === 'eth_chainId');
    assert.equal(new Set(healthCalls.map(call => call.connection)).size, 1, 'Health retries reuse the existing HTTP client/socket.');
    assert.equal(c.submissions.length, 3); assert.equal(await c.nft.balanceOf(WALLET), 2n);
    assert.ok(result.events.some(event => event.event === 'waiting')); noOpenSea(c);
  });

for (const permanent of [false, true]) {
  test(`Rust CLI public heartbeat ${permanent ? 'stops after three HTTP 503 failures with no mint' : 'reconnects after HTTP 503 and mints without resending preparation'}`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { mode: 'public', quantity: 2, waitTimeoutSecs: 35 });
      success(await run(c, 'prepare'));
      const saved = await state(c);
      const start = (await c.provider.getBlock('latest')).timestamp + 3600;
      await publicDrop(c, start);
      let healthChecks = 0;
      c.rpcResponseHook = async (rpc, route, res) => {
        if (route !== '/sender' || rpc.method !== 'eth_chainId') return false;
        ++healthChecks;
        if (healthChecks === 2 || (permanent && healthChecks > 2)) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ diagnostic: `private proxy response ${API_KEY}` }));
          return true;
        }
        if (healthChecks === 3) await mineAt(c, start);
        return false;
      };
      const result = await run(c, 'start');
      const healthCalls = c.calls.filter(call => call.invocation === 2 && call.route === '/sender'
        && call.method === 'eth_chainId');
      assert.equal(healthCalls[1].connection, healthCalls[0].connection,
        'The first heartbeat uses the already warmed connection.');
      assert.notEqual(healthCalls[2].connection, healthCalls[1].connection,
        'A transport-poisoned client must be replaced before the next health request.');
      noOpenSea(c); assert.equal((await state(c)).factory, saved.factory);
      if (permanent) {
        assert.notEqual(result.code, 0); assert.match(result.stderr, /ALL_WARMED_SENDERS_UNAVAILABLE/);
        assert.equal(healthChecks, 4, 'One initial warmup followed by exactly three failed health requests.');
        assert.equal(result.events.filter(event => event.event === 'sender_health_failed').length, 3);
        assert.equal(c.submissions.length, 2); assert.equal(c.finalSimulations.length, 0);
        assert.equal(await c.nft.balanceOf(WALLET), 0n);
        assert.equal((await state(c)).gas_cost_wei, saved.gas_cost_wei);
      } else {
        success(result); assert.ok(healthChecks >= 3);
        assert.equal(c.submissions.length, 3); assert.equal(await c.nft.balanceOf(WALLET), 2n);
        assert.equal(c.submissions.filter(tx => tx.to === null).length, 1);
      }
      assert.equal((await state(c)).pending, null);
    });
}

test('Rust CLI stops after three consecutive API eligibility failures without any signed transaction', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { quantity: 1 }); c.apiStatus = 422;
  const result = await run(c, 'start'); assert.notEqual(result.code, 0);
  assert.match(result.stderr, /THREE_CONSECUTIVE_API_FAILURES/);
  assert.equal(c.apiRequests.length, 3); assert.equal(c.submissions.length, 0);
  assert.equal((await state(c)).pending, null);
});

test('Rust CLI fee and per-transaction budget caps both prevent submission', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { quantity: 1 });
  const fee = await run(c, 'start', { maxFeePerGasGwei: '0.000000001' });
  assert.notEqual(fee.code, 0); assert.match(fee.stderr, /FEE_CAP|GAS_PRICE|BASE_FEE/);
  const budget = await run(c, 'start', { maxGasCostEth: '0.000000000000000001' });
  assert.notEqual(budget.code, 0); assert.match(budget.stderr, /GAS_BUDGET|GAS_COST/);
  assert.equal(c.submissions.length, 0); assert.equal((await state(c)).pending, null);
});

test('Rust CLI refreshes a revoked signer while waiting and mints with the replacement signature', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t, { quantity: 1 });
  const head = await c.provider.getBlock('latest');
  c.config.waitUntilTimestamp = head.timestamp + 3;
  let rotated = false;
  c.apiHook = async () => {
    if (rotated) return;
    rotated = true;
    c.signer = Wallet.createRandom();
    await (await c.route.setSigner(c.signer.address)).wait();
    await c.provider.send('evm_setNextBlockTimestamp', [c.config.waitUntilTimestamp]);
    await c.provider.send('evm_mine', []);
  };
  const result = await run(c, 'start'); success(result);
  assert.ok(rotated); assert.ok(c.apiRequests.length >= 2);
  assert.equal(c.submissions.length, 1); assert.equal(await c.nft.ownerOf(1), WALLET);
});

test('Rust CLI recovers an accepted mint with lost ACK and does not submit again even when unused children remain', { timeout: 90_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t);
  success(await run(c, 'prepare', { quantity: 20 }));
  c.loseMintAck = true;
  const first = await run(c, 'start'); assert.notEqual(first.code, 0);
  assert.match(first.stderr, /UNRESOLVED_TRANSACTION/);
  assert.equal(await c.nft.balanceOf(WALLET), 10n);
  const pending = await state(c); assert.equal(pending.pending.action.kind, 'mint');
  assert.equal(pending.pending.hash, c.hideReceipt);
  const sent = c.submissions.length;
  c.loseMintAck = false; c.hideReceipt = null;
  const recovered = await run(c, 'start'); success(recovered);
  assert.equal(c.submissions.length, sent, 'Recovery must finish this mint, not consume ten more children.');
  assert.equal(await c.nft.balanceOf(WALLET), 10n); assert.equal((await state(c)).pending, null);
  assert.ok(recovered.events.some(event => event.event === 'recovered_existing_mint_no_new_submission'));
});

test('Rust CLI rejects an oversized final simulated mint count without a panic or a mint submission', { timeout: 60_000 }, async t => {
  if (!await available(t)) return;
  const c = await fixture(t);
  success(await run(c, 'prepare'));
  const sent = c.submissions.length;
  c.finalSimulationFault = { result: toBeHex(1n << 64n, 32) };
  const result = await run(c, 'start');
  assert.equal(result.code, 1, 'Malformed RPC data must produce a controlled error, not a panic exit.');
  assert.match(result.stderr, /UNEXPECTED_SIMULATED_MINT_COUNT/);
  assert.doesNotMatch(result.stderr, /panicked|stack backtrace/);
  assert.equal(c.finalSimulations.length, 1);
  assert.equal(BigInt(c.finalSimulations[0].result), 10n, 'The underlying EVM really simulated ten mints.');
  assert.equal(c.submissions.length, sent); assert.equal((await state(c)).pending, null);
  assert.equal(await c.nft.balanceOf(WALLET), 0n);
});

for (const scenario of [
  { name: 'final preflight', config: { maxPreflightAgeMs: 250 }, delayMs: 450 },
  { name: 'payload age', config: { maxPayloadAgeMs: 1000, maxPreflightAgeMs: 5000 }, delayMs: 1150 },
]) {
  test(`Rust CLI rejects expired ${scenario.name} after a delayed successful simulation and stops after three attempts`,
    { timeout: 60_000 }, async t => {
      if (!await available(t)) return;
      const c = await fixture(t, { quantity: 1, ...scenario.config });
      c.finalSimulationFault = { delayMs: scenario.delayMs };
      const result = await run(c, 'start');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /THREE_CONSECUTIVE_PREFLIGHT_FAILURES_STOPPED/);
      assert.match(result.stdout, /FINAL_PREPARATION_DEADLINE_EXCEEDED/);
      assert.equal(c.finalSimulations.length, 3, 'Exercise successful final simulations, not transport timeouts.');
      assert.ok(c.finalSimulations.every(call => call.result === '0x'));
      assert.equal(c.apiRequests.length, 3, 'Every stale preparation obtains a fresh payload.');
      assert.equal(c.submissions.length, 0); assert.equal((await state(c)).pending, null);
      assert.equal(await c.nft.balanceOf(WALLET), 0n);
    });
}
