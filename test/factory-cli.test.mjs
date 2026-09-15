import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Transaction, Wallet, ZeroAddress, getCreateAddress, keccak256, toBeHex, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, NFT_ABI } from '../mint.mjs';
import { loadArtifact } from '../batch.mjs';

// All wallets, state files and RPC responses here are local synthetic fixtures.
const KEY = `0x${'59'.repeat(32)}`;
const OWNER = new Wallet(KEY).address;
const OTHER = '0x4000000000000000000000000000000000000001';
const IMPORTED_FACTORY = '0x4000000000000000000000000000000000000002';
const CLI = fileURLToPath(new URL('../batch.mjs', import.meta.url));
const ARTIFACT = await loadArtifact();
const ABI = new Interface(ARTIFACT.abi);
const SEA = new Interface(JSON.parse(await readFile(new URL('../research/seadrop-abi.json', import.meta.url), 'utf8')));
const NFT = new Interface(NFT_ABI);
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';
const MAX_TX_GAS_SELECTOR = '0xaae1cd4c'; // getMaxTxGasLimit()
const NFT_CODE = (await readFile(new URL('../research/nft-runtime.hex', import.meta.url), 'utf8')).trim();
const CREATION_DATA = ARTIFACT.bytecode + ABI.encodeDeploy([OWNER]).slice(2);
const BLOCK_HASH = `0x${'a7'.repeat(32)}`;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function missing(path) {
  try { await readFile(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function runtime(owner = OWNER, recipient = OWNER) {
  const data = Buffer.from(ARTIFACT.deployedBytecode.slice(2), 'hex');
  for (const [index, group] of Object.values(ARTIFACT.immutableReferences).entries()) {
    const word = Buffer.from(zeroPadValue([owner, recipient][index], 32).slice(2), 'hex');
    for (const { start } of group) word.copy(data, start);
  }
  return `0x${data.toString('hex')}`;
}
function event(contract, iface, name, values) {
  return { address: contract, ...iface.encodeEventLog(iface.getEvent(name), values) };
}
function deployedState(factory, overrides = {}) {
  return { version: 1, chainId: '4663', owner: OWNER, recipient: OWNER,
    sourceSha256: ARTIFACT.sourceSha256, initCodeHash: keccak256(CREATION_DATA),
    status: 'deployed', factory, updatedAt: new Date().toISOString(), ...overrides };
}
async function fixture(t, { sequencer = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-factory-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'factory-state.json');
  const acceptedDeployment = deferred();
  const state = {
    directory, stateFile, acceptedDeployment, calls: [], sequencerCalls: [], submissions: [], pendingSnapshots: [], failures: [],
    transactions: new Map(), receipts: new Map(), factories: new Map(),
    nonce: 7n, supply: 900n, directMinted: 0n, helperNonce: 1,
    acceptDeploy: true, ambiguousDeploymentAck: false, holdDeploymentReceipts: false, configSequence: 0,
    blockNumber: 256n, timestamp: 100n, blockObservers: [],
    maxTxGasLimit: 32_000_000n, blockGasLimit: 30_000_000n, publisherHealthy: true,
  };
  state.observeBlock = () => {
    const observed = deferred();
    state.blockObservers.push(observed.resolve);
    return observed.promise;
  };
  state.installFactory = (factory = IMPORTED_FACTORY, owner = OWNER, recipient = OWNER) => {
    state.factories.set(factory.toLowerCase(), { owner, recipient, code: runtime(owner, recipient) });
    return factory;
  };
  async function rpc(method, params, endpoint) {
    const calls = endpoint === 'sequencer' ? state.sequencerCalls : state.calls;
    calls.push({ method, params });
    if (endpoint === 'sequencer') {
      if (method === 'arb_checkPublisherHealth') return state.publisherHealthy ? null :
        { rpcError: { code: -32000, message: 'Synthetic publisher is unhealthy' } };
      if (method === 'rpc_modules') return { eth: '1.0', arb: '1.0', rpc: '1.0' };
      assert.equal(method, 'eth_sendRawTransaction', 'A send-only sequencer must never receive a state, chain or receipt read.');
    } else if (sequencer) {
      assert.notEqual(method, 'eth_sendRawTransaction', 'Sequencer mode must never silently submit through the read RPC.');
    }
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') {
      const block = { number: toQuantity(state.blockNumber), hash: BLOCK_HASH, timestamp: toQuantity(state.timestamp),
        gasLimit: toQuantity(state.blockGasLimit), baseFeePerGas: '0x64' };
      for (const resolve of state.blockObservers.splice(0)) resolve(block);
      return block;
    }
    if (method === 'eth_getBalance') return toQuantity(10n ** 18n);
    if (method === 'eth_getTransactionCount') return toQuantity(state.nonce);
    if (method === 'eth_maxPriorityFeePerGas') return '0x3';
    if (method === 'eth_gasPrice') return '0xcb';
    if (method === 'eth_getCode') {
      assert.equal(params[1], 'latest');
      if (params[0].toLowerCase() === CONFIG.nftContract.toLowerCase()) return NFT_CODE;
      if (params[0].toLowerCase() === CONFIG.seaDrop.toLowerCase()) return '0x6000';
      return state.factories.get(params[0].toLowerCase())?.code ?? '0x';
    }
    if (method === 'eth_call') {
      const [tx, tag] = params;
      assert.equal(tag, 'latest');
      assert.equal(params.length, 2);
      if (!tx.to) {
        assert.equal(tx.data.toLowerCase(), CREATION_DATA.toLowerCase());
        return runtime();
      }
      if (tx.to.toLowerCase() === ARB_GAS_INFO) {
        assert.equal(tx.data, MAX_TX_GAS_SELECTOR);
        return zeroPadValue(toBeHex(state.maxTxGasLimit), 32);
      }
      if (tx.to.toLowerCase() === CONFIG.seaDrop.toLowerCase()) {
        const decoded = SEA.parseTransaction(tx);
        if (decoded.name === 'getPublicDrop') return SEA.encodeFunctionResult('getPublicDrop', [[0n, 100n, 200n, 1n, 1000n, true]]);
        assert.equal(decoded.name, 'mintPublic');
        assert.equal(decoded.args.quantity, 1n);
        return '0x';
      }
      if (tx.to.toLowerCase() === CONFIG.nftContract.toLowerCase()) {
        const decoded = NFT.parseTransaction(tx);
        assert.equal(decoded.name, 'getMintStats');
        return NFT.encodeFunctionResult('getMintStats', [decoded.args.minter === OWNER ? state.directMinted : 0n, state.supply, 1024n]);
      }
      const factory = state.factories.get(tx.to.toLowerCase());
      assert.ok(factory, 'The CLI called an absent factory.');
      const decoded = ABI.parseTransaction(tx);
      if (decoded.name === 'owner' || decoded.name === 'recipient') return ABI.encodeFunctionResult(decoded.name, [factory[decoded.name]]);
      assert.equal(decoded.name, 'mintBatch');
      const available = 1024n - state.supply;
      const count = decoded.args.maxCount < available ? decoded.args.maxCount : available;
      assert.ok(count >= decoded.args.minCount);
      return ABI.encodeFunctionResult('mintBatch', [count]);
    }
    if (method === 'eth_estimateGas') {
      assert.equal(params[1], 'latest');
      return toQuantity(params[0].to ? 1_000_000n : 500_000n);
    }
    if (method === 'eth_sendRawTransaction') {
      const [raw] = params;
      const tx = Transaction.from(raw);
      const hash = keccak256(raw);
      state.submissions.push({ raw, hash, tx, endpoint, blockNumber: state.blockNumber, timestamp: state.timestamp });
      assert.equal(tx.from, OWNER);
      assert.equal(tx.chainId, CONFIG.chainId);
      assert.equal(tx.value, 0n);
      if (!tx.to) {
        const saved = JSON.parse(await readFile(stateFile, 'utf8'));
        state.pendingSnapshots.push(saved);
        assert.equal(saved.status, 'pending', 'Deployment intent must be persisted before its first RPC send.');
        assert.equal(saved.deployment.rawTransaction, raw);
        assert.equal(saved.deployment.hash, hash);
        assert.equal(saved.deployment.nonce, String(tx.nonce));
        if (!state.acceptDeploy) return { rpcError: { code: -32000, message: 'Synthetic deployment transport rejection' } };
      }
      if (state.transactions.has(hash)) return hash;
      assert.equal(BigInt(tx.nonce), state.nonce, 'A fresh or changed nonce must never replace pending deployment recovery.');
      state.nonce++;
      let factory = null;
      let logs = [];
      if (!tx.to) {
        assert.equal(tx.data.toLowerCase(), CREATION_DATA.toLowerCase());
        factory = getCreateAddress({ from: OWNER, nonce: tx.nonce });
        state.installFactory(factory);
        acceptedDeployment.resolve(hash);
      } else if (tx.to.toLowerCase() === CONFIG.seaDrop.toLowerCase()) {
        const decoded = SEA.parseTransaction(tx);
        assert.equal(decoded.name, 'mintPublic');
        assert.equal(decoded.args.minterIfNotPayer, ZeroAddress);
        state.directMinted++;
        logs = [event(CONFIG.nftContract, NFT, 'Transfer', [ZeroAddress, OWNER, ++state.supply]),
          event(CONFIG.seaDrop, SEA, 'SeaDropMint', [CONFIG.nftContract, OWNER, CONFIG.feeRecipient, OWNER, 1n, 0n, 1000n, 0n])];
      } else {
        assert.ok(state.factories.has(tx.to.toLowerCase()));
        const decoded = ABI.parseTransaction(tx);
        assert.equal(decoded.name, 'mintBatch');
        const available = 1024n - state.supply;
        const count = decoded.args.maxCount < available ? decoded.args.maxCount : available;
        for (let i = 0n; i < count; i++) logs.push(event(tx.to, ABI, 'TokenMinted', [
          getCreateAddress({ from: tx.to, nonce: state.helperNonce++ }), OWNER, ++state.supply,
        ]));
        logs.push(event(tx.to, ABI, 'BatchMinted', [OWNER, count]));
      }
      state.transactions.set(hash, { hash, from: OWNER, to: tx.to, nonce: toQuantity(tx.nonce), input: tx.data,
        value: '0x0', blockHash: BLOCK_HASH, blockNumber: '0x101', transactionIndex: '0x0' });
      state.receipts.set(hash, { transactionHash: hash, status: '0x1', from: OWNER, to: tx.to, contractAddress: factory,
        blockNumber: '0x101', blockHash: BLOCK_HASH, transactionIndex: '0x0', gasUsed: '0x7a120',
        cumulativeGasUsed: '0x7a120', effectiveGasPrice: '0xcb', logs });
      if (!tx.to && state.ambiguousDeploymentAck) return { rpcError: { code: -32000, message: 'Synthetic acknowledgement lost after acceptance' } };
      return hash;
    }
    if (method === 'eth_getTransactionByHash') return state.transactions.get(params[0]) ?? null;
    if (method === 'eth_getTransactionReceipt') {
      const receipt = state.receipts.get(params[0]);
      return receipt?.contractAddress && state.holdDeploymentReceipts ? null : receipt ?? null;
    }
    assert.fail(`Unexpected local RPC method: ${method}`);
  }
  async function serve(endpoint) {
    const server = createServer(async (request, response) => {
      let id = null;
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; assert.ok(body.length <= 65536); }
        const message = JSON.parse(body);
        ({ id } = message);
        const result = await rpc(message.method, message.params, endpoint);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(result?.rpcError ? { error: result.rpcError } : { result }) }));
      } catch (error) {
        state.failures.push(error.message);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Local factory fixture failed' } }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}/synthetic-${endpoint}-secret`;
  }
  state.url = await serve('rpc');
  if (sequencer) state.sequencerUrl = await serve('sequencer');
  t.after(() => assert.deepEqual(state.failures, []));
  return state;
}
async function launch(t, state, command, { send = true, extra = [], config = {}, key = KEY, onOutput } = {}) {
  const configPath = join(state.directory, `synthetic-config-${++state.configSequence}.json`);
  await writeFile(configPath, JSON.stringify({ quantity: 3, minQuantity: null, recipient: null, factory: null,
    rpcUrls: [state.url], concurrency: 1, attempts: 2, retryDelayMs: 0,
    receiptTimeoutSeconds: 1, waitTimeoutSeconds: 2, pollIntervalMs: 100, keepAliveIntervalMs: 1000, ...config }));
  const child = spawn(process.execPath, [CLI, command, '--config', configPath, '--state-file', state.stateFile,
    '--from', OWNER, ...(send ? ['--send'] : []), ...extra], {
    env: { PRIVATE_KEY: key, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const promise = new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Factory CLI fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(stdout); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, output: stdout + stderr }); });
  });
  return { child, promise };
}
async function run(t, state, command, settings) { return (await launch(t, state, command, settings)).promise; }
function noSecrets(result, state) {
  for (const secret of [KEY, state.url, state.sequencerUrl, ...state.submissions.map(item => item.raw)].filter(Boolean)) assert.ok(!result.output.includes(secret));
}
function sequencerRouting(state) {
  assert.ok(state.submissions.length > 0);
  assert.ok(state.submissions.every(item => item.endpoint === 'sequencer'));
  assert.ok(state.sequencerCalls.every(call => ['eth_sendRawTransaction', 'arb_checkPublisherHealth', 'rpc_modules'].includes(call.method)));
  assert.ok(!state.calls.some(call => call.method === 'eth_sendRawTransaction'));
  assert.ok(state.calls.some(call => call.method === 'eth_getTransactionReceipt'));
}
async function beforeExit(running, event) {
  return Promise.race([event, running.promise.then(result => { throw new Error(`CLI exited before the expected event:\n${result.output}`); })]);
}

