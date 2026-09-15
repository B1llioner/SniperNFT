import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, access, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAzArgs, resolveAzOptions } from '../az-benchmark.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'az-benchmark.mjs');
const SECRET = 'synthetic-not-a-key-or-query-token';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'az-cli-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function startCli(t, args, entry = ENTRY, cwd = ROOT) {
  // Do not inherit wallet, cloud credentials or proxy settings into the fixture.
  const child = spawn(process.execPath, [entry, ...args], {
    cwd, env: { PATH: process.env.PATH, PRIVATE_KEY: SECRET }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const events = new EventEmitter();
  child.stdout.on('data', bytes => { stdout += bytes; events.emit('output'); });
  child.stderr.on('data', bytes => { stderr += bytes; events.emit('output'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveDone({ code, signal, stdout, stderr });
      events.emit('finished');
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
  });
  return {
    child, done,
    async outputMatches(pattern) {
      while (!pattern.test(stdout + stderr)) {
        if (child.exitCode !== null || child.signalCode !== null) assert.fail(`CLI exited before expected output: ${stdout}${stderr}`);
        await Promise.race([once(events, 'output'), once(events, 'finished')]);
      }
    },
  };
}

async function server(t, respond) {
  const requests = [];
  const sockets = new Set();
  const failures = [];
  const instance = http.createServer(async (request, response) => {
    try {
      let text = '';
      for await (const bytes of request) text += bytes;
      const payload = JSON.parse(text);
      requests.push({ payload, url: request.url, socket: request.socket, at: Date.now() });
      if (respond) await respond(request, response, payload);
      else response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: null }));
    } catch (error) { failures.push(error.message); response.destroy(); }
  });
  instance.keepAliveTimeout = 10_000;
  instance.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => instance.close(resolveClose));
    assert.deepEqual(failures, []);
  });
  return { requests, sockets, endpoint: `http://127.0.0.1:${instance.address().port}/health?token=${SECRET}` };
}

function probeArgs(endpoint, output, overrides = {}) {
  const options = {
    label: 'local', endpoint, 'duration-seconds': '1', 'interval-ms': '250', 'cold-interval-ms': '5000',
    'timeout-ms': '200', 'warmup-samples': '1', 'progress-interval-seconds': '1',
    'zone-id': 'use2-az1', 'zone-name': 'us-east-2a', region: 'us-east-2', output, ...overrides,
  };
  return ['probe', ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)])];
}

async function report(path) { return JSON.parse(await readFile(path, 'utf8')); }

