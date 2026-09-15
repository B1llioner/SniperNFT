import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction, Wallet, keccak256 } from 'ethers';
import { BroadcastError, broadcastIdentical } from '../lib/broadcast.mjs';

// Public deterministic test key only; no live provider is used in this suite.
const wallet = new Wallet(`0x${'31'.repeat(32)}`);
const unsigned = {
  type: 2, chainId: 4663, nonce: 7,
  to: '0x0000000000000000000000000000000000000123',
  gasLimit: 350000, maxFeePerGas: 100000000, maxPriorityFeePerGas: 0,
  data: '0x12345678', value: 0,
};
const raw = await wallet.signTransaction(unsigned);
const hash = keccak256(raw);
const wrongHash = `0x${'00'.repeat(32)}`;
const immediate = () => new Promise(resolve => setImmediate(resolve));

function provider(sendResult, knownResult = null) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'eth_sendRawTransaction') return sendResult(params[0], calls);
      assert.equal(method, 'eth_getTransactionByHash');
      assert.deepEqual(params, [hash]);
      return typeof knownResult === 'function' ? knownResult() : knownResult;
    },
  };
}

const rejects = () => { throw new Error('RPC unavailable https://secret.example/API-KEY'); };

test('every endpoint receives the same signed bytes, sender, nonce, and hash', async () => {
  const providers = Array.from({ length: 3 }, () => provider(() => hash));
  const result = await broadcastIdentical(raw, providers, { concurrency: 2 });
  assert.deepEqual(result, { hash, acceptedBy: [0, 1, 2], knownBy: [], failed: [] });
  for (const item of providers) {
    assert.equal(item.calls.length, 1);
    const submitted = item.calls[0].params[0];
    assert.equal(submitted, raw);
    const transaction = Transaction.from(submitted);
    assert.equal(transaction.nonce, 7);
    assert.equal(transaction.from, wallet.address);
    assert.equal(transaction.hash, hash);
  }
});

