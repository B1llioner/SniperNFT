import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Transaction, Wallet, getCreateAddress, parseEther, toBeHex, toQuantity } from 'ethers';
import { expectedBenchmarkRuntime, loadBenchmarkArtifact } from '../lib/benchmark-contract.mjs';

// Entire CLI flow executes on a fresh, non-forked Anvil EVM. The two local
// proxies model routing only: Nitro's gas-limit getter and publisher health are
// explicit mocks. Durations here are NOT Robinhood/sequencer latency samples.
const KEY = `0x${'77'.repeat(32)}`; // Public synthetic test material; never fund on a public chain.
const OWNER = new Wallet(KEY).address;
const CLI = fileURLToPath(new URL('../sequencer-benchmark.mjs', import.meta.url));
const ARTIFACT = await loadBenchmarkArtifact();
const ABI = new Interface(ARTIFACT.abi);
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function localAnvil(t) {
  const binary = process.env.ANVIL_BIN ?? 'anvil';
  const version = spawnSync(binary, ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (version.error?.code === 'ENOENT') { t.skip('Anvil is not installed; set ANVIL_BIN to enable the full local EVM benchmark test.'); return; }
  assert.equal(version.status, 0, 'Anvil must start successfully.');
  const portReservation = createServer();
  const port = await listen(portReservation);
  await close(portReservation);
  const anvil = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--silent'], { stdio: 'ignore' });
  let startError;
  anvil.on('error', error => { startError = error; });
  const exited = new Promise(resolve => anvil.once('close', resolve));
  const request = new FetchRequest(`http://127.0.0.1:${port}`);
  request.timeout = 1000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  t.after(async () => {
    provider.destroy();
    if (anvil.exitCode == null) anvil.kill('SIGTERM');
    await Promise.race([exited, delay(2000)]);
    if (anvil.exitCode == null) { anvil.kill('SIGKILL'); await exited; }
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startError) throw startError;
    try {
      assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal(BigInt(await provider.send('eth_chainId', [])), 4663n);
      assert.equal(BigInt(await provider.send('eth_blockNumber', [])), 0n, 'Use a fresh local chain without a fork.');
      await provider.send('anvil_setBalance', [OWNER, toQuantity(parseEther('1'))]);
      return provider;
    } catch (error) { if (attempt === 39) throw error; await delay(50); }
  }
}

async function proxies(t, upstream, outputFile) {
  const state = { readerCalls: [], sequencerCalls: [], rawTransactions: [], rejectedRoutes: [], mockedGasReads: 0 };
  async function dispatch(endpoint, method, params) {
    state[endpoint === 'reader' ? 'readerCalls' : 'sequencerCalls'].push(method);
    if (endpoint === 'sequencer') {
      if (method === 'arb_checkPublisherHealth') return null;
      if (method !== 'eth_sendRawTransaction') {
        state.rejectedRoutes.push({ endpoint, method });
        throw new Error('Local sequencer fixture accepts only publisher health and raw submission.');
      }
      const tx = Transaction.from(params[0]);
      assert.equal(tx.from, OWNER);
      assert.equal(tx.chainId, 4663n);
      assert.equal(tx.value, 0n);
      const entries = (await readFile(outputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(entries.some(entry => entry.type === 'intent' && entry.hash === tx.hash), 'CLI must persist intent before sending the actual transaction.');
      state.rawTransactions.push(tx);
    } else {
      if (method === 'eth_sendRawTransaction' || method === 'arb_checkPublisherHealth') {
        state.rejectedRoutes.push({ endpoint, method });
        throw new Error('Local reader fixture must never be used for sequencer submission or health.');
      }
      if (method === 'eth_call' && params[0]?.to?.toLowerCase() === ARB_GAS_INFO) {
        assert.equal(params[0].data, '0xaae1cd4c');
        state.mockedGasReads++;
        return toBeHex(32_000_000n, 32);
      }
    }
    return upstream.send(method, params);
  }
  for (const endpoint of ['reader', 'sequencer']) {
    const server = createServer(async (request, response) => {
      let rpc;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(size <= 1024 * 1024, 'Local test RPC request exceeded one MiB.');
          chunks.push(chunk);
        }
        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(!Array.isArray(rpc));
        const result = await dispatch(endpoint, rpc.method, rpc.params);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      } catch (error) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32000, message: error.shortMessage ?? error.message, data: error.data } }));
      }
    });
    const port = await listen(server);
    t.after(() => close(server));
    state[`${endpoint}Url`] = `http://127.0.0.1:${port}`;
  }
  return state;
}

async function runCli(t, endpoints, outputFile) {
  const cli = spawn(process.execPath, [CLI, '--rpc', endpoints.readerUrl, '--sequencer-url', endpoints.sequencerUrl,
    '--cycles', '1', '--quantity', '2', '--send', '--poll-interval-ms', '50', '--receipt-timeout', '10', '--output', outputFile], {
    env: { PATH: process.env.PATH, PRIVATE_KEY: KEY, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  cli.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) cli.kill('SIGKILL'); });
  cli.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) cli.kill('SIGKILL'); });
  const exited = once(cli, 'close');
  const timer = setTimeout(() => cli.kill('SIGKILL'), 25_000);
  t.after(() => { clearTimeout(timer); if (cli.exitCode == null) cli.kill('SIGKILL'); });
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, `Local benchmark CLI failed (${signal}):\n${stderr}\n${stdout}`);
  assert.equal(stderr, '');
  return stdout;
}