test('fresh setup persists deployment before sending and later start/setup reuse that factory', async t => {
  const rpc = await fixture(t);
  for (const command of ['setup', 'start', 'setup']) {
    const result = await run(t, rpc, command);
    assert.equal(result.code, 0, result.output);
    noSecrets(result, rpc);
  }
  const deployments = rpc.submissions.filter(item => !item.tx.to);
  const mints = rpc.submissions.filter(item => item.tx.to);
  assert.equal(deployments.length, 1);
  assert.equal(mints.length, 3);
  assert.deepEqual(rpc.submissions.map(item => item.tx.nonce), [7, 8, 9, 10]);
  const factory = getCreateAddress({ from: OWNER, nonce: 7 });
  assert.ok(mints.every(item => item.tx.to === factory));
  const saved = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(saved.status, 'deployed');
  assert.equal(saved.factory, factory);
  assert.equal(saved.owner, OWNER);
  assert.equal(saved.recipient, OWNER);
  assert.equal(saved.deployment.hash, deployments[0].hash);
  assert.equal(saved.deployment.rawTransaction, undefined);
  assert.ok(await missing(`${rpc.stateFile}.lock`));
});

test('start with an explicit verified factory imports it without deploying', async t => {
  const rpc = await fixture(t);
  rpc.installFactory();
  const result = await run(t, rpc, 'start', { extra: ['--factory', IMPORTED_FACTORY] });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.length, 1);
  assert.equal(rpc.submissions[0].tx.to, IMPORTED_FACTORY);
  assert.equal(JSON.parse(await readFile(rpc.stateFile, 'utf8')).factory, IMPORTED_FACTORY);
});

