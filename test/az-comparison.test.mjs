import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareAzReports, formatAzComparison, formatAzSummary, summarizeAzSamples,
} from '../lib/az-comparison.mjs';

const BASE = Date.parse('2026-09-16T12:00:00.000Z');
const iso = seconds => new Date(BASE + seconds * 1000).toISOString();

test('comparison requires identical routing pins and preserves old unpinned reports', () => {
  assert.equal(compareAzReports([report('a'), report('b')]).comparable, true);
  assert.equal(compareAzReports([report('a', 10, { connectIp: '192.0.2.10' }), report('b', 10, { connectIp: '192.0.2.10' })]).comparable, true);
  assert.throws(() => compareAzReports([report('a'), report('b', 10, { connectIp: '192.0.2.10' })]), /same endpoint/);
  assert.throws(() => compareAzReports([report('a', 10, { connectIp: '192.0.2.10' }), report('b', 10, { connectIp: '192.0.2.11' })]), /same endpoint/);
  assert.throws(() => compareAzReports([report('a', 10, { connectIp: 'hostname' }), report('b')]), /pinned IPv4/);
});
const sample = (seconds, total = 10, extra = {}) => ({
  kind: 'warm', timestamp: iso(seconds), ok: true, reusedSocket: true, tlsSessionReused: false,
  timingsMs: { firstByte: total / 2, total }, remoteAddress: '192.0.2.10', remoteFamily: 4, httpStatus: 200,
  ...extra,
});
function report(label, latency = 10, extra = {}) {
  const start = extra.start ?? 0;
  const duration = extra.duration ?? 200;
  const { start: _start, duration: _duration, ...overrides } = extra;
  return {
    schemaVersion: 1, kind: 'sequencer-az-probe', label, runId: `run-${label}`,
    endpointId: 'a'.repeat(64), endpointOrigin: 'https://sequencer.example.com',
    family: 4, protocol: 'http/1.1', method: 'arb_checkPublisherHealth',
    settings: { durationSeconds: duration, intervalMs: 1000, coldIntervalMs: 10_000, timeoutMs: 3000, warmupSamples: 5 },
    startedAt: iso(start), finishedAt: iso(start + duration), completed: true,
    zoneId: `use2-az${label}`, zoneName: `us-east-2${label}`, region: 'us-east-2', placementSource: 'imds-v2',
    host: { nodeVersion: 'v20.18.0', platform: 'linux', arch: 'x64', cpuModel: 'test CPU', cpuCount: 2, instanceType: 'c7i.large' },
    samples: Array.from({ length: Math.floor(duration) }, (_, index) => sample(start + index + 0.5, typeof latency === 'function' ? latency(index) : latency)),
    ...overrides,
  };
}

test('nearest-rank quantiles keep cold, reconnect and reused sockets separate', () => {
  const samples = Array.from({ length: 100 }, (_, index) => sample(index, index + 1));
  samples.push(sample(101, 500, { reusedSocket: false, timingsMs: { dns: 1, tcp: 2, tls: 3, firstByte: 450, total: 500 } }));
  samples.push(sample(102, 800, { kind: 'cold', reusedSocket: false, tlsSessionReused: true }));
  const summary = summarizeAzSamples(samples);
  assert.deepEqual(summary.groups.warmReused.metrics.total, { count: 100, minMs: 1, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100, jitterMs: 49 });
  assert.equal(summary.groups.warmReconnect.metrics.total.p99Ms, 500);
  assert.equal(summary.groups.cold.metrics.total.p99Ms, 800);
  assert.equal(summary.groups.warmReused.metrics.tcp.count, 0);
  assert.equal(summary.groups.warmReused.metrics.tcp.p99Ms, null);
  assert.equal(summary.groups.warmReconnect.metrics.tcp.p50Ms, 2);
  assert.equal(summary.groups.cold.connections.tlsSessionReused, 1);
  assert.deepEqual(summary.groups.warmReused.ips, { '192.0.2.10': 100 });
  assert.match(formatAzSummary(summary, 'Ohio A'), /p50 ms\s+p95 ms\s+p99 ms\s+max ms\s+p99-p50/);
  assert.match(formatAzSummary(summary), /warm reused\s+total\s+100\s+50\.000\s+95\.000\s+99\.000/);
});

