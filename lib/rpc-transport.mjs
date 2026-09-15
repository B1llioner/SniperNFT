import http from 'node:http';
import https from 'node:https';
import { createGunzip } from 'node:zlib';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class RpcTransportError extends Error {
  constructor(message, code = 'NETWORK_ERROR') {
    super(message);
    this.name = 'RpcTransportError';
    this.code = code;
  }
}

// The caller validates the configured URL. Each provider owns its connection
// pool; FetchRequest clones share this transport without creating new agents.
export function createRpcTransport(url, timeoutMs) {
  const endpoint = new URL(url);
  const client = endpoint.protocol === 'https:' ? https : http;
  const agent = new client.Agent({
    keepAlive: true, keepAliveMsecs: 1000, maxSockets: 8, maxFreeSockets: 2,
    scheduling: 'lifo',
  });
  const pending = new Set();
  let destroyed = false;

  function getUrl(request, signal) {
    if (destroyed || signal?.cancelled) {
      return Promise.reject(new RpcTransportError('RPC request was cancelled.', 'CANCELLED'));
    }
    if (request.url !== endpoint.href) {
      return Promise.reject(new RpcTransportError('RPC destination changed.'));
    }
    return new Promise((resolve, reject) => {
      let outgoing;
      let incoming;
      let decoded;
      let settled = false;
      let timer;
      const cancel = () => finish(new RpcTransportError('RPC request was cancelled.', 'CANCELLED'));

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (error) {
          // A deadline must release the socket as well as reject the promise.
          outgoing?.destroy();
          incoming?.destroy();
          if (decoded !== incoming) decoded?.destroy();
          reject(error);
        } else resolve(result);
      }

      pending.add(cancel);
      // This is a wall-clock deadline, including DNS, TLS, upload and download.
      // Socket inactivity timers alone would allow an endless trickle response.
      timer = setTimeout(() => finish(new RpcTransportError('RPC request timed out.', 'TIMEOUT')), timeoutMs);
      try {
        signal?.addListener(cancel);
        outgoing = client.request(endpoint, { method: request.method, headers: request.headers, agent });
        outgoing.once('error', () => finish(new RpcTransportError('RPC request failed.')));
        outgoing.once('response', response => {
          incoming = response;
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            finish(new RpcTransportError('RPC redirects are unsupported.'));
            return;
          }
          if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
            finish(new RpcTransportError('RPC response is too large.'));
            return;
          }
          const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [
            name, Array.isArray(value) ? value.join(', ') : value ?? '',
          ]));
          const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
          if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') {
            finish(new RpcTransportError('Unsupported RPC response encoding.'));
            return;
          }
          response.once('error', () => finish(new RpcTransportError('RPC response failed.')));
          response.once('aborted', () => finish(new RpcTransportError('RPC response was interrupted.')));
          let received = 0;
          let expanded = 0;
          const chunks = [];
          response.on('data', chunk => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) finish(new RpcTransportError('RPC response is too large.'));
          });
          decoded = encoding === 'gzip' ? response.pipe(createGunzip()) : response;
          if (decoded !== response) decoded.once('error', () => finish(new RpcTransportError('Cannot decode RPC response.')));
          decoded.on('data', chunk => {
            if (settled) return;
            expanded += chunk.length;
            if (expanded > MAX_RESPONSE_BYTES) {
              finish(new RpcTransportError('RPC response is too large.'));
              return;
            }
            chunks.push(chunk);
          });
          decoded.once('end', () => finish(null, {
            statusCode, statusMessage: http.STATUS_CODES[statusCode] ?? '', headers,
            body: Buffer.concat(chunks, expanded),
          }));
        });
        outgoing.end(request.body == null ? undefined : Buffer.from(request.body));
      } catch {
        finish(new RpcTransportError('RPC request failed.'));
      }
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const cancel of pending) cancel();
    agent.destroy();
  }
  return { getUrl, destroy };
}