test('quantity one setup calls SeaDrop directly and never reads or changes factory state', async t => {
  const rpc = await fixture(t);
  await writeFile(rpc.stateFile, 'intentionally not a state JSON file');
  const result = await run(t, rpc, 'setup', { config: { quantity: 1 } });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.length, 1);
  assert.equal(rpc.submissions[0].tx.to, CONFIG.seaDrop);
  assert.equal(await readFile(rpc.stateFile, 'utf8'), 'intentionally not a state JSON file');
  assert.ok(await missing(`${rpc.stateFile}.lock`));
});

test('unaccepted pending deployment recovery reuses identical raw bytes, nonce and hash', async t => {
  const rpc = await fixture(t);
  rpc.acceptDeploy = false;
  const failed = await run(t, rpc, 'setup');
  assert.equal(failed.code, 1);
  const pending = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(pending.status, 'pending');
  assert.equal(rpc.nonce, 7n);
  const sendsBeforeStart = rpc.submissions.length;
  const refusedStart = await run(t, rpc, 'start');
  assert.equal(refusedStart.code, 1);
  assert.match(refusedStart.output, /setup|pending|recover/i);
  assert.equal(rpc.submissions.length, sendsBeforeStart, 'start must never rebroadcast an unverified deployment.');
  rpc.acceptDeploy = true;
  const recovered = await run(t, rpc, 'setup');
  assert.equal(recovered.code, 0, recovered.output);
  const deployments = rpc.submissions.filter(item => !item.tx.to);
  assert.ok(deployments.length >= 2);
  assert.ok(deployments.every(item => item.raw === pending.deployment.rawTransaction));
  assert.ok(deployments.every(item => item.hash === pending.deployment.hash && item.tx.nonce === 7));
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 1);
  assert.equal(JSON.parse(await readFile(rpc.stateFile, 'utf8')).status, 'deployed');
  noSecrets(failed, rpc); noSecrets(recovered, rpc);
});

