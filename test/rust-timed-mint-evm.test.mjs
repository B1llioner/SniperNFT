import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Transaction, Wallet, getCreateAddress, parseEther, toQuantity } from 'ethers';
import { WebSocketServer } from 'ws';

// A fresh, non-forked EVM executes the embedded production test artifacts. Local
// HTTP/WS proxies exercise routing, signing and uncertainty handling, not TLS or
// real sequencer latency. Only publisher health and named fault injections are
// mocked; state-override eth_call/estimateGas execute in Anvil itself.
const KEY = `0x${'77'.repeat(32)}`; // Public synthetic material. Never fund it on a public chain.
const OWNER = new Wallet(KEY).address;
const WRONG_KEY = `0x${'66'.repeat(32)}`;
const INITIAL_BALANCE = parseEther('0.02');
const BINARY = process.env.RUST_MINT_BENCHMARK_BIN ?? fileURLToPath(new URL('../rust-mint-benchmark/target/debug/rust-mint-benchmark', import.meta.url));
const ARTIFACT = JSON.parse(await readFile(new URL('../artifacts/timed-benchmark.json', import.meta.url), 'utf8'));
const NFT_ABI = new Interface(ARTIFACT.contracts.TimedBenchmarkNFT.abi);
const FACTORY_ABI = new Interface(ARTIFACT.contracts.TimedBenchmarkBatchMinter.abi);
const DROP_RESPONSE = Symbol('drop-response');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function available(t) {
  try { await access(BINARY); } catch {
    t.skip('Build rust-mint-benchmark or set RUST_MINT_BENCHMARK_BIN for local integration tests.');
    return false;
  }
  const version = spawnSync(process.env.ANVIL_BIN ?? 'anvil', ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (version.error?.code === 'ENOENT') {
    t.skip('Set ANVIL_BIN to a recent Anvil with interval mining and estimateGas state overrides.');
    return false;
  }
  assert.equal(version.status, 0, 'Anvil must start successfully.');
  return true;
}

async function localAnvil(t) {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663',
    '--hardfork', 'shanghai', '--block-time', '0.2', '--gas-limit', '30000000',
    '--gas-price', '50000000', '--base-fee', '50000000', '--disable-min-priority-fee',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', startError;
  anvil.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) anvil.kill('SIGKILL'); });
  anvil.on('error', error => { startError = error; });
  const exited = new Promise(resolve => anvil.once('close', resolve));
  const request = new FetchRequest(`http://127.0.0.1:${port}`);
  request.timeout = 2000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  t.after(async () => {
    provider.destroy();
    if (anvil.exitCode == null) anvil.kill('SIGTERM');
    await Promise.race([exited, delay(2000)]);
    if (anvil.exitCode == null) { anvil.kill('SIGKILL'); await exited; }
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startError) throw startError;
    assert.equal(anvil.exitCode, null, `Anvil exited during startup: ${stderr}`);
    try {
      assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal(BigInt(await provider.send('eth_chainId', [])), 4663n);
      assert.ok(BigInt(await provider.send('eth_blockNumber', [])) < 10n, 'Use a fresh non-forked chain.');
      await provider.send('anvil_setBalance', [OWNER, toQuantity(INITIAL_BALANCE)]);
      // Anvil's genesis header timestamp is not the historical eth_call EVM
      // timestamp. Start from an ordinary block before timestamp-pinned calls.
      await provider.send('evm_mine', []);
      assert.ok(BigInt(await provider.send('eth_gasPrice', [])) <= 50000000n, 'The local low-fee fixture must fit the full two-route budget.');
      return provider;
    } catch (error) { if (attempt === 59) throw error; await delay(50); }
  }
}

