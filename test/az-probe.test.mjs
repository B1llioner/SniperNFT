import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAzProbe } from '../lib/az-probe.mjs';

async function fixture(t, handler, tls) {
  const requests = [];
  const sockets = new Set();
  const failures = [];
  const serve = async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ payload, headers: request.headers, socket: request.socket, url: request.url });
      await handler(request, response, payload);
    } catch (error) {
      failures.push(error.message);
      response.destroy();
    }
  };
  const server = tls ? https.createServer(tls, serve) : http.createServer(serve);
  server.keepAliveTimeout = 10_000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    endpoint: `${tls ? 'https' : 'http'}://localhost:${server.address().port}/synthetic-route-token`,
    requests, sockets,
  };
}

function healthy(_request, response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: null }));
}

function ownProbe(t, options) {
  const probe = createAzProbe({ family: 4, ...options });
  t.after(() => probe.close());
  return probe;
}

function assertTimings(record) {
  assert.equal(typeof record.timingsMs.total, 'number');
  for (const value of Object.values(record.timingsMs)) assert.ok(Number.isFinite(value) && value >= 0);
  if (record.timingsMs.firstByte !== undefined) assert.ok(record.timingsMs.firstByte <= record.timingsMs.total);
}

test('AZ probe validates destinations and options without disclosing URL contents', () => {
  for (const endpoint of [undefined, '', 'broken synthetic-route-token', 'ftp://localhost',
    'http://example.com/synthetic-route-token', 'https://user:secret@example.com',
    'https://example.com/#token', 'https://example.com/#']) {
    assert.throws(() => createAzProbe({ endpoint }), error => {
      assert.equal(error instanceof TypeError, true);
      assert.equal(error.message.includes('synthetic-route-token'), false);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
  for (const timeoutMs of [49, 60001, 1.5, Infinity, '100']) {
    assert.throws(() => createAzProbe({ endpoint: 'https://example.com', timeoutMs }), /timeoutMs/);
  }
  for (const family of [1, '4', null]) {
    assert.throws(() => createAzProbe({ endpoint: 'https://example.com', family }), /family/);
  }
});

test('warm probes reuse an actual socket; cold probes use fresh connections and unique health IDs', async t => {
  const rpc = await fixture(t, healthy);
  const probe = ownProbe(t, { endpoint: rpc.endpoint });
  const first = await probe.warm();
  const second = await probe.warm();
  const cold = await probe.cold();
  const anotherCold = await probe.cold();
  const afterCold = await probe.warm();
  for (const record of [first, second, cold, anotherCold, afterCold]) {
    assert.equal(record.ok, true);
    assert.equal(record.httpStatus, 200);
    assert.equal(record.remoteAddress, '127.0.0.1');
    assert.equal(record.remoteFamily, 'IPv4');
    assert.equal(record.tlsSessionReused, false);
    assertTimings(record);
  }
  assert.deepEqual([first, second, cold, anotherCold, afterCold].map(record => record.reusedSocket),
    [false, true, false, false, true]);
  assert.equal(typeof first.timingsMs.dns, 'number');
  assert.equal(typeof first.timingsMs.tcp, 'number');
  for (const key of ['dns', 'tcp', 'tls']) assert.equal(Object.hasOwn(second.timingsMs, key), false);
  assert.equal(Object.hasOwn(first.timingsMs, 'tls'), false);
  assert.equal(rpc.requests[0].socket, rpc.requests[1].socket);
  assert.equal(rpc.requests[0].socket, rpc.requests[4].socket);
  assert.notEqual(rpc.requests[0].socket, rpc.requests[2].socket);
  assert.notEqual(rpc.requests[2].socket, rpc.requests[3].socket);
  assert.equal(new Set(rpc.requests.map(request => request.payload.id)).size, 5);
  for (const { payload, headers } of rpc.requests) {
    assert.equal(payload.method, 'arb_checkPublisherHealth');
    assert.deepEqual(payload.params, []);
    assert.equal(payload.jsonrpc, '2.0');
    assert.equal(headers['accept-encoding'], 'identity');
  }
});

test('a warm-mode request on a replacement socket remains classified as a new connection', async t => {
  const rpc = await fixture(t, (request, response, payload) => {
    response.setHeader('connection', 'close');
    healthy(request, response, payload);
  });
  const probe = ownProbe(t, { endpoint: rpc.endpoint });
  const first = await probe.warm();
  const second = await probe.warm();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.reusedSocket, false);
  assert.equal(second.reusedSocket, false);
  assert.equal(typeof second.timingsMs.tcp, 'number');
  assert.notEqual(rpc.requests[0].socket, rpc.requests[1].socket);
});

test('HTTP failures are categorized without retries, redirects, or response text exposure', async t => {
  for (const status of [429, 503, 401, 307]) {
    await t.test(String(status), async t => {
      const rpc = await fixture(t, (_request, response) => {
        response.writeHead(status, { location: '/redirect-target', 'retry-after': '0' });
        response.end('synthetic-route-token server error');
      });
      const probe = ownProbe(t, { endpoint: rpc.endpoint });
      const record = await probe.warm();
      assert.equal(record.ok, false);
      assert.equal(record.errorCode, status === 307 ? 'HTTP_REDIRECT' : `HTTP_${status}`);
      assert.equal(record.httpStatus, status);
      assert.equal(JSON.stringify(record).includes('synthetic-route-token'), false);
      assert.equal(rpc.requests.length, 1);
      assertTimings(record);
    });
  }
});

test('health responses must match the ID, JSON-RPC version and null result', async t => {
  const invalidResponses = [
    'invalid JSON',
    [], null,
    { jsonrpc: '2.0', id: 'wrong-id', result: null },
    { jsonrpc: '1.0', result: null },
    { jsonrpc: '2.0', result: true },
    { jsonrpc: '2.0' },
  ];
  for (const [index, value] of invalidResponses.entries()) {
    await t.test(String(index), async t => {
      const rpc = await fixture(t, (_request, response, payload) => {
        const object = value && typeof value === 'object' && !Array.isArray(value)
          ? { id: payload.id, ...value } : value;
        response.end(typeof object === 'string' ? object : JSON.stringify(object));
      });
      const record = await ownProbe(t, { endpoint: rpc.endpoint }).warm();
      assert.equal(record.ok, false);
      assert.equal(record.errorCode, 'INVALID_RESPONSE');
    });
  }
});

test('RPC errors retain only a safe numeric code', async t => {
  for (const code of [-32601, -32000, 'synthetic-route-token']) {
    const rpc = await fixture(t, (_request, response, payload) => response.end(JSON.stringify({
      jsonrpc: '2.0', id: payload.id, error: { code, message: 'synthetic-route-token', data: { secret: 'token' } },
    })));
    const record = await ownProbe(t, { endpoint: rpc.endpoint }).warm();
    assert.equal(record.ok, false);
    assert.equal(record.errorCode, code === -32601 ? 'RPC_METHOD_NOT_FOUND' : 'RPC_ERROR');
    assert.equal(record.rpcErrorCode, typeof code === 'number' ? code : undefined);
    assert.equal(JSON.stringify(record).includes('synthetic-route-token'), false);
  }
});

test('probe rejects oversized declared and streamed bodies and unsupported compression', async t => {
  for (const mode of ['declared', 'streamed', 'compressed']) {
    await t.test(mode, async t => {
      const rpc = await fixture(t, (_request, response) => {
        response.writeHead(200, mode === 'declared' ? { 'content-length': 65537 }
          : mode === 'compressed' ? { 'content-encoding': 'gzip' } : {});
        response.end(Buffer.alloc(65537, 32));
      });
      const record = await ownProbe(t, { endpoint: rpc.endpoint }).warm();
      assert.equal(record.errorCode, mode === 'compressed' ? 'UNSUPPORTED_ENCODING' : 'RESPONSE_TOO_LARGE');
      assert.equal(rpc.requests.length, 1);
    });
  }
});

test('absolute deadline stops an endless response trickle and releases the socket', async t => {
  let closed;
  const rpc = await fixture(t, (request, response) => {
    closed = once(request.socket, 'close');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
    const interval = setInterval(() => response.write(' '), 10);
    request.socket.once('close', () => clearInterval(interval));
  });
  const record = await ownProbe(t, { endpoint: rpc.endpoint, timeoutMs: 100 }).warm();
  assert.equal(record.errorCode, 'TIMEOUT');
  assert.ok(record.timingsMs.total >= 80 && record.timingsMs.total < 2000);
  assertTimings(record);
  await closed;
  assert.equal(rpc.sockets.size, 0);
});

test('close aborts both active warm and cold requests and future calls stay cancelled', async t => {
  let ready;
  let count = 0;
  const arrived = new Promise(resolve => { ready = resolve; });
  const rpc = await fixture(t, () => { if (++count === 2) ready(); });
  const probe = ownProbe(t, { endpoint: rpc.endpoint });
  const requests = [probe.warm(), probe.cold()];
  await arrived;
  const closed = [...rpc.sockets].map(socket => once(socket, 'close'));
  probe.close();
  probe.close();
  for (const record of await Promise.all(requests)) {
    assert.equal(record.errorCode, 'CANCELLED');
    assertTimings(record);
  }
  await Promise.all(closed);
  assert.equal(rpc.sockets.size, 0);
  assert.equal((await probe.warm()).errorCode, 'CANCELLED');
  assert.equal((await probe.cold()).errorCode, 'CANCELLED');
  assert.equal(rpc.requests.length, 2);
});

test('HTTPS verifies certificates and measures fresh TLS separately from socket reuse', async t => {
  // Ephemeral localhost-only certificate; no fixture keys are stored in the repo.
  const directory = mkdtempSync(join(tmpdir(), 'az-probe-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'openssl.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-new', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1',
    '-config', config, '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')],
  { stdio: 'pipe', timeout: 20_000 });
  const cert = readFileSync(join(directory, 'cert.pem'));
  const rpc = await fixture(t, healthy, { key: readFileSync(join(directory, 'key.pem')), cert });
  const probe = ownProbe(t, { endpoint: rpc.endpoint, ca: cert });
  const first = await probe.warm();
  const second = await probe.warm();
  const cold = await probe.cold();
  const anotherCold = await probe.cold();
  for (const record of [first, second, cold, anotherCold]) {
    assert.equal(record.ok, true);
    assertTimings(record);
  }
  assert.equal(first.reusedSocket, false);
  assert.equal(first.tlsSessionReused, false);
  assert.equal(typeof first.timingsMs.dns, 'number');
  assert.equal(typeof first.timingsMs.tcp, 'number');
  assert.equal(typeof first.timingsMs.tls, 'number');
  assert.equal(second.reusedSocket, true);
  assert.equal(Object.hasOwn(second.timingsMs, 'tls'), false);
  for (const record of [cold, anotherCold]) {
    assert.equal(record.reusedSocket, false);
    assert.equal(record.tlsSessionReused, false);
    assert.equal(typeof record.timingsMs.tls, 'number');
  }
  const untrusted = await ownProbe(t, { endpoint: rpc.endpoint }).warm();
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.errorCode, 'TLS_ERROR');
  assert.equal(rpc.requests.length, 4);
});
