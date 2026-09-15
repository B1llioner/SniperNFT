import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { MintError } from '../mint.mjs';
import { waitForPublicStage } from '../lib/warm.mjs';

// Controlled in-memory RPCs only. Their chain timestamps intentionally differ
// from the machine clock, and no signing or transaction submission is provided.
const WAIT_OPTIONS = { waitTimeoutSeconds: 0.5, pollIntervalMs: 3, keepAliveIntervalMs: 15 };
const SECRET = 'https://fixture.invalid/private-rpc-token';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function endpoint(index, { timestamp = 90n, chainId = '0x1237', onBlock } = {}) {
  const provider = {
    timestamp, chainId, calls: [], blockReads: 0,
    async send(method, params) {
      this.calls.push({ method, params });
      if (method === 'eth_chainId') return this.chainId;
      assert.equal(method, 'eth_getBlockByNumber', 'Warm orchestration must never submit a transaction.');
      assert.deepEqual(params, ['latest', false]);
      this.blockReads++;
      if (onBlock) {
        const result = await onBlock(this);
        if (result != null) return result;
      }
      return { number: '0x100', timestamp: `0x${this.timestamp.toString(16)}` };
    },
  };
  return { endpoint: index, provider };
}
function stage(entry, overrides = {}) {
  return { startTime: 100n, endTime: 200n, mintPrice: 0n,
    maxTotalMintableByWallet: 1n, timestamp: entry.provider.timestamp, ...overrides };
}
function callbacks() {
  const prepared = [];
  const readStages = [];
  return {
    prepared, readStages,
    async prepare(entry) {
      prepared.push(entry);
      if (await entry.provider.send('eth_chainId', []) !== '0x1237') throw new Error(`Wrong chain: ${SECRET}`);
      return { source: entry.provider, preparedBeforeStart: entry.provider.timestamp < 100n };
    },
    async getStage(entry) { readStages.push(entry); return stage(entry); },
  };
}
function run(entries, overrides = {}) {
  const hooks = callbacks();
  return { hooks, promise: waitForPublicStage({ entries, options: WAIT_OPTIONS, ...hooks, ...overrides }) };
}

test('warm preparation runs once per endpoint before start and reuses the same providers', async () => {
  const primary = endpoint(2, { onBlock(provider) { if (provider.blockReads >= 8) provider.timestamp = 100n; } });
  const secondary = endpoint(7);
  const { hooks, promise } = run([primary, secondary]);
  const result = await promise;
  assert.equal(result.entry.provider, primary.provider);
  assert.equal(result.prepared.source, primary.provider);
  assert.equal(result.prepared.preparedBeforeStart, true);
  assert.deepEqual(hooks.prepared, [primary, secondary]);
  assert.deepEqual(result.entries.map(entry => entry.provider), [primary.provider, secondary.provider]);
  assert.ok(primary.provider.calls.filter(call => call.method === 'eth_chainId').length >= 2);
  assert.ok(secondary.provider.calls.filter(call => call.method === 'eth_chainId').length >= 2);
  assert.ok(secondary.provider.blockReads >= 1, 'The secondary connection must also receive keepalive probes.');
  assert.ok(hooks.readStages.length >= 2, 'Stage conditions must be re-read before returning ready.');
  assert.ok(result.stage.timestamp >= result.stage.startTime);
});

test('a stage already active on the chain returns after preparation', async () => {
  const active = endpoint(0, { timestamp: 150n });
  const { hooks, promise } = run([active]);
  const result = await promise;
  assert.equal(result.entry.provider, active.provider);
  assert.equal(result.stage.timestamp, 150n);
  assert.equal(hooks.prepared.length, 1);
});

test('exact start and exact end timestamps remain valid mint boundaries', async () => {
  for (const timestamp of [100n, 200n]) {
    const { promise } = run([endpoint(0, { timestamp })]);
    const result = await promise;
    assert.equal(result.stage.timestamp, timestamp);
  }
});

test('wall clock being past the opening cannot release a chain whose blocks are still early', async () => {
  const early = endpoint(0, { timestamp: 99n });
  const start = performance.now();
  const { promise } = run([early], { options: { ...WAIT_OPTIONS, waitTimeoutSeconds: 0.08 } });
  await assert.rejects(promise, /timeout|timed out|deadline|expired/i);
  assert.ok(performance.now() - start < 1000, 'The overall deadline must remain bounded.');
  assert.ok(early.provider.blockReads > 0);
  assert.ok(early.provider.blockReads < 100, 'Polling must include a bounded pause.');
});

test('opening time is revalidated when the owner postpones the stage', async () => {
  let stageReads = 0;
  const entry = endpoint(0, { onBlock(provider) { provider.timestamp = stageReads >= 2 ? 150n : 100n; } });
  const { promise } = run([entry], {
    async getStage(current) {
      stageReads++;
      return stage(current, { startTime: stageReads >= 2 ? 150n : 100n });
    },
  });
  const result = await promise;
  assert.ok(stageReads >= 3);
  assert.equal(result.stage.startTime, 150n);
  assert.equal(result.stage.timestamp, 150n);
});

