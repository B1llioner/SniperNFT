import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { AbiCoder, Interface, Transaction, Wallet, ZeroAddress, getCreateAddress, keccak256, toQuantity, zeroPadValue, toBeHex } from 'ethers';
import { expectedBenchmarkRuntime, loadBenchmarkArtifact } from '../lib/benchmark-contract.mjs';
import { parseSequencerBenchmarkArgs, resolveSequencerBenchmarkOptions } from '../sequencer-benchmark.mjs';

// Local synthetic wallet and independent read/send servers only. No public RPC
// or real keys are used; the fixture checks every transaction's destination.
const KEY = `0x${'47'.repeat(32)}`;
const OWNER = new Wallet(KEY).address;
const CLI = fileURLToPath(new URL('../sequencer-benchmark.mjs', import.meta.url));
const ARTIFACT = await loadBenchmarkArtifact();
const ABI = new Interface(ARTIFACT.abi);
const CODER = AbiCoder.defaultAbiCoder();
const BLOCK_HASH = `0x${'b7'.repeat(32)}`;
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function journal(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-sequencer-benchmark-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = {
    directory, outputFile: join(directory, 'observations.jsonl'), submissions: [], calls: [], sequencerCalls: [], failures: [],
    contracts: new Map(), transactions: new Map(), receipts: new Map(), nonce: 7n, pendingNonce: null,
    balance: 10n ** 18n, blockNumber: 256n, deployEstimate: 500_000n, mintEstimate: 90_000n,
    maxTxGasLimit: 32_000_000n, blockGasLimit: 30_000_000n, ackDelayMs: 0, receiptDelayMs: 0,
    rejectAt: 0, revertAt: 0, wrongOwner: false, wrongMintLogs: false, healthy: true, ...options,
  };
  function creation(data) {
    assert.ok(data.startsWith(ARTIFACT.bytecode), 'Deployments must use the standalone benchmark bytecode.');
    const tail = `0x${data.slice(ARTIFACT.bytecode.length)}`;
    assert.equal(tail.length, 66);
    const [runId] = CODER.decode(['bytes32'], tail);
    assert.notEqual(runId, `0x${'00'.repeat(32)}`);
    return { runId, code: expectedBenchmarkRuntime(ARTIFACT, OWNER, runId), supply: 0n };
  }
  async function rpc(method, params, endpoint) {
    const calls = endpoint === 'sequencer' ? state.sequencerCalls : state.calls;
    calls.push({ method, params, at: performance.now() });
    if (endpoint === 'sequencer') {
      if (method === 'arb_checkPublisherHealth') return state.healthy ? null : { rpcError: { code: -32000, message: 'Synthetic publisher unavailable' } };
      assert.equal(method, 'eth_sendRawTransaction', 'Send-only sequencer must never receive state or receipt reads.');
    } else {
      assert.notEqual(method, 'eth_sendRawTransaction', 'Read RPC must never become an automatic broadcast fallback.');
    }
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: toQuantity(state.blockNumber), hash: BLOCK_HASH,
      timestamp: '0x64', gasLimit: toQuantity(state.blockGasLimit), baseFeePerGas: '0x64' };
    if (method === 'eth_getTransactionCount') return toQuantity(params[1] === 'pending' ? state.pendingNonce ?? state.nonce : state.nonce);
    if (method === 'eth_getBalance') return toQuantity(state.balance);
    if (method === 'eth_maxPriorityFeePerGas') return '0x3';
    if (method === 'eth_gasPrice') return '0xcb';
    if (method === 'eth_getCode') return state.contracts.get(params[0].toLowerCase())?.code ?? '0x';
    if (method === 'eth_estimateGas') return toQuantity(params[0].to ? state.mintEstimate : state.deployEstimate);
    if (method === 'eth_call') {
      const [tx] = params;
      if (!tx.to) return creation(tx.data).code;
      if (tx.to.toLowerCase() === ARB_GAS_INFO) {
        assert.equal(tx.data, '0xaae1cd4c');
        return zeroPadValue(toBeHex(state.maxTxGasLimit), 32);
      }
      const contract = state.contracts.get(tx.to.toLowerCase());
      assert.ok(contract, 'The CLI must deploy the benchmark before simulating mint.');
      const decoded = ABI.parseTransaction(tx);
      const values = {
        owner: [state.wrongOwner ? ZeroAddress : OWNER], runId: [contract.runId], totalSupply: [contract.supply],
        balanceOf: [contract.supply], ownerOf: [OWNER], mint: [contract.supply + 1n], supportsInterface: [true],
      };
      assert.ok(decoded.name in values, `Unexpected benchmark read: ${decoded.name}`);
      return ABI.encodeFunctionResult(decoded.name, values[decoded.name]);
    }
    if (method === 'eth_sendRawTransaction') {
      const [raw] = params;
      const tx = Transaction.from(raw);
      const hash = keccak256(raw);
      assert.equal(tx.from, OWNER);
      assert.equal(tx.chainId, 4663n);
      assert.equal(tx.value, 0n);
      const records = await journal(state.outputFile);
      const intent = records.find(record => record.type === 'intent' && record.hash === hash);
      assert.ok(intent, 'Transaction intent must reach the journal before any raw submission.');
      assert.equal(String(intent.nonce), String(tx.nonce));
      assert.ok(!(await readFile(state.outputFile, 'utf8')).includes(raw), 'The journal must never persist a signed raw transaction.');
      state.submissions.push({ tx, hash, raw, at: performance.now(), intent });
      const ordinal = state.submissions.length;
      if (state.rejectAt === ordinal) return { rpcError: { code: -32000, message: `Synthetic send rejected ${raw} ${KEY} ${state.sequencerUrl}` } };
      assert.equal(BigInt(tx.nonce), state.nonce, 'Each mined phase consumes exactly the next nonce.');
      state.nonce++;
      state.blockNumber++;
      const reverted = state.revertAt === ordinal;
      let contractAddress = null;
      const logs = [];
      if (!tx.to) {
        const contract = creation(tx.data);
        contractAddress = getCreateAddress({ from: OWNER, nonce: tx.nonce });
        if (!reverted) state.contracts.set(contractAddress.toLowerCase(), contract);
      } else {
        const contract = state.contracts.get(tx.to.toLowerCase());
        assert.ok(contract, 'Mint must target this run’s freshly deployed benchmark.');
        const decoded = ABI.parseTransaction(tx);
        assert.equal(decoded.name, 'mint');
        assert.ok(decoded.args.quantity >= 1n && decoded.args.quantity <= 100n);
        if (!reverted) {
          for (let i = 0n; i < decoded.args.quantity; i++) {
            const tokenId = ++contract.supply;
            if (!state.wrongMintLogs) logs.push({ address: tx.to, ...ABI.encodeEventLog(ABI.getEvent('Transfer'), [ZeroAddress, OWNER, tokenId]),
              blockNumber: toQuantity(state.blockNumber), blockHash: BLOCK_HASH, transactionHash: hash, transactionIndex: '0x0', logIndex: toQuantity(i), removed: false });
          }
        }
      }
      const gasUsed = tx.to ? state.mintEstimate : state.deployEstimate;
      state.balance -= gasUsed * 203n;
      const receipt = { transactionHash: hash, status: reverted ? '0x0' : '0x1', from: OWNER, to: tx.to,
        contractAddress: reverted ? null : contractAddress, blockNumber: toQuantity(state.blockNumber), blockHash: BLOCK_HASH,
        transactionIndex: '0x0', gasUsed: toQuantity(gasUsed), cumulativeGasUsed: toQuantity(gasUsed), effectiveGasPrice: '0xcb', logs };
      state.receipts.set(hash, { receipt, availableAt: performance.now() + state.receiptDelayMs });
      state.transactions.set(hash, { hash, from: OWNER, to: tx.to, nonce: toQuantity(tx.nonce), input: tx.data, value: '0x0',
        blockHash: BLOCK_HASH, blockNumber: toQuantity(state.blockNumber), transactionIndex: '0x0' });
      if (state.ackDelayMs) await delay(state.ackDelayMs);
      return hash;
    }
    if (method === 'eth_getTransactionByHash') return state.transactions.get(params[0]) ?? null;
    if (method === 'eth_getTransactionReceipt') {
      const item = state.receipts.get(params[0]);
      if (!item || performance.now() < item.availableAt) return null;
      item.firstObservedAt ??= performance.now();
      return item.receipt;
    }
    assert.fail(`Unexpected synthetic RPC method: ${method}`);
  }
  async function serve(endpoint) {
    const server = createServer(async (request, response) => {
      let id = null;
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; assert.ok(body.length <= 64 * 1024); }
        const message = JSON.parse(body);
        ({ id } = message);
        const result = await rpc(message.method, message.params, endpoint);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(result?.rpcError ? { error: result.rpcError } : { result }) }));
      } catch (error) {
        state.failures.push(error.message);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Synthetic benchmark fixture failed' } }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}/synthetic-${endpoint}-secret`;
  }
  state.url = await serve('rpc');
  state.sequencerUrl = await serve('sequencer');
  t.after(() => assert.deepEqual(state.failures, []));
  return state;
}

