// Destructive local test operations are guarded by loopback URL, Anvil identity and chain ID.
// No private keys are read. Every local mutation is reverted to the initial snapshot.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  Contract, ContractFactory, FetchRequest, JsonRpcProvider, ZeroAddress, keccak256,
} from 'ethers';
import { CONFIG, SEADROP_ABI } from '../mint.mjs';
import { createRpcTransport } from '../lib/rpc-transport.mjs';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:18546');
assert.equal(process.argv.length <= 3, true, 'Usage: node scripts/simulate-race.mjs [local-anvil-url]');
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback HTTP is allowed.');
assert.ok(!url.username && !url.password && !url.search && !url.hash, 'RPC credentials, query strings and fragments are not allowed.');
function localProvider(timeoutMs) {
  const transport = createRpcTransport(url.href, timeoutMs);
  const request = new FetchRequest(url.href);
  request.timeout = timeoutMs;
  request.setThrottleParams({ maxAttempts: 1 });
  request.retryFunc = async () => false;
  request.getUrlFunc = transport.getUrl;
  const instance = new JsonRpcProvider(request, Number(CONFIG.chainId), {
    staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1,
  });
  instance.pollingInterval = 100;
  const destroy = instance.destroy.bind(instance);
  instance.destroy = () => { transport.destroy(); destroy(); };
  return instance;
}
const LOCAL_RPC_TIMEOUT_MS = 600000;
const CLEANUP_TIMEOUT_MS = 20000;
const provider = localProvider(LOCAL_RPC_TIMEOUT_MS);
const OUTPUT = new URL('../research/race-simulation.json', import.meta.url);
const TARGET_SUPPLY = 910n;
const MAX_SUPPLY = 1024n;
// Header gasLimit can be 2^50 on Nitro. Do not treat that as the transaction gas cap.
const CONSERVATIVE_GAS_CAP = 32000000n;
const EXPECTED_NFT_CODE_HASH = '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c';
const report = {
  kind: 'local-anvil-fork-supply-race', status: 'running', mainnetBroadcast: false,
  privateKeysRead: false, nftStorageOverrides: false, startedAt: new Date().toISOString(),
  conservativeTransactionGasCap: CONSERVATIVE_GAS_CAP.toString(),
  gasCapNote: '32M test ceiling, also bounded by local block.gasLimit; no gas limit is raised. Nitro header gasLimit alone is insufficient.',
  rpcTimeoutMs: LOCAL_RPC_TIMEOUT_MS, cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
  transportAttempts: 1, maximumRpcResponseBytes: 2 * 1024 * 1024,
  scenarios: [], checks: [],
};
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
let initialSnapshot;
let failure;

async function checkpoint() {
  await writeFile(OUTPUT, `${json(report)}\n`);
}

async function progress(phase) {
  report.phase = phase;
  console.log(`Starting ${phase}.`);
  await checkpoint();
}

async function actorState(instance, address) {
  const [nonce, balance, code] = await Promise.all([
    instance.getTransactionCount(address, 'latest'), instance.getBalance(address, 'latest'), instance.getCode(address),
  ]);
  return { address, nonce, balance, code };
}

async function verifyRestoration(instance) {
  const restoredNFT = new Contract(CONFIG.nftContract, [
    'function getMintStats(address) view returns(uint256,uint256,uint256)',
  ], instance);
  const [block, stats, actors, factoryCodes] = await Promise.all([
    instance.getBlock('latest'), restoredNFT.getMintStats(ZeroAddress),
    Promise.all(report.initialActorState.map(actor => actorState(instance, actor.address))),
    Promise.all(Object.values(report.factories ?? {}).map(factory => instance.getCode(factory.address))),
  ]);
  report.postCleanupReadOnlyVerification = {
    block: block.number, hash: block.hash, supply: stats[1], actors,
    factoryCodeBytes: factoryCodes.map(code => (code.length - 2) / 2),
    checkedAt: new Date().toISOString(), passed: false,
  };
  assert.equal(block.number, report.forkBlock);
  assert.equal(block.hash, report.forkHash);
  assert.equal(stats[1], report.originalSupply);
  assert.deepEqual(actors, report.initialActorState, 'Initial synthetic actor nonce/balance/code was not restored.');
  assert.ok(factoryCodes.every(code => code === '0x'), 'A test factory remained after snapshot cleanup.');
  report.postCleanupReadOnlyVerification.passed = true;
}