test('accepted deployment with a missing receipt is recovered without a new deployment nonce', async t => {
  const rpc = await fixture(t);
  rpc.holdDeploymentReceipts = true;
  const failed = await run(t, rpc, 'setup');
  assert.equal(failed.code, 1);
  const pending = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(pending.status, 'pending');
  assert.equal(rpc.nonce, 8n);
  rpc.holdDeploymentReceipts = false;
  const recovered = await run(t, rpc, 'setup');
  assert.equal(recovered.code, 0, recovered.output);
  const deployments = rpc.submissions.filter(item => !item.tx.to);
  assert.equal(new Set(deployments.map(item => item.raw)).size, 1);
  assert.ok(deployments.every(item => item.hash === pending.deployment.hash && item.tx.nonce === 7));
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 1);
  assert.equal(JSON.parse(await readFile(rpc.stateFile, 'utf8')).deployment.hash, pending.deployment.hash);
});

test('a consumed pending nonce with no matching deployment cannot trigger a new deployment', async t => {
  const rpc = await fixture(t);
  rpc.acceptDeploy = false;
  assert.equal((await run(t, rpc, 'setup')).code, 1);
  const previousSends = rpc.submissions.length;
  rpc.nonce = 8n;
  rpc.acceptDeploy = true;
  const result = await run(t, rpc, 'setup');
  assert.equal(result.code, 1);
  assert.match(result.output, /nonce|pending|transaction/i);
  assert.equal(rpc.submissions.length, previousSends);
  assert.equal(JSON.parse(await readFile(rpc.stateFile, 'utf8')).status, 'pending');
});

