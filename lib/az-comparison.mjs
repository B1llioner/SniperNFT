import { isIP } from 'node:net';

const GROUPS = ['warmReused', 'warmReconnect', 'cold'];
const PHASES = ['dns', 'tcp', 'tls', 'firstByte', 'total'];
const SETTING_KEYS = ['durationSeconds', 'intervalMs', 'coldIntervalMs', 'timeoutMs', 'warmupSamples'];
const MAX_SAMPLES = 200_000;
const MAX_REPORTS = 32;
const MIN_WARM_SUCCESSES = 100;
const MIN_WINDOW_FRACTION = 0.8;
const MAX_WARM_FAILURE_FRACTION = 0.01;
const MIN_SUCCESSFUL_REUSE_RATIO = 0.95;
const PERCENTILE_METHOD = 'nearest rank; successful observations only; absent or failed timings never become zero';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timing = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => Number(value.toFixed(3));

function time(value, field) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new TypeError(`${field} must be an ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${field} must be a canonical UTC ISO timestamp with milliseconds.`);
  return parsed;
}

function text(value, field, maximum = 120) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${field} must be a nonempty string without control characters (maximum ${maximum}).`);
  }
}

function validateSample(sample, index) {
  if (!record(sample) || !['warm', 'cold'].includes(sample.kind) || typeof sample.ok !== 'boolean' ||
      typeof sample.reusedSocket !== 'boolean') {
    throw new TypeError(`Invalid sample ${index}: kind, ok and reusedSocket are required.`);
  }
  const timestamp = time(sample.timestamp, `sample ${index} timestamp`);
  if (sample.kind === 'cold' && sample.reusedSocket) throw new TypeError(`Invalid sample ${index}: a cold probe reused a socket.`);
  if (sample.tlsSessionReused !== undefined && typeof sample.tlsSessionReused !== 'boolean') {
    throw new TypeError(`Invalid sample ${index}: tlsSessionReused must be boolean.`);
  }
  if (sample.timingsMs !== undefined && !record(sample.timingsMs)) throw new TypeError(`Invalid sample ${index}: timingsMs must be an object.`);
  for (const phase of PHASES) {
    const value = sample.timingsMs?.[phase];
    if (value !== undefined && value !== null && !timing(value)) throw new TypeError(`Invalid sample ${index}: ${phase} timing.`);
  }
  if (sample.ok && !timing(sample.timingsMs?.total)) throw new TypeError(`Invalid sample ${index}: a successful probe needs a total timing.`);
  if (sample.errorCode !== undefined && (typeof sample.errorCode !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(sample.errorCode))) {
    throw new TypeError(`Invalid sample ${index}: errorCode must be a bounded code, not a raw message.`);
  }
  if (sample.remoteAddress !== undefined && sample.remoteAddress !== null && !isIP(sample.remoteAddress)) {
    throw new TypeError(`Invalid sample ${index}: remoteAddress must be an IP address.`);
  }
  if (sample.httpStatus !== undefined && sample.httpStatus !== null &&
      (!Number.isInteger(sample.httpStatus) || sample.httpStatus < 100 || sample.httpStatus > 599)) {
    throw new TypeError(`Invalid sample ${index}: invalid HTTP status.`);
  }
  return timestamp;
}

function validateSamples(samples) {
  if (!Array.isArray(samples)) throw new TypeError('Samples must be an array.');
  if (samples.length > MAX_SAMPLES) throw new RangeError(`At most ${MAX_SAMPLES} samples per report are supported.`);
  return samples.map(validateSample);
}

function metric(values) {
  values.sort((left, right) => left - right);
  const percentile = fraction => values.length ? round(values[Math.ceil(values.length * fraction) - 1]) : null;
  const p50Ms = percentile(0.5);
  const p99Ms = percentile(0.99);
  return {
    count: values.length,
    minMs: values.length ? round(values[0]) : null,
    p50Ms,
    p95Ms: percentile(0.95),
    p99Ms,
    maxMs: values.length ? round(values.at(-1)) : null,
    jitterMs: values.length ? round(p99Ms - p50Ms) : null,
  };
}

function increment(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }
const sortedCounts = map => Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)));

function group(samples) {
  const successful = samples.filter(sample => sample.ok);
  const errors = new Map();
  const ips = new Map();
  for (const sample of samples) {
    if (!sample.ok) increment(errors, sample.errorCode ?? 'UNKNOWN_ERROR');
    if (sample.remoteAddress) increment(ips, sample.remoteAddress);
  }
  return {
    counts: { attempted: samples.length, success: successful.length, failed: samples.length - successful.length },
    metrics: Object.fromEntries(PHASES.map(phase => [phase,
      metric(successful.map(sample => sample.timingsMs?.[phase]).filter(timing)),
    ])),
    connections: {
      socketReused: samples.filter(sample => sample.reusedSocket).length,
      tlsSessionReused: samples.filter(sample => sample.tlsSessionReused === true).length,
    },
    errors: sortedCounts(errors),
    ips: sortedCounts(ips),
  };
}

/** Timings describe read-only RPC probes; they never establish transaction ordering. */
export function summarizeAzSamples(samples, runMeta = {}) {
  validateSamples(samples);
  const groups = {
    warmReused: group(samples.filter(sample => sample.kind === 'warm' && sample.reusedSocket)),
    warmReconnect: group(samples.filter(sample => sample.kind === 'warm' && !sample.reusedSocket)),
    cold: group(samples.filter(sample => sample.kind === 'cold')),
  };
  const success = samples.filter(sample => sample.ok).length;
  const warnings = [];
  const reused = groups.warmReused.counts.success;
  if (reused < 1000) warnings.push(`Only ${reused} successful reused-socket probes; p99 is descriptive. Collect at least 1000 observations and repeat the run to assess the tail.`);
  if (groups.warmReconnect.counts.attempted) warnings.push(`${groups.warmReconnect.counts.attempted} warm probes opened or attempted a new connection; their timings are separate from reused sockets.`);
  if (success < samples.length) warnings.push('Failures are counted separately and omitted from latency percentiles; compare availability as well as successful latency.');
  if (runMeta.completed === false) warnings.push('Run is incomplete; it cannot select a candidate zone.');
  return {
    percentileMethod: PERCENTILE_METHOD,
    counts: { attempted: samples.length, success, failed: samples.length - success },
    groups,
    warnings,
  };
}

function validateReport(report, index) {
  if (!record(report) || report.schemaVersion !== 1 || report.kind !== 'sequencer-az-probe') {
    throw new TypeError(`Report ${index} has an unsupported schema or kind.`);
  }
  text(report.label, `Report ${index} label`, 80);
  text(report.runId, `Report ${index} runId`, 120);
  if (!/^[a-f0-9]{64}$/i.test(report.endpointId ?? '')) throw new TypeError(`Report ${index} needs an endpoint SHA-256 ID.`);
  let endpoint;
  try { endpoint = new URL(report.endpointOrigin); } catch { throw new TypeError(`Report ${index} has an invalid endpoint origin.`); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.origin !== report.endpointOrigin) {
    throw new TypeError(`Report ${index} endpointOrigin must contain only its canonical scheme, host and port.`);
  }
  if (![0, 4, 6].includes(report.family) || report.protocol !== 'http/1.1' ||
      typeof report.method !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(report.method)) {
    throw new TypeError(`Report ${index} has invalid transport or request metadata.`);
  }
  if (report.connectIp !== undefined && (typeof report.connectIp !== 'string' || isIP(report.connectIp) !== 4 || report.family === 6)) {
    throw new TypeError(`Report ${index} has an invalid pinned IPv4 address.`);
  }
  if (!record(report.settings) || Object.keys(report.settings).some(key => !SETTING_KEYS.includes(key))) {
    throw new TypeError(`Report ${index} has invalid settings.`);
  }
  for (const key of SETTING_KEYS) {
    const value = report.settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < (key === 'warmupSamples' ? 0 : Number.MIN_VALUE) ||
        (key !== 'durationSeconds' && !Number.isSafeInteger(value))) throw new TypeError(`Report ${index} has invalid ${key}.`);
  }
  if (typeof report.completed !== 'boolean') throw new TypeError(`Report ${index} needs a completed flag.`);
  if (report.wallClockDriftMs !== undefined && (typeof report.wallClockDriftMs !== 'number' || !Number.isFinite(report.wallClockDriftMs))) {
    throw new TypeError(`Report ${index} has an invalid wall-clock drift measurement.`);
  }
  const startedAt = time(report.startedAt, `Report ${index} startedAt`);
  const finishedAt = time(report.finishedAt, `Report ${index} finishedAt`);
  if (finishedAt < startedAt) throw new TypeError(`Report ${index} finishes before it starts.`);
  if (report.scheduledStartAt !== undefined) time(report.scheduledStartAt, `Report ${index} scheduledStartAt`);
  for (const key of ['zoneId', 'zoneName', 'region']) if (report[key] !== undefined) text(report[key], `Report ${index} ${key}`, 80);
  if (report.placementSource !== undefined && !['imds-v2', 'user'].includes(report.placementSource)) throw new TypeError(`Report ${index} has invalid placementSource.`);
  if (report.host !== undefined) {
    if (!record(report.host)) throw new TypeError(`Report ${index} host must be an object.`);
    for (const key of ['nodeVersion', 'platform', 'arch', 'cpuModel', 'instanceType']) {
      if (report.host[key] !== undefined) text(report.host[key], `Report ${index} host.${key}`, 200);
    }
    if (report.host.cpuCount !== undefined && (!Number.isSafeInteger(report.host.cpuCount) || report.host.cpuCount < 1)) {
      throw new TypeError(`Report ${index} has an invalid CPU count.`);
    }
  }
  const sampleTimes = validateSamples(report.samples);
  if (sampleTimes.some(timestamp => timestamp < startedAt || timestamp > finishedAt)) {
    throw new TypeError(`Report ${index} contains samples outside its run window.`);
  }
  return { report, startedAt, finishedAt, sampleTimes };
}

function fingerprint(report) {
  return JSON.stringify([
    report.endpointId.toLowerCase(), report.endpointOrigin, report.family, report.connectIp ?? null, report.protocol, report.method,
    ...SETTING_KEYS.map(key => report.settings[key]),
  ]);
}

/** Recompute every statistic from raw samples in the common wall-clock window. */
export function compareAzReports(reports) {
  if (!Array.isArray(reports) || reports.length < 2 || reports.length > MAX_REPORTS) {
    throw new RangeError(`Compare between 2 and ${MAX_REPORTS} reports.`);
  }
  const validated = reports.map(validateReport);
  const labels = new Set();
  const zoneIds = new Set();
  const expected = fingerprint(reports[0]);
  for (const report of reports) {
    if (fingerprint(report) !== expected) throw new TypeError('Reports must use the same endpoint, address family, protocol, RPC method and settings.');
    if (labels.has(report.label)) throw new TypeError('Report labels must be unique.');
    labels.add(report.label);
    if (report.zoneId !== undefined) {
      if (zoneIds.has(report.zoneId)) throw new TypeError('Reported physical zone IDs must be unique.');
      zoneIds.add(report.zoneId);
    }
  }
  const start = Math.max(...validated.map(entry => entry.startedAt));
  const end = Math.min(...validated.map(entry => entry.finishedAt));
  const overlapMs = Math.max(0, end - start);
  const requestedMs = reports[0].settings.durationSeconds * 1000;
  const fractionOfRequested = Math.min(1, overlapMs / requestedMs);
  const sufficientOverlap = overlapMs > 0 && fractionOfRequested >= MIN_WINDOW_FRACTION;
  const expectedWarmAttempts = Math.max(1, Math.floor(overlapMs / reports[0].settings.intervalMs));
  const warnings = ['This compares read-only HTTPS RPC latency, not transaction acceptance, inclusion time or ordering. Verify the candidate with real transactions before choosing a deployment location.'];
  warnings.push('The shared window uses host wall clocks; synchronize all hosts with NTP/chrony. These reports cannot prove clock synchronization.');
  if (!sufficientOverlap) warnings.push(`Common measurement window is ${(fractionOfRequested * 100).toFixed(1)}% of requested duration; at least 80% is required for ranking.`);
  if (reports.some(report => !report.zoneId)) warnings.push('Some reports have no physical AWS zone ID; zone names alone can map differently between AWS accounts.');
  if (new Set(reports.map(report => report.region ?? '')).size > 1) warnings.push('Reported AWS regions differ or are missing.');
  const hostFields = ['nodeVersion', 'platform', 'arch', 'cpuModel', 'cpuCount', 'instanceType'];
  const hostSignatures = reports.map(report => JSON.stringify(hostFields.map(key => report.host?.[key] ?? null)));
  const instanceTypes = new Set(reports.map(report => report.host?.instanceType).filter(value => value !== undefined));
  const instanceTypeMismatch = instanceTypes.size > 1;
  if (new Set(hostSignatures).size > 1) warnings.push('Host hardware, runtime or instance type differs; this comparison may include factors beyond network placement.');
  if (reports.some(report => !report.host)) warnings.push('Host metadata is missing from some reports; matching instance configuration cannot be checked.');
  const rows = validated.map(({ report, sampleTimes }) => {
    // Select by request START time and retain the whole result, including a
    // timeout after the overlap ends. Dropping these would censor the slow tail.
    const samples = overlapMs > 0 ? report.samples.filter((_, index) => sampleTimes[index] >= start && sampleTimes[index] <= end) : [];
    const summary = summarizeAzSamples(samples, report);
    const warmAttempts = summary.groups.warmReused.counts.attempted + summary.groups.warmReconnect.counts.attempted;
    const warmFailures = summary.groups.warmReused.counts.failed + summary.groups.warmReconnect.counts.failed;
    const warmFailureFraction = warmAttempts ? warmFailures / warmAttempts : null;
    const reuseRatio = warmAttempts ? summary.groups.warmReused.counts.success / warmAttempts : null;
    const samplingCoverage = Math.min(1, warmAttempts / expectedWarmAttempts);
    const reasons = [];
    if (!report.completed) reasons.push('incomplete run');
    if (!sufficientOverlap) reasons.push('insufficient common time window');
    if (summary.groups.warmReused.counts.success < MIN_WARM_SUCCESSES) reasons.push('fewer than 100 successful reused-socket probes');
    if (samplingCoverage < MIN_WINDOW_FRACTION) reasons.push('warm sample coverage below 80% of configured cadence');
    if (warmFailureFraction === null || warmFailureFraction > MAX_WARM_FAILURE_FRACTION) reasons.push('warm failure rate exceeds 1% or no attempts');
    if (reuseRatio === null || reuseRatio < MIN_SUCCESSFUL_REUSE_RATIO) reasons.push('successful reused-socket probes are below 95% of warm attempts');
    if (instanceTypeMismatch) reasons.push('reported EC2 instance types differ');
    if (Math.abs(report.wallClockDriftMs ?? 0) > 1000) reasons.push('host wall clock changed by more than 1000 ms during the run');
    return {
      label: report.label,
      runId: report.runId,
      ...(report.zoneId !== undefined ? { zoneId: report.zoneId } : {}),
      ...(report.zoneName !== undefined ? { zoneName: report.zoneName } : {}),
      completed: report.completed,
      summary,
      excludedSamples: report.samples.length - samples.length,
      warmFailureFraction,
      reuseRatio,
      samplingCoverage,
      eligible: reasons.length === 0,
      reasons,
      rank: null,
    };
  });
  const comparable = rows.every(row => row.eligible);
  let provisionalCandidate = null;
  if (comparable) {
    rows.sort((left, right) => {
      const leftMetric = left.summary.groups.warmReused.metrics.total;
      const rightMetric = right.summary.groups.warmReused.metrics.total;
      return leftMetric.p95Ms - rightMetric.p95Ms || leftMetric.p99Ms - rightMetric.p99Ms || leftMetric.p50Ms - rightMetric.p50Ms || left.label.localeCompare(right.label);
    });
    for (const [index, row] of rows.entries()) {
      const previous = rows[index - 1]?.summary.groups.warmReused.metrics.total;
      const current = row.summary.groups.warmReused.metrics.total;
      row.rank = previous && ['p95Ms', 'p99Ms', 'p50Ms'].every(key => previous[key] === current[key]) ? rows[index - 1].rank : index + 1;
    }
    const first = rows[0].summary.groups.warmReused.metrics.total;
    const second = rows[1].summary.groups.warmReused.metrics.total;
    if (['p95Ms', 'p99Ms', 'p50Ms'].every(key => first[key] === second[key])) {
      warnings.push('The leading reports tie at printed precision; no single candidate is selected.');
    } else {
      provisionalCandidate = rows[0].label;
      warnings.push('The candidate is provisional; repeat simultaneous measurements before interpreting small differences as a stable advantage.');
    }
  } else {
    warnings.push('No candidate selected: every report must meet the completion, overlap, sample count, cadence, availability, socket reuse and host criteria.');
  }
  for (const row of rows) for (const warning of row.summary.warnings) warnings.push(`${row.label}: ${warning}`);
  return {
    comparable,
    provisionalCandidate,
    overlap: {
      startedAt: overlapMs > 0 ? new Date(start).toISOString() : null,
      finishedAt: overlapMs > 0 ? new Date(end).toISOString() : null,
      durationSeconds: round(overlapMs / 1000),
      fractionOfRequested,
    },
    criteria: {
      minimumWarmSuccesses: MIN_WARM_SUCCESSES,
      minimumOverlapFraction: MIN_WINDOW_FRACTION,
      minimumSamplingCoverage: MIN_WINDOW_FRACTION,
      maximumWarmFailureFraction: MAX_WARM_FAILURE_FRACTION,
      minimumSuccessfulReuseRatio: MIN_SUCCESSFUL_REUSE_RATIO,
      order: ['warmReused.total.p95Ms', 'warmReused.total.p99Ms', 'warmReused.total.p50Ms'],
    },
    rows,
    warnings,
  };
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}
const display = value => value === null ? 'n/a' : value.toFixed(3);
const GROUP_LABELS = { warmReused: 'warm reused', warmReconnect: 'warm reconnect', cold: 'cold' };

export function formatAzSummary(summary, label = 'run') {
  text(label, 'label', 80);
  const rows = [['Probe', 'Phase', 'N', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'p99-p50']];
  for (const name of GROUPS) {
    const entry = summary.groups[name];
    for (const phase of PHASES) {
      const values = entry.metrics[phase];
      if (phase !== 'total' && !values.count) continue;
      rows.push([GROUP_LABELS[name], phase, String(values.count), display(values.p50Ms), display(values.p95Ms), display(values.p99Ms), display(values.maxMs), display(values.jitterMs)]);
    }
  }
  const lines = [`${label}: RPC probe latency (nearest-rank percentiles)`, table(rows)];
  for (const name of GROUPS) {
    const entry = summary.groups[name];
    lines.push(`${GROUP_LABELS[name]}: attempted=${entry.counts.attempted}, success=${entry.counts.success}, failed=${entry.counts.failed}; errors=${JSON.stringify(entry.errors)}; IPs=${JSON.stringify(entry.ips)}.`);
  }
  lines.push('Successful probes only; warm reused sockets are separate from reconnects. RPC response time does not establish transaction inclusion or ordering.');
  lines.push(...summary.warnings.map(warning => `NOTE: ${warning}`));
  return lines.join('\n');
}

export function formatAzComparison(result) {
  const rows = [['Rank', 'Label', 'Zone ID', 'Warm N', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'p99-p50', 'Warm fail', 'Reuse', 'Coverage']];
  for (const row of result.rows) {
    const values = row.summary.groups.warmReused.metrics.total;
    rows.push([
      row.rank === null ? '-' : String(row.rank), row.label, row.zoneId ?? '-', String(values.count),
      display(values.p50Ms), display(values.p95Ms), display(values.p99Ms), display(values.maxMs), display(values.jitterMs),
      row.warmFailureFraction === null ? 'n/a' : `${(row.warmFailureFraction * 100).toFixed(2)}%`,
      row.reuseRatio === null ? 'n/a' : `${(row.reuseRatio * 100).toFixed(1)}%`,
      `${(row.samplingCoverage * 100).toFixed(1)}%`,
    ]);
  }
  const lines = [
    `Common window: ${result.overlap.startedAt ?? 'none'} .. ${result.overlap.finishedAt ?? 'none'} (${result.overlap.durationSeconds.toFixed(3)} s).`,
    'Successful reused-socket total RPC latency; order: p95, then p99, then p50.',
    table(rows),
    `Provisional candidate: ${result.provisionalCandidate ?? 'none'}.`,
  ];
  for (const row of result.rows) {
    if (row.reasons.length) lines.push(`${row.label}: not eligible: ${row.reasons.join('; ')}.`);
    lines.push(`${row.label}: reused IPs=${JSON.stringify(row.summary.groups.warmReused.ips)}; warm reconnects=${row.summary.groups.warmReconnect.counts.attempted}; warm errors=${JSON.stringify({ reused: row.summary.groups.warmReused.errors, reconnect: row.summary.groups.warmReconnect.errors })}.`);
  }
  lines.push(...result.warnings.map(warning => `NOTE: ${warning}`));
  return lines.join('\n');
}