test('actual AZ CLI measures a full short window with warm reuse, cold connections and safe metadata', async t => {
  const dir = await directory(t);
  const rpc = await server(t);
  const output = join(dir, 'report.json');
  const result = await startCli(t, probeArgs(rpc.endpoint, output)).done;
  assert.equal(result.code, 0, result.stderr);
  const saved = await report(output);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.kind, 'sequencer-az-probe');
  assert.equal(saved.completed, true);
  assert.equal(saved.label, 'local');
  assert.equal(saved.endpointOrigin, new URL(rpc.endpoint).origin);
  assert.equal(saved.endpointId, createHash('sha256').update(new URL(rpc.endpoint).href).digest('hex'));
  assert.equal(saved.protocol, 'http/1.1');
  assert.equal(saved.method, 'arb_checkPublisherHealth');
  assert.equal(saved.family, 4);
  assert.equal(saved.zoneId, 'use2-az1');
  assert.equal(saved.zoneName, 'us-east-2a');
  assert.equal(saved.region, 'us-east-2');
  assert.equal(saved.placementSource, 'user');
  assert.equal(saved.host.nodeVersion, process.version);
  assert.ok(saved.host.cpuCount > 0);
  assert.ok(Date.parse(saved.finishedAt) - Date.parse(saved.startedAt) >= 990);
  assert.equal(saved.warmup.attempted, 1);
  assert.equal(saved.warmup.success, 1);
  assert.ok(saved.samples.length >= 4);
  assert.equal(saved.summary.groups.warmReused.counts.success >= 3, true);
  assert.equal(saved.summary.groups.warmReconnect.counts.attempted, 0);
  assert.equal(saved.summary.groups.cold.counts.success, 1);
  assert.ok(saved.summary.groups.warmReused.metrics.total.p95Ms >= 0);
  assert.equal(saved.summary.groups.warmReused.metrics.tls.count, 0);
  assert.equal(saved.summary.groups.warmReused.ips['127.0.0.1'] >= 3, true);
  assert.ok(saved.samples.filter(sample => sample.kind === 'warm').every(sample => sample.reusedSocket));
  assert.ok(saved.samples.filter(sample => sample.kind === 'cold').every(sample => !sample.reusedSocket && !sample.tlsSessionReused));
  assert.ok(saved.samples.every(sample => Date.parse(sample.timestamp) >= Date.parse(saved.startedAt)));
  assert.ok(saved.runtime.eventLoopDelayP95Ms >= 0);
  assert.equal(rpc.requests.length, saved.samples.length + saved.warmup.attempted);
  assert.ok(rpc.requests.every(request => request.payload.method === 'arb_checkPublisherHealth' && request.payload.params.length === 0));
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
  assert.equal((result.stdout + result.stderr).includes(SECRET), false);
  assert.match(result.stdout, /p95 ms/);
  assert.match(result.stdout, /p99 ms/);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('CLI prints sanitized HTTP errors and exits unsuccessfully when every health probe fails', async t => {
  const dir = await directory(t);
  const rpc = await server(t, (_request, response) => {
    response.writeHead(429, { 'retry-after': '0' }); response.end(`do not print ${SECRET}`);
  });
  const output = join(dir, 'failed.json');
  const result = await startCli(t, probeArgs(rpc.endpoint, output)).done;
  assert.equal(result.code, 1);
  const saved = await report(output);
  assert.equal(saved.completed, true);
  assert.equal(saved.summary.counts.success, 0);
  assert.ok(saved.samples.every(sample => sample.errorCode === 'HTTP_429'));
  assert.equal(saved.summary.groups.warmReconnect.metrics.total.p95Ms, null);
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
  assert.equal((result.stdout + result.stderr).includes(SECRET), false);
  assert.match(result.stdout, /HTTP_429/);
  assert.equal(rpc.requests.length, saved.samples.length + saved.warmup.attempted);
});

test('existing probe outputs are preserved and no requests are sent', async t => {
  const dir = await directory(t);
  const rpc = await server(t);
  const output = join(dir, 'existing.json');
  await writeFile(output, 'existing report');
  const result = await startCli(t, probeArgs(rpc.endpoint, output)).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exclusively/);
  assert.equal(await readFile(output, 'utf8'), 'existing report');
  assert.equal(rpc.requests.length, 0);
});

test('Ctrl+C saves a partial report and closes active keep-alive connections', async t => {
  const dir = await directory(t);
  const rpc = await server(t);
  const output = join(dir, 'interrupted.json');
  const execution = startCli(t, probeArgs(rpc.endpoint, output, { 'duration-seconds': '30' }));
  await execution.outputMatches(/reused N=/);
  const checkpoint = await report(output);
  assert.ok(checkpoint.samples.length > 0);
  const socketsClosed = [...rpc.sockets].map(socket => once(socket, 'close'));
  execution.child.kill('SIGINT');
  const result = await execution.done;
  await Promise.all(socketsClosed);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null);
  const saved = await report(output);
  assert.equal(saved.completed, false);
  assert.equal(saved.stopReason, 'cancelled');
  assert.ok(saved.samples.length >= checkpoint.samples.length);
  assert.ok(Date.parse(saved.finishedAt) - Date.parse(saved.startedAt) < 30_000);
  assert.equal(rpc.sockets.size, 0);
  assert.match(result.stdout, /Incomplete: cancelled/);
});

