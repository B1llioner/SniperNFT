import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { FEED, parseArgs, percentiles, probeWebSocket, validateEndpoint, writeReport } from '../probe.mjs';

async function server(t, handler, options = {}) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  ws.on('connection', socket => { socket.on('error', () => {}); handler(socket); });
  await once(ws, 'listening');
  t.after(async () => { for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); });
  return `ws://127.0.0.1:${ws.address().port}`;
}

test('nearest-rank percentile calculation and empty sample', () => {
  assert.deepEqual(percentiles([]), { count: 0, p50: null, p95: null, p99: null, min: null, max: null });
  const stats = percentiles(Array.from({ length: 100 }, (_, i) => 100 - i));
  assert.equal(stats.p50, 50); assert.equal(stats.p95, 95); assert.equal(stats.p99, 99);
});

test('endpoint input rejects credentials, query, fragments and non-loopback plaintext', () => {
  for (const url of ['not a url', 'ws://example.com', 'https://example.com', 'wss://user:pass@example.com',
    'wss://example.com?key=secret', 'wss://example.com#fragment']) assert.throws(() => validateEndpoint(url));
  assert.equal(validateEndpoint(FEED).hostname, 'feed.mainnet.chain.robinhood.com');
  assert.equal(validateEndpoint('ws://127.0.0.1:1234').protocol, 'ws:');
});

test('input boundaries and feed JSON-RPC protection fail before network activity', () => {
  assert.throws(() => probeWebSocket({ intervalMs: 99 }));
  assert.throws(() => probeWebSocket({ timeoutMs: 49 }));
  assert.throws(() => probeWebSocket({ durationSeconds: 3601 }));
  assert.throws(() => probeWebSocket({ warmup: -1 }));
  assert.throws(() => probeWebSocket({ family: 5 }));
  assert.throws(() => probeWebSocket({ label: 'a\nb' }));
  assert.throws(() => probeWebSocket({ mode: 'other' }));
  assert.throws(() => probeWebSocket({ mode: 'capability', endpoint: FEED }));
  assert.throws(() => parseArgs(['--start-at', 'tomorrow']));
  assert.throws(() => parseArgs(['--timeout-ms', '5.5']));
  assert.throws(() => parseArgs(['--endpoint', FEED, '--endpoint', FEED]));
  assert.throws(() => parseArgs(['--unknown', 'true']));
  assert.throws(() => parseArgs(['--output']));
});

test('real control ping/pong matches payload, excludes warmup, counts stream without retaining it', async t => {
  let receivedData = 0;
  const endpoint = await server(t, socket => {
    socket.on('message', () => receivedData++);
    socket.send('sensitive-stream-payload');
  });
  const report = await probeWebSocket({ endpoint, durationSeconds: 1, intervalMs: 100, timeoutMs: 70, warmup: 2 });
  assert.equal(report.completed, true);
  assert.equal(report.connection.attempts, 1);
  assert.equal(report.connection.reconnects, 0);
  assert.equal(report.connection.opened, true);
  assert.equal(report.connection.httpStatus, 101);
  assert.ok(report.pingRttMs.count >= 5);
  assert.equal(report.counts.timeout, 0);
  assert.equal(report.measuredCounts.success, report.pingRttMs.count);
  assert.equal(report.counts.success - report.measuredCounts.success, 2);
  assert.equal(report.stream.messages, 1);
  assert.equal(report.stream.bytes, Buffer.byteLength('sensitive-stream-payload'));
  assert.ok(report.stream.firstMessageAfterOpenMs >= 0);
  assert.ok(!JSON.stringify(report).includes('sensitive-stream-payload'));
  assert.equal(receivedData, 0, 'feed mode must not send application messages');
});

