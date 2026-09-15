import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTransactionMetrics, summarizeTransactionMetrics } from '../lib/transaction-metrics.mjs';

const transaction = (cycle, kind, duration, extra = {}) => ({
  cycle,
  kind,
  status: 'mined',
  acknowledged: true,
  timingsMs: { prepare: duration * 10, sign: duration / 10, ack: duration, receiptObserved: duration * 2, total: duration * 20 },
  ...extra,
});

test('100 known samples use nearest-rank p50/p95/p99 and keep deploy and mint separate', () => {
  const records = Array.from({ length: 100 }, (_, index) => [
    transaction(index + 1, 'deploy', 100 - index),
    transaction(index + 1, 'mint', (100 - index) * 10),
  ]).flat();
  const summary = summarizeTransactionMetrics(records, 100);
  assert.deepEqual(summary.byKind.deploy.phases.ack, { count: 100, minMs: 1, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
  assert.deepEqual(summary.byKind.mint.phases.ack, { count: 100, minMs: 10, p50Ms: 500, p95Ms: 950, p99Ms: 990, maxMs: 1000 });
  assert.equal(summary.byKind.deploy.phases.receiptObserved.p99Ms, 198);
  assert.equal(summary.byKind.deploy.phases.prepare.p99Ms, 990);
  assert.equal(summary.phases.ack.count, 200);
  assert.equal(summary.counts.mined, 200);
  assert.equal(summary.observedCycles, 100);
  assert.deepEqual(summary.warnings, []);
});

test('acknowledged failures and reverted receipts retain their observations without becoming successful transactions', () => {
  const records = [
    transaction(1, 'deploy', 10),
    transaction(1, 'mint', 20, { status: 'reverted' }),
    transaction(2, 'deploy', 30, { status: 'uncertain' }),
    transaction(2, 'mint', 40, { status: 'failed', acknowledged: false }),
    transaction(3, 'deploy', 50, { acknowledged: false }),
  ];
  const summary = summarizeTransactionMetrics(records, 4);
  assert.deepEqual(summary.counts, {
    requestedTransactions: 8, attemptedTransactions: 5,
    mined: 2, reverted: 1, uncertain: 1, failed: 1,
    acknowledged: 3, receiptObserved: 3, missingTransactions: 3, invalidRecords: 0,
  });
  assert.equal(summary.byKind.deploy.phases.ack.count, 2);
  assert.equal(summary.byKind.deploy.phases.ack.maxMs, 30);
  assert.equal(summary.byKind.deploy.phases.receiptObserved.count, 2);
  assert.equal(summary.byKind.deploy.phases.receiptObserved.maxMs, 100);
  assert.equal(summary.byKind.mint.phases.receiptObserved.count, 1);
  assert.equal(summary.byKind.mint.phases.receiptObserved.maxMs, 40);
  assert.equal(summary.byKind.mint.phases.total.count, 0);
  assert.equal(summary.byKind.deploy.phases.total.count, 2);
  assert.equal(summary.byKind.deploy.phases.total.maxMs, 1000);
  assert.equal(summary.byKind.mint.counts.reverted, 1);
  assert.equal(summary.byKind.mint.counts.failed, 1);
});

test('missing, non-number, negative and non-finite timings are omitted rather than converted to zero', () => {
  const values = [undefined, null, '10', -1, Infinity, NaN, 0, 3.1415926];
  const records = values.map((ack, index) => transaction(index + 1, 'deploy', 1, { timingsMs: { ack } }));
  records.push(transaction(9, 'deploy', 1, { timingsMs: undefined }));
  const summary = summarizeTransactionMetrics(records, 9);
  assert.deepEqual(summary.byKind.deploy.phases.ack, { count: 2, minMs: 0, p50Ms: 0, p95Ms: 3.142, p99Ms: 3.142, maxMs: 3.142 });
  assert.equal(summary.byKind.deploy.phases.receiptObserved.count, 0);
  assert.equal(summary.byKind.deploy.phases.receiptObserved.p99Ms, null);
  assert.equal(summary.byKind.deploy.phases.total.count, 0);
  assert.equal(summary.byKind.mint.phases.ack.minMs, null);
  assert.equal(summary.counts.acknowledged, 9, 'Outcome counts are independent of whether a valid timing was recorded.');
});

test('invalid records do not inflate successes and report content excludes raw errors or transaction material', () => {
  const records = [
    transaction(1, 'deploy', 4, { error: 'secret-provider-credential', rawTransaction: 'secret-signed-bytes' }),
    null,
    [],
    transaction(1, 'deploy', 99, { status: 'timeout' }),
    transaction(1, 'other', 99),
    transaction(0, 'mint', 99),
    transaction(1.5, 'mint', 99),
    transaction('2', 'mint', 99),
  ];
  const summary = summarizeTransactionMetrics(records, 2);
  assert.equal(summary.counts.attemptedTransactions, 1);
  assert.equal(summary.counts.invalidRecords, 7);
  assert.equal(summary.counts.mined, 1);
  assert.equal(summary.observedCycles, 1);
  assert.ok(summary.warnings.some(warning => /7 invalid records/.test(warning)));
  assert.ok(!JSON.stringify(summary).includes('secret-'));
  assert.ok(!formatTransactionMetrics(summary).includes('secret-'));
});

test('one deploy and mint print p95 and p99 with separate phases and an explicit small-sample limitation', () => {
  const summary = summarizeTransactionMetrics([transaction(1, 'deploy', 25), transaction(1, 'mint', 35)], 1);
  const output = formatTransactionMetrics(summary);
  assert.match(output, /Kind\s+Phase\s+N\s+p50\s+p95\s+p99\s+max/);
  assert.match(output, /deploy\s+submit ACK\s+1\s+25\.000\s+25\.000\s+25\.000\s+25\.000/);
  assert.match(output, /mint\s+receipt observed\s+1\s+70\.000\s+70\.000\s+70\.000\s+70\.000/);
  assert.match(output, /ack=1, receiptObserved=1 samples \(<100\); p95\/p99 are descriptive/);
  assert.match(output, /at least 100 observations per kind\/phase/);
  assert.match(output, /not exact block inclusion or finality/);
  assert.match(output, /Includes reverted receipts/);
  assert.equal(summary.warnings.length, 2);
});

test('empty and interrupted runs print n/a rather than zero and preserve requested transaction count', () => {
  const empty = summarizeTransactionMetrics([], 3);
  assert.equal(empty.requestedCycles, 3);
  assert.equal(empty.observedCycles, 0);
  assert.equal(empty.counts.missingTransactions, 6);
  assert.deepEqual(empty.byKind.deploy.phases.ack, { count: 0, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  assert.match(formatTransactionMetrics(empty), /deploy\s+submit ACK\s+0\s+n\/a\s+n\/a\s+n\/a\s+n\/a/);
  const inferred = summarizeTransactionMetrics([transaction(1, 'deploy', 4), transaction(1, 'mint', 7), transaction(2, 'deploy', 8)]);
  assert.equal(inferred.requestedCycles, 2);
  assert.equal(inferred.counts.missingTransactions, 1);
});

test('metrics do not mutate input ordering or timing values and validate the requested count', () => {
  const records = Object.freeze([
    Object.freeze(transaction(1, 'deploy', 8, { timingsMs: Object.freeze({ ack: 8 }) })),
    Object.freeze(transaction(2, 'deploy', 3, { timingsMs: Object.freeze({ ack: 3 }) })),
  ]);
  assert.equal(summarizeTransactionMetrics(records, 2).byKind.deploy.phases.ack.p50Ms, 3);
  assert.equal(records[0].timingsMs.ack, 8);
  for (const count of [-1, 1.5, Infinity, NaN, '2', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => summarizeTransactionMetrics([], count), RangeError);
  }
  assert.throws(() => summarizeTransactionMetrics(null, 1), TypeError);
});