test('full sequencer benchmark CLI deploys and mints on a real isolated EVM through separate local routes', { timeout: 40_000 }, async t => {
  const upstream = await localAnvil(t);
  if (!upstream) return;
  const directory = await mkdtemp(join(tmpdir(), 'vinos-benchmark-evm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputFile = join(directory, 'observations.jsonl');
  const endpoints = await proxies(t, upstream, outputFile);
  const stdout = await runCli(t, endpoints, outputFile);
  assert.deepEqual(endpoints.rejectedRoutes, []);
  assert.equal(endpoints.mockedGasReads, 2, 'Only the missing Nitro gas getter is mocked for the two actual transactions.');
  assert.ok(endpoints.sequencerCalls.includes('arb_checkPublisherHealth'));
  assert.equal(endpoints.sequencerCalls.filter(method => method === 'eth_sendRawTransaction').length, 2);
  assert.ok(endpoints.readerCalls.includes('eth_getTransactionReceipt'));
  assert.equal(endpoints.rawTransactions.length, 2);
  const [deployTx, mintTx] = endpoints.rawTransactions;
  assert.equal(deployTx.to, null);
  assert.equal(deployTx.nonce, 0);
  assert.equal(mintTx.nonce, 1);
  assert.ok(deployTx.data.startsWith(ARTIFACT.bytecode));
  const contract = getCreateAddress({ from: OWNER, nonce: 0 });
  assert.equal(mintTx.to, contract);
  const mintCall = ABI.parseTransaction(mintTx);
  assert.equal(mintCall.name, 'mint');
  assert.equal(mintCall.args.quantity, 2n);
  assert.equal(BigInt(await upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 2n);
  assert.equal(BigInt(await upstream.send('eth_blockNumber', [])), 2n, 'Exactly two actual transactions must be auto-mined.');
  const receipts = await Promise.all([deployTx, mintTx].map(tx => upstream.send('eth_getTransactionReceipt', [tx.hash])));
  for (let index = 0; index < receipts.length; index++) {
    assert.equal(receipts[index].status, '0x1');
    assert.equal(receipts[index].transactionHash, endpoints.rawTransactions[index].hash);
    assert.ok(BigInt(receipts[index].gasUsed) > 21_000n);
  }
  assert.equal(receipts[0].contractAddress.toLowerCase(), contract.toLowerCase());
  const nft = new Contract(contract, ARTIFACT.abi, upstream);
  const runId = await nft.runId();
  assert.equal(await upstream.getCode(contract), expectedBenchmarkRuntime(ARTIFACT, OWNER, runId));
  assert.equal(await nft.owner(), OWNER);
  assert.equal(await nft.totalSupply(), 2n);
  assert.equal(await nft.balanceOf(OWNER), 2n);
  assert.equal(await nft.ownerOf(1), OWNER);
  assert.equal(await nft.ownerOf(2), OWNER);
  assert.equal(receipts[1].logs.length, 2);

  const journalText = await readFile(outputFile, 'utf8');
  const records = journalText.trim().split('\n').map(line => JSON.parse(line));
  const results = records.filter(record => record.type === 'result');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(record => record.kind), ['deploy', 'mint']);
  assert.deepEqual(results.map(record => record.hash), [deployTx.hash, mintTx.hash]);
  assert.ok(results.every(record => record.status === 'mined' && record.verified && record.acknowledged));
  assert.deepEqual(results[1].tokenIds, ['1', '2']);
  const summary = records.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.success, true);
  assert.equal(summary.submittedTransactions, 2);
  assert.equal(summary.statistics.counts.mined, 2);
  const paid = receipts.reduce((sum, receipt) => sum + BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), 0n);
  assert.equal(BigInt(summary.spentWei), paid);
  assert.equal(await upstream.getBalance(OWNER), parseEther('1') - paid);
  for (const kind of ['deploy', 'mint']) {
    for (const phase of ['ack', 'receiptObserved']) {
      const metrics = summary.statistics.byKind[kind].phases[phase];
      assert.equal(metrics.count, 1);
      assert.ok(Number.isFinite(metrics.p95Ms) && metrics.p95Ms >= 0);
      assert.equal(metrics.p95Ms, metrics.p99Ms, 'One observation produces equal descriptive p95 and p99.');
    }
  }
  assert.match(stdout, /Kind\s+Phase\s+N\s+p50\s+p95\s+p99\s+max/);
  assert.match(stdout, /deploy\s+submit ACK/);
  assert.match(stdout, /mint\s+receipt observed/);
  assert.match(stdout, /p95\/p99 are descriptive/);
  for (const text of [stdout, journalText]) {
    assert.ok(!text.includes(KEY), 'Private key must not be printed or journaled.');
    assert.ok(!text.includes(deployTx.serialized) && !text.includes(mintTx.serialized), 'Signed raw transactions must not be printed or journaled.');
  }
});
