#!/usr/bin/env node
// Local, nonforked Anvil only. No RPC URL, wallet or secret inputs are accepted.
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node scripts/benchmark-genesis-preflight.mjs
  --before /path/to/instrumented-baseline --after /path/to/new-binary
  [--samples 5] [--delay-ms 20] [--output .state/preflight-benchmark.json]

Requires Anvil and installed local JS dependencies. Each binary must emit
mint_preflight.preparationMs measured from finalize_batch entry to its event.
Deploys fixtures only to a fresh local Anvil, then performs public quantity10
dry runs without keys or broadcasts. Reports baseline and new concurrency1/4.
The fixed injected delay is a controlled experiment, not an AWS latency claim.`;

function parse(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const options = { samples: 5, 'delay-ms': 20 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2), value = args[index + 1];
    if (!args[index]?.startsWith('--') || !['before', 'after', 'samples', 'delay-ms', 'output'].includes(key)
      || seen.has(key) || !value || value.startsWith('--')) throw new Error('Invalid or duplicate option.');
    seen.add(key); options[key] = value;
  }
  for (const [key, min, max] of [['samples', 1, 20], ['delay-ms', 1, 100]]) {
    if (!/^\d+$/.test(String(options[key]))) throw new Error(`Invalid --${key}.`);
    options[key] = Number(options[key]);
    if (options[key] < min || options[key] > max) throw new Error(`--${key} must be ${min}..${max}.`);
  }
  if (!options.before || !options.after) throw new Error('--before and --after are required.');
  for (const key of ['before', 'after']) options[key] = resolve(options[key]);
  if (options.before === options.after) throw new Error('Use separate baseline and new binary paths.');
  options.output = resolve(options.output ?? `.state/preflight-benchmark-${Date.now()}.json`);
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (!options) { console.log(usage); process.exitCode = 0; }
  else {
    await Promise.all([access(options.before), access(options.after)]);
    try { await lstat(options.output); throw new Error('Output already exists; choose a fresh report path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(options.output), { recursive: true });
    console.log(`Local Anvil: 10 children, ${options['delay-ms']} ms/read RPC; ${options.samples} samples per variant.`);
    const child = spawn(process.execPath, ['--test', '--test-name-pattern',
      '^Rust CLI local preflight benchmark$', 'test/rust-genesis-minter-evm.test.mjs'], {
      cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env,
        VINOS_PREFLIGHT_BENCHMARK: JSON.stringify(options), RUST_GENESIS_MINTER_BIN: options.after },
    });
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const code = await new Promise((resolveCode, reject) => {
      child.once('error', reject); child.once('close', (status, signal) => resolveCode(signal ? 1 : status));
    });
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (code !== 0) throw new Error(`Benchmark failed (exit ${code}); incomplete results are not reported as success.`);
    const report = JSON.parse(await readFile(options.output, 'utf8'));
    if (report.completed !== true) throw new Error('Benchmark did not complete.');
    console.table(report.summary.map(({ variant, preparationMs, maxReadConcurrency }) => ({ variant,
      samples: preparationMs.count, 'p50 ms': preparationMs.p50.toFixed(1),
      'p95 ms': preparationMs.p95.toFixed(1), 'p99 ms': preparationMs.p99.toFixed(1), maxReadConcurrency })));
    console.log('Only 1–20 samples: p95/p99 are the maximum or near-maximum, not reliable production tail estimates.');
    console.log(`Observed median speedup baseline/new4: ${report.medianSpeedup.toFixed(2)}x.`);
    console.log(`Report: ${options.output}`);
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
