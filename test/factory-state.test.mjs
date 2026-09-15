import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Transaction, Wallet, getCreateAddress, keccak256 } from 'ethers';
import { FactoryStateError, openFactoryState } from '../lib/factory-state.mjs';
import { MintError, safeError } from '../mint.mjs';

// This key is a public, synthetic fixture used only to sign local test data.
const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const OTHER = new Wallet(`0x${'22'.repeat(32)}`).address;
const INIT_CODE = '0x60006000f3';
const IDENTITY = { chainId: '4663', owner: wallet.address, recipient: wallet.address,
  sourceSha256: 'aa'.repeat(32), initCodeHash: keccak256(INIT_CODE) };
const MODULE = new URL('../lib/factory-state.mjs', import.meta.url).href;
const isCode = code => error => error instanceof FactoryStateError && error.code === code;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-factory-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'state.json') };
}
async function pending(changes = {}, signer = wallet) {
  const tx = { type: 2, chainId: 4663n, nonce: 5, to: null, data: INIT_CODE,
    gasLimit: 100000n, maxFeePerGas: 70000000n, maxPriorityFeePerGas: 0n, value: 0n, ...changes };
  const rawTransaction = await signer.signTransaction(tx);
  return { status: 'pending', factory: getCreateAddress({ from: wallet.address, nonce: tx.nonce }),
    deployment: { hash: keccak256(rawTransaction), nonce: String(tx.nonce), rawTransaction } };
}
async function openFixture(t, path, identity = IDENTITY) {
  const store = await openFactoryState(path, identity);
  t.after(() => store.close().catch(() => {}));
  return store;
}
function child(script, args) {
  // No inherited environment: in particular no real PRIVATE_KEY or RPC credentials.
  return spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    env: { NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function childResult(process) {
  let output = ''; let errorOutput = '';
  process.stdout.on('data', data => { output += data; });
  process.stderr.on('data', data => { errorOutput += data; });
  const [code, signal] = await once(process, 'exit');
  return { code, signal, output, errorOutput };
}

test('state persists signed pending deployment and strips raw transaction after deployed transition', async t => {
  const { directory, path } = await fixture(t);
  const store = await openFixture(t, path);
  assert.equal(await store.read(), null);
  const payload = await pending();
  const saved = await store.write(payload);
  assert.equal(saved.version, 1);
  assert.equal(saved.owner, wallet.address);
  assert.deepEqual(saved.deployment, payload.deployment);
  assert.equal(new Date(saved.updatedAt).toISOString(), saved.updatedAt);
  assert.deepEqual(await store.read(), saved);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(`${path}.lock`)).mode & 0o777, 0o600);
  const { hash, nonce } = payload.deployment;
  await store.write({ status: 'deployed', factory: payload.factory, deployment: { hash, nonce } });
  assert.equal((await readFile(path, 'utf8')).includes('rawTransaction'), false);
  assert.deepEqual((await store.read()).deployment, { hash, nonce });
  await store.close();
  await store.close();
  assert.deepEqual(await readdir(directory), ['state.json']);
  await assert.rejects(store.read(), isCode('STATE_CLOSED'));
  const reopened = await openFixture(t, path);
  assert.equal((await reopened.read()).status, 'deployed');
});

