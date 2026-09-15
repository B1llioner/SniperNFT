import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let nextRequestId = 0;

function validateEndpoint(value) {
  let endpoint;
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    endpoint = new URL(value);
  } catch {
    throw new TypeError('The probe endpoint must be a valid HTTPS URL.');
  }
  if (endpoint.username || endpoint.password || endpoint.href.includes('#')) {
    throw new TypeError('The probe endpoint cannot contain credentials or a fragment.');
  }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && LOOPBACK_HOSTS.has(endpoint.hostname))) {
    throw new TypeError('The probe endpoint requires HTTPS; HTTP is allowed only on loopback.');
  }
  return endpoint;
}

function networkErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA'].includes(code)) return 'DNS_ERROR';
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code.includes('CERT') ||
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) {
    return 'TLS_ERROR';
  }
  if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'CONNECT_ERROR';
  return 'NETWORK_ERROR';
}

/**
 * An unsigned publisher-health probe. Each instance owns one warm HTTP/1.1 pool;
 * cold requests use a fresh agent with TLS session caching disabled. Timings use
 * a monotonic clock. firstByte includes connection setup (and any agent queue),
 * while dns/tcp/tls measure individual setup phases when those phases occur.
 */
export function createAzProbe({ endpoint: value, timeoutMs = 5000, family = 0, ca } = {}) {
  const endpoint = validateEndpoint(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) {
    throw new TypeError('Probe timeoutMs must be an integer from 50 to 60000.');
  }
  if (![0, 4, 6].includes(family)) throw new TypeError('Probe family must be 0, 4 or 6.');
  const client = endpoint.protocol === 'https:' ? https : http;
  const isTls = endpoint.protocol === 'https:';
  const agentOptions = {
    keepAlive: true, maxSockets: 1, maxFreeSockets: 1, scheduling: 'lifo',
    ...(isTls ? { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) } : {}),
  };
  const warmAgent = new client.Agent(agentOptions);
  const active = new Set();
  let closed = false;

  function probe(cold) {
    const started = performance.now();
    const timingsMs = {};
    if (closed) return Promise.resolve({
      ok: false, errorCode: 'CANCELLED', timingsMs: { total: performance.now() - started },
      reusedSocket: false, tlsSessionReused: false,
    });
    const agent = cold
      ? new client.Agent({ ...agentOptions, keepAlive: false, maxCachedSessions: 0 })
      : warmAgent;
    const id = `az-probe-${++nextRequestId}`;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'arb_checkPublisherHealth', params: [] }));

    return new Promise(resolve => {
      let request;
      let response;
      let socket;
      let socketStarted;
      let dnsEnded;
      let connected;
      let settled = false;
      let reusedSocket = false;
      let tlsSessionReused = false;
      let remoteAddress;
      let remoteFamily;
      let httpStatus;
      let timer;
      const socketListeners = [];
      const cancel = () => finish('CANCELLED');

      function observeRemote() {
        if (typeof socket?.remoteAddress === 'string') remoteAddress = socket.remoteAddress;
        if (typeof socket?.remoteFamily === 'string') remoteFamily = socket.remoteFamily;
      }

      function listenSocket(event, handler) {
        socket.once(event, handler);
        socketListeners.push([event, handler]);
      }

      function finish(errorCode, extra = {}) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(cancel);
        observeRemote();
        for (const [event, handler] of socketListeners) socket?.removeListener(event, handler);
        const record = {
          ok: errorCode === undefined,
          ...(errorCode ? { errorCode } : {}),
          timingsMs: { ...timingsMs, total: performance.now() - started },
          reusedSocket, tlsSessionReused,
          ...(remoteAddress ? { remoteAddress } : {}),
          ...(remoteFamily ? { remoteFamily } : {}),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...extra,
        };
        // Destroy timed-out sockets, including stalled bodies, instead of leaving
        // them in the warm pool. No error messages or URLs enter the result.
        if (errorCode) {
          response?.destroy();
          request?.destroy();
        }
        if (cold) agent.destroy();
        resolve(record);
      }

      active.add(cancel);
      // Socket inactivity timeouts miss DNS, connection queues and slow trickles.
      timer = setTimeout(() => finish('TIMEOUT'), timeoutMs);
      try {
        request = client.request(endpoint, {
          agent, method: 'POST', family,
          ...(isTls ? { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) } : {}),
          headers: {
            'content-type': 'application/json', accept: 'application/json',
            'accept-encoding': 'identity', 'content-length': body.length,
            'user-agent': 'rare-friends-az-probe/1.0',
          },
          lookup(hostname, options, callback) {
            const lookupStarted = performance.now();
            dns.lookup(hostname, options, (error, address, addressFamily) => {
              if (!settled) {
                dnsEnded = performance.now();
                timingsMs.dns = dnsEnded - lookupStarted;
              }
              callback(error, address, addressFamily);
            });
          },
        });
        request.once('socket', assigned => {
          socket = assigned;
          if (settled) { socket.destroy(); return; }
          socketStarted = performance.now();
          reusedSocket = request.reusedSocket === true;
          observeRemote();
          if (!reusedSocket) {
            listenSocket('connect', () => {
              connected = performance.now();
              timingsMs.tcp = connected - (dnsEnded ?? socketStarted);
              observeRemote();
            });
            if (isTls) listenSocket('secureConnect', () => {
              if (connected !== undefined) timingsMs.tls = performance.now() - connected;
              tlsSessionReused = socket.isSessionReused() === true;
              observeRemote();
            });
          } else if (isTls) {
            tlsSessionReused = socket.isSessionReused() === true;
          }
          // TLSSocket emits decrypted HTTP bytes here. Remove the listener on
          // completion so a reused socket cannot contaminate a later sample.
          listenSocket('data', () => {
            if (timingsMs.firstByte === undefined) timingsMs.firstByte = performance.now() - started;
          });
        });
        request.once('error', error => finish(networkErrorCode(error)));
        request.once('response', incoming => {
          response = incoming;
          if (settled) { incoming.destroy(); return; }
          if (timingsMs.firstByte === undefined) timingsMs.firstByte = performance.now() - started;
          httpStatus = incoming.statusCode ?? 0;
          if (httpStatus >= 300 && httpStatus < 400) { finish('HTTP_REDIRECT'); return; }
          if (httpStatus < 200 || httpStatus >= 300) { finish(`HTTP_${httpStatus}`); return; }
          if (Number(incoming.headers['content-length']) > MAX_RESPONSE_BYTES) {
            finish('RESPONSE_TOO_LARGE'); return;
          }
          const encoding = String(incoming.headers['content-encoding'] ?? '').trim().toLowerCase();
          if (encoding !== '' && encoding !== 'identity') { finish('UNSUPPORTED_ENCODING'); return; }
          let size = 0;
          const chunks = [];
          incoming.once('error', error => finish(networkErrorCode(error)));
          incoming.once('aborted', () => finish('RESPONSE_ABORTED'));
          incoming.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { finish('RESPONSE_TOO_LARGE'); return; }
            chunks.push(chunk);
          });
          incoming.once('end', () => {
            if (settled) return;
            let parsed;
            try { parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
            catch { finish('INVALID_RESPONSE'); return; }
            if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id) {
              finish('INVALID_RESPONSE'); return;
            }
            if (Object.hasOwn(parsed, 'error')) {
              const code = parsed.error?.code;
              finish(code === -32601 ? 'RPC_METHOD_NOT_FOUND' : 'RPC_ERROR', {
                ...(Number.isSafeInteger(code) ? { rpcErrorCode: code } : {}),
              });
              return;
            }
            if (!Object.hasOwn(parsed, 'result') || parsed.result !== null) { finish('INVALID_RESPONSE'); return; }
            finish();
          });
        });
        request.end(body);
      } catch (error) { finish(networkErrorCode(error)); }
    });
  }

  return {
    warm: () => probe(false),
    cold: () => probe(true),
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...active]) cancel();
      warmAgent.destroy();
    },
  };
}
