// Local Anvil fork only. This script advances local time and sends local test transactions.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, ZeroAddress, toBeHex } from 'ethers';
import { CONFIG, SEADROP_ABI } from '../mint.mjs';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:18545');
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only a local Anvil RPC is allowed.');
assert.ok(!url.username && !url.password, 'Credentials are not accepted.');
const request = new FetchRequest(url.href);
request.timeout = 120000;
const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
provider.pollingInterval = 100;
const report = { kind: 'local-anvil-fork', mainnetBroadcast: false, checks: [] };
let initialSnapshot;

async function rejectWith(operation, name) {
  await assert.rejects(operation, error => error.revert?.name === name || error.message.includes(name));
  report.checks.push(name);
}
async function localMint(factory, maximum, minimum) {
  console.log(`Local batch: max=${maximum}, min=${minimum}`);
  const sent = await factory.mintBatch(maximum, minimum, { gasLimit: 12000000n });
  let receipt;
  try { receipt = await sent.wait(1, 120000); }
  catch (error) {
    if (error.receipt) {
      const trace = await provider.send('debug_traceTransaction', [sent.hash, { disableStorage: true, disableMemory: true }]);
      await writeFile(new URL('../research/batch-failure-trace.json', import.meta.url), JSON.stringify({
        failed: trace.failed, returnValue: trace.returnValue,
        tail: trace.structLogs?.slice(-120),
      }, null, 2));
    }
    throw error;
  }
  assert.equal(receipt.status, 1);
  const events = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== factory.target.toLowerCase()) return [];
    try { const decoded = factory.interface.parseLog(log); return decoded?.name === 'TokenMinted' ? [decoded.args] : []; }
    catch { return []; }
  });
  return { receipt, events };
}

