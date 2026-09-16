import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, ZeroAddress, id } from 'ethers';
import solc from 'solc';

const artifact = JSON.parse(await readFile(new URL('../artifacts/timed-benchmark.json', import.meta.url), 'utf8'));
const { TimedBenchmarkNFT: NFT, TimedBenchmarkBatchMinter: BATCH } = artifact.contracts;
const fixtures = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {TimedBenchmarkNFT} from "contracts/TimedBenchmarkNFT.sol";
contract CrowdMint {
    constructor(TimedBenchmarkNFT target, uint256 round, address recipient) {
        uint256 token = target.mint(round);
        target.transferFrom(address(this), recipient, token);
    }
}
contract Crowd {
    function fill(TimedBenchmarkNFT target, uint256 round, uint256 quantity, address recipient) external {
        require(quantity <= 10000);
        for (uint256 i; i < quantity; ++i) new CrowdMint(target, round, recipient);
    }
}
contract FailingCollection {
    address public immutable owner = msg.sender;
    uint256 public constant MAX_SUPPLY = 10000;
    uint256 public constant ROUNDS = 10;
    uint256 public startTime;
    uint256 public totalSupply;
    mapping(uint256 => address) public ownerOf;
    error InjectedFailure();
    function arm(uint256 time) external { startTime = time; }
    function remainingSupply() external view returns(uint256) { return 10000 - totalSupply; }
    function mint(uint256) external returns(uint256 token) {
        token = ++totalSupply;
        if (token == 2) revert InjectedFailure();
        ownerOf[token] = msg.sender;
    }
    function transferFrom(address, address to, uint256 token) external { ownerOf[token] = to; }
}`;
const fixtureInput = { language: 'Solidity', sources: {
  'Fixture.sol': { content: fixtures },
  'contracts/TimedBenchmarkNFT.sol': { content: await readFile(new URL('../contracts/TimedBenchmarkNFT.sol', import.meta.url), 'utf8') },
}, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const fixtureOutput = JSON.parse(solc.compile(JSON.stringify(fixtureInput)));
assert.deepEqual(fixtureOutput.errors ?? [], []);
const fixtureArtifact = name => ({ abi: fixtureOutput.contracts['Fixture.sol'][name].abi,
  bytecode: '0x' + fixtureOutput.contracts['Fixture.sol'][name].evm.bytecode.object });

async function anvil(t) {
  const binary = process.env.ANVIL_BIN ?? 'anvil';
  const version = spawnSync(binary, ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (version.error?.code === 'ENOENT') { t.skip('Anvil is required; set ANVIL_BIN to run local EVM tests.'); return; }
  assert.equal(version.status, 0);
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663',
    '--hardfork', 'shanghai', '--timestamp', '1800000000', '--gas-limit', '2000000000', '--order', 'fifo', '--silent'], { stdio: 'ignore' });
  let startError;
  child.on('error', error => { startError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const request = new FetchRequest(`http://127.0.0.1:${port}`);
  request.timeout = 60_000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => {
    provider.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(2000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
  });
  for (let attempt = 0; attempt < 50; ++attempt) {
    if (startError) throw startError;
    try {
      assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal(BigInt(await provider.send('eth_blockNumber', [])), 0n);
      return provider;
    } catch (error) { if (attempt === 49) throw error; await delay(40); }
  }
}

async function deploy(signer, contractArtifact, args = []) {
  const contract = await new ContractFactory(contractArtifact.abi, contractArtifact.bytecode, signer).deploy(...args, { gasLimit: 5_000_000 });
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, receipt };
}
async function setup(provider) {
  const owner = await provider.getSigner(0), other = await provider.getSigner(1), recipient = await provider.getSigner(2);
  const nft = await deploy(owner, NFT, [id('local-only-timed-benchmark')]);
  const batch = await deploy(owner, BATCH, [await nft.contract.getAddress(), await recipient.getAddress()]);
  return { owner, other, recipient, nft: nft.contract, batch: batch.contract,
    gas: { deployNFT: nft.receipt.gasUsed.toString(), deployFactory: batch.receipt.gasUsed.toString() } };
}
async function time(provider, timestamp) {
  await provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await provider.send('evm_mine', []);
}
async function transactAt(provider, timestamp, fn) {
  await provider.send('evm_setNextBlockTimestamp', [timestamp]);
  return (await fn()).wait();
}
async function transactionsAt(provider, timestamp, functions) {
  const transactions = [];
  await provider.send('evm_setAutomine', [false]);
  try {
    await provider.send('evm_setNextBlockTimestamp', [timestamp]);
    for (const fn of functions) transactions.push(await fn());
    await provider.send('evm_mine', []);
  } finally {
    await provider.send('evm_setAutomine', [true]);
  }
  return Promise.all(transactions.map(transaction => transaction.wait()));
}
function event(batch, receipt) {
  const parsed = receipt.logs.filter(log => log.address.toLowerCase() === batch.target.toLowerCase()).map(log => batch.interface.parseLog(log));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'BatchResult');
  return parsed[0].args;
}
async function revert(promise, iface, name) {
  await assert.rejects(promise, error => {
    const data = error.data ?? error.info?.error?.data;
    return typeof data === 'string' && data.startsWith(iface.getError(name).selector);
  });
}