test('shared UTC start waits before measurement; two short reports compare without selecting a candidate', async t => {
  const dir = await directory(t);
  const rpc = await server(t);
  const startAt = new Date(Date.now() + 1500).toISOString();
  const paths = [join(dir, 'a.json'), join(dir, 'b.json')];
  const executions = paths.map((path, index) => startCli(t, probeArgs(rpc.endpoint, path, {
    label: index === 0 ? 'ohio-a' : 'ohio-b', 'zone-id': `use2-az${index + 1}`,
    'zone-name': index === 0 ? 'us-east-2a' : 'us-east-2b', 'start-at': startAt,
  })));
  for (const result of await Promise.all(executions.map(execution => execution.done))) assert.equal(result.code, 0, result.stderr);
  for (const path of paths) {
    const saved = await report(path);
    assert.equal(saved.scheduledStartAt, startAt);
    assert.ok(Date.parse(saved.startedAt) >= Date.parse(startAt));
    assert.ok(saved.samples.every(sample => Date.parse(sample.timestamp) >= Date.parse(startAt)));
  }
  const comparisonPath = join(dir, 'comparison.json');
  const compared = await startCli(t, ['compare', ...paths, '--output', comparisonPath]).done;
  assert.equal(compared.code, 2, compared.stderr);
  const comparison = await report(comparisonPath);
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.provisionalCandidate, null);
  assert.equal(comparison.rows.length, 2);
  assert.ok(comparison.rows.every(row => row.rank === null && row.summary.groups.warmReused.counts.success > 0));
  assert.match(compared.stdout, /Provisional candidate: none/);
  assert.match(compared.stdout, /p95 ms/);

  const changed = await report(paths[1]);
  changed.endpointId = 'f'.repeat(64);
  const mismatchPath = join(dir, 'mismatch.json');
  await writeFile(mismatchPath, JSON.stringify(changed));
  const mismatchOutput = join(dir, 'must-not-exist.json');
  const mismatch = await startCli(t, ['compare', paths[0], mismatchPath, '--output', mismatchOutput]).done;
  assert.equal(mismatch.code, 1);
  await assert.rejects(access(mismatchOutput), { code: 'ENOENT' });
  assert.match(mismatch.stderr, /malformed or incompatible/);

  const malformedPath = join(dir, 'malformed.json');
  await writeFile(malformedPath, '{ malformed');
  const malformed = await startCli(t, ['compare', paths[0], malformedPath, '--output', comparisonPath]).done;
  assert.equal(malformed.code, 1);
  assert.deepEqual(await report(comparisonPath), comparison);
  const duplicateOutput = await startCli(t, ['compare', ...paths, '--output', comparisonPath]).done;
  assert.equal(duplicateOutput.code, 1);
  assert.deepEqual(await report(comparisonPath), comparison);
});

