import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createProvider, MintError, safeError } from '../mint.mjs';
import { RpcTransportError } from '../lib/rpc-transport.mjs';
import { waitForPublicStage } from '../lib/warm.mjs';

const LIMIT = 2 * 1024 * 1024;

async function localRpc(t, respond) {
  const sockets = new Set();
  const requests = [];
  let connections = 0;
  const failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ socket: request.socket, payload, headers: request.headers });
      await respond(request, response, payload);
    } catch (error) {
      failures.push(error.message);
      response.destroy();
    }
  });
  server.on('connection', socket => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.keepAliveTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/synthetic-api-token`, requests, sockets,
    get connections() { return connections; },
  };
}

function jsonResult(response, payload, result = '0x1237') {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
}

test('provider reuses one TCP connection for consecutive cold and warm RPC reads', async t => {
  const rpc = await localRpc(t, (_request, response, payload) => jsonResult(response, payload));
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  for (let index = 0; index < 4; index++) assert.equal(await provider.send('eth_chainId', []), '0x1237');
  assert.equal(rpc.requests.length, 4);
  assert.equal(rpc.connections, 1);
  assert.ok(rpc.requests.every(request => request.socket === rpc.requests[0].socket));
  assert.ok(rpc.requests.every(request => request.headers.connection === 'keep-alive'));
  assert.ok(rpc.requests.every(request => request.headers['user-agent'] === 'Mozilla/5.0'));
  assert.ok(rpc.requests.every(request => request.payload.method === 'eth_chainId'));
});

test('provider destroy closes an idle keep-alive socket and remains idempotent', async t => {
  const rpc = await localRpc(t, (_request, response, payload) => jsonResult(response, payload));
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  await provider.send('eth_chainId', []);
  assert.equal(rpc.sockets.size, 1);
  const socketClosed = once(rpc.requests[0].socket, 'close');
  provider.destroy();
  await socketClosed;
  assert.equal(provider.destroyed, true);
  assert.equal(rpc.sockets.size, 0);
  provider.destroy();
  await assert.rejects(provider.send('eth_chainId', []));
  assert.equal(rpc.requests.length, 1);
});

test('request deadline aborts a stalled RPC and releases its socket', async t => {
  let close;
  const rpc = await localRpc(t, (request) => { close = once(request.socket, 'close'); });
  const provider = createProvider(rpc.url, { timeoutMs: 1000 });
  t.after(() => provider.destroy());
  const started = performance.now();
  await assert.rejects(provider.send('eth_chainId', []), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(safeError(error), 'RPC request timed out.');
    assert.ok(!String(error).includes('synthetic-api-token'));
    return true;
  });
  assert.ok(performance.now() - started < 3000);
  await close;
  assert.equal(rpc.sockets.size, 0);
  assert.equal(rpc.requests.length, 1);
});

test('wall-clock deadline also stops a response that keeps sending data', async t => {
  const rpc = await localRpc(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
    const timer = setInterval(() => response.write(' '), 80);
    request.socket.once('close', () => clearInterval(timer));
  });
  const provider = createProvider(rpc.url, { timeoutMs: 1000 });
  t.after(() => provider.destroy());
  const started = performance.now();
  await assert.rejects(provider.send('eth_chainId', []), { code: 'TIMEOUT' });
  assert.ok(performance.now() - started < 3000);
  assert.equal(rpc.requests.length, 1);
});

test('destroy aborts an active request before its timeout', async t => {
  let requestArrived;
  const arrived = new Promise(resolve => { requestArrived = resolve; });
  let closed;
  const rpc = await localRpc(t, request => {
    closed = once(request.socket, 'close');
    requestArrived();
  });
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  const pending = assert.rejects(provider.send('eth_chainId', []));
  await arrived;
  provider.destroy();
  await pending;
  await closed;
  assert.equal(rpc.sockets.size, 0);
});

test('redirects are rejected without following the destination', async t => {
  let followed = false;
  const rpc = await localRpc(t, (request, response) => {
    if (request.url === '/redirected') followed = true;
    response.writeHead(307, { location: '/redirected' });
    response.end();
  });
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  await assert.rejects(provider.send('eth_chainId', []), /redirects are unsupported/);
  assert.equal(followed, false);
  assert.equal(rpc.requests.length, 1);
});

test('HTTP throttling does not trigger a hidden transport retry', async t => {
  const rpc = await localRpc(t, (_request, response) => {
    response.writeHead(429, { 'retry-after': '0' });
    response.end('Rate limited');
  });
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  await assert.rejects(provider.send('eth_chainId', []));
  assert.equal(rpc.requests.length, 1);
});

test('response limit rejects declared and chunked oversized bodies', async t => {
  for (const declared of [true, false]) {
    await t.test(declared ? 'content length' : 'streamed bytes', async t => {
      const rpc = await localRpc(t, (_request, response) => {
        response.writeHead(200, declared ? { 'content-length': LIMIT + 1 } : {});
        response.end(Buffer.alloc(LIMIT + 1, 32));
      });
      const provider = createProvider(rpc.url);
      t.after(() => provider.destroy());
      await assert.rejects(provider.send('eth_chainId', []), /response is too large/);
      assert.equal(rpc.requests.length, 1);
    });
  }
});

test('gzip responses decode normally and the expanded body remains bounded', async t => {
  const rpc = await localRpc(t, (_request, response, payload) => {
    const body = payload.method === 'eth_chainId'
      ? JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: '0x1237' })
      : ' '.repeat(LIMIT + 1);
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.end(gzipSync(body));
  });
  const provider = createProvider(rpc.url);
  t.after(() => provider.destroy());
  assert.equal(await provider.send('eth_chainId', []), '0x1237');
  await assert.rejects(provider.send('eth_blockNumber', []), /response is too large/);
  assert.equal(rpc.requests.length, 2);
  assert.equal(rpc.connections, 1);
});

test('provider keeps URL restrictions and validates timeout bounds before connecting', () => {
  for (const url of ['http://example.com', 'file:///tmp/rpc', 'https://user:secret@example.com', 'invalid-url']) {
    assert.throws(() => createProvider(url));
  }
  for (const timeoutMs of [0, 999, 20001, 1.5, '1000', NaN, Infinity]) {
    assert.throws(() => createProvider('http://127.0.0.1:1', { timeoutMs }), /timeoutMs/);
  }
  const provider = createProvider('https://example.com', { timeoutMs: 1000 });
  provider.destroy();
});

test('a real socket reset remains a sanitized transport error and warm mode uses its prepared fallback', async t => {
  const primary = await localRpc(t, (request, response, payload) => {
    if (payload.method === 'eth_getBlockByNumber') request.socket.destroy();
    else jsonResult(response, payload);
  });
  const backup = await localRpc(t, (_request, response, payload) => {
    jsonResult(response, payload, payload.method === 'eth_getBlockByNumber' ? { timestamp: '0x64' } : '0x1237');
  });
  const providers = [createProvider(primary.url), createProvider(backup.url)];
  t.after(() => providers.forEach(provider => provider.destroy()));
  const failures = [];
  const progress = [];
  const result = await waitForPublicStage({
    entries: providers.map((provider, endpoint) => ({ provider, endpoint })),
    options: { waitTimeoutSeconds: 5, pollIntervalMs: 10, keepAliveIntervalMs: 1000 },
    prepare: async entry => {
      assert.equal(await entry.provider.send('eth_chainId', []), '0x1237');
      return { endpoint: entry.endpoint };
    },
    getStage: async entry => {
      let block;
      try { block = await entry.provider.send('eth_getBlockByNumber', ['latest', false]); }
      catch (error) { failures.push(error); throw error; }
      return { timestamp: BigInt(block.timestamp), startTime: 100n, endTime: 1000n,
        mintPrice: 0n, maxTotalMintableByWallet: 1n };
    },
    onProgress: event => progress.push(event),
  });
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof RpcTransportError);
  assert.ok(!(failures[0] instanceof MintError));
  assert.equal(failures[0].code, 'NETWORK_ERROR');
  assert.equal(safeError(failures[0]), 'RPC request failed.');
  assert.ok(!String(failures[0]).includes('synthetic-api-token'));
  assert.equal(result.entry.endpoint, 1);
  assert.deepEqual(result.prepared, { endpoint: 1 });
  assert.ok(progress.some(event => event.endpoint === 1 && event.warmStatus === 'using prepared fallback'));
  assert.ok([...primary.requests, ...backup.requests].every(request => !request.payload.method.startsWith('eth_send')));
});
