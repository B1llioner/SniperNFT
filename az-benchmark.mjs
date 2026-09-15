#!/usr/bin/env node
import { open, mkdir, rename, unlink, lstat, mkdtemp, rm, copyFile, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAzProbe } from './lib/az-probe.mjs';
import { summarizeAzSamples, compareAzReports, formatAzSummary, formatAzComparison } from './lib/az-comparison.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SEQUENCER = 'https://sequencer.mainnet.chain.robinhood.com';
const execFileAsync = promisify(execFile);
class AzCliError extends Error {}
const check = (condition, message) => { if (!condition) throw new AzCliError(message); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const safeError = error => error instanceof AzCliError ? error.message : 'AZ benchmark failed. Check settings, file permissions and network availability.';
const CONFIG_KEYS = new Set(['endpoint', 'durationSeconds', 'intervalMs', 'coldIntervalMs', 'timeoutMs', 'family', 'warmupSamples', 'progressIntervalSeconds']);

export function parseAzArgs(argv) {
  const tokens = [...argv];
  const args = { files: [] };
  if (tokens[0] && !tokens[0].startsWith('--')) args.command = tokens.shift();
  const flags = new Set(['help', 'ec2']);
  const values = new Set(['config', 'endpoint', 'label', 'zone-id', 'zone-name', 'region', 'start-at', 'output',
    'duration-seconds', 'interval-ms', 'cold-interval-ms', 'timeout-ms', 'family', 'warmup-samples', 'progress-interval-seconds']);
  for (let index = 0; index < tokens.length; index++) {
    if (!tokens[index].startsWith('--')) {
      check(args.command === 'compare' && args.files.length < 32, 'Only compare accepts positional report paths (up to 32).');
      args.files.push(tokens[index]); continue;
    }
    const key = tokens[index].slice(2);
    check(!(key in args), 'Duplicate AZ benchmark option.');
    if (flags.has(key)) args[key] = true;
    else {
      check(values.has(key) && tokens[index + 1] && !tokens[index + 1].startsWith('--'), 'Unknown AZ option or missing value; see --help.');
      args[key] = tokens[++index];
    }
  }
  if (args.help) return args;
  check(['probe', 'compare', 'bundle', 'aws-template'].includes(args.command), 'Choose probe, compare, bundle or aws-template; see --help.');
  if (args.command !== 'probe') check(Object.keys(args).every(key => ['command', 'files', 'output'].includes(key)), 'Probe settings apply only to probe.');
  if (args.command === 'compare') check(args.files.length >= 2, 'Provide between 2 and 32 reports to compare.');
  if (args.command === 'bundle') check(args.output, 'Bundle requires a new --output archive path.');
  return args;
}

async function readBounded(path, limit) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= limit, 'Input must be a regular file within its size limit.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    check(offset <= limit && offset <= stat.size, 'Input grew while it was being read.');
    return bytes.subarray(0, offset);
  } catch (error) { if (error instanceof AzCliError) throw error; throw new AzCliError('Cannot read the requested local file.'); }
  finally { await handle?.close(); }
}
async function readJson(path, limit = 65536) {
  const bytes = await readBounded(resolve(path), limit);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new AzCliError('Input is not a valid JSON report/config.'); }
}

