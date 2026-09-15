import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, toQuantity } from 'ethers';
import { CONFIG, SEADROP_ABI } from '../mint.mjs';
import { parseBenchmarkArgs, readBenchmarkConfig, resolveBenchmarkOptions, runBenchmark, summarize, writeBenchmarkReport } from '../benchmark.mjs';

const CLI = fileURLToPath(new URL('../benchmark.mjs', import.meta.url));
const SEA = new Interface(SEADROP_ABI);
const FACTORY = new Interface(['function mintBatch(uint256,uint256) returns(uint256)']);
const NFT_CODE = (await readFile(new URL('../research/nft-runtime.hex', import.meta.url), 'utf8')).trim();
const START = 1_800_000_000n;
const options = extra => resolveBenchmarkOptions({ rpc: ['http://127.0.0.1:1'], samples: '3', 'interval-ms': '100', ...extra });

test('benchmark extracts only RPC URLs and quantity from batch config, preserving defaults and explicit overrides', () => {
  const config = { quantity: 7, rpcUrls: ['https://rpc.example/path-key'], factory: 'ignored', futureWarmSetting: true };
  const defaults = resolveBenchmarkOptions({ rpc: [] }, config);
  assert.equal(defaults.quantity, 7);
  assert.equal(defaults.samples, 10);
  assert.equal(defaults.intervalMs, 250);
  assert.equal(defaults.fullSamples, 3);
  assert.equal(defaults.full, false);
  assert.deepEqual(defaults.rpcUrls, config.rpcUrls);
  const overridden = resolveBenchmarkOptions(parseBenchmarkArgs(['--rpc', 'http://127.0.0.1:2', '--quantity', '1', '--full']), config);
  assert.deepEqual(overridden.rpcUrls, ['http://127.0.0.1:2']);
  assert.equal(overridden.quantity, 1);
  assert.equal(overridden.full, true);
  for (const invalid of [{ samples: 2 }, { samples: 101 }, { 'interval-ms': 99 }, { 'interval-ms': 10001 },
    { 'full-samples': 0 }, { 'full-samples': 11 }, { quantity: 0 }, { quantity: 1025 }, { rpc: Array(9).fill('https://rpc.example') }]) {
    assert.throws(() => options(invalid));
  }
  assert.throws(() => parseBenchmarkArgs(['--send']));
  assert.throws(() => parseBenchmarkArgs(['--samples', '3', '--samples', '4']));
});

test('latency statistics use successful samples only, nearest-rank percentiles, and nullable empty results', () => {
  const result = summarize([{ ok: true, ms: 9 }, { ok: false, ms: 999, error: 'timeout' }, { ok: true, ms: 1 }, { ok: true, ms: 4 }], 5);
  assert.deepEqual(result, { requested: 5, attempted: 4, successes: 3, errors: 1, skipped: 1,
    minMs: 1, p50Ms: 4, p95Ms: 9, maxMs: 9, errorCounts: { timeout: 1 } });
  const failed = summarize([{ ok: false, ms: 100, error: 'rpc_error' }], 3);
  assert.equal(failed.p50Ms, null);
  assert.equal(failed.maxMs, null);
  assert.equal(failed.successes, 0);
  assert.equal(failed.skipped, 2);
});

test('RPC invocation starts obey pacing under short, long and mixed latency without counting waits as latency', async () => {
  const selected = options();
  for (const latencies of [[10, 20, 30, 40], [170, 240, 130, 180], [250, 10, 180, 5]]) {
    let time = 0; let destroyed = 0; let inFlight = 0;
    const starts = []; const waits = []; const methods = [];
    const report = await runBenchmark(selected, {
      now: () => time,
      wait: async ms => { assert.ok(ms > 0); waits.push(ms); time += ms; },
      providerFactory: () => ({
        async send(method, params) {
          assert.equal(inFlight++, 0, 'Only one request per endpoint may be in flight.');
          assert.deepEqual(params, []);
          methods.push(method); starts.push(time);
          const latency = latencies[starts.length - 1];
          assert.ok(latency != null, 'Unexpected extra RPC request.');
          await Promise.resolve();
          time += latency; inFlight--;
          return method === 'eth_chainId' ? '0x1237' : '0x64';
        },
        destroy() { destroyed++; },
      }),
    });
    assert.equal(report.success, true);
    assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber', 'eth_blockNumber']);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 1] >= selected.intervalMs);
      assert.equal(starts[i] - starts[i - 1], Math.max(selected.intervalMs, latencies[i - 1]));
    }
    assert.deepEqual(waits, latencies.slice(0, -1).map(ms => Math.max(0, selected.intervalMs - ms)).filter(ms => ms > 0));
    const endpoint = report.endpoints[0];
    assert.equal(endpoint.coldConnectAndChainRead.p50Ms, latencies[0]);
    const warm = latencies.slice(1).sort((a, b) => a - b);
    assert.equal(endpoint.warm.minMs, warm[0]);
    assert.equal(endpoint.warm.p50Ms, warm[1]);
    assert.equal(endpoint.warm.p95Ms, warm[2]);
    assert.equal(endpoint.warm.maxMs, warm[2]);
    assert.equal(endpoint.warm.successes, selected.samples);
    assert.equal(destroyed, 1);
  }
});

