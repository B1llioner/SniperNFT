import { Transaction, keccak256 } from 'ethers';

export class BroadcastError extends Error {
  constructor(message, hash) {
    super(message);
    this.name = 'BroadcastError';
    if (hash) this.hash = hash;
  }
}

function requireThat(condition, message) {
  if (!condition) throw new BroadcastError(message);
}

function boundedInteger(value, minimum, maximum, name) {
  requireThat(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} must be an integer between ${minimum} and ${maximum}.`);
}

function transactionHash(raw) {
  requireThat(typeof raw === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw),
    'A serialized signed transaction is required.');
  try {
    const transaction = Transaction.from(raw);
    requireThat(transaction.isSigned() && transaction.from !== null,
      'A serialized signed transaction is required.');
    requireThat(transaction.chainId === 4663n,
      'The signed transaction must use Robinhood Chain ID 4663.');
    const hash = keccak256(raw);
    requireThat(transaction.hash === hash,
      'The signed transaction must use canonical serialization.');
    return hash;
  } catch (error) {
    if (error instanceof BroadcastError) throw error;
    throw new BroadcastError('Cannot decode the signed transaction.');
  }
}

/**
 * Submit one already signed transaction to selected broadcast providers.
 * Send-only endpoints require separate chain-verified lookupProviders.
 * Providers must enforce request timeouts and disable their own HTTP retries.
 * This function never signs, changes the nonce, or creates another transaction.
 */
export async function broadcastIdentical(raw, providers, options = {}) {
  requireThat(options !== null && typeof options === 'object' && !Array.isArray(options),
    'Broadcast options must be an object.');
  const { concurrency = 2, attempts = 2, retryDelayMs = 250, onAttempt = () => {} } = options;
  boundedInteger(concurrency, 1, 8, 'concurrency');
  boundedInteger(attempts, 1, 5, 'attempts');
  boundedInteger(retryDelayMs, 0, 5000, 'retryDelayMs');
  requireThat(typeof onAttempt === 'function', 'onAttempt must be a function.');
  requireThat(Array.isArray(providers) && providers.length >= 1 && providers.length <= 8,
    'Provide between 1 and 8 RPC providers.');
  requireThat(providers.every(provider => provider && typeof provider.send === 'function'),
    'Every RPC provider must support send.');
  const lookupProviders = options.lookupProviders;
  if (lookupProviders !== undefined) {
    requireThat(Array.isArray(lookupProviders) && lookupProviders.length >= 1 && lookupProviders.length <= 8 &&
      lookupProviders.every(provider => provider && typeof provider.send === 'function'),
    'Provide between 1 and 8 transaction lookup providers.');
  }
  const hash = transactionHash(raw);
  const { signal } = options;
  requireThat(signal == null || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'), 'signal must be an AbortSignal.');
  function live() {
    if (signal?.aborted) throw new BroadcastError(`Broadcast cancelled. Check transaction ${hash} before retrying; an in-flight submission may have succeeded.`, hash);
  }
  async function delay() {
    live();
    let timer;
    const abort = () => { clearTimeout(timer); resolveDelay(); };
    let resolveDelay;
    try {
      await new Promise(resolve => {
        resolveDelay = resolve;
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(resolve, retryDelayMs);
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    live();
  }
  live();
  const outcomes = Array(providers.length).fill('failed');
  let observed = false;

  function notify(endpoint, attempt, status) {
    // Progress reporting must not turn an accepted transaction into an error.
    try {
      const result = onAttempt({ endpoint, attempt, status });
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* The broadcast result remains authoritative. */ }
  }

  async function submit(endpoint, attempt) {
    live();
    notify(endpoint, attempt, 'sending');
    live();
    let returned;
    try {
      returned = await providers[endpoint].send('eth_sendRawTransaction', [raw]);
    } catch { /* A transport error does not establish whether the RPC accepted it. */ }
    live();

    if (typeof returned === 'string' && returned.toLowerCase() === hash) {
      outcomes[endpoint] = 'accepted';
      observed = true;
      notify(endpoint, attempt, 'accepted');
      return;
    }

    // Error text such as "already known" is insufficient evidence. Check our
    // locally computed hash, including when an RPC returns a different hash.
    const lookups = await Promise.allSettled((lookupProviders ?? [providers[endpoint]])
      .map(provider => Promise.resolve().then(() => provider.send('eth_getTransactionByHash', [hash]))));
    live();
    if (lookups.some(result => result.status === 'fulfilled' &&
      typeof result.value?.hash === 'string' && result.value.hash.toLowerCase() === hash)) {
      outcomes[endpoint] = 'known';
      observed = true;
      notify(endpoint, attempt, 'known');
      return;
    }
    notify(endpoint, attempt, 'failed');
  }

  async function round(attempt) {
    const endpoints = outcomes.flatMap((outcome, index) => outcome === 'failed' ? [index] : []);
    let next = 0;
    async function worker() {
      while (next < endpoints.length) {
        live();
        // Complete the initial fanout. Subsequent rounds stop starting requests
        // as soon as another endpoint observes this same transaction.
        if (attempt > 1 && observed) return;
        const endpoint = endpoints[next++];
        await submit(endpoint, attempt);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, endpoints.length) }, () => worker()));
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    live();
    if (attempt > 1) {
      if (observed) break;
      if (retryDelayMs > 0) await delay();
    }
    await round(attempt);
    if (observed) break;
  }

  if (!observed) {
    throw new BroadcastError(
      `Broadcast outcome is uncertain. Check transaction ${hash} before retrying.`, hash,
    );
  }
  return {
    hash,
    acceptedBy: outcomes.flatMap((outcome, index) => outcome === 'accepted' ? [index] : []),
    knownBy: outcomes.flatMap((outcome, index) => outcome === 'known' ? [index] : []),
    failed: outcomes.flatMap((outcome, index) => outcome === 'failed' ? [index] : []),
  };
}