test('timed benchmark artifacts bind compiler, sources, immutable references and storage layout', async () => {
  assert.equal(artifact.compiler, '0.8.26+commit.8a97fa7a.Emscripten.clang');
  assert.equal(artifact.settings.evmVersion, 'shanghai');
  for (const [file, hash] of Object.entries(artifact.sourceSha256)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../' + file, import.meta.url))).digest('hex'), hash);
  }
  assert.ok(NFT.storageLayout.storage.some(item => item.label === 'totalSupply'));
  for (const contract of Object.values(artifact.contracts)) {
    assert.ok(contract.bytecode.length > contract.deployedBytecode.length);
    for (const astId of Object.values(contract.immutableIds)) assert.ok(contract.immutableReferences[astId]?.length);
  }
});

test('ten timed rounds transfer 100 NFTs through distinct lifetime-limited helpers', { timeout: 120_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const { owner, recipient, nft, batch, gas } = await setup(provider);
  const start = 1800000100;
  const arm = await (await nft.arm(start)).wait(); gas.arm = arm.gasUsed.toString();
  const helpers = new Set();
  for (let round = 0; round < 10; ++round) {
    const receipt = await transactAt(provider, start + round, () => batch.mintBatch(round, 10, { gasLimit: 3_000_000 }));
    const result = event(batch, receipt);
    assert.equal(result.round, BigInt(round)); assert.equal(result.status, 0n); assert.equal(result.minted, 10n);
    assert.equal(result.firstTokenId, BigInt(round * 10 + 1)); assert.equal(result.remaining, BigInt(10000 - (round + 1) * 10));
    assert.equal(await batch.attemptedRounds(round), true);
    gas[round === 0 ? 'mint10FirstRound' : 'mint10LaterRound'] = receipt.gasUsed.toString();
    for (const log of receipt.logs.filter(log => log.address.toLowerCase() === nft.target.toLowerCase())) {
      const transfer = nft.interface.parseLog(log);
      if (transfer.args.from === ZeroAddress) helpers.add(transfer.args.to);
    }
  }
  assert.equal(helpers.size, 100);
  assert.equal(await nft.totalSupply(), 100n);
  assert.equal(await nft.balanceOf(await recipient.getAddress()), 100n);
  assert.equal(await nft.balanceOf(await owner.getAddress()), 0n);
  for (let token = 1; token <= 100; ++token) assert.equal(await nft.ownerOf(token), await recipient.getAddress());
  for (const helper of helpers) { assert.equal(await nft.hasMinted(helper), true); assert.equal(await nft.balanceOf(helper), 0n); }
  t.diagnostic('LOCAL_EVM_GAS ' + JSON.stringify(gas));
});

test('arming, authorization, windows, duplicates and quantity validation enforce the state machine', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const { other, nft, batch } = await setup(provider);
  await revert(nft.connect(other).arm.staticCall(1800000100), nft.interface, 'NotOwner');
  await revert(nft.arm.staticCall(0), nft.interface, 'InvalidStartTime');
  await revert(nft.mint.staticCall(0), nft.interface, 'NotArmed');
  assert.deepEqual(Array.from(await batch.mintBatch.staticCall(0, 10)), [0n, 3n]);
  await revert(batch.connect(other).mintBatch.staticCall(0, 10), batch.interface, 'NotOwner');
  await revert(batch.mintBatch.staticCall(10, 10), batch.interface, 'InvalidRound');
  for (const count of [0, 11]) await revert(batch.mintBatch.staticCall(0, count), batch.interface, 'InvalidQuantity');
  const start = 1800000100; await (await nft.arm(start)).wait();
  await revert(nft.arm.staticCall(start + 1), nft.interface, 'AlreadyArmed');
  let receipt = await transactAt(provider, start - 1, () => batch.mintBatch(0, 10, { gasLimit: 500000 }));
  assert.equal(event(batch, receipt).status, 4n); assert.equal(await batch.attemptedRounds(0), false);
  const [first, duplicate] = await transactionsAt(provider, start, [
    () => batch.mintBatch(0, 1, { gasLimit: 500000 }),
    () => batch.mintBatch(0, 10, { gasLimit: 500000 }),
  ]);
  assert.equal(event(batch, first).minted, 1n);
  assert.equal(event(batch, duplicate).status, 6n); assert.equal(await nft.totalSupply(), 1n);
  await revert(nft.mint.staticCall(1), nft.interface, 'TooEarly');
  receipt = await transactAt(provider, start + 2, () => batch.mintBatch(1, 10, { gasLimit: 500000 }));
  assert.equal(event(batch, receipt).status, 5n); assert.equal(await batch.attemptedRounds(1), false);
  await revert(nft.mint.staticCall(1), nft.interface, 'Expired');
  await time(provider, start + 10);
  assert.deepEqual(Array.from(await batch.mintBatch.staticCall(9, 10)), [0n, 5n]);
});

