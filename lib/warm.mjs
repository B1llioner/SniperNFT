import { MintError, parseUint, CONFIG } from '../mint.mjs';

function check(condition, message) { if (!condition) throw new MintError(message); }
function progress(callback, event) {
  try { Promise.resolve(callback?.(event)).catch(() => {}); } catch { /* Reporting cannot arm a transaction. */ }
}

/** Prepare once, keep the same RPC connections active, and wait for chain time.
 * No signing, transaction submission, or simulated block-time override occurs here.
 */
export async function waitForPublicStage({ entries, options, prepare, getStage, onProgress, signal }) {
  check(Array.isArray(entries) && entries.length > 0 && entries.length <= 8, 'Warm mode requires between 1 and 8 RPC endpoints.');
  check(typeof prepare === 'function' && typeof getStage === 'function', 'Warm mode callbacks are missing.');
  const { waitTimeoutSeconds, pollIntervalMs, keepAliveIntervalMs, targetTimestamp, targetBlock } = options;
  check(Number.isFinite(waitTimeoutSeconds) && waitTimeoutSeconds > 0 && waitTimeoutSeconds <= 86400, 'Invalid warm wait timeout.');
  check([pollIntervalMs, keepAliveIntervalMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 60000), 'Invalid warm polling interval.');
  for (const [name, value] of Object.entries({ targetTimestamp, targetBlock })) {
    check(value == null || (typeof value === 'bigint' && value >= 0n), `${name} must be a non-negative bigint when provided.`);
  }
  let stopped;
  let stopReject;
  const stoppedPromise = new Promise((_, reject) => { stopReject = reject; });
  stoppedPromise.catch(() => {});
  function stop(message) {
    if (stopped) return;
    stopped = new MintError(message);
    stopReject(stopped);
  }
  const abort = () => stop('Warm mode cancelled. No new transaction will be signed or submitted.');
  const timeout = setTimeout(() => stop('Warm wait timed out before the public stage became ready.'), Math.ceil(waitTimeoutSeconds * 1000));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  function live() { if (stopped) throw stopped; }
  async function guard(operation) {
    live();
    const result = await Promise.race([Promise.resolve().then(() => { live(); return operation(); }), stoppedPromise]);
    live();
    return result;
  }
  async function sleep(ms) {
    let timer;
    try { await guard(() => new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, ms)); })); }
    finally { clearTimeout(timer); }
  }
  function validateStage(stage) {
    const normalized = Object.fromEntries(['startTime', 'endTime', 'mintPrice', 'maxTotalMintableByWallet', 'timestamp']
      .map(name => [name, parseUint(stage?.[name], name)]));
    check(normalized.mintPrice === 0n, 'Warm mode supports only a free public stage.');
    check(normalized.maxTotalMintableByWallet > 0n, 'Public minting is disabled.');
    check(normalized.endTime >= normalized.startTime && normalized.endTime > 0n, 'Public stage has no valid schedule.');
    check(normalized.timestamp <= normalized.endTime, 'The public stage has ended.');
    check(targetBlock == null || stage?.blockNumber != null, 'RPC returned no block number required by targetBlock.');
    if (stage?.blockNumber != null) normalized.blockNumber = parseUint(stage.blockNumber, 'block number');
    return normalized;
  }
  function ready(stage) {
    return stage.timestamp >= stage.startTime &&
      (targetTimestamp == null || stage.timestamp >= targetTimestamp) &&
      (targetBlock == null || stage.blockNumber >= targetBlock);
  }
  function clockFields(stage) {
    return { chainTimestamp: stage.timestamp.toString(),
      ...(stage.blockNumber != null ? { chainBlockNumber: stage.blockNumber.toString() } : {}) };
  }
  try {
    const prepared = await guard(() => Promise.allSettled(entries.map(async entry => ({ ...entry, prepared: await prepare(entry) }))));
    let healthy = prepared.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        progress(onProgress, { endpoint: entries[index].endpoint, warmStatus: 'prepared' });
        return [result.value];
      }
      progress(onProgress, { endpoint: entries[index].endpoint, warmStatus: 'preparation failed; skipped' });
      return [];
    });
    check(healthy.length > 0, 'No RPC passed the warm contract and wallet checks.');
    let selected = healthy[0];
    async function refreshStage() {
      while (true) {
        let raw;
        try { raw = await guard(() => getStage(selected)); }
        catch (error) {
          live();
          // Application checks such as sold out must not be hidden by an older
          // backup snapshot. Transport/decoding failures may use a prepared RPC.
          if (error instanceof MintError) throw error;
          healthy = healthy.filter(entry => entry !== selected);
          check(healthy.length > 0, 'No prepared RPC can read the public stage.');
          selected = healthy[0];
          progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'using prepared fallback' });
          continue;
        }
        return validateStage(raw);
      }
    }
    let stage = await refreshStage();
    let heartbeatAt = Date.now();
    let heartbeat;
    let healthResult;
    const probeHealth = () => {
      if (heartbeat) return;
      const probed = [...healthy];
      heartbeat = Promise.allSettled(probed.map(async entry => {
        const [chainId, block] = await Promise.all([
          entry.provider.send('eth_chainId', []), entry.provider.send('eth_getBlockByNumber', ['latest', false]),
        ]);
        check(parseUint(chainId) === CONFIG.chainId, 'Wrong RPC chain during warm wait.');
        check(block?.timestamp != null, 'RPC returned no block timestamp.');
        parseUint(block.timestamp, 'block timestamp');
        if (targetBlock != null) parseUint(block?.number, 'block number required by targetBlock');
        return entry;
      })).then(results => { if (!stopped) healthResult = { results, probed }; })
        .finally(() => { heartbeat = undefined; });
    };
    progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'waiting', startTime: stage.startTime.toString(), endTime: stage.endTime.toString(), ...clockFields(stage),
      ...(targetTimestamp != null ? { targetTimestamp: targetTimestamp.toString() } : {}),
      ...(targetBlock != null ? { targetBlock: targetBlock.toString() } : {}) });
    while (true) {
      live();
      if (healthResult) {
        const { results, probed } = healthResult;
        healthResult = undefined;
        const failed = new Set(results.flatMap((result, index) => result.status === 'rejected' ? [probed[index]] : []));
        healthy = healthy.filter(entry => !failed.has(entry));
        for (const entry of failed) progress(onProgress, { endpoint: entry.endpoint, warmStatus: 'unavailable or wrong chain; skipped' });
        check(healthy.length > 0, 'All warmed RPC endpoints became unavailable.');
        if (!healthy.includes(selected)) {
          selected = healthy[0];
          stage = await refreshStage();
          progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'using prepared fallback' });
        }
      }
      if (ready(stage)) {
        // Re-read mutable drop configuration at the release boundary. The caller
        // still performs the final eth_call, gas estimate, fees and nonce checks.
        stage = await refreshStage();
        if (ready(stage)) {
          live();
          progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'stage ready', ...clockFields(stage) });
          live();
          return { entry: selected, prepared: selected.prepared, entries: healthy, stage };
        }
      }

      const timeBoundary = targetTimestamp != null && targetTimestamp > stage.startTime ? targetTimestamp : stage.startTime;
      const secondsRemaining = timeBoundary - stage.timestamp;
      await sleep(secondsRemaining > 15n ? keepAliveIntervalMs : pollIntervalMs);
      if (Date.now() - heartbeatAt >= keepAliveIntervalMs) {
        // Slow standby RPCs must not hold up the primary's start detection.
        probeHealth();
        stage = await refreshStage();
        heartbeatAt = Date.now();
        progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'alive', ...clockFields(stage), startTime: stage.startTime.toString() });
      } else {
        let block;
        try {
          block = await guard(() => selected.provider.send('eth_getBlockByNumber', ['latest', false]));
          stage.timestamp = parseUint(block?.timestamp, 'block timestamp');
        } catch (error) {
          live();
          // Switch only before signing, and only to an endpoint already prepared.
          healthy = healthy.filter(entry => entry !== selected);
          check(healthy.length > 0, 'No prepared RPC is available to observe the public stage.');
          selected = healthy[0];
          stage = await refreshStage();
          progress(onProgress, { endpoint: selected.endpoint, warmStatus: 'using prepared fallback' });
          continue;
        }
        check(targetBlock == null || block?.number != null, 'RPC returned no block number required by targetBlock.');
        if (block.number != null) stage.blockNumber = parseUint(block.number, 'block number');
        // The owner may have extended or replaced the cached window. Re-read
        // its current configuration before declaring it expired.
        if (stage.timestamp > stage.endTime) stage = await refreshStage();
      }
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
