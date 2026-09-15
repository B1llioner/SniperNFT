import { MintError, createProvider } from '../mint.mjs';

export const SEQUENCER_URL = 'https://sequencer.mainnet.chain.robinhood.com';

/** Keep Nitro's send-only connection alive without querying chain state there.
 * Signing, transaction lookup and receipts belong to the caller/read RPCs.
 */
export async function openSequencer(options, { register = () => {}, onProgress, signal } = {}) {
  const provider = createProvider(options.sequencerUrl ?? SEQUENCER_URL);
  register(provider);
  let timer, pending;
  let closed = false;
  let healthy = false;
  function progress(status) {
    try { Promise.resolve(onProgress?.({ sequencerStatus: status })).catch(() => {}); } catch { /* Reporting only. */ }
  }
  function live() {
    if (closed || signal?.aborted) throw new MintError('Sequencer connection cancelled.');
  }
  async function probe() {
    live();
    if (!pending) {
      pending = (async () => {
        try {
          const result = await provider.send('arb_checkPublisherHealth', []);
          live();
          if (result !== null) throw new MintError('Unexpected sequencer health response.');
          if (!healthy) progress('publisher healthy; connection warm');
          healthy = true;
        } catch {
          healthy = false;
          throw new MintError('Sequencer publisher health check failed. No automatic RPC broadcast fallback.');
        }
      })().finally(() => { pending = undefined; });
    }
    return pending;
  }
  function schedule() {
    if (closed) return;
    timer = setTimeout(async () => {
      try { await probe(); } catch { if (!closed) progress('publisher unavailable; will recheck'); }
      schedule();
    }, options.keepAliveIntervalMs);
    timer.unref?.();
  }
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', close);
    provider.destroy();
  }
  signal?.addEventListener('abort', close, { once: true });
  try {
    await probe();
    live();
    schedule();
    return { provider, close, ensureHealthy: async () => {
      live();
      if (pending) await pending;
      else if (!healthy) await probe();
      live();
    } };
  } catch (error) { close(); throw error; }
}
