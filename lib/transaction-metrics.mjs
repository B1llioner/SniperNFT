const KINDS = ['deploy', 'mint'];
const STATUSES = new Set(['mined', 'reverted', 'uncertain', 'failed']);
const PHASES = ['prepare', 'sign', 'ack', 'receiptObserved', 'total'];

function isRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    KINDS.includes(record.kind) && STATUSES.has(record.status) &&
    Number.isSafeInteger(record.cycle) && record.cycle >= 1;
}

function validTiming(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasReceipt(record) {
  return record.status === 'mined' || record.status === 'reverted';
}

function phaseCompleted(record, phase) {
  // The producer sets acknowledged only after the sequencer returns the exact
  // locally calculated transaction hash. A later revert does not undo an ACK.
  if (phase === 'ack') return record.acknowledged === true;
  // A reverted receipt is a valid observation, but never a successful mint.
  if (phase === 'receiptObserved') return hasReceipt(record);
  // Keep failed or unfinished pipelines out of successful pipeline timings.
  return record.status === 'mined';
}

function summarizePhase(records, phase) {
  const values = records
    .filter(record => phaseCompleted(record, phase) && validTiming(record.timingsMs?.[phase]))
    .map(record => record.timingsMs[phase])
    .sort((left, right) => left - right);
  const round = value => Number(value.toFixed(3));
  const percentile = fraction => values.length ? round(values[Math.ceil(values.length * fraction) - 1]) : null;
  return {
    count: values.length,
    minMs: values.length ? round(values[0]) : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: values.length ? round(values.at(-1)) : null,
  };
}

function summarizeGroup(records, requestedTransactions) {
  const counts = {
    requestedTransactions,
    attemptedTransactions: records.length,
    mined: 0,
    reverted: 0,
    uncertain: 0,
    failed: 0,
    acknowledged: 0,
    receiptObserved: 0,
    missingTransactions: Math.max(0, requestedTransactions - records.length),
  };
  for (const record of records) {
    counts[record.status]++;
    if (record.acknowledged === true) counts.acknowledged++;
    if (hasReceipt(record)) counts.receiptObserved++;
  }
  return { counts, phases: Object.fromEntries(PHASES.map(phase => [phase, summarizePhase(records, phase)])) };
}

/**
 * Summarize measurements from complete or interrupted deploy/mint cycles.
 *
 * Timings are monotonic-clock durations in milliseconds supplied by the caller.
 * ack and receiptObserved both start at raw submission, independently of one
 * another. Receipt observation is not an exact block inclusion/finality time.
 * Missing/invalid timings remain absent; a timeout never becomes a zero sample.
 * The returned object deliberately contains no raw records, RPC errors or keys.
 */
export function summarizeTransactionMetrics(records, requestedCycles) {
  if (!Array.isArray(records)) throw new TypeError('Transaction records must be an array.');
  const validRecords = records.filter(isRecord);
  const observedCycles = new Set(validRecords.map(record => record.cycle)).size;
  requestedCycles ??= observedCycles;
  if (!Number.isSafeInteger(requestedCycles) || requestedCycles < 0 || requestedCycles > Number.MAX_SAFE_INTEGER / 2) {
    throw new RangeError('Requested cycles must be a non-negative safe integer with a safe transaction count.');
  }
  const group = summarizeGroup(validRecords, requestedCycles * 2);
  group.counts.invalidRecords = records.length - validRecords.length;
  const byKind = Object.fromEntries(KINDS.map(kind => [kind,
    summarizeGroup(validRecords.filter(record => record.kind === kind), requestedCycles),
  ]));
  const warnings = [];
  for (const kind of KINDS) {
    const sparse = ['ack', 'receiptObserved']
      .filter(phase => byKind[kind].phases[phase].count < 100)
      .map(phase => `${phase}=${byKind[kind].phases[phase].count}`);
    if (sparse.length) warnings.push(`${kind}: ${sparse.join(', ')} samples (<100); p95/p99 are descriptive. Collect at least 100 observations per kind/phase to begin assessing p99; even 100 does not guarantee a reliable tail estimate.`);
  }
  if (group.counts.invalidRecords) warnings.push(`${group.counts.invalidRecords} invalid records were excluded.`);
  return {
    requestedCycles,
    observedCycles,
    percentileMethod: 'nearest rank; milliseconds; no replacement values for missing or invalid samples',
    counts: group.counts,
    phases: group.phases,
    byKind,
    warnings,
  };
}

/** Render a terminal-friendly report without mixing deploy and mint samples. */
export function formatTransactionMetrics(summary) {
  const labels = { prepare: 'prepare', sign: 'sign', ack: 'submit ACK', receiptObserved: 'receipt observed', total: 'total' };
  const rows = [['Kind', 'Phase', 'N', 'p50', 'p95', 'p99', 'max']];
  const display = value => value === null ? 'n/a' : value.toFixed(3);
  for (const kind of KINDS) {
    for (const phase of PHASES) {
      const metrics = summary.byKind[kind].phases[phase];
      rows.push([kind, labels[phase], String(metrics.count), display(metrics.p50Ms), display(metrics.p95Ms), display(metrics.p99Ms), display(metrics.maxMs)]);
    }
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  const table = rows.map(row => row.map((cell, column) => column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ').trimEnd()).join('\n');
  const { counts } = summary;
  const lines = [
    'Transaction latency (ms; nearest-rank percentiles)',
    table,
    `Transactions: requested=${counts.requestedTransactions}, attempted=${counts.attemptedTransactions}, mined=${counts.mined}, reverted=${counts.reverted}, uncertain=${counts.uncertain}, failed=${counts.failed}, missing=${counts.missingTransactions}.`,
    'Submit ACK: time from raw-send start to the matching sequencer hash; preparation/signing excluded.',
    'Receipt observed: time from raw-send start to a reader RPC receipt, including propagation and polling; not exact block inclusion or finality. Includes reverted receipts.',
    'Prepare/sign/total: mined transactions only. Total is the full measured per-transaction duration.',
  ];
  if (summary.warnings.length) lines.push(...summary.warnings.map(warning => `NOTE: ${warning}`));
  return lines.join('\n');
}