test('timeouts remain failures and never become zero or successful tail samples', () => {
  const summary = summarizeAzSamples([
    sample(0, 4),
    sample(1, 5000, { ok: false, errorCode: 'TIMEOUT' }),
    sample(2, 10, { ok: false, reusedSocket: false, errorCode: 'ECONNRESET', timingsMs: undefined }),
    sample(3, 6, { remoteAddress: '2001:db8::1', remoteFamily: 6 }),
  ]);
  assert.deepEqual(summary.counts, { attempted: 4, success: 2, failed: 2 });
  assert.deepEqual(summary.groups.warmReused.counts, { attempted: 3, success: 2, failed: 1 });
  assert.equal(summary.groups.warmReused.metrics.total.p99Ms, 6);
  assert.deepEqual(summary.groups.warmReused.errors, { TIMEOUT: 1 });
  assert.deepEqual(summary.groups.warmReconnect.errors, { ECONNRESET: 1 });
  assert.equal(summary.groups.warmReconnect.metrics.total.minMs, null);
  assert.match(formatAzSummary(summary), /failed=1; errors=\{"TIMEOUT":1\}/);
  assert.ok(summary.warnings.some(warning => /compare availability/.test(warning)));
});

test('empty and incomplete summaries print n/a with sample-size and completion limits', () => {
  const summary = summarizeAzSamples([], { completed: false });
  assert.equal(summary.groups.warmReused.metrics.total.p95Ms, null);
  assert.equal(summary.counts.attempted, 0);
  assert.match(formatAzSummary(summary), /warm reused\s+total\s+0\s+n\/a/);
  assert.ok(summary.warnings.some(warning => /incomplete/.test(warning)));
  assert.ok(summary.warnings.some(warning => /Only 0/.test(warning)));
});

