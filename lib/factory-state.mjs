import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { Transaction, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { MintError } from '../mint.mjs';

const MAX_BYTES = 1024 * 1024;
const IDENTITY_KEYS = ['chainId', 'owner', 'recipient', 'sourceSha256', 'initCodeHash'];
const RECORD_KEYS = new Set(['version', ...IDENTITY_KEYS, 'status', 'factory', 'deployment', 'updatedAt']);
const NOFOLLOW = constants.O_NOFOLLOW;
export class FactoryStateError extends MintError {
  constructor(code, message) { super(message); this.name = 'FactoryStateError'; this.code = code; }
}
function check(condition, code, message) { if (!condition) throw new FactoryStateError(code, message); }
function object(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.has(key)), 'STATE_INVALID', `${label} contains invalid or unknown fields.`);
}
function address(value, label) {
  let normalized;
  try { normalized = getAddress(value); } catch { throw new FactoryStateError('STATE_INVALID', `${label} is not a valid address.`); }
  check(normalized === value && normalized !== '0x0000000000000000000000000000000000000000',
    'STATE_INVALID', `${label} must be a nonzero checksummed address.`);
  return normalized;
}
function hash(value, label, prefix = true) {
  check(typeof value === 'string' && (prefix ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-fA-F]{64}$/).test(value),
    'STATE_INVALID', `${label} is not a 32-byte hash.`);
  return value.toLowerCase();
}
function identityOf(value) {
  object(value, new Set(IDENTITY_KEYS), 'Factory identity');
  check(value.chainId === '4663', 'STATE_INVALID', 'Factory state chainId must be the string 4663.');
  return { chainId: value.chainId, owner: address(value.owner, 'Owner'), recipient: address(value.recipient, 'Recipient'),
    sourceSha256: hash(value.sourceSha256, 'Source hash', false), initCodeHash: hash(value.initCodeHash, 'Init code hash') };
}
function canonicalRecord(value, identity) {
  object(value, RECORD_KEYS, 'Factory state');
  check(value.version === 1 && ['pending', 'deployed'].includes(value.status), 'STATE_INVALID', 'Unsupported factory state version or status.');
  const ownIdentity = identityOf(Object.fromEntries(IDENTITY_KEYS.map(key => [key, value[key]])));
  check(IDENTITY_KEYS.every(key => ownIdentity[key] === identity[key]), 'STATE_IDENTITY_MISMATCH',
    'Factory state belongs to a different chain, wallet, recipient or contract build. It will not be overwritten.');
  check(typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) &&
    new Date(value.updatedAt).toISOString() === value.updatedAt, 'STATE_INVALID', 'Factory state updatedAt must be a canonical ISO timestamp.');
  const result = { version: 1, ...identity, status: value.status, factory: address(value.factory, 'Factory'), updatedAt: value.updatedAt };
  check(!Object.hasOwn(value, 'deployment') || (value.deployment && typeof value.deployment === 'object'),
    'STATE_INVALID', 'Deployment must be an object when present.');
  check(value.status !== 'pending' || value.deployment != null, 'STATE_INVALID', 'Pending factory state requires its signed deployment.');
  if (value.deployment != null) {
    const deployed = value.status === 'deployed';
    const allowed = new Set(deployed ? ['hash', 'nonce'] : ['hash', 'nonce', 'rawTransaction']);
    object(value.deployment, allowed, 'Deployment');
    const deployment = { hash: hash(value.deployment.hash, 'Deployment hash'), nonce: value.deployment.nonce };
    check(typeof deployment.nonce === 'string' && /^(?:0|[1-9][0-9]*)$/.test(deployment.nonce) &&
      BigInt(deployment.nonce) < (1n << 64n), 'STATE_INVALID', 'Deployment nonce must be a canonical uint64 decimal string.');
    let predicted;
    try { predicted = getCreateAddress({ from: identity.owner, nonce: BigInt(deployment.nonce) }); }
    catch { throw new FactoryStateError('STATE_INVALID', 'Deployment nonce cannot be decoded.'); }
    check(predicted === result.factory, 'STATE_INVALID', 'Deployment nonce does not derive the recorded factory address.');
    if (!deployed) {
      const raw = value.deployment.rawTransaction;
      check(typeof raw === 'string' && raw.length <= MAX_BYTES && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw),
        'STATE_INVALID', 'Pending deployment requires a bounded serialized signed transaction.');
      let tx;
      try { tx = Transaction.from(raw); }
      catch { throw new FactoryStateError('STATE_INVALID', 'Pending deployment transaction cannot be decoded.'); }
      try {
        check(tx.isSigned() && tx.from === identity.owner && tx.chainId === BigInt(identity.chainId) &&
          tx.to === null && tx.value === 0n && String(tx.nonce) === deployment.nonce &&
          keccak256(tx.data) === identity.initCodeHash && keccak256(raw) === deployment.hash && tx.hash === deployment.hash,
        'STATE_INVALID', 'Pending deployment does not match its wallet, chain, init code, nonce, value or transaction hash.');
      } catch (error) {
        if (error instanceof FactoryStateError) throw error;
        throw new FactoryStateError('STATE_INVALID', 'Pending deployment signature or transaction is invalid.');
      }
      deployment.rawTransaction = raw.toLowerCase();
    }
    result.deployment = deployment;
  }
  return result;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function validTransition(previous, next) {
  if (!previous) return;
  const sameFactory = previous.factory === next.factory;
  const sameDeployment = JSON.stringify(previous.deployment) === JSON.stringify(next.deployment);
  const finalizedPending = previous.status === 'pending' && next.status === 'deployed' &&
    next.deployment?.hash === previous.deployment.hash && next.deployment?.nonce === previous.deployment.nonce;
  check(sameFactory && ((previous.status === next.status && sameDeployment) || finalizedPending),
    'STATE_TRANSITION', 'Factory state already records a different deployment intent or lifecycle status. It will not be replaced.');
}
function regular(stat, limit, label) {
  check(stat.isFile() && stat.nlink === 1 && stat.size <= limit && (stat.mode & 0o777) === 0o600,
    'STATE_FILE_INVALID', `${label} must be a bounded regular file with one hard link and permissions 0600; symlinks are not accepted.`);
}
async function readSecure(path, limit, label, missing = false) {
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    throw new FactoryStateError('STATE_IO', `Cannot inspect ${label}.`);
  }
  regular(before, limit, label);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const actual = await handle.stat();
    regular(actual, limit, label);
    check(sameFile(before, actual), 'STATE_FILE_CHANGED', `${label} changed while being opened.`);
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    check(used <= limit, 'STATE_FILE_INVALID', `${label} exceeds its size limit.`);
    const after = await lstat(path);
    check(sameFile(actual, after) && after.isFile(), 'STATE_FILE_CHANGED', `${label} changed while being read.`);
    let value;
    try { value = JSON.parse(buffer.subarray(0, used).toString('utf8')); }
    catch { throw new FactoryStateError('STATE_INVALID', `${label} contains malformed JSON; it will not be overwritten.`); }
    return { value, stat: actual };
  } catch (error) {
    if (error instanceof FactoryStateError) throw error;
    throw new FactoryStateError('STATE_IO', `Cannot securely read ${label}.`);
  } finally { await handle?.close(); }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function lockMetadata(value) {
  object(value, new Set(['version', 'pid', 'hostname', 'token', 'createdAt']), 'Lock');
  check(value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.hostname === 'string' && value.hostname.length > 0 && value.hostname.length <= 255 &&
    typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token) &&
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt, 'STATE_LOCK_INVALID',
  'Factory lock metadata is invalid. Check the lock manually; it will not be removed automatically.');
  return value;
}

