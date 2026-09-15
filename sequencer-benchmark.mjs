#!/usr/bin/env node
import { open, mkdir, unlink, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Interface, Wallet, ZeroAddress, getAddress, getCreateAddress, isHexString, keccak256, parseEther, formatEther } from 'ethers';
import { CONFIG, MintError, createProvider, parseUint, safeError } from './mint.mjs';
import { gasQuote } from './batch.mjs';
import { openSequencer, SEQUENCER_URL } from './lib/sequencer.mjs';
import { loadBenchmarkArtifact, expectedBenchmarkRuntime } from './lib/benchmark-contract.mjs';
import { summarizeTransactionMetrics, formatTransactionMetrics } from './lib/transaction-metrics.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_RPC = 'https://robinhood-rpc.publicnode.com';
const CONFIG_KEYS = new Set(['rpcUrl', 'sequencerUrl', 'cycles', 'quantity', 'pollIntervalMs', 'receiptTimeoutSeconds',
  'intervalMs', 'maxGasCostEth', 'maxTotalGasCostEth', 'maxFeeMultiplier']);
const check = (value, message) => { if (!value) throw new MintError(message); };
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const print = value => console.log(json(value));
const ms = value => Math.round(value * 100) / 100;

export function parseSequencerBenchmarkArgs(argv) {
  const result = {};
  const flags = new Set(['help', 'send']);
  const values = new Set(['config', 'rpc', 'sequencer-url', 'cycles', 'quantity', 'from', 'output',
    'poll-interval-ms', 'receipt-timeout', 'interval-ms', 'max-gas-cost-eth', 'max-total-gas-cost-eth', 'max-fee-multiplier']);
  for (let index = 0; index < argv.length; index++) {
    check(argv[index].startsWith('--'), 'Use named benchmark options; see --help.');
    const key = argv[index].slice(2);
    check(!(key in result), 'Duplicate benchmark option.');
    if (flags.has(key)) result[key] = true;
    else {
      check(values.has(key) && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Unknown benchmark option or missing value; see --help.');
      result[key] = argv[++index];
    }
  }
  return result;
}

async function readConfig(path) {
  if (!path) return {};
  let handle;
  try {
    handle = await open(resolve(path), 'r');
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= 65536, 'Benchmark config must be a regular JSON file within 64 KiB.');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= 65536, 'Benchmark config exceeds 64 KiB.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError('Cannot read benchmark JSON config.');
  } finally { await handle?.close(); }
}

export function resolveSequencerBenchmarkOptions(args, config = {}) {
  check(config && typeof config === 'object' && !Array.isArray(config), 'Benchmark config must be a JSON object.');
  check(Object.keys(config).every(key => CONFIG_KEYS.has(key)), 'Unknown benchmark config field. Use the dedicated benchmark config.');
  const bounded = (value, lower, upper, name) => {
    const parsed = parseUint(value, name);
    check(parsed >= BigInt(lower) && parsed <= BigInt(upper), `${name} is outside the supported range.`);
    return Number(parsed);
  };
  const eth = (value, name) => {
    check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value), `${name} must be an ETH amount string.`);
    const parsed = parseUint(parseEther(value), name);
    check(parsed > 0n, `${name} must be positive.`);
    return parsed;
  };
  const rpcUrl = args.rpc ?? config.rpcUrl ?? DEFAULT_RPC;
  const sequencerUrl = args['sequencer-url'] ?? config.sequencerUrl ?? SEQUENCER_URL;
  for (const url of [rpcUrl, sequencerUrl]) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new MintError('Invalid benchmark RPC URL.'); }
    check(typeof url === 'string' && !parsed.username && !parsed.password && !parsed.hash &&
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))),
    'Benchmark RPC must use HTTPS (or HTTP on localhost), without URL user/password or fragment.');
  }
  return {
    rpcUrl, sequencerUrl, keepAliveIntervalMs: 10000,
    cycles: bounded(args.cycles ?? config.cycles ?? 1, 1, 1000, 'cycles'),
    quantity: bounded(args.quantity ?? config.quantity ?? 1, 1, 100, 'quantity'),
    pollIntervalMs: bounded(args['poll-interval-ms'] ?? config.pollIntervalMs ?? 100, 50, 5000, 'pollIntervalMs'),
    receiptTimeoutSeconds: bounded(args['receipt-timeout'] ?? config.receiptTimeoutSeconds ?? 30, 1, 300, 'receiptTimeoutSeconds'),
    intervalMs: bounded(args['interval-ms'] ?? config.intervalMs ?? 250, 100, 60000, 'intervalMs'),
    maxFeeMultiplier: bounded(args['max-fee-multiplier'] ?? config.maxFeeMultiplier ?? 2, 1, 20, 'maxFeeMultiplier'),
    maxGasCost: eth(args['max-gas-cost-eth'] ?? config.maxGasCostEth ?? '0.003', 'maxGasCostEth'),
    maxTotalGasCost: eth(args['max-total-gas-cost-eth'] ?? config.maxTotalGasCostEth ?? '0.01', 'maxTotalGasCostEth'),
  };
}