test('pending transaction is bound to signer, chain, creation input, zero value, nonce, address and hash', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const valid = await pending();
  await store.write(valid);
  const original = await readFile(path, 'utf8');
  const unsigned = Transaction.from({ chainId: 4663, nonce: 5, data: INIT_CODE, to: null }).unsignedSerialized;
  const invalid = [
    await pending({ chainId: 1n }), await pending({ to: OTHER }), await pending({ value: 1n }),
    await pending({ data: '0x6001' }), await pending({}, new Wallet(`0x${'22'.repeat(32)}`)),
    { ...valid, factory: OTHER },
    { ...valid, deployment: { ...valid.deployment, nonce: '6' } },
    { ...valid, deployment: { ...valid.deployment, hash: `0x${'00'.repeat(32)}` } },
    { ...valid, deployment: { ...valid.deployment, rawTransaction: '0xab' } },
    { ...valid, deployment: { ...valid.deployment, rawTransaction: unsigned, hash: keccak256(unsigned) } },
  ];
  for (const payload of invalid) {
    await assert.rejects(store.write(payload), isCode('STATE_INVALID'));
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('schema rejects ambiguous records and supports an imported factory without deployment metadata', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const valid = await pending();
  const invalid = [
    { ...valid, status: 'unknown' }, { ...valid, version: 2 }, { ...valid, undocumented: 1 },
    { ...valid, factory: OTHER.toLowerCase() }, { ...valid, updatedAt: '2026-09-15' },
    { ...valid, deployment: undefined }, { ...valid, deployment: null },
    { ...valid, deployment: { ...valid.deployment, nonce: '05' } },
    { ...valid, deployment: { ...valid.deployment, nonce: String(1n << 64n) } },
    { ...valid, deployment: { ...valid.deployment, nonce: 5 } },
    { ...valid, deployment: { ...valid.deployment, undocumented: true } },
    { ...valid, status: 'deployed' },
  ];
  for (const payload of invalid) await assert.rejects(store.write(payload), isCode('STATE_INVALID'));
  assert.equal(await store.read(), null);
  const imported = await store.write({ status: 'deployed', factory: OTHER });
  assert.equal(imported.deployment, undefined);
  assert.deepEqual(await store.read(), imported);
});

test('wrong build or wallet identity cannot read or overwrite an existing deployment', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const valid = await pending();
  await store.write(valid);
  await assert.rejects(store.write({ ...valid, recipient: OTHER }), isCode('STATE_IDENTITY_MISMATCH'));
  await store.close();
  const bytes = await readFile(path, 'utf8');
  for (const change of [{ owner: OTHER }, { recipient: OTHER }, { sourceSha256: 'bb'.repeat(32) },
    { initCodeHash: `0x${'bb'.repeat(32)}` }]) {
    const wrong = await openFactoryState(path, { ...IDENTITY, ...change });
    try {
      await assert.rejects(wrong.read(), isCode('STATE_IDENTITY_MISMATCH'));
      await assert.rejects(wrong.write({ status: 'deployed', factory: OTHER }), isCode('STATE_IDENTITY_MISMATCH'));
    } finally { await wrong.close(); }
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  await assert.rejects(openFactoryState(path, { ...IDENTITY, chainId: '1' }), isCode('STATE_INVALID'));
});

test('an existing deployment intent cannot be replaced or moved backwards through its lifecycle', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const valid = await pending();
  await store.write(valid);
  await store.write(valid); // Retrying the identical signed deployment is permitted.
  const original = await readFile(path, 'utf8');
  await assert.rejects(store.write(await pending({ nonce: 6 })), isCode('STATE_TRANSITION'));
  await assert.rejects(store.write(await pending({ maxFeePerGas: 80000000n })), isCode('STATE_TRANSITION'));
  await assert.rejects(store.write({ status: 'deployed', factory: valid.factory }), isCode('STATE_TRANSITION'));
  assert.equal(await readFile(path, 'utf8'), original);
  const { hash, nonce } = valid.deployment;
  const deployed = { status: 'deployed', factory: valid.factory, deployment: { hash, nonce } };
  await store.write(deployed);
  await store.write(deployed);
  const finalized = await readFile(path, 'utf8');
  for (const update of [valid, { status: 'deployed', factory: OTHER },
    { status: 'deployed', factory: valid.factory },
    { ...deployed, deployment: { hash: `0x${'ab'.repeat(32)}`, nonce } }]) {
    await assert.rejects(store.write(update), isCode('STATE_TRANSITION'));
    assert.equal(await readFile(path, 'utf8'), finalized);
  }
});

