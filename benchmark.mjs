#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Interface, Wallet, ZeroAddress, getAddress, keccak256, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, SEADROP_ABI, MintError, createProvider, parseUint } from './mint.mjs';
import { loadArtifact, verifyFactoryCode } from './batch.mjs';

const DEFAULT_RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_estimateGas']);
const NFT_HASH = '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c';
const SEA = new Interface(SEADROP_ABI);
const FACTORY_ABI = ['function mintBatch(uint256,uint256) returns(uint256)'];
const FACTORY = new Interface(FACTORY_ABI);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class BenchmarkError extends Error {
  constructor(message, kind = 'validation') { super(message); this.kind = kind; }
}
function check(value, message, kind) { if (!value) throw new BenchmarkError(message, kind); }
function bounded(value, low, high, name) {
  const n = parseUint(value, name);
  check(n >= BigInt(low) && n <= BigInt(high), `${name} must be between ${low} and ${high}.`);
  return Number(n);
}
export function parseBenchmarkArgs(argv) {
  const result = { rpc: [] };
  const values = new Set(['config', 'rpc', 'samples', 'interval-ms', 'full-samples', 'output', 'quantity']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    check(argv[i].startsWith('--'), 'Use named options; see --help.');
    check(key === 'rpc' || !(key in result), 'Duplicate CLI option.');
    if (key === 'help' || key === 'full') result[key] = true;
    else {
      check(values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown option or missing value; see --help.');
      if (key === 'rpc') result.rpc.push(argv[++i]); else result[key] = argv[++i];
    }
  }
  return result;
}
export function resolveBenchmarkOptions(args, config = {}) {
  check(config && typeof config === 'object' && !Array.isArray(config), 'Config must be a JSON object.');
  // Other batch configuration fields intentionally do not affect this read-only benchmark.
  const urls = args.rpc?.length ? args.rpc : config.rpcUrls ?? DEFAULT_RPCS;
  check(Array.isArray(urls) && urls.length >= 1 && urls.length <= 8 && urls.every(url => typeof url === 'string'), 'Provide 1-8 RPC URL strings.');
  return { rpcUrls: [...new Set(urls)], quantity: bounded(args.quantity ?? config.quantity ?? 10, 1, 1024, 'quantity'),
    samples: bounded(args.samples ?? 10, 3, 100, 'samples'), intervalMs: bounded(args['interval-ms'] ?? 250, 100, 10000, 'interval-ms'),
    full: Boolean(args.full), fullSamples: bounded(args['full-samples'] ?? 3, 1, 10, 'full-samples'), output: args.output };
}
export async function readBenchmarkConfig(path) {
  const handle = await open(resolve(path), 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= 65536, 'Config must be a regular file of at most 64 KiB.');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= 65536, 'Config exceeds 64 KiB.');
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new BenchmarkError('Config is not valid JSON.'); }
  } finally { await handle.close(); }
}
const round = value => Math.round(value * 1000) / 1000;
export function summarize(records, requested = records.length) {
  const sorted = records.filter(record => record.ok).map(record => record.ms).sort((a, b) => a - b);
  const quantile = fraction => sorted.length ? round(sorted[Math.ceil(sorted.length * fraction) - 1]) : null;
  const errorCounts = {};
  for (const record of records.filter(record => !record.ok)) errorCounts[record.error] = (errorCounts[record.error] ?? 0) + 1;
  return { requested, attempted: records.length, successes: sorted.length, errors: records.length - sorted.length,
    skipped: requested - records.length, minMs: sorted.length ? round(sorted[0]) : null, p50Ms: quantile(0.5),
    p95Ms: quantile(0.95), maxMs: sorted.length ? round(sorted.at(-1)) : null, errorCounts };
}
function errorKind(error) {
  if (error instanceof BenchmarkError) return error.kind;
  if (['TIMEOUT', 'CALL_EXCEPTION', 'NETWORK_ERROR'].includes(error?.code)) return error.code.toLowerCase();
  const code = error?.info?.error?.code ?? error?.error?.code;
  return code === -32601 ? 'method_unavailable' : code === -32602 ? 'invalid_rpc_params_or_overrides' : 'rpc_error';
}
function endpointLabel(url) { try { return new URL(url).origin; } catch { return 'invalid URL'; } }
function syntheticAddress() {
  let result;
  do { result = getAddress(`0x${randomBytes(20).toString('hex')}`); } while (result === ZeroAddress);
  return result;
}
async function prepareFull(send, quantity) {
  const sender = syntheticAddress();
  let factory; do { factory = syntheticAddress(); } while (factory === sender);
  check(await send('eth_getCode', [sender, 'latest']) === '0x', 'Synthetic sender is not empty.', 'sender_not_empty');
  const code = await send('eth_getCode', [CONFIG.nftContract, 'latest']);
  check(keccak256(code) === NFT_HASH, 'NFT runtime differs.', 'nft_code_mismatch');
  const [drop] = SEA.decodeFunctionResult('getPublicDrop', await send('eth_call', [
    { to: CONFIG.seaDrop, data: SEA.encodeFunctionData('getPublicDrop', [CONFIG.nftContract]) }, 'latest',
  ]));
  check(drop.mintPrice === 0n && drop.maxTotalMintableByWallet > 0n && drop.startTime + 1n <= drop.endTime, 'Public drop does not permit free simulation.', 'drop_not_suitable');
  const state = {};
  let to = CONFIG.seaDrop;
  let data = SEA.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n]);
  let sourceSha256;
  if (quantity > 1) {
    const artifact = await loadArtifact();
    sourceSha256 = artifact.sourceSha256;
    check(await send('eth_getCode', [factory, 'latest']) === '0x', 'Synthetic factory is not empty.', 'factory_not_empty');
    const bytes = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
    const word = Buffer.from(zeroPadValue(sender, 32).slice(2), 'hex');
    for (const group of Object.values(artifact.immutableReferences)) for (const { start } of group) word.copy(bytes, start);
    const runtime = `0x${bytes.toString('hex')}`;
    verifyFactoryCode(runtime, artifact);
    state[factory] = { code: runtime, state: {} };
    to = factory; data = FACTORY.encodeFunctionData('mintBatch', [quantity, quantity]);
  }
  return { params: [{ from: sender, to, value: '0x0', gas: toQuantity(12_000_000n), gasPrice: '0x0', data }, 'latest', state, { time: toQuantity(drop.startTime + 1n) }],
    context: { route: quantity === 1 ? 'direct' : 'factory', quantity, blockTimeOverride: String(drop.startTime + 1n), sourceSha256, gasCap: 12_000_000 } };
}
export async function benchmarkEndpoint(url, index, options, dependencies = {}) {
  const { providerFactory = createProvider, now = () => performance.now(), wait = sleep } = dependencies;
  const report = { index, endpoint: endpointLabel(url), chainVerified: false, warm: summarize([], options.samples) };
  let provider; let nextStart = 0;
  async function paced(method, params, validate = value => value) {
    check(READ_METHODS.has(method), 'Only read-only RPC methods are allowed.');
    const delay = Math.max(0, nextStart - now());
    if (delay) await wait(delay);
    nextStart = now() + options.intervalMs;
    return validate(await provider.send(method, params));
  }
  async function measured(method, params, validate) {
    const delay = Math.max(0, nextStart - now());
    if (delay) await wait(delay);
    // Exclude pacing from latency, while allowing each endpoint only one in-flight call.
    nextStart = now();
    const started = now();
    try { return { ok: true, value: await paced(method, params, validate), ms: now() - started }; }
    catch (error) { return { ok: false, error: errorKind(error), ms: now() - started }; }
  }
  try {
    provider = providerFactory(url);
    const cold = await measured('eth_chainId', [], value => {
      check(parseUint(value) === CONFIG.chainId, 'Wrong chain.', 'wrong_chain'); return String(CONFIG.chainId);
    });
    report.coldConnectAndChainRead = summarize([cold], 1);
    if (!cold.ok) return report;
    report.chainVerified = true;
    const warm = [];
    for (let i = 0; i < options.samples; i++) {
      const record = await measured('eth_blockNumber', [], value => parseUint(value).toString());
      warm.push(record);
      if (record.ok) report.lastObservedHead = record.value;
    }
    report.warm = summarize(warm, options.samples);
    if (options.full) {
      const full = { ethCall: summarize([], options.fullSamples), ethEstimateGas: summarize([], options.fullSamples) };
      report.full = full;
      try {
        const prepared = await prepareFull(paced, options.quantity);
        full.context = prepared.context;
        const calls = []; const estimates = [];
        for (let i = 0; i < options.fullSamples; i++) {
          calls.push(await measured('eth_call', prepared.params, value => {
            check(options.quantity === 1 ? value === '0x' : FACTORY.decodeFunctionResult('mintBatch', value)[0] === BigInt(options.quantity), 'Unexpected mint return.', 'unexpected_mint_result');
            return true;
          }));
          const estimate = await measured('eth_estimateGas', prepared.params, value => {
            const n = parseUint(value); check(n > 0n, 'Zero estimate.', 'invalid_gas_estimate'); return String(n);
          });
          estimates.push(estimate);
          if (estimate.ok) full.lastGasEstimate = estimate.value;
        }
        full.ethCall = summarize(calls, options.fullSamples); full.ethEstimateGas = summarize(estimates, options.fullSamples);
      } catch (error) { full.setupError = errorKind(error); }
    }
  } catch (error) { report.setupError = errorKind(error); }
  finally { provider?.destroy(); }
  return report;
}
async function offlineBenchmark(options) {
  const encode = () => options.quantity === 1
    ? SEA.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n])
    : FACTORY.encodeFunctionData('mintBatch', [options.quantity, options.quantity]);
  const measure = async fn => { const start = performance.now(); await fn(); return { ok: true, ms: performance.now() - start }; };
  const coldEncode = await measure(encode);
  const encoded = encode();
  // This is deliberately public test material, never the user's wallet or PRIVATE_KEY.
  let wallet;
  const transaction = { to: options.quantity === 1 ? CONFIG.seaDrop : '0x1000000000000000000000000000000000000002', data: encoded, value: 0n, chainId: CONFIG.chainId, nonce: 0, gasLimit: 12_000_000n, type: 2, maxFeePerGas: 70_000_000n, maxPriorityFeePerGas: 0n };
  const coldSign = await measure(async () => { wallet = new Wallet(`0x${'11'.repeat(32)}`); await wallet.signTransaction(transaction); });
  const encodes = []; const signs = [];
  for (let i = 0; i < options.samples; i++) { encodes.push(await measure(encode)); signs.push(await measure(() => wallet.signTransaction(transaction))); }
  return { note: 'First local encode/sign and subsequent operations in this process; signing uses a public synthetic key. Serialized transactions are discarded and never submitted.',
    coldEncode: summarize([coldEncode]), warmEncode: summarize(encodes), coldSign: summarize([coldSign]), warmSign: summarize(signs) };
}
export async function runBenchmark(options, dependencies = {}) {
  const offline = await offlineBenchmark(options);
  const endpoints = await Promise.all(options.rpcUrls.map((url, index) => benchmarkEndpoint(url, index, options, dependencies)));
  const success = endpoints.some(endpoint => endpoint.chainVerified && endpoint.warm.successes > 0 &&
    (!options.full || (endpoint.full?.ethCall.successes > 0 && endpoint.full?.ethEstimateGas.successes > 0)));
  return { kind: 'read-only-rpc-latency-benchmark', recordedAt: new Date().toISOString(), success,
    quantity: options.quantity, samples: options.samples, intervalMs: options.intervalMs, fullSamples: options.full ? options.fullSamples : 0,
    percentileMethod: 'nearest rank, successful samples only; milliseconds; pacing excluded', offline, endpoints,
    limits: ['Read/simulation/estimate latency is not transaction submission, mempool propagation, inclusion or finality latency.',
      'Cold RPC measurement is the first eth_chainId request; DNS/TCP/TLS may be cached by the host.',
      'Warm reads use eth_blockNumber; hosts and public RPC caches can change results. No minimum block production lag is inferred.',
      'Full mode uses latest state plus temporary publicStart+1 time and synthetic addresses; factory code is virtual for quantity>1. Existing dependencies are unchanged.',
      'Full requests use gasPrice 0 and a 12-million gas cap. Unsupported overrides, reverts and failed estimates are errors, not successful latency samples.',
      'No actual wallet key is read; no deployment or broadcast is performed.'] };
}
export async function writeBenchmarkReport(path, report) {
  await writeFile(resolve(path), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
const HELP = `Read-only RPC latency benchmark; never broadcasts.
  node benchmark.mjs [--config batch.config.json] [--rpc URL ...]
  node benchmark.mjs --full --quantity 10 --samples 10 --output benchmark.json
--samples N       Warm read samples per RPC, 3-100; default 10.
--interval-ms N   Minimum RPC start interval, 100-10000 ms; default 250.
--full            Also time eth_call and eth_estimateGas with state/time overrides.
--full-samples N  Full samples per method/RPC, 1-10; default 3.
--quantity N      Config quantity override, 1-1024; default 10.
--rpc URL         Repeat up to 8 times; overrides config.rpcUrls.
--output FILE     Exclusively create a JSON report with mode 0600; never overwrite.
--help            No network. URL paths/query credentials and raw errors are hidden.
Read/estimate timings do not measure transaction submission or inclusion speed.`;
export async function main(argv = process.argv.slice(2)) {
  const args = parseBenchmarkArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const options = resolveBenchmarkOptions(args, args.config ? await readBenchmarkConfig(args.config) : {});
  const report = await runBenchmark(options);
  if (options.output) await writeBenchmarkReport(options.output, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${error instanceof BenchmarkError || error instanceof MintError ? error.message : 'Benchmark failed; private details were suppressed.'}`); process.exitCode = 1; });
}