async function run(t, state, { send = true, extra = [], env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, '--rpc', state.url, '--sequencer-url', state.sequencerUrl,
    '--output', state.outputFile, '--receipt-timeout', '1', '--poll-interval-ms', '50', '--interval-ms', '100',
    '--from', OWNER, ...(send ? ['--send'] : []), ...extra], { env: { PRIVATE_KEY: KEY, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic benchmark CLI timed out')); }, 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      try {
        assert.deepEqual(state.failures, [], 'The CLI violated an RPC fixture invariant.');
        resolve({ code, output, records: await journal(state.outputFile) });
      } catch (error) { reject(error); }
    });
  });
}
function summary(result) {
  const records = result.records.filter(record => record.type === 'summary');
  assert.equal(records.length, 1, result.output);
  return records[0];
}
function noSecrets(result, state) {
  const text = `${result.output}\n${JSON.stringify(result.records)}`;
  for (const secret of [KEY, state.url, state.sequencerUrl, ...state.submissions.map(item => item.raw)]) {
    assert.ok(!text.includes(secret), 'Console and journal must exclude private keys, RPC URLs and signed raw bytes.');
  }
}

test('benchmark default sends exactly deploy then mint to sequencer and persists private intent before each raw', async t => {
  const state = await fixture(t);
  const result = await run(t, state);
  assert.equal(result.code, 0, result.output);
  assert.equal(state.submissions.length, 2);
  const [deploy, mint] = state.submissions;
  assert.equal(deploy.tx.to, null);
  assert.equal(mint.tx.to, getCreateAddress({ from: OWNER, nonce: 7 }));
  assert.equal(ABI.parseTransaction(mint.tx).args.quantity, 1n);
  assert.deepEqual(state.submissions.map(item => item.tx.nonce), [7, 8]);
  assert.equal(state.contracts.get(mint.tx.to.toLowerCase()).supply, 1n);
  assert.equal((await stat(state.outputFile)).mode & 0o777, 0o600);
  assert.equal(summary(result).success, true);
  assert.equal(summary(result).statistics.counts.mined, 2);
  assert.ok(state.sequencerCalls.every(call => ['arb_checkPublisherHealth', 'eth_sendRawTransaction'].includes(call.method)));
  assert.ok(!state.calls.some(call => call.method === 'eth_sendRawTransaction'));
  assert.match(result.output, /p95/);
  assert.match(result.output, /p99/);
  noSecrets(result, state);
});