test('wrong-chain and failed warm reads never produce a success summary or leaked RPC credentials', async () => {
  let destroyed = 0;
  const bad = new Error('secret-url-path and secret-api-query');
  const report = await runBenchmark({ ...options(), rpcUrls: ['https://rpc.example/secret-url-path?key=secret-api-query', 'https://wrong.example/private'] }, {
    wait: async () => {}, providerFactory: url => ({
      async send(method) {
        if (method === 'eth_chainId') return url.includes('wrong') ? '0x1' : '0x1237';
        throw bad;
      }, destroy() { destroyed++; },
    }),
  });
  assert.equal(report.success, false);
  assert.equal(report.endpoints[0].warm.errors, 3);
  assert.equal(report.endpoints[0].warm.p95Ms, null);
  assert.equal(report.endpoints[1].coldConnectAndChainRead.errorCounts.wrong_chain, 1);
  assert.equal(report.endpoints[1].warm.attempted, 0);
  assert.equal(destroyed, 2);
  assert.ok(!JSON.stringify(report).includes('secret-'));
});

test('config file is bounded and output is exclusively created with private permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-benchmark-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ quantity: 2 }));
  assert.deepEqual(await readBenchmarkConfig(config), { quantity: 2 });
  await writeFile(config, ' '.repeat(65537));
  await assert.rejects(readBenchmarkConfig(config), /64 KiB/);
  const output = join(directory, 'report.json');
  await writeBenchmarkReport(output, { success: false });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(writeBenchmarkReport(output, { success: true }), error => error.code === 'EEXIST');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { success: false });
});

async function fixture(t, settings = {}) {
  const calls = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    let id = null;
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length < 65536); }
      const message = JSON.parse(body); ({ id } = message);
      const { method, params } = message;
      calls.push({ method, params });
      let result;
      switch (method) {
        case 'eth_chainId': result = '0x1237'; break;
        case 'eth_blockNumber': result = '0x64'; break;
        case 'eth_getCode': result = params[0].toLowerCase() === CONFIG.nftContract.toLowerCase() ? NFT_CODE : '0x'; break;
        case 'eth_call': {
          const [tx, tag, overrides, block] = params;
          if (tx.data.slice(0, 10) === SEA.getFunction('getPublicDrop').selector) {
            result = SEA.encodeFunctionResult('getPublicDrop', [[0n, START, START + 3600n, 1n, 1000n, true]]); break;
          }
          assert.equal(tag, 'latest');
          assert.equal(block.time, toQuantity(START + 1n));
          assert.equal(tx.gas, toQuantity(12_000_000n));
          assert.equal(tx.value, '0x0');
          if (tx.to.toLowerCase() === CONFIG.seaDrop.toLowerCase()) {
            assert.equal(SEA.parseTransaction(tx).name, 'mintPublic');
            assert.deepEqual(overrides, {});
            result = '0x';
          } else {
            assert.equal(Object.keys(overrides).length, 1);
            assert.ok(overrides[tx.to].code.length > 2);
            assert.deepEqual(overrides[tx.to].state, {});
            assert.deepEqual([...FACTORY.parseTransaction(tx).args], [2n, 2n]);
            result = FACTORY.encodeFunctionResult('mintBatch', [2n]);
          }
          break;
        }
        case 'eth_estimateGas':
          assert.equal(params.length, 4);
          assert.equal(params[3].time, toQuantity(START + 1n));
          if (settings.estimateFails) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'private-provider-key-url-detail' } })); return;
          }
          result = '0x100000'; break;
        default: assert.fail(`Disallowed fixture RPC method: ${method}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture failed' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); });
  return { calls, url: `http://127.0.0.1:${server.address().port}/private-api-path?key=private-api-query` };
}
async function cli(rpc, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--rpc', rpc.url, '--samples', '3', '--interval-ms', '100', ...args], {
      env: { PRIVATE_KEY: 'malformed-must-not-be-read', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Benchmark CLI fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function parsed(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('private-api-'));
  assert.ok(!result.stdout.includes('malformed-must-not-be-read'));
  assert.ok(!result.stdout.includes(`0x${'11'.repeat(32)}`));
  return JSON.parse(result.stdout);
}

test('default CLI only checks chain and head reads, independent of PRIVATE_KEY', async t => {
  const rpc = await fixture(t);
  const report = parsed(await cli(rpc));
  assert.equal(report.success, true);
  assert.deepEqual(rpc.calls.map(call => call.method), ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber', 'eth_blockNumber']);
  // Server arrival gaps include variable transport delay. Client start pacing
  // is checked above with a controlled clock, independently of machine load.
  assert.equal(report.endpoints[0].warm.successes, 3);
  assert.equal(report.offline.warmSign.successes, 3);
});

for (const quantity of [1, 2]) test(`full CLI quantity ${quantity} validates read-only call and estimate overrides`, async t => {
  const rpc = await fixture(t);
  const report = parsed(await cli(rpc, ['--full', '--full-samples', '1', '--quantity', String(quantity)]));
  assert.equal(report.endpoints[0].full.context.route, quantity === 1 ? 'direct' : 'factory');
  assert.equal(report.endpoints[0].full.ethCall.successes, 1);
  assert.equal(report.endpoints[0].full.ethEstimateGas.successes, 1);
  assert.ok(rpc.calls.every(call => !call.method.startsWith('eth_send')));
});

test('unsupported full estimate reports failure without fake successful latency or leaked provider detail', async t => {
  const rpc = await fixture(t, { estimateFails: true });
  const result = await cli(rpc, ['--full', '--full-samples', '1', '--quantity', '1']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, false);
  assert.equal(report.endpoints[0].full.ethCall.successes, 1);
  assert.equal(report.endpoints[0].full.ethEstimateGas.errors, 1);
  assert.equal(report.endpoints[0].full.ethEstimateGas.p50Ms, null);
  assert.ok(!result.stdout.includes('private-provider-key'));
});