test('missing pong is a timeout, with no fabricated latency', async t => {
  const endpoint = await server(t, () => {}, { autoPong: false });
  const report = await probeWebSocket({ endpoint, durationSeconds: 1, intervalMs: 100, timeoutMs: 50, warmup: 0 });
  assert.equal(report.completed, true);
  assert.ok(report.counts.timeout >= 5);
  assert.equal(report.pingRttMs.count, 0);
  assert.equal(report.pingRttMs.p99, null);
});

test('wrong pong payload never satisfies a pending ping', async t => {
  const endpoint = await server(t, socket => socket.on('ping', () => socket.pong('wrong-id')), { autoPong: false });
  const report = await probeWebSocket({ endpoint, durationSeconds: 1, intervalMs: 100, timeoutMs: 50, warmup: 0 });
  assert.ok(report.counts.unmatchedPongs >= 5);
  assert.ok(report.counts.timeout >= 5);
  assert.equal(report.pingRttMs.count, 0);
});

test('HTTP 404 upgrade rejection reports exact status and stops', async t => {
  const http = createServer((_req, res) => { res.writeHead(404); res.end('private remote body'); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => http.close(resolve)));
  const report = await probeWebSocket({ endpoint: `ws://127.0.0.1:${http.address().port}`, mode: 'capability', timeoutMs: 500 });
  assert.equal(report.completed, false);
  assert.equal(report.connection.httpStatus, 404);
  assert.equal(report.connection.opened, false);
  assert.equal(report.finishReason, 'HTTP_UPGRADE_REJECTED');
  assert.ok(!JSON.stringify(report).includes('private remote body'));
});

test('capability sends exactly one unsigned health RPC and waits for matching ID', async t => {
  let calls = 0;
  const endpoint = await server(t, socket => socket.on('message', data => {
    calls++;
    const request = JSON.parse(data);
    assert.equal(request.method, 'arb_checkPublisherHealth');
    assert.deepEqual(request.params, []);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'not-our-id', result: null }));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
  }));
  const report = await probeWebSocket({ endpoint, mode: 'capability', timeoutMs: 500 });
  assert.equal(calls, 1);
  assert.equal(report.completed, true);
  assert.equal(report.capability.rpcSucceeded, true);
  assert.equal(report.counts.sent, 0);
});

test('capability connection without RPC response times out', async t => {
  const endpoint = await server(t, () => {});
  const report = await probeWebSocket({ endpoint, mode: 'capability', timeoutMs: 50 });
  assert.equal(report.completed, false);
  assert.equal(report.connection.opened, true);
  assert.equal(report.capability.rpcSucceeded, false);
  assert.equal(report.finishReason, 'RPC_TIMEOUT');
});

test('aborting a pending measurement saves an explicitly incomplete report', async t => {
  const controller = new AbortController();
  const endpoint = await server(t, () => {}, { autoPong: false });
  const timer = setTimeout(() => controller.abort(), 70);
  t.after(() => clearTimeout(timer));
  const report = await probeWebSocket({ endpoint, durationSeconds: 1, signal: controller.signal, warmup: 0 });
  assert.equal(report.completed, false);
  assert.equal(report.finishReason, 'CANCELLED');
  assert.equal(report.counts.cancelled, 1);
  assert.equal(report.pingRttMs.count, 0);
});

test('remote close records disconnect without reconnecting', async t => {
  const endpoint = await server(t, socket => socket.close(1000));
  const report = await probeWebSocket({ endpoint, durationSeconds: 1 });
  assert.equal(report.completed, false);
  assert.equal(report.connection.disconnects, 1);
  assert.equal(report.connection.attempts, 1);
  assert.equal(report.connection.reconnects, 0);
});

test('private atomic reports refuse existing files and symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vinos-ws-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  await writeReport(file, { value: 1 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeReport(file, { value: 2 }), { code: 'EEXIST' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 1);
  const symlinkFile = join(dir, 'symlink.json');
  await symlink(file, symlinkFile);
  await assert.rejects(writeReport(symlinkFile, { value: 3 }), { code: 'EEXIST' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 1);
});