test('benchmark repeated pairs use fresh run IDs/contracts and separate deployment/mint percentiles', async t => {
  const state = await fixture(t);
  const result = await run(t, state, { extra: ['--cycles', '3', '--quantity', '2'] });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(state.submissions.map(item => item.tx.nonce), [7, 8, 9, 10, 11, 12]);
  assert.equal(state.contracts.size, 3);
  assert.equal(new Set([...state.contracts.values()].map(item => item.runId)).size, 3);
  assert.ok([...state.contracts.values()].every(item => item.supply === 2n));
  const final = summary(result);
  assert.equal(final.requestedCycles, 3);
  assert.equal(final.statistics.counts.mined, 6);
  for (const kind of ['deploy', 'mint']) {
    const group = final.statistics.byKind[kind];
    assert.equal(group.counts.mined, 3);
    assert.equal(group.phases.ack.count, 3);
    assert.equal(group.phases.receiptObserved.count, 3);
    assert.ok(group.phases.ack.p50Ms <= group.phases.ack.p95Ms);
    assert.ok(group.phases.ack.p95Ms <= group.phases.ack.p99Ms);
  }
  assert.ok(final.statistics.warnings.some(message => message.includes('p99')));
  noSecrets(result, state);
});

test('receipt observation runs concurrently with a slow sequencer ACK and starts at raw submission', async t => {
  const state = await fixture(t, { ackDelayMs: 350, receiptDelayMs: 30 });
  const result = await run(t, state);
  assert.equal(result.code, 0, result.output);
  const observations = result.records.filter(record => record.type === 'result');
  assert.equal(observations.length, 2);
  for (const record of observations) {
    assert.ok(record.timingsMs.ack >= 300, JSON.stringify(record.timingsMs));
    assert.ok(record.timingsMs.receiptObserved < record.timingsMs.ack - 150, JSON.stringify(record.timingsMs));
    assert.ok(record.timingsMs.receiptObserved >= 25, JSON.stringify(record.timingsMs));
  }
});

test('a rejected deployment remains uncertain, gets no retry or mint, and leaks no RPC error payload', async t => {
  const state = await fixture(t, { rejectAt: 1 });
  const result = await run(t, state, { extra: ['--cycles', '2'] });
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 1);
  assert.equal(summary(result).success, false);
  assert.equal(summary(result).statistics.counts.uncertain, 1);
  assert.equal(summary(result).statistics.phases.ack.count, 0);
  assert.equal(summary(result).statistics.phases.receiptObserved.count, 0);
  noSecrets(result, state);
});