test('comparison recomputes raw samples, ranks p95 then p99, and never trusts supplied summaries', () => {
  const a = report('a', index => index < 190 ? 4 : 20);
  const b = report('b', index => index < 190 ? 4 : 30);
  const c = report('c', 5);
  b.summary = { groups: { warmReused: { metrics: { total: { p95Ms: -1000 } } } } };
  const comparison = compareAzReports([c, b, a]);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.provisionalCandidate, 'a');
  assert.deepEqual(comparison.rows.map(row => [row.label, row.rank]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.equal(comparison.rows[0].summary.groups.warmReused.metrics.total.p95Ms, 4);
  assert.equal(comparison.rows[0].summary.groups.warmReused.metrics.total.p99Ms, 20);
  assert.equal(comparison.overlap.durationSeconds, 200);
  assert.equal(comparison.overlap.fractionOfRequested, 1);
  assert.ok(comparison.warnings.some(warning => /wall clocks/.test(warning)));
  assert.match(formatAzComparison(comparison), /Provisional candidate: a/);
  assert.match(formatAzComparison(comparison), /Warm fail\s+Reuse\s+Coverage/);
  assert.ok(!JSON.stringify(comparison).includes('-1000'));
});

test('only request starts inside the common time window affect comparison', () => {
  const a = report('a', index => index < 20 ? 10000 : 5);
  const b = report('b', 6, { start: 20 });
  // A response completing outside the shared window remains a slow observation.
  a.samples[199].timingsMs.total = 5000;
  const result = compareAzReports([a, b]);
  assert.equal(result.comparable, true);
  assert.equal(result.overlap.durationSeconds, 180);
  assert.equal(result.overlap.startedAt, iso(20));
  assert.equal(result.overlap.finishedAt, iso(200));
  assert.equal(result.rows.find(row => row.label === 'a').excludedSamples, 20);
  assert.equal(result.rows.find(row => row.label === 'b').excludedSamples, 20);
  assert.equal(result.rows.find(row => row.label === 'a').summary.groups.warmReused.metrics.total.maxMs, 5000);
  assert.equal(result.provisionalCandidate, 'a');
});

test('insufficient or absent overlap displays statistics without selecting a winner', () => {
  for (const start of [41, 200, 300]) {
    const result = compareAzReports([report('a', 1), report('b', 2, { start })]);
    assert.equal(result.comparable, false);
    assert.equal(result.provisionalCandidate, null);
    assert.ok(result.rows.every(row => row.rank === null));
    assert.ok(result.rows.every(row => row.reasons.includes('insufficient common time window')));
  }
  const absent = compareAzReports([report('a'), report('b', 2, { start: 300 })]);
  assert.equal(absent.overlap.startedAt, null);
  assert.match(formatAzComparison(absent), /Common window: none/);
});

test('short smoke tests and interrupted reports are valid but cannot qualify', () => {
  const small = compareAzReports([report('a', 1, { duration: 1 }), report('b', 2, { duration: 1 })]);
  assert.equal(small.comparable, false);
  assert.ok(small.rows.every(row => row.reasons.includes('fewer than 100 successful reused-socket probes')));
  const incomplete = compareAzReports([report('a', 1), report('b', 2, { completed: false })]);
  assert.equal(incomplete.provisionalCandidate, null);
  assert.ok(incomplete.rows.find(row => row.label === 'b').reasons.includes('incomplete run'));
  assert.equal(incomplete.rows.find(row => row.label === 'a').rank, null, 'A weak participant must not manufacture a winner among the rest.');
});

test('fast successful responses cannot conceal outages, reconnects or missing cadence', () => {
  const outages = report('a', 1);
  for (let index = 0; index < 20; index++) Object.assign(outages.samples[index], { ok: false, errorCode: 'TIMEOUT', timingsMs: { total: 5000 } });
  const failed = compareAzReports([outages, report('b', 100)]);
  assert.equal(failed.provisionalCandidate, null);
  assert.equal(failed.rows[0].summary.groups.warmReused.metrics.total.p95Ms, 1);
  assert.equal(failed.rows[0].warmFailureFraction, 0.1);
  assert.ok(failed.rows[0].reasons.includes('warm failure rate exceeds 1% or no attempts'));

  const reconnects = report('a', 1);
  for (let index = 0; index < 20; index++) Object.assign(reconnects.samples[index], { reusedSocket: false, timingsMs: { total: 4000 } });
  const unstable = compareAzReports([reconnects, report('b', 100)]);
  assert.equal(unstable.provisionalCandidate, null);
  assert.equal(unstable.rows[0].reuseRatio, 0.9);
  assert.ok(unstable.rows[0].reasons.includes('successful reused-socket probes are below 95% of warm attempts'));

  const sparse = report('a', 1);
  sparse.samples = sparse.samples.slice(0, 120);
  const sparseResult = compareAzReports([sparse, report('b', 100)]);
  assert.equal(sparseResult.provisionalCandidate, null);
  assert.equal(sparseResult.rows[0].samplingCoverage, 0.6);
  assert.ok(sparseResult.rows[0].reasons.includes('warm sample coverage below 80% of configured cadence'));
});

test('exact availability and reuse thresholds are inclusive', () => {
  const a = report('a', 1);
  for (let index = 0; index < 2; index++) Object.assign(a.samples[index], { ok: false, errorCode: 'TIMEOUT' });
  for (let index = 2; index < 10; index++) a.samples[index].reusedSocket = false;
  const result = compareAzReports([a, report('b', 2)]);
  assert.equal(result.rows[0].warmFailureFraction, 0.01);
  assert.equal(result.rows[0].reuseRatio, 0.95);
  assert.equal(result.comparable, true);
});

test('tied leading quantiles do not select a zone through alphabetical tiebreaking', () => {
  const result = compareAzReports([report('b', 2), report('a', 2), report('c', 3)]);
  assert.equal(result.comparable, true);
  assert.equal(result.provisionalCandidate, null);
  assert.deepEqual(result.rows.map(row => [row.label, row.rank]), [['a', 1], ['b', 1], ['c', 3]]);
  assert.ok(result.warnings.some(warning => /tie at printed precision/.test(warning)));
});

test('different remote IP routes stay visible and do not invalidate a same-endpoint comparison', () => {
  const b = report('b', 2);
  for (const item of b.samples) item.remoteAddress = '192.0.2.11';
  const result = compareAzReports([report('a', 1), b]);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.rows[0].summary.groups.warmReused.ips, { '192.0.2.10': 200 });
  assert.deepEqual(result.rows[1].summary.groups.warmReused.ips, { '192.0.2.11': 200 });
  assert.match(formatAzComparison(result), /192\.0\.2\.11/);
});

test('settings compare by values and mismatched requests or duplicate identities fail closed', () => {
  const b = report('b', 2);
  b.settings = Object.fromEntries(Object.entries(b.settings).reverse());
  assert.equal(compareAzReports([report('a', 1), b]).comparable, true);
  for (const changed of [
    { endpointId: 'b'.repeat(64) }, { endpointOrigin: 'https://other.example.com' },
    { family: 6 }, { method: 'rpc_modules' }, { settings: { ...b.settings, intervalMs: 2000 } },
    { label: 'a' }, { zoneId: 'use2-aza' },
  ]) assert.throws(() => compareAzReports([report('a'), report('b', 2, changed)]), TypeError);
});