test('the state lock prevents a concurrent start while setup is awaiting deployment confirmation', async t => {
  const rpc = await fixture(t);
  rpc.holdDeploymentReceipts = true;
  const first = await launch(t, rpc, 'setup', { config: { receiptTimeoutSeconds: 10 } });
  await Promise.race([rpc.acceptedDeployment.promise, first.promise.then(result => { throw new Error(result.output); })]);
  const second = await run(t, rpc, 'start');
  assert.equal(second.code, 1);
  assert.match(second.output, /lock|another|in use/i);
  assert.equal(rpc.submissions.length, 1);
  rpc.holdDeploymentReceipts = false;
  const completed = await first.promise;
  assert.equal(completed.code, 0, completed.output);
  assert.equal(rpc.submissions.filter(item => !item.tx.to).length, 1);
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 1);
  assert.ok(await missing(`${rpc.stateFile}.lock`));
});

test('conflicting saved owner or explicit factory stops before any transaction submission', async t => {
  const rpc = await fixture(t);
  rpc.installFactory();
  await writeFile(rpc.stateFile, JSON.stringify(deployedState(IMPORTED_FACTORY, { owner: OTHER })), { mode: 0o600 });
  let result = await run(t, rpc, 'setup');
  assert.equal(result.code, 1);
  assert.match(result.output, /owner|wallet|state|conflict/i);
  assert.equal(rpc.submissions.length, 0);
  await writeFile(rpc.stateFile, JSON.stringify(deployedState(IMPORTED_FACTORY)), { mode: 0o600 });
  result = await run(t, rpc, 'start', { extra: ['--factory', OTHER] });
  assert.equal(result.code, 1);
  assert.match(result.output, /factory|state|conflict/i);
  assert.equal(rpc.submissions.length, 0);
});