test('a reverted mint records paid gas and stops before the next cycle', async t => {
  const state = await fixture(t, { revertAt: 2 });
  const result = await run(t, state, { extra: ['--cycles', '3'] });
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 2);
  const final = summary(result);
  assert.equal(final.success, false);
  assert.equal(final.statistics.counts.mined, 1);
  assert.equal(final.statistics.counts.reverted, 1);
  assert.equal(BigInt(final.spentWei), (state.deployEstimate + state.mintEstimate) * 203n);
  assert.equal(final.statistics.byKind.mint.phases.receiptObserved.count, 1);
  assert.equal(final.statistics.byKind.mint.phases.total.count, 0);
});

test('benchmark verifies deployment ownership and refuses mint after a mismatching proof', async t => {
  const state = await fixture(t, { wrongOwner: true });
  const result = await run(t, state);
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 1);
  assert.equal(summary(result).success, false);
});

test('mint requires valid Transfer evidence before declaring a successful cycle', async t => {
  const state = await fixture(t, { wrongMintLogs: true });
  const result = await run(t, state, { extra: ['--cycles', '2'] });
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 2);
  assert.equal(summary(result).success, false);
});

test('pending wallet transactions prevent all submissions', async t => {
  const state = await fixture(t, { pendingNonce: 8n });
  const result = await run(t, state);
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 0);
  noSecrets(result, state);
});

test('Nitro transaction gas ceiling rejects deployment before sending', async t => {
  const state = await fixture(t, { maxTxGasLimit: 599_999n });
  const result = await run(t, state);
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 0);
});

test('total gas budget includes paid deployment plus the next transaction reserve', async t => {
  const state = await fixture(t);
  // Deploy reserve: 600000 * 203 = 121800000 wei. Actual deploy plus
  // mint reserve: 500000 * 203 + 108000 * 203 = 123424000 wei.
  const result = await run(t, state, { extra: ['--max-total-gas-cost-eth', '0.000000000122'] });
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 1);
  assert.equal(summary(result).success, false);
  assert.equal(BigInt(summary(result).spentWei), state.deployEstimate * 203n);
});

test('dry run accepts no private key, preflights only deployment and broadcasts nothing', async t => {
  const state = await fixture(t);
  const result = await run(t, state, { send: false, env: { PRIVATE_KEY: '' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(state.submissions.length, 0);
  assert.equal(state.contracts.size, 0);
  assert.ok(state.calls.some(call => call.method === 'eth_call' && !call.params[0].to));
  assert.ok(!state.calls.some(call => call.method === 'eth_call' && call.params[0].to?.toLowerCase() !== ARB_GAS_INFO && call.params[0].to));
  noSecrets(result, state);
});

test('an existing output journal is never overwritten and prevents transaction submission', async t => {
  const state = await fixture(t);
  const saved = '{"type":"saved","preserve":true}\n';
  await writeFile(state.outputFile, saved);
  const result = await run(t, state);
  assert.equal(result.code, 1, result.output);
  assert.equal(state.submissions.length, 0);
  assert.equal(await readFile(state.outputFile, 'utf8'), saved);
});

test('benchmark help performs no RPC requests and needs no private key', async t => {
  const state = await fixture(t);
  const result = await run(t, state, { send: false, extra: ['--help'], env: { PRIVATE_KEY: '' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(state.calls.length, 0);
  assert.equal(state.sequencerCalls.length, 0);
  assert.equal(result.records.length, 0);
  assert.match(result.output, /--cycles/);
  assert.match(result.output, /--send/);
});

test('benchmark rejects unbounded workloads, invalid fee budgets and unsafe endpoint/config options', () => {
  for (const args of [
    { cycles: '1001' }, { cycles: '0' }, { quantity: '101' }, { quantity: '-1' },
    { 'poll-interval-ms': '0' }, { 'receipt-timeout': '301' },
    { 'max-gas-cost-eth': '0' }, { 'max-total-gas-cost-eth': '-1' }, { 'max-fee-multiplier': '21' },
    { rpc: 'http://example.invalid' }, { 'sequencer-url': 'https://user:secret@example.invalid' },
  ]) assert.throws(() => resolveSequencerBenchmarkOptions(args), undefined, JSON.stringify(args));
  assert.throws(() => resolveSequencerBenchmarkOptions({}, { privateKey: KEY }));
  assert.throws(() => resolveSequencerBenchmarkOptions({}, { maxGasCostEth: 0.003 }));
  assert.throws(() => parseSequencerBenchmarkArgs(['--cycles', '2', '--cycles', '100']));
  assert.throws(() => parseSequencerBenchmarkArgs(['--private-key', KEY]));
});