async function fixture(t, fault = null) {
  const upstream = await localAnvil(t);
  const directory = await mkdtemp(join(tmpdir(), 'vinos-rust-timed-evm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'report');
  const lockDir = join(directory, 'locks');
  const state = { upstream, directory, output, lockDir, calls: [], submissions: [], faults: [], violations: [], simulations: [], hiddenHash: null };

  async function dispatch(route, rpc) {
    assert.equal(rpc.jsonrpc, '2.0');
    assert.ok(Number.isSafeInteger(rpc.id));
    assert.ok(Array.isArray(rpc.params));
    const { method, params } = rpc;
    state.calls.push({ route, method, params: method === 'eth_sendRawTransaction' ? [] : params });
    if (route === 'reader' && ['eth_sendRawTransaction', 'arb_checkPublisherHealth'].includes(method)) {
      state.violations.push(`${route}:${method}`);
      throw new Error('Reader route must never broadcast.');
    }
    if (route === 'https' && !['arb_checkPublisherHealth', 'eth_sendRawTransaction'].includes(method)) {
      state.violations.push(`${route}:${method}`);
      throw new Error('Sequencer route only accepts health and raw submission.');
    }
    if (route === 'wss' && !['eth_chainId', 'eth_sendRawTransaction'].includes(method)) {
      state.violations.push(`${route}:${method}`);
      throw new Error('WSS sender route must use the separate reader for chain observations.');
    }
    if (method === 'arb_checkPublisherHealth') return null;
    if (fault === 'external-nonce-before-live' && route === 'reader' && method === 'eth_getTransactionCount' && params[1] === 'latest'
      && state.calls.filter(call => call.method === method && call.params[1] === 'latest').length === 3) {
      // A separate local writer consumes nonce zero after both preflights. This
      // transaction is deliberately outside the CLI's sender routes.
      const raw = await new Wallet(KEY).signTransaction({ chainId: 4663, type: 2, nonce: 0, to: OWNER, value: 0n,
        gasLimit: 21000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 0n });
      await upstream.send('eth_sendRawTransaction', [raw]);
      await upstream.send('evm_mine', []);
      state.faults.push('A separate local writer consumed nonce zero after preflight.');
    }
    if (method === 'eth_sendRawTransaction') {
      const tx = Transaction.from(params[0]);
      assert.equal(tx.from, OWNER);
      assert.equal(tx.chainId, 4663n);
      assert.equal(tx.type, 2);
      assert.equal(tx.value, 0n);
      // A durable intent must exist before any network write.
      const journal = await readFile(join(output, 'journal.jsonl'), 'utf8');
      assert.ok(journal.split('\n').filter(Boolean).map(JSON.parse).some(entry => entry.type === 'intent' && entry.hash === tx.hash && entry.nonce === tx.nonce), 'Persist the transaction hash and nonce before submitting it.');
      state.submissions.push({ route, tx });
      if (fault === 'expired-mint-windows' && tx.nonce === 3) {
        // Move the actual EVM clock after setup/preflight, without delaying ACK
        // or substituting receipt data. Every subsequent real mint window is
        // already expired when its transaction executes.
        await upstream.send('evm_increaseTime', [2]);
        state.faults.push('Local EVM time advanced by two seconds before the first mint.');
      }
      if (fault === 'timeout-before-broadcast') {
        state.faults.push('No upstream acceptance; response exceeds the sender timeout.');
        await delay(1800); // Rust sender deadline is 1500 ms; do not send to Anvil.
        return DROP_RESPONSE;
      }
      const acceptedHash = await upstream.send(method, params);
      assert.equal(acceptedHash, tx.hash);
      if (fault === 'accepted-but-unobservable') {
        state.hiddenHash = tx.hash;
        state.faults.push('Anvil accepted transaction; reader receipt hidden and ACK lost.');
        return DROP_RESPONSE;
      }
      return acceptedHash;
    }
    if (state.hiddenHash && method === 'eth_getTransactionReceipt' && params[0] === state.hiddenHash) return null;
    const result = await upstream.send(method, params);
    if (method === 'eth_call' && params.length === 3) {
      const pinned = await upstream.send('eth_getBlockByNumber', [params[1], false]);
      state.simulations.push({ block: params[1], timestamp: pinned.timestamp, result,
        storage: Object.values(params[2]).map(override => override.state) });
    }
    return result;
  }

  function responseFor(rpc, result, error) {
    return JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, ...(error ? { error: { code: -32000, message: error.shortMessage ?? error.message, data: error.data } } : { result }) });
  }
  for (const route of ['reader', 'https']) {
    const server = createServer(async (request, response) => {
      let rpc;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(size < 1024 * 1024, 'Test RPC payload exceeded its limit.');
          chunks.push(chunk);
        }
        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await dispatch(route, rpc);
        if (result === DROP_RESPONSE) { response.destroy(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(responseFor(rpc, result));
      } catch (error) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(responseFor(rpc, undefined, error));
      }
    });
    state[`${route}Url`] = `http://127.0.0.1:${await listen(server)}`;
    t.after(() => close(server));
  }
  const wsHttp = createServer();
  const ws = new WebSocketServer({ server: wsHttp, maxPayload: 1024 * 1024 });
  ws.on('connection', socket => socket.on('message', async payload => {
    let rpc;
    try {
      rpc = JSON.parse(payload.toString());
      const result = await dispatch('wss', rpc);
      if (result === DROP_RESPONSE) { socket.terminate(); return; }
      socket.send(responseFor(rpc, result));
    } catch (error) { if (socket.readyState === 1) socket.send(responseFor(rpc, undefined, error)); }
  }));
  state.wssUrl = `ws://127.0.0.1:${await listen(wsHttp)}`;
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await close(wsHttp);
  });
  return state;
}