test('malformed, oversized and public-readable state is never treated as missing or overwritten', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  for (const [contents, mode, code] of [['{broken', 0o600, 'STATE_INVALID'],
    [' '.repeat(1024 * 1024 + 1), 0o600, 'STATE_FILE_INVALID'], ['{}', 0o644, 'STATE_FILE_INVALID']]) {
    await writeFile(path, contents, { mode: 0o600 }); await chmod(path, mode);
    await assert.rejects(store.read(), isCode(code));
    await assert.rejects(store.write({ status: 'deployed', factory: OTHER }), isCode(code));
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('state and lock symlinks or nonregular files are rejected without altering their targets', async t => {
  const { directory, path } = await fixture(t);
  const target = join(directory, 'target');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, path);
  const store = await openFixture(t, path);
  await assert.rejects(store.read(), isCode('STATE_FILE_INVALID'));
  await assert.rejects(store.write({ status: 'deployed', factory: OTHER }), isCode('STATE_FILE_INVALID'));
  await store.close();
  await unlink(path);
  await mkdir(path, { mode: 0o700 });
  const directoryStore = await openFixture(t, path);
  await assert.rejects(directoryStore.read(), isCode('STATE_FILE_INVALID'));
  await directoryStore.close();
  await symlink(target, `${path}.lock`);
  await assert.rejects(openFactoryState(path, IDENTITY), isCode('STATE_FILE_INVALID'));
  await unlink(`${path}.lock`);
  await mkdir(`${path}.lock`, { mode: 0o700 });
  await assert.rejects(openFactoryState(path, IDENTITY), isCode('STATE_FILE_INVALID'));
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('exclusive lock blocks a separate process and exposes only actionable sanitized metadata', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const script = `import {openFactoryState} from ${JSON.stringify(MODULE)};
    try { const state=await openFactoryState(process.argv[1],JSON.parse(process.argv[2])); await state.close(); }
    catch(error) { console.log(error.code); process.exitCode=3; }`;
  const result = await childResult(child(script, [path, JSON.stringify(IDENTITY)]));
  assert.equal(result.code, 3);
  assert.equal(result.output.trim(), 'STATE_LOCK_HELD');
  assert.equal(result.errorOutput, '');
  await assert.rejects(openFactoryState(path, IDENTITY), error => {
    assert.ok(error instanceof MintError);
    assert.equal(safeError(error), error.message);
    assert.match(error.message, /PID \d+ on host/);
    assert.match(error.message, /Stale locks are not removed automatically/);
    return isCode('STATE_LOCK_HELD')(error);
  });
  await store.close();
  const next = await openFixture(t, path);
  assert.equal(await next.read(), null);
});

test('SIGKILL preserves pending deployment and lock until explicit manual lock recovery', { timeout: 10000 }, async t => {
  const { path } = await fixture(t);
  const payload = await pending();
  const script = `import {openFactoryState} from ${JSON.stringify(MODULE)};
    const state=await openFactoryState(process.argv[1],JSON.parse(process.argv[2]));
    await state.write(JSON.parse(process.argv[3])); console.log('READY'); setInterval(()=>{},1000);`;
  const process = child(script, [path, JSON.stringify(IDENTITY), JSON.stringify(payload)]);
  const exited = once(process, 'exit');
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  await Promise.race([
    new Promise((resolve, reject) => {
      process.stdout.on('data', data => { if (String(data).includes('READY')) resolve(); });
      process.once('error', reject);
    }),
    exited.then(() => { throw new Error('Fixture process exited before its state was durable.'); }),
  ]);
  process.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  await assert.rejects(openFactoryState(path, IDENTITY), isCode('STATE_LOCK_HELD'));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).deployment.hash, payload.deployment.hash);
  // Documented manual recovery, applied only to this known dead synthetic fixture process.
  await unlink(`${path}.lock`);
  const recovered = await openFixture(t, path);
  assert.deepEqual((await recovered.read()).deployment, payload.deployment);
});

test('a replaced lock is preserved and stale handle cannot read, write, or close another owner lock', async t => {
  const { path } = await fixture(t);
  const store = await openFixture(t, path);
  const replacement = { ...JSON.parse(await readFile(`${path}.lock`, 'utf8')), token: 'bb'.repeat(32) };
  await unlink(`${path}.lock`);
  await writeFile(`${path}.lock`, JSON.stringify(replacement), { mode: 0o600 });
  await assert.rejects(store.read(), isCode('STATE_LOCK_LOST'));
  await assert.rejects(store.write({ status: 'deployed', factory: OTHER }), isCode('STATE_LOCK_LOST'));
  await assert.rejects(store.close(), isCode('STATE_LOCK_LOST'));
  assert.equal(JSON.parse(await readFile(`${path}.lock`, 'utf8')).token, replacement.token);
});

test('queued writes finish before close and nested directories are private with no temporary files left', async t => {
  const { directory } = await fixture(t);
  const path = join(directory, 'new', 'nested', 'state.json');
  const store = await openFixture(t, path);
  const first = store.write({ status: 'deployed', factory: OTHER });
  const second = store.write({ status: 'deployed', factory: OTHER });
  const close = store.close();
  await assert.rejects(store.write({ status: 'deployed', factory: OTHER }), isCode('STATE_CLOSED'));
  await Promise.all([first, second, close]);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).factory, OTHER);
  assert.equal((await lstat(join(directory, 'new'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(directory, 'new', 'nested'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(directory, 'new', 'nested')), ['state.json']);
});