test('fanout obeys the concurrency bound while completing every initial attempt', async () => {
  let active = 0;
  let maximum = 0;
  const providers = Array.from({ length: 8 }, () => provider(async () => {
    maximum = Math.max(maximum, ++active);
    await immediate();
    active--;
    return hash;
  }));
  const result = await broadcastIdentical(raw, providers, { concurrency: 3 });
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.deepEqual(result.acceptedBy, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a secondary success stops retries at the failed primary', async () => {
  const primary = provider(rejects);
  const secondary = provider(() => hash);
  const result = await broadcastIdentical(raw, [primary, secondary], { attempts: 5, retryDelayMs: 0 });
  assert.deepEqual(result, { hash, acceptedBy: [1], knownBy: [], failed: [0] });
  assert.equal(primary.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
});

test('already known requires a matching transaction lookup, not an error message', async () => {
  const alreadyKnown = () => { throw new Error('already known'); };
  const known = provider(alreadyKnown, { hash });
  assert.deepEqual(await broadcastIdentical(raw, [known]), {
    hash, acceptedBy: [], knownBy: [0], failed: [],
  });
  const absent = provider(alreadyKnown, null);
  await assert.rejects(broadcastIdentical(raw, [absent], { attempts: 1 }), BroadcastError);
  const different = provider(alreadyKnown, { hash: wrongHash });
  await assert.rejects(broadcastIdentical(raw, [different], { attempts: 1 }), BroadcastError);
});

test('a mismatched returned hash cannot establish acceptance', async () => {
  const endpoint = provider(() => wrongHash);
  await assert.rejects(broadcastIdentical(raw, [endpoint], { attempts: 1 }), error => {
    assert.ok(error instanceof BroadcastError);
    assert.equal(error.hash, hash);
    return true;
  });
  assert.deepEqual(endpoint.calls.map(call => call.method), ['eth_sendRawTransaction', 'eth_getTransactionByHash']);
});

test('send-only sequencer uses separate read RPCs to resolve an ambiguous acknowledgement', async () => {
  const sequencer = provider(rejects, () => { assert.fail('No lookup may reach the sequencer.'); });
  const firstReader = provider(() => assert.fail('No raw may reach a reader.'), null);
  const secondReader = provider(() => assert.fail('No raw may reach a reader.'), { hash });
  const result = await broadcastIdentical(raw, [sequencer], {
    lookupProviders: [firstReader, secondReader], attempts: 3, retryDelayMs: 0,
  });
  assert.deepEqual(result, { hash, acceptedBy: [], knownBy: [0], failed: [] });
  assert.deepEqual(sequencer.calls.map(call => call.method), ['eth_sendRawTransaction']);
  for (const reader of [firstReader, secondReader]) {
    assert.deepEqual(reader.calls, [{ method: 'eth_getTransactionByHash', params: [hash] }]);
  }
});

test('sequencer retries preserve bytes and never fall back to broadcasting through readers', async () => {
  const sequencer = provider(rejects);
  const reader = provider(() => assert.fail('Broadcast fallback is forbidden.'), { hash: wrongHash });
  await assert.rejects(broadcastIdentical(raw, [sequencer], {
    lookupProviders: [reader], attempts: 2, retryDelayMs: 0,
  }), error => error instanceof BroadcastError && error.hash === hash);
  assert.deepEqual(sequencer.calls, Array.from({ length: 2 }, () => ({ method: 'eth_sendRawTransaction', params: [raw] })));
  assert.ok(reader.calls.every(call => call.method === 'eth_getTransactionByHash'));
});

test('uncertain failures have bounded retries and expose no raw or provider details', async () => {
  const events = [];
  const providers = [provider(rejects), provider(rejects, () => { throw new Error(raw); })];
  await assert.rejects(broadcastIdentical(raw, providers, {
    attempts: 3, retryDelayMs: 0, onAttempt: event => events.push(event),
  }), error => {
    assert.ok(error instanceof BroadcastError);
    assert.equal(error.hash, hash);
    assert.ok(error.message.includes(hash));
    assert.ok(!String(error.stack).includes(raw));
    assert.ok(!String(error.stack).includes('secret.example'));
    assert.ok(!String(error.stack).includes('API-KEY'));
    return true;
  });
  for (const endpoint of providers) {
    const sends = endpoint.calls.filter(call => call.method === 'eth_sendRawTransaction');
    assert.equal(sends.length, 3);
    assert.ok(sends.every(call => call.params[0] === raw));
  }
  assert.equal(events.length, 12);
  assert.ok(events.every(event => Object.keys(event).sort().join(',') === 'attempt,endpoint,status'));
  assert.deepEqual([...new Set(events.map(event => event.status))], ['sending', 'failed']);
});

test('success during a retry prevents starting queued retries', async () => {
  const counts = [0, 0, 0];
  const providers = counts.map((_, index) => provider(() => {
    counts[index]++;
    if (index === 0 && counts[index] === 2) return hash;
    throw new Error('not accepted');
  }));
  const result = await broadcastIdentical(raw, providers, { concurrency: 1, attempts: 5, retryDelayMs: 0 });
  assert.deepEqual(counts, [2, 1, 1]);
  assert.deepEqual(result, { hash, acceptedBy: [0], knownBy: [], failed: [1, 2] });
});

test('initial jobs finish and active retries settle after another worker succeeds', async () => {
  let round = 0;
  let settled = false;
  const first = provider(async () => {
    if (++round === 1) throw new Error('first attempt');
    await immediate();
    return hash;
  });
  let secondAttempts = 0;
  const second = provider(async () => {
    secondAttempts++;
    if (secondAttempts === 1) throw new Error('first attempt');
    await immediate();
    await immediate();
    settled = true;
    throw new Error('still failed');
  });
  const result = await broadcastIdentical(raw, [first, second], { concurrency: 2, attempts: 5, retryDelayMs: 0 });
  assert.equal(settled, true);
  assert.equal(secondAttempts, 2);
  assert.deepEqual(result.acceptedBy, [0]);
});

test('progress callback failures cannot hide an accepted transaction', async () => {
  const endpoint = provider(() => hash);
  const result = await broadcastIdentical(raw, [endpoint], { onAttempt: () => { throw new Error(raw); } });
  assert.deepEqual(result.acceptedBy, [0]);
});

test('cancellation interrupts the retry delay without another submission or callback', async () => {
  const controller = new AbortController();
  const endpoint = provider(rejects);
  const events = [];
  const sending = broadcastIdentical(raw, [endpoint], {
    signal: controller.signal, attempts: 5, retryDelayMs: 5000,
    onAttempt: event => {
      events.push(event);
      if (event.status === 'failed') setImmediate(() => controller.abort());
    },
  });
  let timer;
  try {
    await assert.rejects(Promise.race([sending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not interrupt the retry delay.')), 500);
    })]), error => error instanceof BroadcastError && error.hash === hash && /cancelled/.test(error.message));
  } finally { clearTimeout(timer); }
  assert.deepEqual(events.map(event => event.status), ['sending', 'failed']);
  assert.equal(endpoint.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
});

test('already cancelled signals and cancellation from progress prevent first submission', async () => {
  const controller = new AbortController();
  const endpoint = provider(() => hash);
  controller.abort();
  await assert.rejects(broadcastIdentical(raw, [endpoint], { signal: controller.signal }), /cancelled/);
  const next = new AbortController();
  await assert.rejects(broadcastIdentical(raw, [endpoint], {
    signal: next.signal, onAttempt: () => next.abort(),
  }), /cancelled/);
  assert.equal(endpoint.calls.length, 0);
});

test('invalid bounds and providers fail before any network calls', async () => {
  const endpoint = provider(() => hash);
  const invalid = [
    { concurrency: 0 }, { concurrency: 9 }, { concurrency: 1.5 },
    { attempts: 0 }, { attempts: 6 }, { attempts: '2' },
    { retryDelayMs: -1 }, { retryDelayMs: 5001 }, { retryDelayMs: NaN },
    { onAttempt: null }, null,
    { lookupProviders: [] }, { lookupProviders: null }, { lookupProviders: [{}] },
    { lookupProviders: Array(9).fill(endpoint) },
    { signal: {} },
  ];
  for (const options of invalid) await assert.rejects(broadcastIdentical(raw, [endpoint], options), BroadcastError);
  for (const providers of [null, [], Array(9).fill(endpoint), [{}], [null]]) {
    await assert.rejects(broadcastIdentical(raw, providers), BroadcastError);
  }
  assert.equal(endpoint.calls.length, 0);
});

test('unsigned, malformed, and wrong-chain transactions are rejected before submission', async () => {
  const endpoint = provider(() => hash);
  const wrongChain = await wallet.signTransaction({ ...unsigned, chainId: 1 });
  for (const invalid of [null, '', '0x', '0x123', '0x1234', Transaction.from(unsigned).unsignedSerialized, wrongChain]) {
    await assert.rejects(broadcastIdentical(invalid, [endpoint]), BroadcastError);
  }
  assert.equal(endpoint.calls.length, 0);
});