async function runCli(t, state, { transport = 'both', key = KEY, extra = [], send = true, timeout = 160000 } = {}) {
  const child = spawn(BINARY, [
    '--wallet', OWNER, '--transport', transport,
    '--read-rpc', state.readerUrl, '--https-url', state.httpsUrl, '--wss-url', state.wssUrl,
    '--output', state.output, '--lock-dir', state.lockDir,
    '--start-delay-seconds', '15', '--receipt-timeout-seconds', '5',
    ...(send ? ['--send', '--test-key-stdin'] : []), ...extra,
  ], { env: { PATH: process.env.PATH, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {}); // CLI can reject preflight before reading the synthetic key.
  child.stdin.end(send ? `${key}\n` : '');
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  t.after(() => { clearTimeout(timer); if (child.exitCode == null) child.kill('SIGKILL'); });
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.equal(signal, null, `Rust CLI was killed or exceeded its deadline:\n${stderr}\n${stdout}`);
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY) && !stdout.includes(WRONG_KEY) && !stderr.includes(WRONG_KEY), 'Never disclose key input.');
  for (const { tx } of state.submissions) assert.ok(!stdout.includes(tx.serialized) && !stderr.includes(tx.serialized), 'Never print signed raw transactions.');
  assert.deepEqual(state.violations, [], 'Transport routing must remain separated.');
  return { code, stdout, stderr };
}

async function readReports(state) {
  const files = await readdir(state.output);
  const reports = {};
  for (const file of files) {
    const text = await readFile(join(state.output, file), 'utf8');
    assert.ok(!text.includes(KEY) && !text.includes(WRONG_KEY), 'Reports must never store a key.');
    for (const { tx } of state.submissions) assert.ok(!text.includes(tx.serialized), 'Reports must never store signed raw transactions.');
    reports[file] = file.endsWith('.jsonl') ? text.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(text);
  }
  return reports;
}