test('help and invalid config never contact a configured endpoint', async t => {
  const dir = await directory(t);
  const rpc = await server(t);
  const help = await startCli(t, ['probe', '--help', '--endpoint', rpc.endpoint]).done;
  assert.equal(help.code, 0);
  assert.match(help.stdout, /read-only; no wallet/);
  assert.equal(help.stdout.includes(SECRET), false);
  const configPath = join(dir, 'invalid-config.json');
  await writeFile(configPath, JSON.stringify({ endpoint: rpc.endpoint, privateKey: SECRET }));
  const output = join(dir, 'no-report.json');
  const invalid = await startCli(t, ['probe', '--config', configPath, '--label', 'local', '--output', output]).done;
  assert.equal(invalid.code, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(SECRET), false);
  assert.equal(rpc.requests.length, 0);
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('AZ parser and config enforce bounded measurement rates, labels, placement and UTC scheduling', () => {
  const base = parseAzArgs(['probe', '--label', 'local']);
  const resolved = resolveAzOptions(base);
  assert.equal(resolved.settings.durationSeconds, 1800);
  assert.equal(resolved.settings.intervalMs, 1000);
  assert.equal(resolved.endpoint, 'https://sequencer.mainnet.chain.robinhood.com/');
  assert.equal(resolved.family, 4);
  assert.equal(resolveAzOptions({ ...base, 'interval-ms': '500' }, { intervalMs: 1000 }).settings.intervalMs, 500);
  for (const [key, value] of [
    ['duration-seconds', '0'], ['duration-seconds', '7201'], ['interval-ms', '249'],
    ['cold-interval-ms', '4999'], ['timeout-ms', '99'], ['timeout-ms', '20001'],
    ['warmup-samples', '21'], ['progress-interval-seconds', '0'], ['family', '5'],
    ['label', 'label\ncontrol'], ['label', '../path'], ['start-at', '2020-01-01T00:00:00Z'],
    ['start-at', '2026-09-16T00:00:00+03:00'], ['endpoint', 'http://example.com'],
    ['endpoint', 'https://user:secret@example.com'],
  ]) assert.throws(() => resolveAzOptions({ ...base, [key]: value }), undefined, key);
  assert.throws(() => resolveAzOptions({ ...base, ec2: true, 'zone-id': 'use2-az1' }), /manual/);
  assert.throws(() => parseAzArgs(['probe', '--label', 'x', '--label', 'y']), /Duplicate/);
  assert.throws(() => parseAzArgs(['probe', '--send']), /Unknown/);
  assert.throws(() => parseAzArgs(['compare', 'one.json']), /between 2/);
  assert.throws(() => parseAzArgs(['aws-template', '--ec2']), /only to probe/);
});

test('bundle contains only allowed files, verifies its manifest and runs without installed dependencies', async t => {
  const dir = await directory(t);
  const archive = join(dir, 'az-benchmark.tgz');
  const result = await startCli(t, ['bundle', '--output', archive]).done;
  assert.equal(result.code, 0, result.stderr);
  const expected = ['az-benchmark.mjs', 'az-benchmark.config.example.json', 'lib/az-probe.mjs', 'lib/az-comparison.mjs', 'AZ_BENCHMARK.md',
    'AWS_AZ_BENCHMARK.md', 'infra/az-benchmark.template.json', 'package.json', 'MANIFEST.json'].sort();
  const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, expected);
  assert.ok(listed.every(path => !/(^|\/)(\.env|\.state|node_modules)(\/|$)/.test(path)));
  const extracted = join(dir, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const manifest = await report(join(extracted, 'MANIFEST.json'));
  assert.equal(manifest.kind, 'dependency-free-az-benchmark');
  for (const [path, hash] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(extracted, path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    assert.equal(bytes.toString('utf8').includes(SECRET), false);
  }
  const pkg = await report(join(extracted, 'package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const help = await startCli(t, ['--help'], join(extracted, 'az-benchmark.mjs'), extracted).done;
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Sequencer AWS AZ benchmark/);
  const before = await readFile(archive);
  assert.equal((await startCli(t, ['bundle', '--output', archive]).done).code, 1);
  assert.deepEqual(await readFile(archive), before);
});

test('aws-template only emits the local template and preserves existing output files', async t => {
  const dir = await directory(t);
  const source = await readFile(join(ROOT, 'infra/az-benchmark.template.json'), 'utf8');
  const printed = await startCli(t, ['aws-template']).done;
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stdout, source);
  const output = join(dir, 'template.json');
  const copied = await startCli(t, ['aws-template', '--output', output]).done;
  assert.equal(copied.code, 0, copied.stderr);
  assert.equal(await readFile(output, 'utf8'), source);
  await writeFile(output, 'existing template');
  const repeated = await startCli(t, ['aws-template', '--output', output]).done;
  assert.equal(repeated.code, 1);
  assert.equal(await readFile(output, 'utf8'), 'existing template');
});