/** Acquire an exclusive lock until close(). Existing locks, including stale ones, fail closed. */
export async function openFactoryState(path, inputIdentity) {
  check(typeof NOFOLLOW === 'number', 'STATE_UNSUPPORTED', 'This platform does not support secure no-follow file operations.');
  const identity = identityOf(inputIdentity);
  check(typeof path === 'string' && path.length > 0, 'STATE_INVALID', 'A factory state file path is required.');
  const statePath = resolve(path); const directory = dirname(statePath); const lockPath = `${statePath}.lock`;
  let lockHandle; let lockStat;
  const metadata = { version: 1, pid: process.pid, hostname: hostname(), token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  try {
    const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      // Persist newly created directory entries, including an optional nested state directory.
      for (let current = directory;; current = dirname(current)) {
        await syncDirectory(current);
        if (current === dirname(firstCreated)) break;
      }
    }
    try { lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readSecure(lockPath, 4096, 'Factory lock');
      const owner = lockMetadata(existing.value);
      throw new FactoryStateError('STATE_LOCK_HELD', `Factory state is locked by PID ${owner.pid} on host ${JSON.stringify(owner.hostname)}. After verifying that process has stopped, remove only ${JSON.stringify(lockPath)} manually. Stale locks are not removed automatically.`);
    }
    lockStat = await lockHandle.stat();
    await lockHandle.writeFile(`${JSON.stringify(metadata)}\n`);
    await lockHandle.sync();
    await syncDirectory(directory);
  } catch (error) {
    if (lockHandle) {
      try { if (sameFile(await lstat(lockPath), lockStat)) await unlink(lockPath); } catch { /* Preserve any replacement lock. */ }
      await lockHandle.close();
    }
    if (error instanceof FactoryStateError) throw error;
    throw new FactoryStateError('STATE_IO', 'Cannot create and persist the factory state lock.');
  }
  let tail = Promise.resolve(); let closing = false; let closePromise;
  const append = task => { const result = tail.then(task); tail = result.catch(() => {}); return result; };
  async function ownsLock() {
    const current = await readSecure(lockPath, 4096, 'Factory lock');
    check(sameFile(current.stat, lockStat) && lockMetadata(current.value).token === metadata.token,
      'STATE_LOCK_LOST', 'Factory lock was replaced or changed. The replacement will not be removed.');
  }
  async function readState() {
    const current = await readSecure(statePath, MAX_BYTES, 'Factory state', true);
    return current ? canonicalRecord(current.value, identity) : null;
  }
  function operation(task) {
    if (closing) return Promise.reject(new FactoryStateError('STATE_CLOSED', 'Factory state handle is closed.'));
    return append(async () => { await ownsLock(); return task(); });
  }
  return {
    read() { return operation(readState); },
    write(record) { return operation(async () => {
      // A caller may not skip read() and overwrite malformed or mismatched persisted state.
      const previous = await readState();
      object(record, RECORD_KEYS, 'Factory state update');
      const candidate = { version: 1, ...identity, updatedAt: new Date().toISOString(), ...record };
      const normalized = canonicalRecord(candidate, identity);
      normalized.updatedAt = new Date().toISOString();
      validTransition(previous, normalized);
      const body = `${JSON.stringify(normalized, null, 2)}\n`;
      check(Buffer.byteLength(body) <= MAX_BYTES, 'STATE_FILE_INVALID', 'Factory state exceeds 1 MiB.');
      const temporary = `${directory}/.${basename(statePath)}.${randomBytes(24).toString('hex')}.tmp`;
      let handle; let installed = false;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
        await ownsLock();
        const latest = await readState();
        check(JSON.stringify(latest) === JSON.stringify(previous), 'STATE_FILE_CHANGED',
          'Factory state changed during the write. The existing file will not be replaced.');
        validTransition(latest, normalized);
        await rename(temporary, statePath); installed = true;
        await syncDirectory(directory);
        return normalized;
      } catch (error) {
        if (error instanceof FactoryStateError) throw error;
        throw new FactoryStateError('STATE_IO', 'Factory state write or directory sync failed. Do not broadcast until the persisted state has been checked.');
      } finally {
        await handle?.close();
        if (!installed) { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw new FactoryStateError('STATE_IO', 'Cannot remove the temporary factory state file.'); } }
      }
    }); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = append(async () => {
        try { await ownsLock(); await unlink(lockPath); await syncDirectory(directory); }
        finally { await lockHandle.close(); }
      });
      return closePromise;
    },
  };
}