async function receiptFor(sent, expectedStatus = 1) {
  let receipt;
  try { receipt = await sent.wait(1, 120000); }
  catch (error) {
    if (error.receipt) receipt = error.receipt;
    else throw error;
  }
  assert.ok(receipt, 'A mined local receipt is required.');
  assert.equal(receipt.status, expectedStatus);
  return receipt;
}

async function isolated(operation) {
  const snapshot = await provider.send('evm_snapshot', []);
  try { return await operation(); }
  finally { assert.equal(await provider.send('evm_revert', [snapshot]), true, 'Scenario snapshot cleanup failed.'); }
}

async function gasBudget(factory, maximum, minimum) {
  console.log(`Estimating local batch ${maximum}/${minimum} before submitting it.`);
  const estimate = await factory.mintBatch.estimateGas(maximum, minimum);
  const block = await provider.getBlock('latest');
  const allowed = block.gasLimit < CONSERVATIVE_GAS_CAP ? block.gasLimit : CONSERVATIVE_GAS_CAP;
  assert.ok(estimate <= allowed, `Local estimate ${estimate} exceeds allowed ${allowed}; refusing to raise the gas limit.`);
  const buffered = (estimate * 120n + 99n) / 100n;
  return {
    estimate, gasLimit: buffered < allowed ? buffered : allowed,
    headerGasLimit: block.gasLimit, allowedGasLimit: allowed,
    full20PercentMarginFits: buffered <= allowed,
  };
}

function eventsFor(factory, receipt) {
  return receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== factory.target.toLowerCase()) return [];
    try { const event = factory.interface.parseLog(log); return event ? [event] : []; }
    catch { return []; }
  });
}

async function assertMint(nft, factory, recipient, data, gasLimit, count, label) {
  const before = {
    total: (await nft.getMintStats(ZeroAddress))[1], balance: await nft.balanceOf(recipient),
  };
  const sent = await factory.runner.sendTransaction({ to: factory.target, data, gasLimit, value: 0n });
  assert.equal(sent.data, data, 'Submitted calldata changed.');
  assert.equal(sent.gasLimit, gasLimit, 'Submitted gas limit changed.');
  const receipt = await receiptFor(sent);
  const events = eventsFor(factory, receipt);
  const minted = events.filter(event => event.name === 'TokenMinted');
  const batches = events.filter(event => event.name === 'BatchMinted');
  assert.equal(BigInt(minted.length), count);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].args.count, count);
  assert.equal(batches[0].args.recipient.toLowerCase(), recipient.toLowerCase());
  assert.equal(new Set(minted.map(event => event.args.helper.toLowerCase())).size, Number(count));
  assert.equal(new Set(minted.map(event => event.args.tokenId.toString())).size, Number(count));
  assert.equal((await nft.getMintStats(ZeroAddress))[1], before.total + count);
  assert.equal(await nft.balanceOf(recipient), before.balance + count);
  for (let i = 0; i < minted.length; i++) {
    const { helper, tokenId, recipient: eventRecipient } = minted[i].args;
    assert.equal(tokenId, before.total + BigInt(i) + 1n);
    assert.equal(eventRecipient.toLowerCase(), recipient.toLowerCase());
    const [owner, stats, balance] = await Promise.all([
      nft.ownerOf(tokenId), nft.getMintStats(helper), nft.balanceOf(helper),
    ]);
    assert.equal(owner.toLowerCase(), recipient.toLowerCase());
    assert.equal(stats[0], 1n);
    assert.equal(balance, 0n);
  }
  const result = {
    label, hash: sent.hash, calldata: data, calldataHash: keccak256(data),
    gasLimit, gasUsed: receipt.gasUsed, status: receipt.status, count,
    supplyBefore: before.total, supplyAfter: before.total + count,
    recipient, balanceBefore: before.balance, balanceAfter: before.balance + count,
    tokenIds: minted.map(event => event.args.tokenId), helpers: minted.map(event => event.args.helper),
  };
  console.log(`${label}: ${count} NFTs, ${receipt.gasUsed} local gas.`);
  return result;
}