function senderAddress(value) {
  let address;
  try { address = getAddress(value); } catch { throw new MintError('Provide a valid --from address for dry-run, or PRIVATE_KEY with --send.'); }
  check(address !== ZeroAddress, 'The benchmark wallet cannot be zero.');
  return address;
}

/** A fresh append-only journal: no overwrites, signatures, private keys or RPC URLs.
 * The intent and local hash reach disk before submission; uncertain runs stop.
 */
async function journalFor(output, wallet, liveRun) {
  const directory = resolve(ROOT, '.state', 'benchmarks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = output ? resolve(output) : resolve(directory, `sequencer-${Date.now()}-${randomBytes(6).toString('hex')}.jsonl`);
  let handle, lock, lockStat;
  const lockPath = resolve(directory, `wallet-4663-${wallet.toLowerCase()}.lock`);
  const close = async () => {
    await handle?.close();
    if (lock) {
      await lock.close();
      const current = await lstat(lockPath).catch(() => null);
      if (current?.ino === lockStat.ino && current?.dev === lockStat.dev) await unlink(lockPath);
      lock = undefined;
    }
  };
  try {
    if (liveRun) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch { throw new MintError('Benchmark wallet lock is unavailable. Check other benchmark processes or a stale lock before restarting.'); }
      lockStat = await lock.stat();
      await lock.writeFile(json({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }) + '\n');
      await lock.sync();
    }
    // Explicit output parents must already exist; never overwrite an old report.
    try { handle = await open(path, 'wx', 0o600); }
    catch { throw new MintError('Cannot create benchmark output exclusively. Choose a new output file in an existing directory.'); }
    return { path, close, append: async record => { await handle.writeFile(json(record) + '\n'); await handle.sync(); } };
  } catch (error) { await close(); throw error; }
}

function cancelled(signal) { check(!signal.aborted, 'Benchmark cancelled. Check recorded transaction hashes before restarting.'); }
async function guard(operation, signal) {
  cancelled(signal);
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { cancelled(signal); return operation(); }),
      new Promise((_, reject) => { abort = () => reject(new MintError('Benchmark cancelled. Check recorded transaction hashes before restarting.')); signal.addEventListener('abort', abort, { once: true }); }),
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}