test('fresh setup dry-run simulates deployment and stops without state or minting', async t => {
  const rpc = await fixture(t);
  const result = await run(t, rpc, 'setup', { send: false, key: 'not-a-private-key' });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.length, 0);
  assert.ok(rpc.calls.some(call => call.method === 'eth_call' && !call.params[0].to));
  assert.ok(!rpc.calls.some(call => call.method === 'eth_call' && call.params[0].to
    && ![CONFIG.nftContract, CONFIG.seaDrop].includes(call.params[0].to)
    && !(call.params[0].to.toLowerCase() === ARB_GAS_INFO && call.params[0].data === MAX_TX_GAS_SELECTOR)));
  assert.ok(await missing(rpc.stateFile));
  assert.ok(await missing(`${rpc.stateFile}.lock`));
});

test('start without a saved or explicit factory refuses deployment', async t => {
  const rpc = await fixture(t);
  const result = await run(t, rpc, 'start');
  assert.equal(result.code, 1);
  assert.match(result.output, /factory|setup|state/i);
  assert.equal(rpc.submissions.length, 0);
  assert.ok(await missing(rpc.stateFile));
});

test('sequencer setup deploys first, waits for time and block, then mints ten; start reuses the factory', async t => {
  const rpc = await fixture(t, { sequencer: true });
  const waiting = deferred();
  const first = await launch(t, rpc, 'setup', {
    config: { quantity: 10 },
    extra: ['--sequencer', '--sequencer-url', rpc.sequencerUrl, '--wait-until-timestamp', '105', '--wait-until-block', '260'],
    onOutput: output => { if (/"warmStatus":\s*"waiting"/.test(output)) waiting.resolve(); },
  });
  await beforeExit(first, waiting.promise);
  assert.equal(rpc.submissions.length, 1, 'Deployment must complete before the wait boundary.');
  assert.equal(rpc.submissions[0].tx.to, null);
  assert.equal(JSON.parse(await readFile(rpc.stateFile, 'utf8')).status, 'deployed');
  rpc.blockNumber = 260n;
  rpc.timestamp = 104n;
  const block = await beforeExit(first, rpc.observeBlock());
  assert.equal(block.number, '0x104');
  assert.equal(rpc.submissions.length, 1, 'The reached block cannot override the timestamp gate.');
  rpc.blockNumber = 261n;
  rpc.timestamp = 105n;
  const firstResult = await first.promise;
  assert.equal(firstResult.code, 0, firstResult.output);
  const firstMint = rpc.submissions[1];
  assert.equal(firstMint.blockNumber, 261n);
  assert.equal(firstMint.timestamp, 105n);
  assert.equal(ABI.parseTransaction(firstMint.tx).args.maxCount, 10n);
  assert.equal(rpc.supply, 910n);

  const waitingAgain = deferred();
  const reused = await launch(t, rpc, 'start', {
    config: { quantity: 10, sequencer: true, sequencerUrl: rpc.sequencerUrl },
    extra: ['--wait-until-block', '300'],
    onOutput: output => { if (/"warmStatus":\s*"waiting"/.test(output)) waitingAgain.resolve(); },
  });
  await beforeExit(reused, waitingAgain.promise);
  await beforeExit(reused, rpc.observeBlock());
  assert.equal(rpc.submissions.length, 2, 'Reuse must wait for its block without creating another factory.');
  rpc.blockNumber = 300n;
  const reusedResult = await reused.promise;
  assert.equal(reusedResult.code, 0, reusedResult.output);
  assert.equal(rpc.submissions.filter(item => !item.tx.to).length, 1);
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 2);
  assert.equal(rpc.submissions[2].blockNumber, 300n);
  assert.equal(rpc.submissions[2].tx.to, firstMint.tx.to);
  assert.equal(rpc.supply, 920n);
  assert.deepEqual(rpc.submissions.map(item => item.tx.nonce), [7, 8, 9]);
  const saved = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(saved.factory, firstMint.tx.to);
  assert.equal(saved.deployment.rawTransaction, undefined);
  sequencerRouting(rpc);
  noSecrets(firstResult, rpc); noSecrets(reusedResult, rpc);
});