test('Rust timed benchmark runs both transports through real deployment, arming and ten timed batches each', { timeout: 180000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state);
  assert.ok(result.code === 0 || result.code === 2, `Rust CLI did not complete:\n${result.stderr}\n${result.stdout}\nSimulations: ${JSON.stringify(state.simulations)}`);
  assert.equal(state.submissions.length, 26, 'Each transport must deploy two contracts, arm once and submit ten batches.');
  const reports = await readReports(state);
  assert.equal((await readdir(state.lockDir)).filter(file => file.endsWith('.pending.json')).length, 0, 'Fully resolved run clears its durable wallet marker.');
  const plan = reports['plan.json'];
  assert.ok(plan, 'Persist the preflight plan.');
  assert.equal(plan.chainId, 4663);
  assert.equal(plan.wallet.toLowerCase(), OWNER.toLowerCase());
  assert.equal(plan.roundsPerRoute, 10);
  assert.equal(plan.nftsPerRoundMaximum, 10);
  assert.equal(plan.deployments.length, 2);
  assert.ok(BigInt(plan.maximumGasCostWei) <= parseEther('0.019'));
  assert.ok(BigInt(plan.maximumGasCostWei) + parseEther('0.001') <= INITIAL_BALANCE);
  assert.equal(BigInt(plan.maximumGasCostWei), 2n * (4000000n + 150000n + 10n * 3000000n) * BigInt(plan.maxFeePerGasWei));
  assert.ok(state.calls.some(call => call.route === 'https' && call.method === 'arb_checkPublisherHealth'));
  assert.ok(state.calls.some(call => call.route === 'wss' && call.method === 'eth_chainId'));
  assert.equal(state.calls.filter(call => call.route === 'reader' && call.method === 'eth_call' && call.params.length === 3).length, 6, 'Both preflights and the final check simulate each route against real EVM state.');
  assert.ok(state.calls.filter(call => call.route === 'reader' && call.method === 'eth_estimateGas' && call.params.length === 3).length >= 6);
  assert.equal(new Set(state.submissions.map(({ tx }) => tx.hash)).size, 26, 'No signed transaction was submitted twice.');
  assert.deepEqual(state.submissions.map(({ tx }) => tx.nonce), Array.from({ length: 26 }, (_, index) => index));
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 26n);
  let actualCost = 0n;
  const observedRounds = [];
  for (let routeIndex = 0; routeIndex < 2; routeIndex++) {
    const route = routeIndex === 0 ? 'https' : 'wss';
    const transactions = state.submissions.slice(routeIndex * 13, (routeIndex + 1) * 13);
    assert.ok(transactions.every(item => item.route === route));
    const nftAddress = getCreateAddress({ from: OWNER, nonce: routeIndex * 13 });
    const factoryAddress = getCreateAddress({ from: OWNER, nonce: routeIndex * 13 + 1 });
    const deployment = plan.deployments[routeIndex];
    assert.equal(deployment.collection.toLowerCase(), nftAddress.toLowerCase());
    assert.equal(deployment.factory.toLowerCase(), factoryAddress.toLowerCase());
    assert.equal(deployment.simulation.fullBatchMinted, 10);
    assert.equal(deployment.simulation.stateOverride, true);
    assert.equal(deployment.simulation.liveDeployment, false);
    assert.equal(transactions[0].tx.to, null);
    assert.equal(transactions[1].tx.to, null);
    assert.ok(transactions[0].tx.data.startsWith(ARTIFACT.contracts.TimedBenchmarkNFT.bytecode));
    assert.ok(transactions[1].tx.data.startsWith(ARTIFACT.contracts.TimedBenchmarkBatchMinter.bytecode));
    assert.equal(transactions[2].tx.to, nftAddress);
    const arm = NFT_ABI.parseTransaction(transactions[2].tx);
    assert.equal(arm.name, 'arm');
    const startTime = Number(arm.args[0]);
    const nft = new Contract(nftAddress, NFT_ABI, state.upstream);
    const factory = new Contract(factoryAddress, FACTORY_ABI, state.upstream);
    assert.equal(await nft.owner(), OWNER);
    assert.equal(await factory.owner(), OWNER);
    assert.equal(await factory.recipient(), OWNER);
    assert.equal(await factory.collection(), nftAddress);
    assert.equal(await nft.MAX_SUPPLY(), 10000n);
    assert.equal(await nft.ROUNDS(), 10n);
    assert.equal(await nft.startTime(), BigInt(startTime));
    assert.equal(await nft.runId(), deployment.runId);
    let mintedTotal = 0n;
    const helpers = new Set();
    for (let index = 0; index < transactions.length; index++) {
      const { tx } = transactions[index];
      assert.equal(tx.value, 0n);
      assert.equal(tx.maxFeePerGas, BigInt(plan.maxFeePerGasWei));
      assert.equal(tx.maxPriorityFeePerGas, 0n);
      assert.equal(tx.gasLimit, index < 2 ? 2000000n : index === 2 ? 150000n : 3000000n);
      const receipt = await state.upstream.send('eth_getTransactionReceipt', [tx.hash]);
      assert.equal(receipt.status, '0x1');
      assert.equal(receipt.transactionHash, tx.hash);
      assert.ok(BigInt(receipt.gasUsed) <= tx.gasLimit);
      assert.ok(BigInt(receipt.effectiveGasPrice) <= tx.maxFeePerGas);
      actualCost += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      if (index < 3) continue;
      const round = index - 3;
      assert.equal(tx.to, factoryAddress);
      const call = FACTORY_ABI.parseTransaction(tx);
      assert.equal(call.name, 'mintBatch');
      assert.equal(call.args[0], BigInt(round));
      assert.equal(call.args[1], 10n);
      const events = receipt.logs.filter(log => log.address.toLowerCase() === factoryAddress.toLowerCase()).map(log => FACTORY_ABI.parseLog(log));
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal(event.name, 'BatchResult');
      assert.equal(event.args.round, BigInt(round));
      assert.equal(event.args.requested, 10n);
      assert.ok(event.args.minted >= 0n && event.args.minted <= 10n);
      const block = await state.upstream.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
      assert.equal(block.hash, receipt.blockHash, 'Receipt must be in the current canonical block.');
      const target = startTime + round;
      if (Number(block.timestamp) < target) assert.equal(event.args.status, 4n);
      else if (Number(block.timestamp) >= target + 1) assert.equal(event.args.status, 5n);
      else { assert.equal(event.args.status, 0n); assert.equal(event.args.minted, 10n); }
      mintedTotal += event.args.minted;
      const nftEvents = receipt.logs.filter(log => log.address.toLowerCase() === nftAddress.toLowerCase()).map(log => NFT_ABI.parseLog(log)).filter(event => event.name === 'Transfer');
      const mints = nftEvents.filter(event => BigInt(event.args.from) === 0n);
      const deliveries = nftEvents.filter(event => event.args.to === OWNER);
      assert.equal(mints.length, Number(event.args.minted));
      assert.equal(deliveries.length, Number(event.args.minted));
      for (const mint of mints) {
        assert.ok(!helpers.has(mint.args.to), 'Every NFT is minted by a fresh helper subject to the lifetime sender cap.');
        helpers.add(mint.args.to);
        assert.equal(await nft.hasMinted(mint.args.to), true);
        assert.equal(await nft.ownerOf(mint.args.tokenId), OWNER);
      }
      observedRounds.push({ route, round, hash: tx.hash, target, receipt, event, block });
    }
    assert.equal(await nft.totalSupply(), mintedTotal);
    assert.equal(await nft.balanceOf(OWNER), mintedTotal);
    assert.equal(await nft.hasMinted(OWNER), false, 'EOA receives transfers; helpers consume their own lifetime allowances.');
  }
  assert.notEqual(plan.deployments[0].runId, plan.deployments[1].runId);
  assert.equal(observedRounds.length, 20);
  assert.ok(actualCost > 0n && actualCost <= BigInt(plan.maximumGasCostWei));
  assert.equal(await state.upstream.getBalance(OWNER), INITIAL_BALANCE - actualCost);
  const completed = reports['result.json'];
  assert.equal(completed.kind, 'rust-timed-mint-result-v1');
  assert.equal(completed.completed, true);
  assert.equal(completed.routes.length, 2);
  assert.equal(BigInt(completed.gasCostWei), actualCost);
  assert.equal(BigInt(completed.finalBalanceWei), INITIAL_BALANCE - actualCost);
  assert.equal(result.code, completed.allTenFullBatchesInFirstBlock ? 0 : 2, 'Missing a local first block is a completed observation, not a transport failure.');
  for (const [index, route] of completed.routes.entries()) {
    const label = index === 0 ? 'https-sequencer' : 'wss-rpc-provider';
    assert.equal(route.route, label);
    assert.deepEqual(reports[`${label}.json`], route);
    assert.equal(route.rounds.length, 10);
    assert.equal(route.setupReceipts.length, 3);
    assert.equal(route.allTransactionsResolved, true);
    const expected = observedRounds.slice(index * 10, (index + 1) * 10);
    let firstHits = 0, fullBatches = 0;
    for (const [round, row] of route.rounds.entries()) {
      const actual = expected[round];
      assert.equal(row.round, round);
      assert.equal(row.targetTimestamp, actual.target);
      assert.equal(row.hash, actual.hash);
      assert.equal(row.receipt.hash, actual.hash);
      assert.equal(row.receipt.blockHash, actual.receipt.blockHash);
      assert.equal(row.receipt.blockNumber, Number(actual.receipt.blockNumber));
      assert.equal(row.receipt.success, true);
      assert.equal(row.transactionIndexZeroBased, Number(actual.receipt.transactionIndex));
      assert.equal(row.minted, Number(actual.event.args.minted));
      assert.equal(row.batchResult.status, Number(actual.event.args.status));
      assert.equal(row.batchResult.minted, row.minted);
      assert.equal(row.batchResult.requested, 10);
      assert.equal(row.attempt.nonce, index * 13 + 3 + round);
      assert.equal(row.attempt.hash, actual.hash);
      assert.equal(row.attempt.sendError, null);
      assert.ok(Number.isFinite(row.attempt.rpcAckMs) && row.attempt.rpcAckMs >= 0);
      assert.ok(Number.isFinite(row.receiptObservedAfterSendMs) && row.receiptObservedAfterSendMs >= 0);
      const first = await state.upstream.send('eth_getBlockByNumber', [toQuantity(row.firstEligibleBlock.number), false]);
      const previous = await state.upstream.send('eth_getBlockByNumber', [toQuantity(row.previousBlock.number), false]);
      assert.equal(first.hash, row.firstEligibleBlock.hash);
      assert.equal(previous.hash, row.previousBlock.hash);
      assert.equal(first.parentHash, previous.hash);
      assert.equal(Number(first.number), Number(previous.number) + 1);
      assert.ok(Number(previous.timestamp) < actual.target && Number(first.timestamp) >= actual.target, 'First eligible block proof must bracket the target on the canonical chain.');
      const hit = row.minted > 0 && actual.receipt.blockNumber === first.number && Number(actual.block.timestamp) === actual.target;
      assert.equal(row.hitFirstBlock, hit);
      assert.equal(row.blocksAfterFirstEligible, Number(actual.receipt.blockNumber) - Number(first.number));
      if (hit) firstHits++;
      if (row.minted === 10) fullBatches++;
    }
    assert.equal(route.firstBlockHits, firstHits);
    assert.equal(route.fullBatches, fullBatches);
    assert.equal(route.allTenFullBatchesInFirstBlock, firstHits === 10 && fullBatches === 10);
    for (const [summary, samples] of [[route.rpcAck, route.rounds.map(row => row.attempt.rpcAckMs)], [route.receiptObserved, route.rounds.map(row => row.receiptObservedAfterSendMs)]]) {
      assert.equal(summary.count, 10);
      assert.equal(summary.p95Ms, Math.max(...samples));
      assert.equal(summary.p99Ms, Math.max(...samples));
      assert.match(summary.note, /not a stable tail/i);
    }
  }
  assert.match(result.stdout, /p95/i);
  assert.match(result.stdout, /p99/i);
  t.diagnostic(JSON.stringify({ localOnly: true, actualTransactions: 26, gasCostWei: actualCost.toString(), routes: completed.routes.map(route => ({ route: route.route, fullBatches: route.fullBatches, firstBlockHits: route.firstBlockHits })) }));
});