async function observeReceipt(reader, hash, start, options, signal, record) {
  const deadline = performance.now() + options.receiptTimeoutSeconds * 1000;
  const local = new AbortController();
  const abort = () => local.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, options.receiptTimeoutSeconds * 1000);
  try {
    while (!local.signal.aborted && performance.now() < deadline) {
      let receipt;
      record.receiptPolls++;
      try { receipt = await guard(() => reader.send('eth_getTransactionReceipt', [hash]), local.signal); }
      catch {
        if (local.signal.aborted) break;
        record.receiptRpcErrors++;
      }
      if (receipt) {
        check(receipt.transactionHash?.toLowerCase() === hash, 'Read RPC returned a receipt for a different hash.');
        check(['0x0', '0x1'].includes(receipt.status), 'Read RPC returned invalid receipt status.');
        parseUint(receipt.blockNumber, 'receipt block');
        record.timingsMs.receiptObserved = ms(performance.now() - start);
        return receipt;
      }
      try { await sleep(Math.min(options.pollIntervalMs, Math.max(1, deadline - performance.now())), undefined, { signal: local.signal }); }
      catch { break; }
    }
    throw new MintError('Receipt observation timed out or was cancelled. Submission outcome may be uncertain.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

async function readContract(reader, address, iface, method, args = []) {
  const result = await reader.send('eth_call', [{ to: address, data: iface.encodeFunctionData(method, args) }, 'latest']);
  return iface.decodeFunctionResult(method, result)[0];
}

async function verifyDeployed(reader, contract, runtime, iface, owner, runId) {
  const [code, actualOwner, actualRunId] = await Promise.all([
    reader.send('eth_getCode', [contract, 'latest']), readContract(reader, contract, iface, 'owner'), readContract(reader, contract, iface, 'runId'),
  ]);
  check(typeof code === 'string' && code.toLowerCase() === runtime.toLowerCase(), 'Test contract runtime differs from the compiled benchmark artifact.');
  check(actualOwner === owner && actualRunId.toLowerCase() === runId.toLowerCase(), 'Deployed benchmark ownership or run ID differs from the request.');
}

async function verifyMint(reader, receipt, contract, iface, owner, quantity) {
  check(Array.isArray(receipt.logs), 'Mint receipt is missing logs.');
  const transfers = receipt.logs.filter(log => log.address?.toLowerCase() === contract.toLowerCase()).flatMap(log => {
    try { const parsed = iface.parseLog(log); return parsed?.name === 'Transfer' ? [parsed] : []; } catch { return []; }
  });
  check(transfers.length === quantity, 'Mint receipt has an unexpected number of NFT transfers.');
  const ids = transfers.map(event => event.args.tokenId);
  check(transfers.every(event => event.args.from === ZeroAddress && event.args.to === owner) &&
    new Set(ids.map(String)).size === quantity && ids.every(id => id >= 1n && id <= BigInt(quantity)),
  'Mint receipt contains unexpected owners or token IDs.');
  const [supply, balance, firstOwner, lastOwner] = await Promise.all([
    readContract(reader, contract, iface, 'totalSupply'), readContract(reader, contract, iface, 'balanceOf', [owner]),
    readContract(reader, contract, iface, 'ownerOf', [1n]), readContract(reader, contract, iface, 'ownerOf', [BigInt(quantity)]),
  ]);
  check(supply === BigInt(quantity) && balance === supply && firstOwner === owner && lastOwner === owner, 'Post-mint ownership or supply verification failed.');
  return ids.map(String);
}

const HELP = `Live sequencer transaction benchmark / Robinhood Chain 4663
  npm run benchmark:sequencer -- --send
  npm run benchmark:sequencer -- --cycles 100 --send --output results.jsonl
  npm run benchmark:sequencer -- --from 0xYOUR_WALLET
Default: one cycle = two transactions: new test NFT contract, then mint(quantity).
The test contract has no cumulative supply cap. It is unrelated to Rare Friends.
--send                         Read PRIVATE_KEY from environment, sign and submit real transactions.
Without --send: simulate deployment only; no signing/deployment/mint is performed.
--config FILE                  Dedicated benchmark config (not batch.config.json).
--rpc URL                      Read/simulation/fees/nonce/receipt RPC.
--sequencer-url URL            Nitro health/send endpoint; default official Robinhood sequencer.
--cycles N                     Fresh deploy+mint pairs, default 1; 1..1000 (2*N transactions).
--quantity N                   Test NFTs per mint, default 1; 1..100.
--poll-interval-ms N            Receipt poll pause, default 100; 50..5000.
--receipt-timeout SECONDS       Receipt observation deadline, default 30; 1..300.
--interval-ms N                Pause between cycles, default 250; 100..60000.
--max-gas-cost-eth ETH          Reserve ceiling per transaction, default 0.003.
--max-total-gas-cost-eth ETH    Actual spent + next transaction reserve ceiling, default 0.01.
--max-fee-multiplier N          Base fee multiplier, default 2; 1..20.
--from ADDRESS                 Required without --send; must match key if both provided.
--output FILE.jsonl            New exclusive journal, default .state/benchmarks/*.jsonl.
One raw submission attempt per transaction. Stop on uncertain outcome or failure.
Prints p50/p95/p99 separately for deploy and mint. One pair is a smoke test, not tail statistics.
Receipt time starts at send invocation and includes RPC propagation/poll delay; it is not finality.
Use a dedicated funded test wallet with no pending transactions or concurrent sender.`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseSequencerBenchmarkArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const options = resolveSequencerBenchmarkOptions(args, await readConfig(args.config));
  let wallet;
  if (args.send) {
    check(isHexString(process.env.PRIVATE_KEY, 32), '--send requires a 32-byte PRIVATE_KEY in the environment.');
    try { wallet = new Wallet(process.env.PRIVATE_KEY); } catch { throw new MintError('Invalid PRIVATE_KEY.'); }
    if (args.from) check(senderAddress(args.from) === wallet.address, '--from differs from the PRIVATE_KEY wallet.');
  }
  const owner = wallet?.address ?? senderAddress(args.from);
  const artifact = await loadBenchmarkArtifact();
  const iface = new Interface(artifact.abi);
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  let reader, sequencer, journal;
  const ownedProviders = [];
  const cancel = () => { cancellation.abort(); for (const provider of ownedProviders) provider.destroy(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const records = [];
  let spent = 0n;
  let success = false;
  let stopReason;
  let expectedNonce;
  const startedAt = new Date().toISOString();
  try {
    journal = await journalFor(args.output, owner, Boolean(args.send));
    await journal.append({ type: 'start', startedAt, chainId: String(CONFIG.chainId), owner, live: Boolean(args.send),
      requestedCycles: options.cycles, plannedTransactions: options.cycles * 2, quantity: options.quantity,
      maxGasCostWei: options.maxGasCost, maxTotalGasCostWei: options.maxTotalGasCost,
      pollIntervalMs: options.pollIntervalMs, receiptTimeoutSeconds: options.receiptTimeoutSeconds });
    print({ type: 'plan', live: Boolean(args.send), cycles: options.cycles, plannedTransactions: options.cycles * 2,
      quantity: options.quantity, wallet: owner, journal: journal.path });
    reader = createProvider(options.rpcUrl); ownedProviders.push(reader);
    const [chain, latestNonce, pendingNonce] = await guard(() => Promise.all([
      reader.send('eth_chainId', []), reader.send('eth_getTransactionCount', [owner, 'latest']), reader.send('eth_getTransactionCount', [owner, 'pending']),
    ]), signal);
    check(parseUint(chain) === CONFIG.chainId, 'Read RPC is connected to the wrong chain.');
    expectedNonce = parseUint(pendingNonce);
    if (args.send) check(parseUint(latestNonce) === expectedNonce, 'The benchmark wallet already has pending transactions. Wait for them before starting.');
    sequencer = await openSequencer(options, { register: provider => ownedProviders.push(provider), signal, onProgress: print });

    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      if (cycle > 1) await sleep(options.intervalMs, undefined, { signal });
      const runId = `0x${randomBytes(32).toString('hex')}`;
      const contract = getCreateAddress({ from: owner, nonce: expectedNonce });
      const runtime = expectedBenchmarkRuntime(artifact, owner, runId);
      const creation = artifact.bytecode + iface.encodeDeploy([runId]).slice(2);
      for (const kind of ['deploy', 'mint']) {
        cancelled(signal);
        const phaseStarted = performance.now();
        const record = { cycle, kind, contract, runId, status: 'failed', acknowledged: false,
          timingsMs: {}, receiptPolls: 0, receiptRpcErrors: 0 };
        records.push(record);
        let submitted = false;
        try {
          await sequencer.ensureHealthy();
          const tx = { from: owner, value: '0x0', ...(kind === 'deploy'
            ? { data: creation } : { to: contract, data: iface.encodeFunctionData('mint', [options.quantity]) }) };
          const [block, currentChain, nonce] = await guard(() => Promise.all([
            reader.send('eth_getBlockByNumber', ['latest', false]), reader.send('eth_chainId', []),
            reader.send('eth_getTransactionCount', [owner, 'pending']),
          ]), signal);
          check(parseUint(currentChain) === CONFIG.chainId, 'Read RPC chain changed before signing.');
          check(parseUint(nonce) === expectedNonce, 'Wallet nonce changed outside this benchmark. No replacement or new nonce will be signed.');
          check(block?.number != null && block?.gasLimit != null, 'Read RPC returned an incomplete latest block.');
          const [simulated, estimate] = await guard(() => Promise.all([
            reader.send('eth_call', [tx, 'latest']), reader.send('eth_estimateGas', [tx, 'latest']),
          ]), signal);
          if (kind === 'deploy') check(typeof simulated === 'string' && simulated.toLowerCase() === runtime.toLowerCase(), 'Deployment simulation returned unexpected test contract runtime.');
          else check(iface.decodeFunctionResult('mint', simulated)[0] === 1n, 'Mint simulation did not return the expected first test token ID.');
          const gasEstimate = parseUint(estimate, 'gas estimate');
          check(gasEstimate > 0n, 'Read RPC returned a zero gas estimate.');
          const [quote, balance] = await guard(() => Promise.all([
            gasQuote(reader, gasEstimate, block, options.maxGasCost, options.maxFeeMultiplier),
            reader.send('eth_getBalance', [owner, 'pending']),
          ]), signal);
          check(spent + quote.maxGasCost <= options.maxTotalGasCost, 'Total benchmark gas budget cannot cover the next transaction reserve.');
          record.timingsMs.prepare = ms(performance.now() - phaseStarted);
          if (!args.send) {
            records.pop();
            const result = { type: 'dryRun', contract, deploymentSimulation: 'passed', mintSimulation: 'not attempted; requires deployed test contract',
              gasEstimate: String(estimate), gasLimit: quote.gasLimit, maximumGasCostEth: formatEther(quote.maxGasCost), transactionsSubmitted: 0 };
            await journal.append(result); print(result); success = true;
            return result;
          }
          check(parseUint(balance) >= quote.maxGasCost, 'Wallet balance cannot cover the next transaction reserve.');
          const signStarted = performance.now();
          const raw = await wallet.signTransaction({ to: tx.to, data: tx.data, value: 0n, nonce: expectedNonce,
            chainId: CONFIG.chainId, gasLimit: quote.gasLimit, ...quote.fees });
          record.timingsMs.sign = ms(performance.now() - signStarted);
          record.hash = keccak256(raw);
          record.nonce = String(expectedNonce);
          record.gasLimit = String(quote.gasLimit);
          cancelled(signal);
          await journal.append({ type: 'intent', cycle, kind, from: owner, contract, runId, hash: record.hash, nonce: record.nonce,
            gasLimit: quote.gasLimit, transactionType: quote.fees.type, maxFeePerGas: quote.fees.maxFeePerGas,
            maxPriorityFeePerGas: quote.fees.maxPriorityFeePerGas, gasPrice: quote.fees.gasPrice, valueWei: '0', quantity: options.quantity });
          cancelled(signal);
          print({ type: 'submission', cycle, kind, hash: record.hash, contract });
          const sendStarted = performance.now();
          submitted = true;
          record.status = 'uncertain';
          const ack = sequencer.provider.send('eth_sendRawTransaction', [raw]).then(hash => {
            if (typeof hash === 'string' && hash.toLowerCase() === record.hash) {
              record.acknowledged = true;
              record.timingsMs.ack = ms(performance.now() - sendStarted);
            } else record.ackError = 'Sequencer returned an unexpected hash; acknowledgement unconfirmed.';
          }, () => { record.ackError = 'Sequencer acknowledgement unavailable; submission may have succeeded.'; });
          // Observe the local hash immediately, independently of the sequencer response.
          // A delayed/lost ACK must not move the start of receipt measurement.
          const receiptResult = observeReceipt(reader, record.hash, sendStarted, options, signal, record);
          const [, observed] = await Promise.allSettled([ack, receiptResult]);
          if (observed.status === 'rejected') throw observed.reason;
          const receipt = observed.value;
          const gasUsed = parseUint(receipt.gasUsed, 'receipt gas used');
          const gasPrice = parseUint(receipt.effectiveGasPrice, 'receipt effective gas price');
          check(gasUsed > 0n && gasUsed <= quote.gasLimit && gasPrice <= (quote.fees.maxFeePerGas ?? quote.fees.gasPrice), 'Receipt gas accounting is inconsistent with the signed transaction.');
          const cost = gasUsed * gasPrice;
          spent += cost;
          Object.assign(record, { gasUsed: String(gasUsed), effectiveGasPrice: String(gasPrice), costWei: String(cost),
            costEth: formatEther(cost), blockNumber: String(parseUint(receipt.blockNumber)), status: parseUint(receipt.status) === 1n ? 'mined' : 'reverted' });
          check(record.status === 'mined', 'Test transaction reverted. Benchmark stopped before sending another transaction.');
          expectedNonce++;
          if (kind === 'deploy') {
            check(senderAddress(receipt.contractAddress) === contract, 'Deployment receipt contains an unexpected contract address.');
            await guard(() => verifyDeployed(reader, contract, runtime, iface, owner, runId), signal);
          } else record.tokenIds = await guard(() => verifyMint(reader, receipt, contract, iface, owner, options.quantity), signal);
          record.verified = true;
        } catch (error) {
          record.error = safeError(error);
          if (!submitted) record.status = 'failed';
          throw error;
        } finally {
          record.timingsMs.total = ms(performance.now() - phaseStarted);
          if (args.send || record.error) { await journal.append({ type: 'result', ...record }); print({ type: 'result', ...record }); }
        }
      }
    }
    success = true;
    return { success: true };
  } catch (error) {
    stopReason = safeError(error);
    throw error;
  } finally {
    sequencer?.close();
    for (const provider of ownedProviders) provider.destroy();
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    const statistics = summarizeTransactionMetrics(records, options.cycles);
    const summary = { type: 'summary', success, live: Boolean(args.send), startedAt, finishedAt: new Date().toISOString(),
      requestedCycles: options.cycles, submittedTransactions: records.filter(record => record.hash && record.status !== 'failed').length,
      spentWei: String(spent), spentEth: formatEther(spent), stopReason, statistics };
    try {
      if (journal) await journal.append(summary);
      print(summary);
      console.log(formatTransactionMetrics(statistics));
      if (journal) console.log(`Journal: ${journal.path}`);
    } finally { await journal?.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${safeError(error)}`); process.exitCode = 1; });
}