test('sequencer quantity one sends the direct SeaDrop mint and leaves factory state untouched', async t => {
  const rpc = await fixture(t, { sequencer: true });
  await writeFile(rpc.stateFile, 'intentionally not a state JSON file');
  const result = await run(t, rpc, 'setup', {
    config: { quantity: 1, sequencerUrl: rpc.sequencerUrl },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.length, 1);
  assert.equal(rpc.submissions[0].tx.to, CONFIG.seaDrop);
  assert.equal(SEA.parseTransaction(rpc.submissions[0].tx).args.quantity, 1n);
  assert.equal(await readFile(rpc.stateFile, 'utf8'), 'intentionally not a state JSON file');
  assert.ok(await missing(`${rpc.stateFile}.lock`));
  sequencerRouting(rpc);
  noSecrets(result, rpc);
});

test('sequencer pending deployment recovery sends the saved raw bytes and resolves an uncertain acknowledgement through read RPC', async t => {
  const rpc = await fixture(t, { sequencer: true });
  const settings = { extra: ['--sequencer-url', rpc.sequencerUrl] };
  rpc.acceptDeploy = false;
  const failed = await run(t, rpc, 'setup', settings);
  assert.equal(failed.code, 1, failed.output);
  const pending = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(pending.status, 'pending');
  assert.equal(rpc.nonce, 7n);
  assert.ok(rpc.calls.some(call => call.method === 'eth_getTransactionByHash' && call.params[0] === pending.deployment.hash));
  rpc.acceptDeploy = true;
  rpc.ambiguousDeploymentAck = true;
  const callsBeforeRecovery = rpc.calls.length;
  const recovered = await run(t, rpc, 'setup', settings);
  assert.equal(recovered.code, 0, recovered.output);
  const deployments = rpc.submissions.filter(item => !item.tx.to);
  assert.ok(deployments.length >= 2);
  assert.ok(deployments.every(item => item.raw === pending.deployment.rawTransaction));
  assert.ok(deployments.every(item => item.hash === pending.deployment.hash && item.tx.nonce === 7));
  assert.ok(rpc.calls.slice(callsBeforeRecovery).some(call => call.method === 'eth_getTransactionByHash' && call.params[0] === pending.deployment.hash));
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 1);
  const saved = JSON.parse(await readFile(rpc.stateFile, 'utf8'));
  assert.equal(saved.status, 'deployed');
  assert.equal(saved.deployment.hash, pending.deployment.hash);
  assert.equal(saved.deployment.rawTransaction, undefined);
  sequencerRouting(rpc);
  noSecrets(failed, rpc); noSecrets(recovered, rpc);
});

test('a fresh sequencer deployment accepted without an acknowledgement is found on the read RPC and minted once', async t => {
  const rpc = await fixture(t, { sequencer: true });
  rpc.ambiguousDeploymentAck = true;
  const result = await run(t, rpc, 'setup', { extra: ['--sequencer-url', rpc.sequencerUrl] });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.filter(item => !item.tx.to).length, 1);
  assert.equal(rpc.submissions.filter(item => item.tx.to).length, 1);
  assert.deepEqual(rpc.submissions.map(item => item.tx.nonce), [7, 8]);
  assert.ok(rpc.calls.some(call => call.method === 'eth_getTransactionByHash' && call.params[0] === rpc.submissions[0].hash));
  sequencerRouting(rpc);
  noSecrets(result, rpc);
});