test('one-per-sender remains consumed after transfers; approvals and safe transfers preserve ownership', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const { owner, other, recipient, nft, batch } = await setup(provider);
  const a = await owner.getAddress(), b = await other.getAddress(), c = await recipient.getAddress();
  const start = 1800000100; await (await nft.arm(start)).wait();
  await transactAt(provider, start, () => nft.mint(0, { gasLimit: 200000 }));
  await transactAt(provider, start + 1, () => nft.approve(b, 1, { gasLimit: 100000 }));
  await transactAt(provider, start + 2, () => nft.connect(other).transferFrom(a, c, 1, { gasLimit: 100000 }));
  assert.equal(await nft.balanceOf(a), 0n); assert.equal(await nft.hasMinted(a), true);
  assert.equal(await nft.getApproved(1), ZeroAddress);
  await revert(nft.mint.staticCall(2), nft.interface, 'AlreadyMinted');
  await time(provider, start + 3); await revert(nft.mint.staticCall(3), nft.interface, 'AlreadyMinted');
  await revert(nft.connect(other).transferFrom.staticCall(c, b, 1), nft.interface, 'NotAuthorized');
  await revert(nft.connect(recipient).transferFrom.staticCall(c, ZeroAddress, 1), nft.interface, 'InvalidAddress');
  await revert(nft.connect(recipient)['safeTransferFrom(address,address,uint256)'].staticCall(c, batch.target, 1), nft.interface, 'UnsafeRecipient');
  assert.equal(await nft.ownerOf(1), c); assert.equal(await nft.totalSupply(), 1n);
  await revert(nft.ownerOf(0), nft.interface, 'NonexistentToken');
});

test('real competing mints fill supply to 10000 and batch clamps partial/soldout before creating helpers', { timeout: 180_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const { owner, other, recipient, nft, batch } = await setup(provider);
  const crowd = (await deploy(owner, fixtureArtifact('Crowd'))).contract;
  const competitor = await other.getAddress();
  const start = 1800000100; await (await nft.arm(start)).wait();
  // This isolated chain has a deliberately large block gas limit for population.
  // These are genuine 9996 mints from distinct helper addresses, not storage overrides.
  await transactAt(provider, start, () => crowd.fill(nft.target, 0, 9996, competitor, { gasLimit: 1_500_000_000 }));
  assert.equal(await nft.totalSupply(), 9996n);
  // An external sender wins one more token after the earlier off-chain observation.
  const [competition, partial] = await transactionsAt(provider, start + 1, [
    () => nft.connect(other).mint(1, { gasLimit: 200000 }),
    () => batch.mintBatch(1, 10, { gasLimit: 3_000_000 }),
  ]);
  assert.equal(competition.blockNumber, partial.blockNumber);
  assert.ok(competition.index < partial.index);
  const result = event(batch, partial); assert.equal(result.status, 1n); assert.equal(result.minted, 3n);
  assert.equal(result.remaining, 0n); assert.equal(result.firstTokenId, 9998n);
  assert.equal(await nft.totalSupply(), 10000n); assert.equal(await nft.balanceOf(await recipient.getAddress()), 3n);
  const soldout = await transactAt(provider, start + 2, () => batch.mintBatch(2, 10, { gasLimit: 500000 }));
  assert.equal(event(batch, soldout).status, 2n); assert.equal(event(batch, soldout).minted, 0n);
  assert.equal(await batch.attemptedRounds(2), true);
  await revert(nft.connect(recipient).mint.staticCall(2), nft.interface, 'SoldOut');
  assert.equal(await nft.totalSupply(), 10000n);
  assert.ok(soldout.gasUsed < 100000n, 'soldout path must avoid the helper creation loop');
  t.diagnostic('LOCAL_EVM_GAS ' + JSON.stringify({ partial3: partial.gasUsed.toString(), soldout: soldout.gasUsed.toString() }));
});

test('unexpected dependency failure atomically rolls back helper mint and round attempt', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const owner = await provider.getSigner(0);
  const fake = (await deploy(owner, fixtureArtifact('FailingCollection'))).contract;
  const batch = (await deploy(owner, BATCH, [fake.target, await owner.getAddress()])).contract;
  const start = 1800000100; await (await fake.arm(start)).wait(); await time(provider, start);
  await revert(batch.mintBatch.staticCall(0, 10), fake.interface, 'InjectedFailure');
  await assert.rejects(transactAt(provider, start + 1, () => batch.mintBatch(1, 10, { gasLimit: 3_000_000 })));
  assert.equal(await fake.totalSupply(), 0n); assert.equal(await batch.attemptedRounds(0), false);
  assert.equal(await batch.attemptedRounds(1), false);
});