async function assertEarlyRevert(nft, factory, recipient, maximum, minimum, remaining, gasLimit, label) {
  await assert.rejects(factory.mintBatch.staticCall(maximum, minimum), error => {
    const decoded = error.revert ?? (error.data ? factory.interface.parseError(error.data) : null);
    return decoded?.name === 'InsufficientSupply'
      && decoded.args[0] === remaining && decoded.args[1] === minimum;
  });
  const data = factory.interface.encodeFunctionData('mintBatch', [maximum, minimum]);
  const sender = await factory.runner.getAddress();
  const [beforeStats, beforeBalance, beforeNonce, senderNonceBefore, senderBalanceBefore] = await Promise.all([
    nft.getMintStats(ZeroAddress), nft.balanceOf(recipient),
    provider.getTransactionCount(factory.target, 'latest'),
    provider.getTransactionCount(sender, 'latest'), provider.getBalance(sender, 'latest'),
  ]);
  // Explicit ample gas bypasses client-side estimation: this must be a mined failed transaction.
  const sent = await factory.runner.sendTransaction({ to: factory.target, data, gasLimit, value: 0n });
  assert.equal(sent.data, data);
  assert.equal(sent.gasLimit, gasLimit);
  const receipt = await receiptFor(sent, 0);
  assert.ok(receipt.gasUsed < 200000n, 'Insufficient supply should fail before expensive helper creation.');
  assert.equal(receipt.logs.length, 0);
  assert.equal((await nft.getMintStats(ZeroAddress))[1], beforeStats[1]);
  assert.equal(await nft.balanceOf(recipient), beforeBalance);
  assert.equal(await provider.getTransactionCount(factory.target, 'latest'), beforeNonce);
  const [senderNonceAfter, senderBalanceAfter] = await Promise.all([
    provider.getTransactionCount(sender, 'latest'), provider.getBalance(sender, 'latest'),
  ]);
  assert.equal(senderNonceAfter, senderNonceBefore + 1, 'A mined failed transaction must consume one sender nonce.');
  const actualGasFee = receipt.gasUsed * receipt.gasPrice;
  const fullGasLimitAtEffectivePrice = gasLimit * receipt.gasPrice;
  assert.equal(senderBalanceBefore - senderBalanceAfter, actualGasFee, 'Sender must pay actual gas used at the receipt price.');
  assert.ok(actualGasFee < fullGasLimitAtEffectivePrice, 'Early revert must not charge the full submitted gas limit.');
  const trace = await provider.send('debug_traceTransaction', [sent.hash, {
    disableStorage: true, disableMemory: true, disableStack: true,
  }]);
  assert.equal(trace.failed, true);
  assert.ok(Array.isArray(trace.structLogs), 'Opcode trace is required to verify no helper was attempted.');
  const creations = trace.structLogs.filter(step => step.op === 'CREATE' || step.op === 'CREATE2').length;
  assert.equal(creations, 0, 'Failed transaction attempted helper construction.');
  const mutableCalls = trace.structLogs.filter(step => ['CALL', 'CALLCODE', 'DELEGATECALL'].includes(step.op)).length;
  assert.equal(mutableCalls, 0, 'Failed transaction attempted a non-static external call.');
  const revertData = trace.returnValue.startsWith('0x') ? trace.returnValue : `0x${trace.returnValue}`;
  const decoded = factory.interface.parseError(revertData);
  assert.equal(decoded?.name, 'InsufficientSupply');
  assert.equal(decoded.args[0], remaining);
  assert.equal(decoded.args[1], minimum);
  console.log(`${label}: mined revert, ${receipt.gasUsed} gas, ${actualGasFee} wei paid, no helper creation or mutable external calls.`);
  return {
    label, hash: sent.hash, calldata: data, calldataHash: keccak256(data),
    status: receipt.status, gasLimit, gasUsed: receipt.gasUsed,
    expectedError: decoded.name, remaining, minimum,
    helperCreationOpcodes: creations, mutableCallOpcodes: mutableCalls, traceSteps: trace.structLogs.length,
    sender, senderNonceBefore, senderNonceAfter, senderBalanceBefore, senderBalanceAfter,
    effectiveGasPrice: receipt.gasPrice, actualGasFee, fullGasLimitAtEffectivePrice,
    supplyUnchanged: true, recipientBalanceUnchanged: true, factoryNonceUnchanged: true,
  };
}