test('sequencer setup dry-run simulates deployment using read RPC and submits nothing', async t => {
  const rpc = await fixture(t, { sequencer: true });
  const result = await run(t, rpc, 'setup', {
    send: false, key: 'not-a-private-key', extra: ['--sequencer-url', rpc.sequencerUrl],
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(rpc.submissions.length, 0);
  assert.ok(rpc.calls.some(call => call.method === 'eth_call' && !call.params[0].to));
  assert.ok(!rpc.sequencerCalls.some(call => call.method === 'eth_sendRawTransaction'));
  assert.ok(await missing(rpc.stateFile));
  assert.ok(await missing(`${rpc.stateFile}.lock`));
  noSecrets(result, rpc);
});

test('sequencer recovery rejects an unchanged saved gas limit exceeding the current transaction or block cap', async t => {
  for (const limit of ['maxTxGasLimit', 'blockGasLimit']) {
    await t.test(limit, async t => {
      const rpc = await fixture(t, { sequencer: true });
      const settings = { extra: ['--sequencer-url', rpc.sequencerUrl] };
      rpc.acceptDeploy = false;
      const failed = await run(t, rpc, 'setup', settings);
      assert.equal(failed.code, 1, failed.output);
      const previousState = await readFile(rpc.stateFile, 'utf8');
      const pending = JSON.parse(previousState);
      const savedTx = Transaction.from(pending.deployment.rawTransaction);
      assert.equal(pending.status, 'pending');
      assert.equal(savedTx.gasLimit, 600_000n);
      const sendsBeforeRecovery = rpc.submissions.length;
      rpc.acceptDeploy = true;
      rpc[limit] = 550_000n; // Fresh estimate fits (500,000), but the already signed 600,000 limit does not.
      const recovered = await run(t, rpc, 'setup', settings);
      assert.equal(recovered.code, 1, recovered.output);
      assert.match(recovered.output, /gas.*limit|limit.*gas|cap/i);
      assert.equal(rpc.submissions.length, sendsBeforeRecovery, 'A previously signed deployment cannot bypass a changed network gas cap.');
      assert.equal(rpc.nonce, 7n);
      assert.equal(await readFile(rpc.stateFile, 'utf8'), previousState);
      assert.ok(rpc.submissions.every(item => item.raw === pending.deployment.rawTransaction));
      assert.ok(await missing(`${rpc.stateFile}.lock`));
      sequencerRouting(rpc);
      noSecrets(failed, rpc); noSecrets(recovered, rpc);
    });
  }
});

test('sequencer setup rejects a timestamp after the public stage end before deploying', async t => {
  const rpc = await fixture(t, { sequencer: true });
  const result = await run(t, rpc, 'setup', {
    extra: ['--sequencer-url', rpc.sequencerUrl, '--wait-until-timestamp', '201'],
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /timestamp|stage.*end|end.*stage/i);
  assert.equal(rpc.submissions.length, 0);
  assert.equal(rpc.nonce, 7n);
  assert.ok(await missing(rpc.stateFile));
  assert.ok(await missing(`${rpc.stateFile}.lock`));
  noSecrets(result, rpc);
});

test('an unhealthy sequencer stops setup before deployment without falling back to read RPC', async t => {
  const rpc = await fixture(t, { sequencer: true });
  rpc.publisherHealthy = false;
  const result = await run(t, rpc, 'setup', { extra: ['--sequencer-url', rpc.sequencerUrl] });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /sequencer|health/i);
  assert.ok(rpc.sequencerCalls.some(call => call.method === 'arb_checkPublisherHealth'));
  assert.equal(rpc.submissions.length, 0);
  assert.equal(rpc.nonce, 7n);
  assert.ok(await missing(rpc.stateFile));
  assert.ok(await missing(`${rpc.stateFile}.lock`));
  noSecrets(result, rpc);
});
