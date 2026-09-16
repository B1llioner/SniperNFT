#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { hostname, platform, arch, release } from 'node:os';
import { mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP, isIPv4 } from 'node:net';
import WebSocket from 'ws';

export const FEED = 'wss://feed.mainnet.chain.robinhood.com';
export const SEQUENCER_WS_HYPOTHESIS = 'wss://sequencer.mainnet.chain.robinhood.com';
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_ERRORS = 16;

export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Endpoint must be a valid WSS URL.'); }
  if (url.username || url.password || url.search || url.hash || value.length > 2048) {
    throw new Error('Endpoint must not contain credentials, query parameters or a fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('WSS is required; unencrypted WS is allowed only on loopback.');
  }
  return url;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, p99: null, min: null, max: null };
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95),
    p99: percentile(0.99), min: sorted[0], max: sorted.at(-1) };
}

function safeError(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return 'NETWORK_ERROR';
}

export function probeWebSocket({ endpoint = FEED, mode = 'feed', label = hostname(),
  durationSeconds = 600, intervalMs = 1000, timeoutMs = 5000, warmup = 5, family = 0, connectIp, signal } = {}) {
  const url = validateEndpoint(endpoint);
  if (!['feed', 'capability'].includes(mode)) throw new Error('Unknown probe mode.');
  if (mode === 'capability' && /^feed\.(mainnet|testnet)\.chain\.robinhood\.com$/.test(url.hostname)) {
    throw new Error('The sequencer feed is a receiving stream; JSON-RPC capability probes are forbidden there.');
  }
  integer(durationSeconds, 'durationSeconds', 1, 3600);
  integer(intervalMs, 'intervalMs', 100, 60_000);
  integer(timeoutMs, 'timeoutMs', 50, 60_000);
  integer(warmup, 'warmup', 0, 1000);
  if (![0, 4, 6].includes(family)) throw new Error('family must be 0, 4 or 6.');
  if (connectIp !== undefined && (typeof connectIp !== 'string' || !isIPv4(connectIp) || family === 6 ||
      (url.protocol === 'ws:' && !connectIp.startsWith('127.')) ||
      (isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname !== connectIp))) {
    throw new Error('connectIp must be an IPv4 address compatible with the endpoint and family; plaintext remains loopback-only.');
  }
  if (typeof label !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(label)) {
    throw new Error('Label must contain 1–128 letters, digits, dots, colons, underscores or dashes.');
  }
  const startedMono = performance.now();
  const startedWall = Date.now();
  const report = {
    schemaVersion: 1, mode, label, endpoint: url.href, hostname: url.hostname,
    metric: mode === 'feed' ? 'websocket-control-ping-round-trip' : 'websocket-json-rpc-capability',
    limitation: 'Feed ping RTT and stream arrival are not transaction acceptance or inclusion latency.',
    startedAt: new Date(startedWall).toISOString(), completed: false,
    settings: { durationSeconds, intervalMs, timeoutMs, warmup, family, connectIp, maxMessageBytes: MAX_MESSAGE_BYTES,
      autoReconnect: false, redirects: false, compression: false },
    host: { hostname: hostname(), node: process.version, ws: '8.21.3', platform: platform(), arch: arch(), release: release() },
    connection: { opened: false, attempts: 0, reconnects: 0, disconnects: 0 },
    stream: { messages: 0, bytes: 0, firstMessageAfterOpenMs: null, firstMessageFromStartMs: null },
    counts: { sent: 0, success: 0, timeout: 0, failure: 0, cancelled: 0, skipped: 0, unmatchedPongs: 0 },
    errors: [], samples: [],
  };
  return new Promise(resolveReport => {
    let ws, done = false, openedMono, pending, pingTimer, durationTimer, connectTimer, rpcTimer;
    const rpcId = 'ws-capability-1';
    const errors = code => { if (report.errors.length < MAX_ERRORS) report.errors.push(code); };
    function settlePending(errorCode) {
      if (!pending) return;
      clearTimeout(pending.timer);
      const { record } = pending;
      pending = undefined;
      if (errorCode) {
        record.errorCode = errorCode;
        record.ok = false;
        if (errorCode === 'TIMEOUT') report.counts.timeout++;
        else if (errorCode === 'CANCELLED') report.counts.cancelled++;
        else report.counts.failure++;
      } else {
        record.rttMs = performance.now() - record.sentMono;
        record.ok = true;
        report.counts.success++;
      }
      delete record.sentMono;
      report.samples.push(record);
    }
    function finish(reason, completed = false) {
      if (done) return;
      done = true;
      clearTimeout(connectTimer); clearTimeout(durationTimer); clearTimeout(rpcTimer); clearInterval(pingTimer);
      settlePending('CANCELLED');
      signal?.removeEventListener('abort', abort);
      report.completed = completed;
      report.finishReason = reason;
      report.endedAt = new Date().toISOString();
      report.elapsedMs = performance.now() - startedMono;
      report.clockDriftMs = Date.now() - startedWall - report.elapsedMs;
      report.pingRttMs = percentiles(report.samples.filter(s => s.ok && !s.warmup).map(s => s.rttMs));
      report.measuredCounts = {
        sent: report.samples.filter(s => !s.warmup).length,
        success: report.samples.filter(s => !s.warmup && s.ok).length,
        timeout: report.samples.filter(s => !s.warmup && s.errorCode === 'TIMEOUT').length,
        failure: report.samples.filter(s => !s.warmup && s.errorCode && !['TIMEOUT', 'CANCELLED'].includes(s.errorCode)).length,
        cancelled: report.samples.filter(s => !s.warmup && s.errorCode === 'CANCELLED').length,
      };
      // No retries and no close handshake which could add another unbounded wait.
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
      resolveReport(report);
    }
    const abort = () => finish('CANCELLED');
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    connectTimer = setTimeout(() => { errors('CONNECT_TIMEOUT'); finish('CONNECT_TIMEOUT'); }, timeoutMs);
    try {
      report.connection.attempts++;
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs, followRedirects: false,
        rejectUnauthorized: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES,
        maxFragments: 4096, maxBufferedChunks: 4096, family,
        ...(connectIp === undefined ? {} : { lookup(_hostname, options, callback) {
          queueMicrotask(() => options.all ? callback(null, [{ address: connectIp, family: 4 }]) : callback(null, connectIp, 4));
        } }),
      });
    } catch (error) { errors(safeError(error)); finish('CONNECT_ERROR'); return; }
    ws.on('error', error => {
      if (done) return;
      errors(safeError(error)); settlePending('CONNECTION_ERROR'); finish('CONNECTION_ERROR');
    });
    ws.on('unexpected-response', (_request, response) => {
      if (done) { response.destroy(); return; }
      report.connection.httpStatus = response.statusCode;
      errors('HTTP_UPGRADE_REJECTED'); response.destroy(); finish('HTTP_UPGRADE_REJECTED');
    });
    ws.on('upgrade', response => {
      report.connection.httpStatus = response.statusCode;
      report.connection.remoteAddress = response.socket.remoteAddress;
      report.connection.remoteFamily = response.socket.remoteFamily;
      report.connection.tlsProtocol = response.socket.getProtocol?.();
    });
    ws.on('close', code => {
      if (done) return;
      report.connection.disconnects++;
      report.connection.closeCode = code;
      errors('CONNECTION_CLOSED'); settlePending('CONNECTION_CLOSED'); finish('CONNECTION_CLOSED');
    });
    ws.on('message', data => {
      if (done || openedMono === undefined) return;
      report.stream.messages++;
      report.stream.bytes += data.byteLength;
      if (report.stream.firstMessageAfterOpenMs === null) {
        report.stream.firstMessageAfterOpenMs = performance.now() - openedMono;
        report.stream.firstMessageFromStartMs = performance.now() - startedMono;
      }
      if (mode !== 'capability') return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message?.id !== rpcId || message.jsonrpc !== '2.0') return;
      report.capability = { upgrade: true, rpcResponded: true,
        method: 'arb_checkPublisherHealth', rpcSucceeded: Object.hasOwn(message, 'result') && message.result === null && !Object.hasOwn(message, 'error'),
        responseAfterOpenMs: performance.now() - openedMono,
        ...(Number.isSafeInteger(message.error?.code) ? { rpcErrorCode: message.error.code } : {}) };
      finish('CAPABILITY_RESPONSE', true);
    });
    ws.on('pong', data => {
      if (done) return;
      if (!pending || !data.equals(pending.payload)) { report.counts.unmatchedPongs++; return; }
      settlePending();
    });
    ws.on('open', () => {
      if (done) return;
      clearTimeout(connectTimer);
      openedMono = performance.now();
      report.connection.opened = true;
      report.connection.openLatencyMs = openedMono - startedMono;
      report.connection.openedAt = new Date().toISOString();
      if (mode === 'capability') {
        report.capability = { upgrade: true, rpcResponded: false, method: 'arb_checkPublisherHealth', rpcSucceeded: false };
        rpcTimer = setTimeout(() => { errors('RPC_TIMEOUT'); finish('RPC_TIMEOUT'); }, timeoutMs);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'arb_checkPublisherHealth', params: [] }), error => {
          if (error && !done) { errors(safeError(error)); finish('SEND_ERROR'); }
        });
        return;
      }
      const ping = () => {
        if (done) return;
        if (pending) { report.counts.skipped++; return; }
        const id = ++report.counts.sent;
        const payload = Buffer.from(`vinos-ping-${id}`);
        const sentMono = performance.now();
        pending = { payload, record: { id, warmup: id <= warmup, sentAfterOpenMs: sentMono - openedMono, sentMono },
          timer: setTimeout(() => settlePending('TIMEOUT'), timeoutMs) };
        ws.ping(payload, undefined, error => {
          if (error && !done && pending?.record.id === id) settlePending('SEND_ERROR');
        });
      };
      durationTimer = setTimeout(() => finish('DURATION_COMPLETE', true), durationSeconds * 1000);
      pingTimer = setInterval(ping, intervalMs);
      ping();
    });
  });
}