export function resolveAzOptions(args, config = {}) {
  check(config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).every(key => CONFIG_KEYS.has(key)),
    'Use the dedicated AZ JSON config with supported fields.');
  const number = (value, min, max, name) => {
    check((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)), `${name} must be an integer.`);
    const result = Number(value);
    check(Number.isSafeInteger(result) && result >= min && result <= max, `${name} is outside the supported range.`);
    return result;
  };
  check(typeof args.label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(args.label), 'Provide --label with 1–64 letters, digits, dots, underscores or hyphens.');
  const endpoint = args.endpoint ?? config.endpoint ?? SEQUENCER;
  let url;
  try { url = new URL(endpoint); } catch { throw new AzCliError('Invalid sequencer endpoint URL.'); }
  check(typeof endpoint === 'string' && !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
  'Use HTTPS, or HTTP on localhost for tests, without URL credentials or a fragment.');
  const placement = {};
  for (const [flag, field] of [['zone-id', 'zoneId'], ['zone-name', 'zoneName'], ['region', 'region']]) {
    if (args[flag] !== undefined) {
      check(typeof args[flag] === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(args[flag]), 'Invalid zone/region label.');
      placement[field] = args[flag];
    }
  }
  check(!args.ec2 || Object.keys(placement).length === 0, 'Use --ec2 or manual zone/region flags, not both.');
  let scheduledStartAt;
  if (args['start-at']) {
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(args['start-at']), '--start-at must be an ISO UTC timestamp ending in Z.');
    const value = Date.parse(args['start-at']);
    check(Number.isFinite(value) && value > Date.now() && value <= Date.now() + 86400000, '--start-at must be in the next 24 hours.');
    scheduledStartAt = new Date(value).toISOString();
  }
  const family = number(args.family ?? config.family ?? 4, 0, 6, 'family');
  check([0, 4, 6].includes(family), 'family must be 0, 4 or 6.');
  return { label: args.label, endpoint: url.href,
    endpointId: createHash('sha256').update(url.href).digest('hex'), endpointOrigin: url.origin, family,
    settings: {
      durationSeconds: number(args['duration-seconds'] ?? config.durationSeconds ?? 1800, 1, 7200, 'durationSeconds'),
      intervalMs: number(args['interval-ms'] ?? config.intervalMs ?? 1000, 250, 60000, 'intervalMs'),
      coldIntervalMs: number(args['cold-interval-ms'] ?? config.coldIntervalMs ?? 30000, 5000, 300000, 'coldIntervalMs'),
      timeoutMs: number(args['timeout-ms'] ?? config.timeoutMs ?? 5000, 100, 20000, 'timeoutMs'),
      warmupSamples: number(args['warmup-samples'] ?? config.warmupSamples ?? 5, 0, 20, 'warmupSamples'),
    }, progressIntervalSeconds: number(args['progress-interval-seconds'] ?? config.progressIntervalSeconds ?? 30, 1, 300, 'progressIntervalSeconds'),
    scheduledStartAt, ec2: Boolean(args.ec2), placement };
}

/** Only explicit placement metadata paths are allowed. No IAM credential paths. */
async function ec2Placement(signal) {
  async function request(method, path, headers = {}) {
    return new Promise((resolveRequest, reject) => {
      const req = http.request({ host: '169.254.169.254', port: 80, method, path, headers, agent: false });
      let finished = false, response;
      const timer = setTimeout(() => end(new AzCliError('IMDSv2 metadata request timed out. Use --ec2 only on an EC2 instance.')), 1500);
      const abort = () => end(new AzCliError('Metadata request cancelled.'));
      function end(error, value) {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) { req.destroy(); response?.destroy(); reject(error); } else resolveRequest(value);
      }
      signal.addEventListener('abort', abort, { once: true });
      req.once('error', () => end(new AzCliError('Cannot read EC2 placement via IMDSv2.')));
      req.once('response', incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) { end(new AzCliError('IMDSv2 returned an unsuccessful status.')); return; }
        let size = 0; const chunks = [];
        incoming.on('data', chunk => { size += chunk.length; if (size > 4096) end(new AzCliError('IMDSv2 response exceeds the size limit.')); else chunks.push(chunk); });
        incoming.once('error', () => end(new AzCliError('EC2 metadata response failed.')));
        incoming.once('aborted', () => end(new AzCliError('EC2 metadata response was interrupted.')));
        incoming.once('end', () => end(null, Buffer.concat(chunks).toString('utf8').trim()));
      });
      if (signal.aborted) abort(); else req.end();
    });
  }
  const token = await request('PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
  const entries = [['region', 'placement/region'], ['zoneName', 'placement/availability-zone'], ['zoneId', 'placement/availability-zone-id'], ['instanceType', 'instance-type']];
  const values = await Promise.all(entries.map(async ([key, path]) => {
    const value = await request('GET', `/latest/meta-data/${path}`, { 'X-aws-ec2-metadata-token': token });
    check(/^[a-z0-9][a-z0-9.-]{1,39}$/.test(value), 'EC2 placement returned invalid metadata.');
    return [key, value];
  }));
  return Object.fromEntries(values);
}