test('a stage becoming paid or disabled before opening cannot return ready', async () => {
  for (const changed of [{ mintPrice: 1n }, { maxTotalMintableByWallet: 0n }]) {
    let reads = 0;
    const entry = endpoint(0, { onBlock(provider) { provider.timestamp = 100n; } });
    const { promise } = run([entry], {
      async getStage(current) { return stage(current, ++reads > 1 ? changed : {}); },
    });
    await assert.rejects(promise);
    assert.ok(reads >= 2);
  }
});

test('an already expired public stage is rejected without waiting for another opening', async () => {
  const { promise } = run([endpoint(0, { timestamp: 201n })]);
  await assert.rejects(promise, /expired|closed|ended|inactive/i);
});

test('wrong-chain preparation failures are skipped and provider errors remain private', async () => {
  const wrong = endpoint(3, { timestamp: 150n, chainId: '0x1' });
  const good = endpoint(8, { timestamp: 150n });
  const progress = [];
  const { promise } = run([wrong, good], { onProgress: event => progress.push(event) });
  const result = await promise;
  assert.equal(result.entry.provider, good.provider);
  assert.deepEqual(result.entries.map(entry => entry.provider), [good.provider]);
  assert.ok(!JSON.stringify(progress).includes(SECRET));
  assert.ok(!JSON.stringify(progress).includes('private-rpc-token'));
});

test('all initial preparation failures reject with a sanitized error', async () => {
  const { promise } = run([endpoint(0), endpoint(1)], { async prepare() { throw new Error(SECRET); } });
  await assert.rejects(promise, error => {
    assert.ok(!String(error).includes(SECRET));
    return true;
  });
});

test('keepalive drops a primary that changes chains and selects an already prepared backup', async () => {
  const primary = endpoint(4);
  const backup = endpoint(9, { timestamp: 100n });
  const hooks = callbacks();
  let firstRead = true;
  const result = await waitForPublicStage({ entries: [primary, backup], options: WAIT_OPTIONS, ...hooks,
    async getStage(entry) {
      if (firstRead) { firstRead = false; primary.provider.chainId = '0x1'; }
      return stage(entry);
    },
  });
  assert.equal(result.entry.provider, backup.provider);
  assert.equal(result.entry.endpoint, 9);
  assert.equal(result.prepared.source, backup.provider);
  assert.deepEqual(result.entries.map(entry => entry.provider), [backup.provider]);
  assert.deepEqual(hooks.prepared, [primary, backup]);
});

test('a stalled secondary heartbeat cannot delay a ready primary', async () => {
  const pending = deferred();
  const primary = endpoint(0, { onBlock(provider) { if (provider.blockReads >= 8) provider.timestamp = 100n; } });
  const standby = endpoint(1, { onBlock: () => pending.promise });
  const { promise } = run([primary, standby]);
  const result = await promise;
  assert.equal(result.entry.provider, primary.provider);
  assert.ok(standby.provider.blockReads > 0, 'The stalled keepalive must actually have started.');
  assert.equal(result.stage.timestamp, 100n);
  pending.resolve({ number: '0x100', timestamp: '0x5a' });
  await tick();
});

test('a primary stage-read transport failure falls back to a prepared healthy endpoint', async () => {
  const primary = endpoint(0);
  const backup = endpoint(1, { timestamp: 100n });
  const { promise } = run([primary, backup], {
    async getStage(entry) {
      if (entry.provider === primary.provider) throw new Error(SECRET);
      return stage(entry);
    },
  });
  const result = await promise;
  assert.equal(result.entry.provider, backup.provider);
  assert.deepEqual(result.entries.map(entry => entry.provider), [backup.provider]);
});

test('sold-out and paid-stage results cannot be hidden by an older healthy backup', async () => {
  for (const soldOut of [true, false]) {
    const reads = [];
    const primary = endpoint(0, { timestamp: 100n });
    const backup = endpoint(1, { timestamp: 100n });
    const { promise } = run([primary, backup], {
      async getStage(entry) {
        reads.push(entry.endpoint);
        if (entry.provider === primary.provider) {
          if (soldOut) throw new MintError('Insufficient remaining NFT supply for the configured minimum.');
          return stage(entry, { mintPrice: 1n });
        }
        return stage(entry);
      },
    });
    await assert.rejects(promise, /supply|free public stage/i);
    assert.deepEqual(reads, [0]);
  }
});

test('loss of every healthy endpoint fails closed instead of returning the last cached stage', async () => {
  const entry = endpoint(0);
  const { promise } = run([entry], {
    async getStage(current) { current.provider.chainId = '0x1'; return stage(current); },
  });
  await assert.rejects(promise);
});