export async function writeReport(path, report) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // An atomic no-clobber publication: existing files and symlinks are refused.
    await link(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function parseArgs(args) {
  const options = { mode: 'feed', endpoint: FEED, durationSeconds: 600, intervalMs: 1000, timeoutMs: 5000, warmup: 5,
    family: 0, label: hostname(), output: 'websocket-report.json' };
  if (args[0] === 'capability') { options.mode = 'capability'; options.endpoint = SEQUENCER_WS_HYPOTHESIS; args = args.slice(1); }
  else if (args[0] === 'probe') args = args.slice(1);
  const names = { '--endpoint': 'endpoint', '--duration-seconds': 'durationSeconds', '--interval-ms': 'intervalMs',
    '--timeout-ms': 'timeoutMs', '--warmup': 'warmup', '--label': 'label', '--output': 'output', '--start-at': 'startAt', '--family': 'family', '--connect-ip': 'connectIp' };
  const numbers = new Set(['durationSeconds', 'intervalMs', 'timeoutMs', 'warmup', 'family']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    const key = names[args[i]];
    if (!key || seen.has(key) || i + 1 === args.length || args[i + 1].startsWith('--')) throw new Error('Invalid, duplicate or incomplete option.');
    seen.add(key);
    const value = args[++i];
    if (numbers.has(key) && !/^\d+$/.test(value)) throw new Error('Numeric options require decimal integers.');
    options[key] = numbers.has(key) ? Number(value) : value;
  }
  if (options.startAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(options.startAt) ||
    !Number.isFinite(Date.parse(options.startAt)) || Date.parse(options.startAt) - Date.now() > 86_400_000)) {
    throw new Error('--start-at must be a valid ISO UTC time at most 24 hours ahead.');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node probe.mjs [probe|capability] [--endpoint WSS_URL] [--duration-seconds 600] [--interval-ms 1000] [--timeout-ms 5000] [--warmup 5] [--family 0|4|6] [--connect-ip IPV4] [--start-at ISO_UTC] [--label NAME] [--output report.json]');
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  if (options.startAt) {
    while (!controller.signal.aborted && Date.now() < Date.parse(options.startAt)) {
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(250, Date.parse(options.startAt) - Date.now())));
    }
  }
  const report = await probeWebSocket({ ...options, signal: controller.signal });
  report.requestedStartAt = options.startAt ?? null;
  await writeReport(options.output, report);
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify({ mode: report.mode, label: report.label, completed: report.completed, finishReason: report.finishReason,
    connection: report.connection, pingRttMs: report.pingRttMs, measuredCounts: report.measuredCounts,
    capability: report.capability, stream: report.stream, errors: report.errors, output: resolve(options.output),
    limitation: report.limitation }, null, 2));
  if (!report.completed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`WebSocket probe failed: ${['EEXIST', 'EACCES', 'ENOENT'].includes(error.code) ? error.code : error.message}`); process.exitCode = 1; });
}
