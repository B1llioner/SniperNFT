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

// All keys, signatures and balances in this file belong to fresh non-forked
// local EVMs. These tests exercise the real Rust binary and production factory,
// while mocking only the OpenSea service and explicitly named RPC failures.
const KEY = `0x${'73'.repeat(32)}`;
const WALLET = new Wallet(KEY).address;
const API_KEY = 'local-fixture-api-key-do-not-log';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = process.env.RUST_GENESIS_MINTER_BIN ?? join(ROOT, 'rust-genesis-minter/target/debug/vinos-genesis');
const ARTIFACT = JSON.parse(await readFile(new URL('../artifacts/GenesisChildFactory.json', import.meta.url), 'utf8'));
const BATCH_SELECTOR = new Interface(ARTIFACT.contracts.GenesisChildFactory.abi).getFunction('mintBatch').selector;
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
async function fixture(t, overrides = {}) {
  const provider = await anvil(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'vinos-genesis-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = await provider.getSigner(0);
  const fee = await (await provider.getSigner(1)).getAddress();
  const nft = await deploy(owner, fixtureArtifact('MockGenesisChildNFT'), [0, 1024]);
  const signer = Wallet.createRandom();
  const route = await deploy(owner, fixtureArtifact('MockGenesisChildSeaDrop'), [signer.address, fee]);
  await (await nft.setRoute(route.target)).wait();
  const context = { provider, directory, owner, nft, route, fee, signer, apiRequests: [], submissions: [], calls: [],
    handlerFailures: [], hideReceipt: null, loseMintAck: false, apiStatus: 200, apiHook: null,
    finalSimulations: [], finalSimulationFault: null };
  const stateRoot = join(directory, 'registry');
  const statePath = join(stateRoot, `4663-${WALLET.toLowerCase()}`, 'state.json');
  const rpcServer = createServer(async (req, res) => {
    let rpc;
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      rpc = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(rpc.jsonrpc, '2.0'); assert.ok(Array.isArray(rpc.params));
      context.calls.push({ route: req.url, method: rpc.method });
      if (req.url === '/reader') assert.notEqual(rpc.method, 'eth_sendRawTransaction', 'Reader never broadcasts.');
      else assert.ok(['eth_chainId', 'eth_sendRawTransaction'].includes(rpc.method), 'Sender only warms/submits.');
      let result;
      if (rpc.method === 'eth_sendRawTransaction') {
        const tx = Transaction.from(rpc.params[0]);
        assert.equal(tx.from, WALLET); assert.equal(tx.chainId, 4663n); assert.equal(tx.value, 0n);
        const saved = JSON.parse(await readFile(statePath, 'utf8'));
        assert.equal(saved.pending.hash, tx.hash, 'Intent must be durable before the network write.');
        assert.equal(saved.pending.nonce, tx.nonce);
        context.submissions.push(tx);
        result = await provider.send(rpc.method, rpc.params);
        if (context.loseMintAck && saved.pending.action.kind === 'mint') {
          context.hideReceipt = tx.hash;
          res.destroy(); return;
        }
      } else if (rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === context.hideReceipt) result = null;
      else result = await provider.send(rpc.method, rpc.params);
      const call = rpc.params[0];
      if (rpc.method === 'eth_call' && call.gas && call.from?.toLowerCase() === WALLET.toLowerCase()
        && [BATCH_SELECTOR, route.interface.getFunction('mintSigned').selector].includes(call.data?.slice(0, 10))) {
        // Only the final exact-gas transaction simulation is faulted. Every
        // per-child simulation and the gas estimate execute normally in Anvil.
        context.finalSimulations.push({ to: call.to, gas: call.gas, result });
        if (context.finalSimulationFault?.delayMs) await delay(context.finalSimulationFault.delayMs);
        if (context.finalSimulationFault?.result !== undefined) result = context.finalSimulationFault.result;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      if (error.code !== 'CALL_EXCEPTION' && error.code !== 'UNKNOWN_ERROR') context.handlerFailures.push(error);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null,
        error: { code: -32000, message: 'Local fixture RPC error', data: error.data ?? error.info?.error?.data } }));
    }
  });
  const rpcPort = await listen(rpcServer); t.after(() => close(rpcServer));
  const apiServer = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/v2/drops/rare-friends-genesis/mint');
      assert.equal(req.headers['x-api-key'], API_KEY);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
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
async function run(c, action, overrides = {}) {
  const configPath = join(c.directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...c.config, ...overrides }), { mode: 0o600 });
  const args = [action, '--config', configPath, '--state-dir', c.stateRoot, '--local-test',
    '--test-api-origin', c.apiOrigin, '--test-secrets-stdin'];
  if (!['recover', 'preflight'].includes(action)) args.push('--send');
  const child = spawn(BINARY, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => { stdout += data; if (stdout.length > 262144) child.kill('SIGKILL'); });
  child.stderr.on('data', data => { stderr += data; if (stderr.length > 262144) child.kill('SIGKILL'); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
  child.stdin.on('error', () => {});
  child.stdin.end(`${KEY}\n${API_KEY}\n`);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  assert.equal(timedOut, false, `CLI timed out: ${stdout}\n${stderr}`);
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), 'Synthetic private key must remain hidden.');
  assert.ok(!stdout.includes(API_KEY) && !stderr.includes(API_KEY), 'API key/error body must remain hidden.');
  assert.deepEqual(c.handlerFailures, []);
  return { code, stdout, stderr, events: stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse) };
}
function success(result) { assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`); }
async function state(c) { return JSON.parse(await readFile(c.statePath, 'utf8')); }

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