try {
  const client = await provider.send('web3_clientVersion', []);
  assert.match(client, /anvil/i, 'RPC must identify as Anvil.');
  report.client = client;
  assert.equal(BigInt(await provider.send('eth_chainId', [])), CONFIG.chainId);
  const accounts = await provider.send('eth_accounts', []);
  assert.ok(accounts.length >= 2, 'Anvil must expose at least two synthetic accounts.');
  initialSnapshot = await provider.send('evm_snapshot', []);
  // Public Anvil development addresses can have EIP-7702 code in the remote chain.
  // Explicitly model ordinary EOAs for these synthetic test actors; NFT/SeaDrop stay untouched.
  for (const account of accounts.slice(0, 2)) await provider.send('anvil_setCode', [account, '0x']);
  report.syntheticActors = 'Anvil accounts 0 and 1 reset to ordinary EOAs locally; account 0 pays and receives.';
  const [owner, outsider] = await Promise.all([provider.getSigner(accounts[0]), provider.getSigner(accounts[1])]);
  const recipient = accounts[0];
  const nft = new Contract(CONFIG.nftContract, [
    'function getMintStats(address) view returns(uint256,uint256,uint256)',
    'function ownerOf(uint256) view returns(address)',
    'function balanceOf(address) view returns(uint256)',
  ], provider);
  const sea = new Contract(CONFIG.seaDrop, SEADROP_ABI, provider);
  const artifact = JSON.parse(await readFile(new URL('../artifacts/RareFriendsBatchMinter.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL(`../${artifact.source}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), artifact.sourceSha256, 'Recompile stale artifacts first.');
  const [block, drop, stats] = await Promise.all([provider.getBlock('latest'), sea.getPublicDrop(CONFIG.nftContract), nft.getMintStats(ZeroAddress)]);
  assert.equal(drop.mintPrice, 0n, 'This proof is for a free drop.');
  assert.ok(stats[2] - stats[1] >= 10n, 'Snapshot has fewer than ten NFTs remaining.');
  report.forkBlock = block.number;
  report.forkTimestamp = block.timestamp;
  report.factorySourceSha256 = artifact.sourceSha256;
  report.startSupply = stats[1].toString();
  report.publicDrop = { startTime: drop.startTime.toString(), endTime: drop.endTime.toString(), mintPrice: '0' };
  const factory = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(recipient, { gasLimit: 2000000n });
  const deployment = await factory.deploymentTransaction().wait(1, 120000);
  report.deploymentGasUsedLocal = deployment.gasUsed.toString();
  await rejectWith(factory.connect(outsider).mintBatch.staticCall(10, 10), 'NotOwner');
  await rejectWith(factory.mintBatch.staticCall(1025, 1), 'InvalidCount');
  await rejectWith(factory.mintBatch.staticCall(1, 0), 'InvalidCount');
  await rejectWith(factory.mintBatch.staticCall(1, 2), 'InvalidCount');
  if (BigInt(block.timestamp) < drop.startTime) {
    await rejectWith(factory.mintBatch.staticCall(10, 10), 'InactiveStage');
    await provider.send('evm_setNextBlockTimestamp', [Number(drop.startTime + 1n)]);
    await provider.send('evm_mine', []);
  } else assert.ok(BigInt(block.timestamp) <= drop.endTime, 'Public stage has ended at this snapshot.');
  const initialBalance = await nft.balanceOf(recipient);
  const batch = await localMint(factory, 10, 10);
  assert.equal(batch.events.length, 10);
  assert.equal(new Set(batch.events.map(event => event.helper)).size, 10);
  assert.equal((await nft.getMintStats(ZeroAddress))[1], stats[1] + 10n);
  assert.equal(await nft.balanceOf(recipient), initialBalance + 10n);
  for (const event of batch.events) {
    assert.equal((await nft.ownerOf(event.tokenId)).toLowerCase(), recipient.toLowerCase());
    assert.equal((await nft.getMintStats(event.helper))[0], 1n);
    assert.equal(await nft.balanceOf(event.helper), 0n);
  }
  report.checks.push('10 distinct helpers mint once and forward all 10 NFTs to recipient');
  report.batchGasUsedLocal = batch.receipt.gasUsed.toString();
  report.tokenIds = batch.events.map(event => event.tokenId.toString());
  report.helpers = batch.events.map(event => event.helper);

  // Artificial scarcity scenario, local storage only. Slot 9 was identified in bytecode.
  const scarcitySnapshot = await provider.send('evm_snapshot', []);
  await provider.send('anvil_setStorageAt', [CONFIG.nftContract, toBeHex(9n, 32), toBeHex(stats[2] - 3n, 32)]);
  await rejectWith(factory.mintBatch.staticCall(10, 10), 'InsufficientSupply');
  const partial = await localMint(factory, 10, 1);
  assert.equal(partial.events.length, 3);
  assert.equal((await nft.getMintStats(ZeroAddress))[1], stats[2]);
  report.checks.push('artificial remaining supply 3: exact 10 rejects; max10/min1 mints 3');
  await provider.send('evm_revert', [scarcitySnapshot]);

  // Artificial broken transfer dependency: a configured hook with no bytecode.
  const hookSnapshot = await provider.send('evm_snapshot', []);
  const supplyBeforeFailure = (await nft.getMintStats(ZeroAddress))[1];
  const balanceBeforeFailure = await nft.balanceOf(recipient);
  await provider.send('anvil_setStorageAt', [CONFIG.nftContract, toBeHex(11n, 32), toBeHex(0xdeadn, 32)]);
  await assert.rejects(localMint(factory, 10, 10));
  assert.equal((await nft.getMintStats(ZeroAddress))[1], supplyBeforeFailure);
  assert.equal(await nft.balanceOf(recipient), balanceBeforeFailure);
  report.checks.push('artificial broken transfer hook reverts the complete batch without partial mints');
  await provider.send('evm_revert', [hookSnapshot]);

  report.note = 'Time advanced on the local fork; scarcity and broken-hook cases used explicit local storage changes. Local gas omits chain-specific L1 posting costs. This is not a mainnet mint or a guarantee of inclusion.';
  await writeFile(new URL('../research/batch-simulation.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (initialSnapshot) await provider.send('evm_revert', [initialSnapshot]);
  provider.destroy();
}