async function verifyGuardRoundEvidence(state, route, count, mintedPerRound, status) {
  const collection = getCreateAddress({ from: OWNER, nonce: 0 });
  const factory = getCreateAddress({ from: OWNER, nonce: 1 });
  assert.equal(route.collection.toLowerCase(), collection.toLowerCase());
  assert.equal(route.factory.toLowerCase(), factory.toLowerCase());
  assert.equal(route.rounds.length, 10);
  assert.equal(state.submissions.length, count + 3);
  assert.ok(state.submissions.every(entry => entry.route === 'https'));
  assert.deepEqual(state.submissions.map(({ tx }) => tx.nonce), Array.from({ length: count + 3 }, (_, index) => index));
  assert.equal(new Set(state.submissions.map(({ tx }) => tx.hash)).size, count + 3, 'The failure guard must never resubmit a transaction.');
  const helpers = new Set();
  for (let round = 0; round < count; round++) {
    const { tx } = state.submissions[round + 3];
    const row = route.rounds[round];
    assert.equal(tx.to, factory);
    const call = FACTORY_ABI.parseTransaction(tx);
    assert.equal(call.name, 'mintBatch');
    assert.equal(call.args[0], BigInt(round));
    assert.equal(call.args[1], 10n);
    const receipt = await state.upstream.send('eth_getTransactionReceipt', [tx.hash]);
    assert.equal(receipt.status, '0x1', 'Late/expired fixture transactions must have genuine successful EVM receipts.');
    const event = receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()).map(log => FACTORY_ABI.parseLog(log));
    assert.equal(event.length, 1);
    assert.equal(event[0].name, 'BatchResult');
    assert.equal(event[0].args.round, BigInt(round));
    assert.equal(event[0].args.minted, BigInt(mintedPerRound));
    assert.equal(event[0].args.status, BigInt(status));
    assert.equal(row.hash, tx.hash);
    assert.equal(row.attempt.hash, tx.hash);
    assert.equal(row.attempt.sendError, null);
    assert.equal(row.minted, mintedPerRound);
    assert.equal(row.batchResult.status, status);
    assert.equal(row.receipt.hash, receipt.transactionHash);
    assert.equal(row.receipt.blockHash, receipt.blockHash);
    const actual = await state.upstream.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
    assert.equal(actual.hash, receipt.blockHash);
    const first = await state.upstream.send('eth_getBlockByNumber', [toQuantity(row.firstEligibleBlock.number), false]);
    const previous = await state.upstream.send('eth_getBlockByNumber', [toQuantity(row.previousBlock.number), false]);
    assert.equal(first.hash, row.firstEligibleBlock.hash);
    assert.equal(previous.hash, row.previousBlock.hash);
    assert.equal(first.parentHash, previous.hash);
    assert.equal(Number(first.number), Number(previous.number) + 1);
    assert.ok(Number(previous.timestamp) < row.targetTimestamp && Number(first.timestamp) >= row.targetTimestamp);
    assert.equal(row.hitFirstBlock, false);
    if (mintedPerRound > 0) {
      assert.equal(Number(actual.timestamp), row.targetTimestamp, 'The 700 ms offset must still mint inside the correct second.');
      assert.ok(Number(actual.number) > Number(first.number), 'The fixture must truly miss the first eligible L2 block.');
      assert.ok(row.blocksAfterFirstEligible > 0);
    } else {
      assert.ok(Number(actual.timestamp) >= row.targetTimestamp + 1, 'Expired outcome must match real block time.');
    }
    for (const helper of row.batchResult.helpers) {
      assert.ok(!helpers.has(helper.toLowerCase()));
      helpers.add(helper.toLowerCase());
    }
  }
  for (const row of route.rounds.slice(count)) {
    assert.equal(row.attempt, null, 'All rounds following the guard stop must remain unsent.');
    assert.equal(row.outcome, 'not_sent');
  }
  assert.equal(helpers.size, count * mintedPerRound);
  const nft = new Contract(collection, NFT_ABI, state.upstream);
  assert.equal(await nft.totalSupply(), BigInt(count * mintedPerRound));
  assert.equal(await nft.balanceOf(OWNER), BigInt(count * mintedPerRound));
  if (mintedPerRound) assert.equal(await nft.ownerOf(count * mintedPerRound), OWNER);
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), BigInt(count + 3));
}