try {
  const client = await provider.send('web3_clientVersion', []);
  assert.match(client, /anvil/i, 'The loopback RPC must identify as Anvil.');
  assert.equal(BigInt(await provider.send('eth_chainId', [])), CONFIG.chainId);
  const accounts = await provider.send('eth_accounts', []);
  assert.ok(accounts.length >= 2, 'Two synthetic Anvil accounts are required.');
  const nft = new Contract(CONFIG.nftContract, [
    'function getMintStats(address) view returns(uint256,uint256,uint256)',
    'function ownerOf(uint256) view returns(address)',
    'function balanceOf(address) view returns(uint256)',
  ], provider);
  const sea = new Contract(CONFIG.seaDrop, SEADROP_ABI, provider);
  const [nftCode, seaCode, block, stats, drop] = await Promise.all([
    provider.getCode(CONFIG.nftContract), provider.getCode(CONFIG.seaDrop), provider.getBlock('latest'),
    nft.getMintStats(ZeroAddress), sea.getPublicDrop(CONFIG.nftContract),
  ]);
  assert.equal(keccak256(nftCode), EXPECTED_NFT_CODE_HASH, 'Unexpected Genesis bytecode.');
  assert.notEqual(seaCode, '0x', 'SeaDrop code is missing.');
  assert.equal(stats[2], MAX_SUPPLY);
  assert.ok(stats[1] <= TARGET_SUPPLY, 'Fork supply is already above 910; pin an earlier fork block. No NFT storage override is allowed.');
  assert.equal(drop.mintPrice, 0n);
  assert.ok(drop.maxTotalMintableByWallet >= 1n);
  assert.ok(BigInt(block.timestamp) <= drop.endTime, 'Fork after public-stage end; pin an earlier block.');
  const artifact = JSON.parse(await readFile(new URL('../artifacts/RareFriendsBatchMinter.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL(`../${artifact.source}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), artifact.sourceSha256, 'Factory artifact does not match source.');
  Object.assign(report, {
    client, forkBlock: block.number, forkHash: block.hash, forkTimestamp: block.timestamp, originalSupply: stats[1],
    maxSupply: stats[2], nftCodeHash: keccak256(nftCode), factorySourceSha256: artifact.sourceSha256,
    publicStage: { startTime: drop.startTime, endTime: drop.endTime, mintPrice: drop.mintPrice },
    syntheticActors: { user: accounts[0], competitor: accounts[1], source: 'Local Anvil exposed signers; private keys are never requested.' },
  });
  report.initialActorState = await Promise.all(accounts.slice(0, 2).map(account => actorState(provider, account)));
  initialSnapshot = await provider.send('evm_snapshot', []);
  for (const account of accounts.slice(0, 2)) await provider.send('anvil_setCode', [account, '0x']);
  report.syntheticActorCodeReset = 'Only local actor accounts reset to ordinary EOAs; NFT and SeaDrop code/storage are unchanged.';
  if (BigInt(block.timestamp) < drop.startTime) {
    await provider.send('evm_setNextBlockTimestamp', [Number(drop.startTime + 1n)]);
    await provider.send('evm_mine', []);
  }
  const [user, competitor] = await Promise.all([provider.getSigner(accounts[0]), provider.getSigner(accounts[1])]);
  async function deploy(signer, recipient) {
    const factory = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(recipient, { gasLimit: 2000000n });
    const receipt = await receiptFor(factory.deploymentTransaction());
    assert.equal((await factory.owner()).toLowerCase(), recipient.toLowerCase());
    assert.equal((await factory.recipient()).toLowerCase(), recipient.toLowerCase());
    return { factory, deploymentGasUsed: receipt.gasUsed, deploymentHash: receipt.hash };
  }
  const ours = await deploy(user, accounts[0]);
  const theirs = await deploy(competitor, accounts[1]);
  report.factories = {
    user: { address: ours.factory.target, deploymentGasUsed: ours.deploymentGasUsed, deploymentHash: ours.deploymentHash },
    competitor: { address: theirs.factory.target, deploymentGasUsed: theirs.deploymentGasUsed, deploymentHash: theirs.deploymentHash },
  };
  report.baselinePreparation = [];
  for (let current = stats[1]; current < TARGET_SUPPLY;) {
    const count = TARGET_SUPPLY - current < 114n ? TARGET_SUPPLY - current : 114n;
    const budget = await gasBudget(theirs.factory, count, count);
    report.baselinePreparation.push(await assertMint(
      nft, theirs.factory, accounts[1], theirs.factory.interface.encodeFunctionData('mintBatch', [count, count]),
      budget.gasLimit, count, 'Real public mints to reach supply 910',
    ));
    current += count;
  }
  assert.equal((await nft.getMintStats(ZeroAddress))[1], TARGET_SUPPLY);
  report.baselineSupply = TARGET_SUPPLY;
  const mainData = ours.factory.interface.encodeFunctionData('mintBatch', [1024n, 1n]);
  await progress('initial_static_call_114');
  const predicted = await ours.factory.mintBatch.staticCall(1024n, 1n);
  assert.equal(predicted, 114n);
  const budget = await gasBudget(ours.factory, 1024n, 1n);
  report.initialPreflight = { maximum: 1024n, minimum: 1n, predictedCount: predicted, calldata: mainData, ...budget };
  await checkpoint();

  await progress('control_without_competitor');
  report.scenarios.push(await isolated(async () => ({
    name: 'control_without_competitor',
    mint: await assertMint(nft, ours.factory, accounts[0], mainData, budget.gasLimit, 114n, 'Control: unchanged calldata mints all 114'),
  })));
  await checkpoint();

  await progress('competitor_108_then_user_remaining_6');
  report.scenarios.push(await isolated(async () => {
    const competitionBudget = await gasBudget(theirs.factory, 108n, 108n);
    const competition = await assertMint(nft, theirs.factory, accounts[1],
      theirs.factory.interface.encodeFunctionData('mintBatch', [108n, 108n]), competitionBudget.gasLimit, 108n, 'Competitor mints 108');
    assert.equal((await nft.getMintStats(ZeroAddress))[1], 1018n);
    assert.equal(await ours.factory.mintBatch.staticCall(1024n, 1n), 6n);
    const mint = await assertMint(nft, ours.factory, accounts[0], mainData, budget.gasLimit, 6n, 'Same calldata now mints remaining 6');
    assert.equal(mint.calldata, report.initialPreflight.calldata);
    assert.equal(mint.gasLimit, report.initialPreflight.gasLimit);
    assert.equal(mint.supplyAfter, MAX_SUPPLY);
    return { name: 'competitor_108_then_user_remaining_6', competition, mint };
  }));
  await checkpoint();

  await progress('sold_out_early_revert');
  report.scenarios.push(await isolated(async () => {
    const competitionBudget = await gasBudget(theirs.factory, 114n, 114n);
    const competition = await assertMint(nft, theirs.factory, accounts[1],
      theirs.factory.interface.encodeFunctionData('mintBatch', [114n, 114n]), competitionBudget.gasLimit, 114n, 'Competitor exhausts all 114');
    const rejected = await assertEarlyRevert(nft, ours.factory, accounts[0], 1024n, 1n, 0n, budget.gasLimit, 'Sold out before user executes');
    assert.equal(rejected.calldata, mainData);
    assert.equal(rejected.gasLimit, report.initialPreflight.gasLimit);
    return { name: 'sold_out_early_revert', competition, rejected };
  }));
  await checkpoint();

  await progress('exact_quantity_early_revert');
  report.scenarios.push(await isolated(async () => {
    const competitionBudget = await gasBudget(theirs.factory, 108n, 108n);
    const competition = await assertMint(nft, theirs.factory, accounts[1],
      theirs.factory.interface.encodeFunctionData('mintBatch', [108n, 108n]), competitionBudget.gasLimit, 108n, 'Competitor takes 108 before exact request');
    const rejected = await assertEarlyRevert(nft, ours.factory, accounts[0], 114n, 114n, 6n, budget.gasLimit, 'Exact 114 rejects remaining 6');
    return { name: 'exact_quantity_early_revert', competition, rejected };
  }));
  report.checks = [
    'Baseline 910 obtained from fork state and real mint transactions; no NFT storage overrides.',
    'Unchanged mintBatch(1024,1) predicts and mints 114 without a competitor.',
    'A separately mined competitor transaction takes 108; unchanged user calldata then mints exactly 6.',
    'Minted NFT ownership, balances, sequential IDs, unique helpers and events match each receipt.',
    'Sold-out and exact-quantity failures are actual mined transactions below 200,000 gas, with zero CREATE/CREATE2 and CALL/CALLCODE/DELEGATECALL opcodes.',
    'Each mined failure advances the sender nonce once and charges exactly receipt gasUsed times effective gasPrice, less than the submitted gas limit times that price.',
  ];
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.failure = { name: error.name, message: error.shortMessage ?? error.message };
  console.error(`Local proof failed: ${report.failure.message}. Attempting snapshot cleanup.`);
  await checkpoint();
} finally {
  if (initialSnapshot) {
    const cleanupProvider = localProvider(CLEANUP_TIMEOUT_MS);
    try {
      report.snapshotRevertAcknowledged = await cleanupProvider.send('evm_revert', [initialSnapshot]);
      assert.equal(report.snapshotRevertAcknowledged, true);
      await verifyRestoration(cleanupProvider);
      report.initialSnapshotRestored = true;
    } catch (error) {
      report.status = 'failed'; report.initialSnapshotRestored = false;
      report.cleanupFailure = { name: error.name, message: error.shortMessage ?? error.message };
      failure ??= error;
    } finally { cleanupProvider.destroy(); }
  }
  report.finishedAt = new Date().toISOString();
  report.limitations = [
    'Local fork transactions only. Execution order is deliberately sequential; transactions do not interleave inside an EVM call.',
    'Local Anvil gas omits Robinhood-specific L1 posting charges and is not a fresh mainnet gas quote or inclusion guarantee.',
    'Snapshots restore all local changes, so the saved hashes are evidence of this local run, not public explorer transactions.',
  ];
  try { await checkpoint(); }
  finally { provider.destroy(); }
}
if (failure) throw failure;
console.log(json(report));