test('overall deadline includes preparation and ignores its late completion', async () => {
  const pending = deferred();
  let stageReads = 0;
  const { promise } = run([endpoint(0, { timestamp: 150n })], {
    options: { ...WAIT_OPTIONS, waitTimeoutSeconds: 0.06 },
    prepare: () => pending.promise,
    async getStage(entry) { stageReads++; return stage(entry); },
  });
  await assert.rejects(promise, /timeout|timed out|deadline|expired/i);
  pending.resolve({ ready: true });
  await tick();
  assert.equal(stageReads, 0);
});

test('overall deadline interrupts a pending stage query', async () => {
  const pending = deferred();
  const entry = endpoint(0);
  const { promise } = run([entry], {
    options: { ...WAIT_OPTIONS, waitTimeoutSeconds: 0.06 },
    getStage: () => pending.promise,
  });
  await assert.rejects(promise, /timeout|timed out|deadline|expired/i);
  pending.resolve(stage(entry, { timestamp: 150n }));
  await tick();
});

test('an already aborted signal prevents preparation and network reads', async () => {
  const controller = new AbortController();
  controller.abort();
  const entry = endpoint(0);
  const { hooks, promise } = run([entry], { signal: controller.signal });
  await assert.rejects(promise, /abort|cancel|interrupt/i);
  assert.equal(hooks.prepared.length, 0);
  assert.equal(entry.provider.calls.length, 0);
});

test('abort during preparation rejects promptly and prevents late stage reads', async () => {
  const controller = new AbortController();
  const started = deferred();
  const pending = deferred();
  let stageReads = 0;
  const { promise } = run([endpoint(0)], {
    signal: controller.signal,
    prepare() { started.resolve(); return pending.promise; },
    async getStage(entry) { stageReads++; return stage(entry); },
  });
  const rejection = assert.rejects(promise, /abort|cancel|interrupt/i);
  await started.promise;
  controller.abort();
  await rejection;
  pending.resolve({ late: true });
  await tick();
  assert.equal(stageReads, 0);
});

test('abort interrupts an in-flight block request and no ready result is produced later', async () => {
  const controller = new AbortController();
  const started = deferred();
  const pending = deferred();
  const entry = endpoint(0, { onBlock() { started.resolve(); return pending.promise; } });
  const { promise } = run([entry], { signal: controller.signal });
  const rejection = assert.rejects(promise, /abort|cancel|interrupt/i);
  await started.promise;
  controller.abort();
  await rejection;
  pending.resolve({ number: '0x101', timestamp: '0x64' });
  await tick();
});

test('abort while waiting stops further polling and keepalive work', async () => {
  const controller = new AbortController();
  const read = deferred();
  const entry = endpoint(0, { onBlock() { read.resolve(); } });
  const { promise } = run([entry], { signal: controller.signal });
  const rejection = assert.rejects(promise, /abort|cancel|interrupt/i);
  await read.promise;
  controller.abort();
  await rejection;
  const requestsAtAbort = entry.provider.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(entry.provider.calls.length, requestsAtAbort);
});

test('progress callbacks cannot prevent a ready result by throwing or rejecting', async () => {
  for (const onProgress of [() => { throw new Error(SECRET); }, async () => { throw new Error(SECRET); }]) {
    const { promise } = run([endpoint(0, { timestamp: 100n })], { onProgress });
    const result = await promise;
    assert.equal(result.stage.timestamp, 100n);
    await tick();
  }
});

test('cancellation from the ready progress callback still prevents release to the caller', async () => {
  const controller = new AbortController();
  const { promise } = run([endpoint(0, { timestamp: 100n })], {
    signal: controller.signal,
    onProgress(event) { if (event.warmStatus === 'stage ready') controller.abort(); },
  });
  await assert.rejects(promise, /abort|cancel|interrupt/i);
});

test('invalid timeout and polling bounds are rejected before preparation', async () => {
  for (const options of [
    { ...WAIT_OPTIONS, waitTimeoutSeconds: 0 }, { ...WAIT_OPTIONS, waitTimeoutSeconds: -1 },
    { ...WAIT_OPTIONS, waitTimeoutSeconds: Number.NaN }, { ...WAIT_OPTIONS, waitTimeoutSeconds: Infinity },
    { ...WAIT_OPTIONS, pollIntervalMs: 0 }, { ...WAIT_OPTIONS, pollIntervalMs: 1.5 },
    { ...WAIT_OPTIONS, keepAliveIntervalMs: 0 },
  ]) {
    const { hooks, promise } = run([endpoint(0)], { options });
    await assert.rejects(promise);
    assert.equal(hooks.prepared.length, 0);
  }
  const { promise } = run([]);
  await assert.rejects(promise);
});