async function verifyGuardStop(state, reports) {
  const preliminary = reports['diagnostics-preliminary.json'];
  const detailed = reports['diagnostics.json'];
  assert.equal(preliminary.analysis, 'preliminary', 'Preserve early evidence before post-run RPC analysis.');
  assert.equal(preliminary.stop.kind, 'THREE_CONSECUTIVE_FAILURES');
  assert.equal(preliminary.attempts.filter(attempt => attempt !== null).length, 3);
  assert.equal(preliminary.observations.length, 3);
  assert.equal(detailed.stop.kind, 'THREE_CONSECUTIVE_FAILURES');
  assert.equal(detailed.rounds.length, 10, 'The detailed report must be written separately from the preliminary report.');
  assert.ok(Array.isArray(detailed.findings));
  for (const round of [0, 1, 2]) {
    const row = reports['https-sequencer.json'].rounds[round];
    const finding = detailed.findings.find(item => item.round === round);
    assert.ok(finding, 'Every confirmed late/expired round needs an explanatory finding.');
    assert.equal(finding.hash, state.submissions[round + 3].tx.hash);
    assert.equal(finding.outcome, row.outcome);
    assert.equal(finding.targetTimestamp, row.targetTimestamp);
    assert.equal(finding.includedBlockTimestamp, row.includedBlockTimestamp);
    assert.match(finding.explanation, row.outcome === 'expired' ? /after the target one-second mint window/i : /later L2 block/i);
  }
  assert.equal(reports['https-sequencer.json'].stopReason.kind, 'THREE_CONSECUTIVE_FAILURES');
  assert.equal(reports['wss-rpc-provider.json'], undefined, 'A guard stop must prevent the second transport series.');
  const second = reports['plan.json'].deployments[1];
  assert.ok(second, 'This fixture planned both transports.');
  assert.equal(await state.upstream.getCode(second.collection), '0x', 'No WSS collection may be deployed after stopping HTTPS.');
  assert.equal(await state.upstream.getCode(second.factory), '0x', 'No WSS factory may be deployed after stopping HTTPS.');
  const markers = (await readdir(state.lockDir)).filter(file => file.endsWith('.pending.json'));
  assert.equal(markers.length, 1, 'A stopped series retains its pending marker for reconciliation.');
  const marker = JSON.parse(await readFile(join(state.lockDir, markers[0]), 'utf8'));
  assert.equal(marker.reportDirectory, await realpath(state.output));
}