async function reportWriter(path) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new AzCliError('Cannot create output exclusively. Use a new path in an existing directory.'); }
  let identity = await handle.stat(); await handle.close();
  return async report => {
    // Freeze a consistent checkpoint before I/O yields to the sampling workers.
    const serialized = json(report);
    const current = await lstat(path);
    check(current.isFile() && current.ino === identity.ino && current.dev === identity.dev, 'Output file changed outside this process.');
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
      await rename(temporary, path); identity = await lstat(path);
    } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
  };
}

async function exclusiveFile(path, bytes) {
  let handle;
  try { handle = await open(resolve(path), 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); }
  catch { throw new AzCliError('Cannot create output exclusively. Choose a new path in an existing directory.'); }
  finally { await handle?.close(); }
}

async function probeCommand(args) {
  const config = args.config ? await readJson(args.config) : {};
  const options = resolveAzOptions(args, config);
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  let probe, reporter;
  let interrupted = false;
  const cancel = () => { cancellation.abort(); probe?.close(); };
  const interrupt = () => { interrupted = true; cancel(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let report, eventLoop;
  let reportTimestamp = () => new Date().toISOString();
  const alive = () => check(!signal.aborted, 'AZ probe cancelled. Partial observations were saved.');
  const delay = async milliseconds => { if (milliseconds > 0) await sleep(milliseconds, undefined, { signal }); alive(); };
  try {
    let placement = options.placement;
    if (options.ec2) placement = await ec2Placement(signal);
    const directory = resolve(ROOT, '.state', 'az-benchmarks');
    if (!args.output) await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = args.output ? resolve(args.output) : resolve(directory, `${options.label}-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
    reporter = await reportWriter(path);
    const cpu = cpus();
    const createdAt = new Date().toISOString();
    report = { schemaVersion: 1, kind: 'sequencer-az-probe', runId: randomBytes(16).toString('hex'), label: options.label,
      endpointId: options.endpointId, endpointOrigin: options.endpointOrigin, family: options.family,
      protocol: 'http/1.1', method: 'arb_checkPublisherHealth', settings: options.settings,
      scheduledStartAt: options.scheduledStartAt, createdAt, startedAt: createdAt, finishedAt: createdAt,
      zoneId: placement.zoneId, zoneName: placement.zoneName, region: placement.region, placementSource: options.ec2 ? 'imds-v2' : 'user',
      host: { nodeVersion: process.version, platform: platform(), arch: arch(), cpuModel: cpu[0]?.model ?? 'unknown', cpuCount: cpu.length, instanceType: placement.instanceType },
      completed: false, samples: [], skippedSlots: { warm: 0, cold: 0 }, warmup: { attempted: 0, success: 0, failed: 0 } };
    await reporter(report);
    console.log(`Probe ${options.label}: ${options.settings.durationSeconds}s, warm every ${options.settings.intervalMs}ms, cold every ${options.settings.coldIntervalMs}ms. Output: ${path}`);
    if (report.zoneId) console.log(`Placement: ${report.region ?? 'unspecified'} / ${report.zoneName ?? 'unspecified'} / ${report.zoneId} (${report.placementSource}).`);
    probe = createAzProbe({ endpoint: options.endpoint, timeoutMs: options.settings.timeoutMs, family: options.family });
    const warmup = async () => {
      const begin = performance.now();
      const result = await probe.warm();
      report.warmup.attempted++; report.warmup[result.ok ? 'success' : 'failed']++;
      await delay(Math.max(0, options.settings.intervalMs - (performance.now() - begin)));
    };
    for (let index = 0; index < options.settings.warmupSamples; index++) { alive(); await warmup(); }
    if (options.scheduledStartAt) {
      const target = Date.parse(options.scheduledStartAt);
      check(Date.now() <= target, 'Scheduled start passed during setup/warmup. Pick a later shared --start-at.');
      console.log(`Ready; waiting for shared UTC start ${options.scheduledStartAt}.`);
      while (target - Date.now() > options.settings.timeoutMs + options.settings.intervalMs) { alive(); await warmup(); }
      await delay(Math.max(0, target - Date.now()));
    }
    alive();
    const wallStart = Date.now();
    const monotonicStart = performance.now();
    const deadline = monotonicStart + options.settings.durationSeconds * 1000;
    report.startedAt = new Date(wallStart).toISOString();
    const timestamp = () => new Date(wallStart + (performance.now() - monotonicStart)).toISOString();
    reportTimestamp = timestamp;
    eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
    const cpuStart = process.cpuUsage();
    let done = false;
    const tasks = ['warm', 'cold'].map(async kind => {
      const interval = kind === 'warm' ? options.settings.intervalMs : options.settings.coldIntervalMs;
      let next = monotonicStart + (kind === 'cold' ? Math.min(options.settings.intervalMs / 2, options.settings.durationSeconds * 250) : 0);
      while (next < deadline && !signal.aborted) {
        await delay(Math.max(0, next - performance.now()));
        if (performance.now() >= deadline || signal.aborted) break;
        const at = timestamp();
        const sample = await probe[kind]();
        report.samples.push({ ...sample, kind, timestamp: at });
        next += interval;
        if (next < performance.now()) {
          const skipped = Math.floor((Math.min(performance.now(), deadline) - next) / interval) + 1;
          report.skippedSlots[kind] += Math.max(0, skipped); next += Math.max(0, skipped) * interval;
        }
      }
    });
    const progress = async () => {
      while (!done && !signal.aborted) {
        await delay(Math.min(options.progressIntervalSeconds * 1000, Math.max(1, deadline - performance.now())));
        if (done || performance.now() >= deadline) break;
        report.finishedAt = timestamp();
        report.summary = summarizeAzSamples(report.samples, report);
        await reporter(report);
        const group = report.summary.groups.warmReused;
        const metric = group.metrics.total;
        console.log(`${options.label}: reused N=${metric.count}, p50=${metric.p50Ms ?? 'n/a'}ms p95=${metric.p95Ms ?? 'n/a'}ms p99=${metric.p99Ms ?? 'n/a'}ms, warm errors=${report.summary.groups.warmReused.counts.failed + report.summary.groups.warmReconnect.counts.failed}.`);
      }
    };
    let progressFailure;
    const progressTask = progress().catch(error => {
      progressFailure = error;
      if (!signal.aborted) cancel();
    });
    let settled;
    try { settled = await Promise.allSettled(tasks); }
    finally { done = true; await progressTask; }
    if (progressFailure && !(progressFailure?.name === 'AbortError')) throw progressFailure;
    alive();
    check(settled.every(result => result.status === 'fulfilled'), 'A probe worker failed; partial measurements were saved.');
    // Record the full planned window even when the last scheduled sample ends early.
    await delay(Math.max(0, deadline - performance.now()));
    report.finishedAt = timestamp();
    const wallExpected = wallStart + (performance.now() - monotonicStart);
    report.wallClockDriftMs = Math.round(Date.now() - wallExpected);
    const usage = process.cpuUsage(cpuStart);
    report.runtime = { cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
      eventLoopDelayP95Ms: eventLoop.percentile(95) / 1e6, eventLoopDelayMaxMs: eventLoop.max / 1e6 };
    report.completed = true;
  } catch (error) {
    if (report) report.stopReason = interrupted ? 'cancelled' : safeError(error);
    if (!interrupted) throw error;
  } finally {
    eventLoop?.disable(); probe?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (report) {
      if (!report.completed) report.finishedAt = reportTimestamp();
      report.summary = summarizeAzSamples(report.samples, report);
      await reporter(report);
      console.log(formatAzSummary(report.summary, report.label));
      if (!report.completed) console.log(`Incomplete: ${report.stopReason ?? 'stopped'}.`);
    }
  }
  const success = report?.summary.groups.warmReused.counts.success + report?.summary.groups.warmReconnect.counts.success;
  return { exitCode: report?.completed && success > 0 ? 0 : 1, report };
}

async function bundleCommand(output) {
  const staging = await mkdtemp(resolve(tmpdir(), 'vinos-az-bundle-'));
  try {
    const files = ['az-benchmark.mjs', 'az-benchmark.config.example.json', 'lib/az-probe.mjs', 'lib/az-comparison.mjs', 'AZ_BENCHMARK.md', 'AWS_AZ_BENCHMARK.md', 'infra/az-benchmark.template.json'];
    const hashes = {};
    for (const file of files) {
      await mkdir(dirname(resolve(staging, file)), { recursive: true });
      await copyFile(resolve(ROOT, file), resolve(staging, file));
      hashes[file] = createHash('sha256').update(await readBounded(resolve(staging, file), 1024 * 1024)).digest('hex');
    }
    const packageData = { name: 'sequencer-az-probe', version: '1.0.0', private: true, type: 'module', engines: { node: '>=18.18' }, scripts: { 'benchmark:az': 'node az-benchmark.mjs' } };
    await exclusiveFile(resolve(staging, 'package.json'), json(packageData));
    await exclusiveFile(resolve(staging, 'MANIFEST.json'), json({ kind: 'dependency-free-az-benchmark', files: hashes }));
    const { stdout } = await execFileAsync('tar', ['-czf', '-', '-C', staging, ...files, 'package.json', 'MANIFEST.json'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    await exclusiveFile(output, stdout);
    console.log(json({ bundle: resolve(output), bytes: stdout.length, sha256: createHash('sha256').update(stdout).digest('hex'), files: [...files, 'package.json', 'MANIFEST.json'] }));
    return { exitCode: 0 };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

const HELP = `Sequencer AWS AZ benchmark (read-only; no wallet, signature or transaction)
  npm run benchmark:az -- probe --label ohio-a --ec2 --duration-seconds 1800 --output a.json
  npm run benchmark:az -- compare a.json b.json c.json
  npm run benchmark:az -- bundle --output az-benchmark.tgz
  npm run benchmark:az -- aws-template --output az-benchmark.template.json
probe:
  --label NAME                 Required unique report label.
  --ec2                        Read region/AZ/Zone ID/instance type via IMDSv2.
  --zone-id ID --zone-name NAME --region REGION  Optional manual placement instead.
  --start-at ISO_UTC            Shared start in the next 24h, e.g. YYYY-MM-DDTHH:mm:ssZ.
  --endpoint URL               Same send endpoint everywhere; default official Robinhood sequencer.
  --duration-seconds N          Default 1800 (30min), 1..7200.
  --interval-ms N               Warm health interval, default 1000, 250..60000.
  --cold-interval-ms N          Separate fresh-connection probes, default 30000, 5000..300000.
  --timeout-ms N                Absolute request deadline, default 5000, 100..20000.
  --family N                    IP family 4 (default), 6 or 0 (system selection).
  --warmup-samples N            Initial warm requests excluded from measurements, default 5, 0..20.
  --progress-interval-seconds N Default 30, 1..300.
  --config FILE                Dedicated AZ JSON config; flags override it.
  --output FILE                New report (0600), default .state/az-benchmarks/*.json.
compare: 2..32 reports; optional --output FILE. Rejects incompatible settings/endpoint.
  Rank only eligible runs with sufficient common time, samples, coverage and socket reuse.
  Exit 2 means no comparable ranking; statistics and reasons are still printed.
bundle: creates an allowlisted dependency-free tarball. No .env, keys, node_modules or live sender.
aws-template: emit CloudFormation template; never calls AWS or creates paid resources.
Health RTT/TCP/TLS are not actual transaction arrival, block inclusion or finality measurements.`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseAzArgs(argv);
  if (args.help) { console.log(HELP); return { exitCode: 0 }; }
  if (args.command === 'probe') return probeCommand(args);
  if (args.command === 'bundle') return bundleCommand(args.output);
  if (args.command === 'aws-template') {
    const template = await readBounded(resolve(ROOT, 'infra/az-benchmark.template.json'), 1024 * 1024);
    if (args.output) { await exclusiveFile(args.output, template); console.log(`Template saved: ${resolve(args.output)}`); }
    else process.stdout.write(template);
    return { exitCode: 0 };
  }
  const reports = await Promise.all(args.files.map(path => readJson(path, 32 * 1024 * 1024)));
  let comparison;
  try { comparison = compareAzReports(reports); }
  catch { throw new AzCliError('Reports are malformed or incompatible. Use the same endpoint, IP family, protocol and measurement settings.'); }
  if (args.output) await exclusiveFile(args.output, json(comparison));
  console.log(formatAzComparison(comparison));
  return { exitCode: comparison.comparable ? 0 : 2, comparison };
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().then(result => { process.exitCode = result.exitCode; }, error => { console.error(`Error: ${safeError(error)}`); process.exitCode = 1; });
}