test('hardware metadata warns, different explicit instance types prevent ranking', () => {
  const b = report('b', 2);
  b.host.cpuModel = 'different CPU';
  const warningOnly = compareAzReports([report('a', 1), b]);
  assert.equal(warningOnly.comparable, true);
  assert.ok(warningOnly.warnings.some(warning => /hardware, runtime or instance type differs/.test(warning)));
  b.host.instanceType = 'c7i.xlarge';
  const mismatch = compareAzReports([report('a', 1), b]);
  assert.equal(mismatch.comparable, false);
  assert.ok(mismatch.rows.every(row => row.reasons.includes('reported EC2 instance types differ')));
  const missing = report('b');
  delete missing.host;
  delete missing.zoneId;
  const missingResult = compareAzReports([report('a'), missing]);
  assert.ok(missingResult.warnings.some(warning => /Host metadata is missing/.test(warning)));
  assert.ok(missingResult.warnings.some(warning => /no physical AWS zone ID/.test(warning)));
});

test('large measured clock steps prevent a shared-window winner without rejecting extra run diagnostics', () => {
  const diagnostics = { createdAt: iso(-20), wallClockDriftMs: 1000, warmup: { attempted: 5 }, skippedSlots: { warm: 0 }, runtime: { cpuUserMs: 2 } };
  assert.equal(compareAzReports([report('a', 1, diagnostics), report('b', 2)]).comparable, true);
  for (const drift of [1001, -1001]) {
    const result = compareAzReports([report('a', 1, { ...diagnostics, wallClockDriftMs: drift }), report('b', 2)]);
    assert.equal(result.comparable, false);
    assert.equal(result.provisionalCandidate, null);
    assert.ok(result.rows[0].reasons.includes('host wall clock changed by more than 1000 ms during the run'));
  }
});

test('malformed raw samples and report metadata are rejected instead of dropped from statistics', () => {
  for (const invalid of [
    null, {}, sample(0, 1, { ok: 'yes' }), sample(0, 1, { reusedSocket: undefined }),
    sample(0, 1, { kind: 'cold' }), sample(0, 1, { timingsMs: {} }),
    sample(0, 1, { timingsMs: { total: NaN } }), sample(0, 1, { timingsMs: { total: 1, dns: -1 } }),
    sample(0, 1, { errorCode: 'url with credentials' }), sample(0, 1, { remoteAddress: 'host.example.com' }),
    sample(0, 1, { timestamp: 'yesterday' }), sample(0, 1, { timestamp: '2026-02-31T12:00:00.000Z' }),
    sample(0, 1, { httpStatus: 700 }),
  ]) assert.throws(() => summarizeAzSamples([invalid]), TypeError);
  assert.throws(() => summarizeAzSamples(null), TypeError);
  for (const changed of [
    { schemaVersion: 2 }, { kind: 'other' }, { endpointId: 'not-a-hash' },
    { label: 'escape\x1b[1m' }, { endpointOrigin: 'https://user:secret@example.com' },
    { endpointOrigin: 'https://example.com/path?token=secret' },
    { settings: {} }, { settings: { ...report('b').settings, surprise: 1 } },
    { settings: { ...report('b').settings, intervalMs: 0 } }, { completed: 'true' },
    { finishedAt: iso(-1) }, { samples: [sample(201)] }, { placementSource: 'arbitrary' },
    { host: { cpuCount: 0 } },
  ]) assert.throws(() => compareAzReports([report('a'), report('b', 2, changed)]), TypeError);
});

test('report and sample counts are bounded before expensive processing', () => {
  for (const input of [null, [], [report('a')], Array(33).fill(null)]) {
    assert.throws(() => compareAzReports(input), RangeError);
  }
  assert.throws(() => summarizeAzSamples(Array(200001)), RangeError);
});

test('statistics do not mutate input records and discard unrelated sensitive fields', () => {
  const input = Object.freeze([
    Object.freeze(sample(1, 4, { timingsMs: Object.freeze({ total: 4 }), secret: 'do-not-print-me' })),
    Object.freeze(sample(0, 2, { timingsMs: Object.freeze({ total: 2 }), rawError: 'also-private' })),
  ]);
  const summary = summarizeAzSamples(input);
  assert.equal(summary.groups.warmReused.metrics.total.p50Ms, 2);
  assert.equal(input[0].timingsMs.total, 4);
  assert.equal(JSON.stringify(summary).includes('do-not-print-me'), false);
  assert.equal(formatAzSummary(summary).includes('also-private'), false);
});