test('Rust default first-block failure guard stops both transports after three confirmed late full mints', { timeout: 90000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state, { extra: ['--send-offset-ms', '700'], timeout: 80000 });
  assert.equal(result.code, 1, `Expected the three-failure stop:\n${result.stderr}\n${result.stdout}`);
  const reports = await readReports(state);
  await verifyGuardRoundEvidence(state, reports['https-sequencer.json'], 3, 10, 0);
  await verifyGuardStop(state, reports);
  assert.equal(reports['https-sequencer.json'].fullBatches, 3);
  assert.equal(reports['https-sequencer.json'].firstBlockHits, 0);
});

test('Rust no-mint failure policy continues ten full HTTPS mints despite missing every first block', { timeout: 110000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state, { transport: 'https', extra: ['--failure-policy', 'no-mint', '--send-offset-ms', '700'], timeout: 100000 });
  assert.equal(result.code, 2, `All rounds should complete with missed first-block goals:\n${result.stderr}\n${result.stdout}`);
  const reports = await readReports(state);
  const route = reports['https-sequencer.json'];
  await verifyGuardRoundEvidence(state, route, 10, 10, 0);
  assert.equal(route.allTransactionsResolved, true);
  assert.equal(route.fullBatches, 10);
  assert.equal(route.firstBlockHits, 0);
  assert.equal(reports['result.json'].completed, true);
  assert.equal(reports['result.json'].allTenFullBatchesInFirstBlock, false);
  assert.equal(reports['result.json'].routes.length, 1);
  assert.equal(reports['diagnostics.json'], undefined, 'Successful no-mint policy must not fabricate an early-stop diagnostic.');
  assert.equal(reports['diagnostics-preliminary.json'], undefined);
  assert.equal((await readdir(state.lockDir)).filter(file => file.endsWith('.pending.json')).length, 0);
});

test('Rust no-mint failure guard stops after three real expired mint outcomes and skips WSS deployment', { timeout: 90000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t, 'expired-mint-windows');
  const result = await runCli(t, state, { extra: ['--failure-policy', 'no-mint'], timeout: 80000 });
  assert.equal(result.code, 1, `Expected the three-empty-mint stop:\n${result.stderr}\n${result.stdout}`);
  assert.equal(state.faults.length, 1);
  const reports = await readReports(state);
  await verifyGuardRoundEvidence(state, reports['https-sequencer.json'], 3, 0, 5);
  await verifyGuardStop(state, reports);
  assert.equal(reports['https-sequencer.json'].fullBatches, 0);
  assert.equal(reports['https-sequencer.json'].firstBlockHits, 0);
});

