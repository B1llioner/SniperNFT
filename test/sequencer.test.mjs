import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MintError, safeError } from '../mint.mjs';
import { openSequencer } from '../lib/sequencer.mjs';

const HEALTH_ERROR = 'Sequencer publisher health check failed. No automatic RPC broadcast fallback.';

async function localSequencer(t, respond) {
  const requests = [];
  const sockets = new Set();
  const waiters = [];
  const cleanup = [];
  const failures = [];
  let connections = 0;
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const entry = { payload, socket: request.socket, headers: request.headers };
      requests.push(entry);
      assert.equal(payload.method, 'arb_checkPublisherHealth');
      assert.deepEqual(payload.params, []);
      await respond(request, response, payload, requests.length);
      for (const waiter of waiters) {
        if (requests.length >= waiter.count) waiter.resolve(requests[waiter.count - 1]);
      }
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  server.keepAliveTimeout = 10000;
  server.on('connection', socket => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const close of cleanup) close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/synthetic-api-token`,
    requests, sockets, cleanup,
    get connections() { return connections; },
    waitForRequest(count) {
      if (requests.length >= count) return Promise.resolve(requests[count - 1]);
      return new Promise(resolve => waiters.push({ count, resolve }));
    },
  };
}

function reply(response, payload, result = null) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
}

function rejectHealth(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    jsonrpc: '2.0', id: payload.id,
    error: { code: -32000, message: 'Upstream https://example.invalid/synthetic-api-token refused health.' },
  }));
}

function assertSanitizedHealthError(error) {
  assert.ok(error instanceof MintError);
  assert.equal(error.message, HEALTH_ERROR);
  assert.equal(safeError(error), HEALTH_ERROR);
  assert.doesNotMatch(String(error), /synthetic-api-token|example\.invalid|127\.0\.0\.1/);
  return true;
}

test('sequencer accepts null health and keeps periodic probes on one TCP connection', { timeout: 5000 }, async t => {
  const rpc = await localSequencer(t, (_request, response, payload) => reply(response, payload));
  const registered = [];
  const progress = [];
  const client = await openSequencer({ sequencerUrl: rpc.url, keepAliveIntervalMs: 20 }, {
    register: provider => registered.push(provider),
    onProgress: event => progress.push(event),
  });
  rpc.cleanup.push(client.close);
  assert.deepEqual(registered, [client.provider]);
  await rpc.waitForRequest(4);
  await client.ensureHealthy();
  const socketClosed = once(rpc.requests[0].socket, 'close');
  client.close();
  await socketClosed;
  assert.equal(rpc.connections, 1);
  assert.ok(rpc.requests.every(request => request.socket === rpc.requests[0].socket));
  assert.ok(rpc.requests.every(request => request.headers.connection === 'keep-alive'));
  assert.ok(progress.some(event => event.sequencerStatus === 'publisher healthy; connection warm'));
  assert.equal(client.provider.destroyed, true);
  assert.equal(rpc.sockets.size, 0);
});

test('ensureHealthy waits for the current heartbeat, rejects its failure and recovers on the next healthy probe', { timeout: 5000 }, async t => {
  let held;
  const rpc = await localSequencer(t, (_request, response, payload, count) => {
    if (count === 2) held = { response, payload };
    else reply(response, payload);
  });
  const client = await openSequencer({ sequencerUrl: rpc.url, keepAliveIntervalMs: 80 });
  rpc.cleanup.push(client.close);
  await rpc.waitForRequest(2);

  let settled = false;
  const pending = client.ensureHealthy().then(
    () => { settled = true; return { ok: true }; },
    error => { settled = true; return { error }; },
  );
  await delay(20);
  assert.equal(settled, false, 'The previous healthy result must not bypass a pending heartbeat.');
  assert.equal(rpc.requests.length, 2, 'Concurrent health checks must share the pending request.');

  rejectHealth(held.response, held.payload);
  const outcome = await pending;
  assertSanitizedHealthError(outcome.error);
  await client.ensureHealthy();
  assert.equal(rpc.requests.length, 3, 'An unhealthy publisher requires a fresh successful health check.');
  assert.equal(rpc.connections, 1);
  client.close();
});

test('initial unhealthy or malformed health closes the provider and sanitizes the error', { timeout: 5000 }, async t => {
  for (const mode of ['rpc-error', 'unexpected-result']) {
    await t.test(mode, async t => {
      let provider;
      let socketClosed;
      const rpc = await localSequencer(t, (request, response, payload) => {
        socketClosed = once(request.socket, 'close');
        if (mode === 'rpc-error') rejectHealth(response, payload);
        else reply(response, payload, true);
      });
      await assert.rejects(openSequencer({ sequencerUrl: rpc.url, keepAliveIntervalMs: 20 }, {
        register: registered => { provider = registered; rpc.cleanup.push(() => provider.destroy()); },
      }), assertSanitizedHealthError);
      await socketClosed;
      assert.equal(provider.destroyed, true);
      assert.equal(rpc.sockets.size, 0);
      await delay(60);
      assert.equal(rpc.requests.length, 1, 'A failed initial health check must not start heartbeats.');
    });
  }
});

test('close and cancellation stop an in-flight heartbeat and prevent later probes', { timeout: 5000 }, async t => {
  for (const action of ['close', 'abort']) {
    await t.test(action, async t => {
      const controller = new AbortController();
      const rpc = await localSequencer(t, (_request, response, payload, count) => {
        if (count === 1) reply(response, payload);
        // Keep the next response open until the client cancels its transport.
      });
      const client = await openSequencer({ sequencerUrl: rpc.url, keepAliveIntervalMs: 20 }, {
        signal: controller.signal,
      });
      rpc.cleanup.push(client.close);
      const heartbeat = await rpc.waitForRequest(2);
      const socketClosed = once(heartbeat.socket, 'close');
      const pending = assert.rejects(client.ensureHealthy(), error => {
        assert.ok(error instanceof MintError);
        assert.match(error.message, /Sequencer (?:publisher health check failed|connection cancelled)/);
        assert.doesNotMatch(String(error), /synthetic-api-token|127\.0\.0\.1/);
        return true;
      });
      if (action === 'abort') controller.abort();
      else client.close();
      await pending;
      await socketClosed;
      assert.equal(client.provider.destroyed, true);
      assert.equal(rpc.sockets.size, 0);
      await delay(80);
      assert.equal(rpc.requests.length, 2, 'Cancellation must not schedule another heartbeat.');
      await assert.rejects(client.ensureHealthy(), /Sequencer connection cancelled/);
      client.close();
    });
  }
});