test('Rust read-only preflight simulates both routes without reading a key or sending transactions', { timeout: 20000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state, { send: false, timeout: 15000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Read-only preflight passed/i);
  assert.equal(state.submissions.length, 0);
  assert.equal(state.simulations.length, 2);
  const reports = await readReports(state);
  assert.equal(reports['plan.json'].deployments.length, 2);
  for (const deployment of reports['plan.json'].deployments) {
    assert.equal(deployment.simulation.fullBatchMinted, 10);
    assert.equal(await state.upstream.getCode(deployment.collection), '0x');
    assert.equal(await state.upstream.getCode(deployment.factory), '0x');
  }
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 0n);
  assert.equal(await state.upstream.getBalance(OWNER), INITIAL_BALANCE);
});

test('Rust timed benchmark refuses insufficient fee budget before any broadcast', { timeout: 20000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state, { extra: ['--max-total-cost-eth', '0.00000001'], timeout: 15000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cost limit|budget/i);
  assert.equal(state.submissions.length, 0);
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 0n);
  assert.equal(await state.upstream.getBalance(OWNER), INITIAL_BALANCE);
});

test('Rust timed benchmark rejects a mismatching synthetic key without broadcasting', { timeout: 25000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t);
  const result = await runCli(t, state, { transport: 'https', key: WRONG_KEY, timeout: 20000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /wallet|signer|key|address/i);
  assert.equal(state.submissions.length, 0);
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 0n);
  assert.equal(await state.upstream.getBalance(OWNER), INITIAL_BALANCE);
});

test('Rust timed benchmark detects an externally consumed nonce before its first broadcast', { timeout: 25000 }, async t => {
  if (!await available(t)) return;
  const state = await fixture(t, 'external-nonce-before-live');
  const result = await runCli(t, state, { transport: 'https', timeout: 20000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /nonce changed/i);
  assert.equal(state.faults.length, 1);
  assert.equal(state.submissions.length, 0, 'CLI must not sign or submit a competing transaction after external nonce consumption.');
  assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), 1n);
  await readReports(state);
});

for (const [transport, fault] of [['https', 'timeout-before-broadcast'], ['wss', 'accepted-but-unobservable']]) {
  test(`Rust ${transport} benchmark stops on uncertain submission (${fault}) without resubmission`, { timeout: 25000 }, async t => {
    if (!await available(t)) return;
    const state = await fixture(t, fault);
    const result = await runCli(t, state, { transport, timeout: 20000 });
    assert.notEqual(result.code, 0);
    assert.equal(state.submissions.length, 1, 'Ambiguous submission must never be blindly retried or followed by the next transaction.');
    assert.equal(state.submissions[0].route, transport);
    assert.equal(state.submissions[0].tx.nonce, 0);
    assert.equal(state.faults.length, 1);
    const accepted = fault === 'accepted-but-unobservable';
    assert.equal(BigInt(await state.upstream.send('eth_getTransactionCount', [OWNER, 'latest'])), accepted ? 1n : 0n);
    const receipt = await state.upstream.send('eth_getTransactionReceipt', [state.submissions[0].tx.hash]);
    assert.equal(Boolean(receipt), accepted, 'Fault injection must match actual EVM acceptance.');
    const reports = await readReports(state);
    const journal = reports['journal.jsonl'];
    assert.equal(journal.filter(entry => entry.type === 'intent').length, 1);
    assert.equal(journal.filter(entry => entry.type === 'ack').length, 0);
    const ambiguous = journal.filter(entry => entry.type === 'ambiguous_send');
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].hash, state.submissions[0].tx.hash);
    assert.equal(journal.at(-1).type, 'stopped');
    if (!accepted) {
      assert.match(result.stderr, /RPC_TIMEOUT/);
      assert.equal(ambiguous[0].error, 'RPC_TIMEOUT');
    }
    const markers = (await readdir(state.lockDir)).filter(file => file.endsWith('.pending.json'));
    assert.equal(markers.length, 1, 'Uncertain send leaves a durable wallet marker after process exit.');
    const marker = JSON.parse(await readFile(join(state.lockDir, markers[0]), 'utf8'));
    assert.equal(marker.reportDirectory, await realpath(state.output));
    state.output = join(state.directory, 'fresh-output-restart');
    const callsBeforeRestart = state.calls.length;
    const restart = await runCli(t, state, { transport, timeout: 5000 });
    assert.equal(restart.code, 1);
    assert.match(restart.stderr, /previous unresolved run/i);
    assert.equal(state.submissions.length, 1, 'New output directory must not bypass the wallet marker.');
    assert.equal(state.calls.length, callsBeforeRestart, 'Block uncertain restart before any RPC or new signing.');
  });
}
