import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, Signature, Wallet, ZeroAddress } from 'ethers';
import solc from 'solc';

const file = 'contracts/GenesisChildFactory.sol';
const fixtureFile = 'contracts/test/GenesisChildFixtures.sol';
const artifact = JSON.parse(await readFile(new URL('../artifacts/GenesisChildFactory.json', import.meta.url), 'utf8'));
const FACTORY = artifact.contracts.GenesisChildFactory;
const CHILD = artifact.contracts.GenesisMintChild;
const sources = Object.fromEntries(await Promise.all([file, fixtureFile].map(async path => [path, {
  content: await readFile(new URL('../' + path, import.meta.url), 'utf8'),
}])));
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: artifact.settings })));
assert.deepEqual(output.errors ?? [], []);
const fixture = name => ({ abi: output.contracts[fixtureFile][name].abi, bytecode: '0x' + output.contracts[fixtureFile][name].evm.bytecode.object });
const mintParamsType = [
  ['mintPrice', 'uint256'], ['maxTotalMintableByWallet', 'uint256'], ['startTime', 'uint256'], ['endTime', 'uint256'],
  ['dropStageIndex', 'uint256'], ['maxTokenSupplyForStage', 'uint256'], ['feeBps', 'uint256'], ['restrictFeeRecipients', 'bool'],
].map(([name, type]) => ({ name, type }));
const types = { MintParams: mintParamsType, SignedMint: [
  { name: 'nftContract', type: 'address' }, { name: 'minter', type: 'address' }, { name: 'feeRecipient', type: 'address' },
  { name: 'mintParams', type: 'MintParams' }, { name: 'salt', type: 'uint256' },
] };

async function anvil(t) {
  const binary = process.env.ANVIL_BIN ?? 'anvil';
  const version = spawnSync(binary, ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (version.error?.code === 'ENOENT') { t.skip('Anvil is required; set ANVIL_BIN to run local EVM tests.'); return; }
  assert.equal(version.status, 0);
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const childProcess = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663',
    '--hardfork', 'shanghai', '--timestamp', '1800000000', '--gas-limit', '200000000', '--silent'], { stdio: 'ignore' });
  let error;
  childProcess.on('error', value => { error = value; });
  const closed = new Promise(resolve => childProcess.once('close', resolve));
  const request = new FetchRequest(`http://127.0.0.1:${port}`); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => {
    provider.destroy(); childProcess.kill('SIGTERM'); await Promise.race([closed, delay(2000)]);
    if (childProcess.exitCode === null) { childProcess.kill('SIGKILL'); await closed; }
  });
  for (let i = 0; i < 50; ++i) {
    if (error) throw error;
    try { assert.match(await provider.send('web3_clientVersion', []), /anvil/i); return provider; }
    catch (error) { if (i === 49) throw error; await delay(40); }
  }
}
async function deploy(signer, value, args = []) {
  const contract = await new ContractFactory(value.abi, value.bytecode, signer).deploy(...args, { gasLimit: 8_000_000 });
  await contract.deploymentTransaction().wait(); return contract;
}
async function setup(provider, { initial = 0, maximum = 1024, count = 10, receiver = false } = {}) {
  const owner = await provider.getSigner(0), other = await provider.getSigner(1), recipientSigner = await provider.getSigner(2);
  const recipient = receiver ? await deploy(owner, fixture('GenesisChildTestReceiver')) : undefined;
  const recipientAddress = recipient ? recipient.target : await recipientSigner.getAddress();
  const signer = Wallet.createRandom(); // Ephemeral, isolated test signer; never a live wallet.
  const fee = await other.getAddress();
  const nft = await deploy(owner, fixture('MockGenesisChildNFT'), [initial, maximum]);
  const route = await deploy(owner, fixture('MockGenesisChildSeaDrop'), [signer.address, fee]);
  await (await nft.setRoute(route.target)).wait();
  const factory = await deploy(owner, FACTORY, [nft.target, recipientAddress]);
  if (recipient) await (await recipient.configure(factory.target, false)).wait();
  const prepared = await (await factory.prepareChildren(count, { gasLimit: 90_000_000 })).wait();
  const children = await Promise.all(Array.from({ length: count }, (_, i) => factory.children(i)));
  return { owner, other, recipient, recipientAddress, signer, fee, nft, route, factory, children, prepared };
}
function publicPayload(context, child = ZeroAddress, override = {}) {
  return context.route.interface.encodeFunctionData('mintPublic', [override.nft ?? context.nft.target,
    override.fee ?? context.fee, override.minter ?? child, override.quantity ?? 1]);
}
async function signedPayload(context, index, override = {}) {
  const params = { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: 1, endTime: 2_000_000_000,
    dropStageIndex: 4, maxTokenSupplyForStage: 1024, feeBps: 1000, restrictFeeRecipients: true, ...override.params };
  const minter = override.minter ?? context.children[index];
  const signingMinter = override.signingMinter ?? minter;
  const salt = override.salt ?? index + 1;
  let signature = await (override.signer ?? context.signer).signTypedData(
    { name: 'SeaDrop', version: '1.0', chainId: 4663, verifyingContract: context.route.target }, types,
    { nftContract: context.nft.target, minter: signingMinter, feeRecipient: context.fee, mintParams: params, salt });
  if (override.compact) signature = Signature.from(signature).compactSerialized;
  return context.route.interface.encodeFunctionData('mintSigned', [context.nft.target, context.fee,
    override.zeroMinter ? ZeroAddress : minter, 1, params, salt, signature]) + (override.suffix ?? '');
}
async function mint(context, payloads, { indices, maxCount = payloads.length, gasPerChild = 500_000, gasLimit = 15_000_000 } = {}) {
  return (await context.factory.mintBatch(context.route.target, context.fee,
    indices ?? payloads.map((_, i) => i), payloads, maxCount, gasPerChild, { gasLimit })).wait();
}
function events(context, receipt, name) {
  return receipt.logs.filter(log => log.address.toLowerCase() === context.factory.target.toLowerCase())
    .map(log => context.factory.interface.parseLog(log)).filter(event => event.name === name).map(event => event.args);
}
function result(context, receipt) { const values = events(context, receipt, 'BatchResult'); assert.equal(values.length, 1); return values[0]; }
async function rejects(promise, iface, name) {
  await assert.rejects(promise, error => (error.data ?? error.info?.error?.data)?.startsWith(iface.getError(name).selector));
}

test('Genesis child artifacts bind pinned compiler, source hashes, bytecode and immutable identities', () => {
  assert.equal(artifact.compiler, solc.version());
  for (const [path, hash] of Object.entries(artifact.sourceSha256)) assert.equal(createHash('sha256').update(sources[path].content).digest('hex'), hash);
  for (const [name, contract] of Object.entries(artifact.contracts)) {
    assert.equal(contract.bytecode, '0x' + output.contracts[file][name].evm.bytecode.object);
    assert.ok(contract.deployedBytecode.length / 2 < 24576);
    for (const id of Object.values(contract.immutableIds)) assert.ok(contract.immutableReferences[id]?.length);
  }
});

test('predeployed children stay inert, public batches of one and ten transfer to the fixed recipient', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider, { count: 11 });
  assert.equal(await c.nft.total(), 0n); assert.equal(await c.factory.childCount(), 11n);
  const first = await mint(c, [publicPayload(c)]);
  assert.equal(result(c, first).minted, 1n);
  const rest = await mint(c, c.children.slice(1).map(child => publicPayload(c, child)), { indices: Array.from({ length: 10 }, (_, i) => i + 1) });
  assert.equal(result(c, rest).minted, 10n);
  assert.equal(await c.nft.balanceOf(c.recipientAddress), 11n);
  for (const child of c.children) {
    const helper = new Contract(child, CHILD.abi, c.owner);
    assert.equal(await helper.factory(), c.factory.target); assert.equal(await helper.recipient(), c.recipientAddress);
    assert.equal(await helper.spent(), true); assert.equal(await c.nft.balanceOf(child), 0n);
  }
  for (let id = 1; id <= 11; ++id) assert.equal(await c.nft.ownerOf(id), c.recipientAddress);
  const reuse = await mint(c, [publicPayload(c)]); assert.equal(result(c, reuse).minted, 0n);
  t.diagnostic('LOCAL_EVM_GAS ' + JSON.stringify({ prepare11: c.prepared.gasUsed.toString(), public1: first.gasUsed.toString(), public10: rest.gasUsed.toString() }));
});

test('each signed mint is bound to its child; invalid signatures preserve successful neighbors and remain retryable', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider);
  const payloads = await Promise.all(c.children.map((_, i) => signedPayload(c, i,
    i === 3 ? { signingMinter: c.children[0] } : { zeroMinter: true, suffix: '3d958fe2' })));
  const receipt = await mint(c, payloads);
  assert.equal(result(c, receipt).minted, 9n); assert.equal(result(c, receipt).attempted, 10n);
  assert.equal(await new Contract(c.children[3], CHILD.abi, c.owner).spent(), false);
  const retry = await mint(c, [await signedPayload(c, 3)], { indices: [3] });
  assert.equal(result(c, retry).minted, 1n); assert.equal(await c.nft.balanceOf(c.recipientAddress), 10n);
});

test('supply is read during execution: 910/1024 gives ten, only three remaining gives three, sold out gives zero', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  for (const [initial, expected] of [[910, 10], [1021, 3], [1024, 0]]) {
    const c = await setup(provider, { initial });
    const receipt = await mint(c, c.children.map(() => publicPayload(c)));
    assert.equal(result(c, receipt).minted, BigInt(expected));
    assert.equal(result(c, receipt).attempted, BigInt(expected));
    assert.equal(await c.nft.total(), BigInt(initial + expected));
    assert.equal(await c.nft.balanceOf(c.recipientAddress), BigInt(expected));
    if (!expected) assert.ok(receipt.gasUsed < 150000n);
  }
});

test('signed stage cap, expired permissions and rotated signer fail locally and fresh signatures work without redeployment', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider, { initial: 910 });
  const limited = await Promise.all(c.children.map((_, i) => signedPayload(c, i, { params: { maxTokenSupplyForStage: 913 } })));
  const partial = await mint(c, limited); assert.equal(result(c, partial).minted, 3n); assert.equal(result(c, partial).attempted, 6n);
  const old = await signedPayload(c, 3);
  const freshSigner = Wallet.createRandom(); await (await c.route.setSigner(freshSigner.address)).wait();
  const rejected = await mint(c, [old], { indices: [3] }); assert.equal(result(c, rejected).minted, 0n);
  const fresh = await mint(c, [await signedPayload(c, 3, { signer: freshSigner })], { indices: [3] });
  assert.equal(result(c, fresh).minted, 1n); assert.equal(await c.factory.childCount(), 10n);
  const expired = await mint(c, [await signedPayload(c, 4, { signer: freshSigner, params: { endTime: 2 } })], { indices: [4] });
  assert.equal(result(c, expired).minted, 0n);
});

test('a competing transaction ahead in the same block reduces the batch to the actual remaining three', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider, { initial: 1020 });
  const before = await c.nft.getMintStats(ZeroAddress); assert.equal(before[2] - before[1], 4n);
  let competitor;
  let batch;
  await provider.send('evm_setAutomine', [false]);
  try {
    competitor = await c.route.connect(c.other).mintPublic(c.nft.target, c.fee, ZeroAddress, 1, { gasLimit: 250_000 });
    batch = await c.factory.mintBatch(c.route.target, c.fee, c.children.map((_, i) => i),
      c.children.map(() => publicPayload(c)), 10, 500_000, { gasLimit: 15_000_000 });
    await provider.send('evm_mine', []);
  } finally { await provider.send('evm_setAutomine', [true]); }
  const [first, ours] = await Promise.all([competitor.wait(), batch.wait()]);
  assert.equal(first.blockNumber, ours.blockNumber); assert.ok(first.index < ours.index);
  assert.equal(result(c, ours).minted, 3n); assert.equal(result(c, ours).attempted, 3n);
  assert.equal(await c.nft.total(), 1024n); assert.equal(await c.nft.balanceOf(c.recipientAddress), 3n);
});

test('three consecutive child failures stop, reset on success, and gas-burning/large-revert dependencies cannot roll back prior mints', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider);
  for (const [index, mode] of [[0, 1], [1, 1], [3, 2], [4, 3], [5, 1]]) await (await c.route.setFailure(c.children[index], mode)).wait();
  const receipt = await mint(c, c.children.map(() => publicPayload(c)), { gasPerChild: 250_000 });
  assert.equal(result(c, receipt).minted, 1n); assert.equal(result(c, receipt).attempted, 6n);
  assert.equal(await c.nft.ownerOf(1), c.recipientAddress);
  assert.equal(await new Contract(c.children[6], CHILD.abi, c.owner).spent(), false);
  assert.ok(receipt.gasUsed < 1_000_000n);
});

test('authorization, route updates, selectors, destination, fee, minter, quantity and payment constraints are enforced', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider);
  await rejects(c.factory.connect(c.other).prepareChildren.staticCall(1), c.factory.interface, 'NotOwner');
  await rejects(c.factory.connect(c.other).mintBatch.staticCall(c.route.target, c.fee, [0], [publicPayload(c)], 1, 500_000), c.factory.interface, 'NotOwner');
  const child = new Contract(c.children[0], CHILD.abi, c.owner);
  await rejects(child.mint.staticCall(c.route.target, c.fee, publicPayload(c)), child.interface, 'NotFactory');
  await rejects(child.onERC721Received.staticCall(c.route.target, ZeroAddress, 1, '0x'), child.interface, 'UnexpectedCallback');
  for (const payload of [publicPayload(c, ZeroAddress, { nft: c.route.target }), publicPayload(c, ZeroAddress, { fee: c.nft.target }),
    publicPayload(c, ZeroAddress, { minter: c.recipientAddress }), publicPayload(c, ZeroAddress, { quantity: 2 }), '0x12345678']) {
    const receipt = await mint(c, [payload]); assert.equal(result(c, receipt).minted, 0n);
  }
  const paid = await mint(c, [await signedPayload(c, 0, { params: { mintPrice: 1 } })]); assert.equal(result(c, paid).minted, 0n);
  const compact = await mint(c, [await signedPayload(c, 0, { compact: true })]); assert.equal(result(c, compact).minted, 0n);
  await rejects(c.factory.mintBatch.staticCall(c.route.target, c.fee, [100], [publicPayload(c)], 1, 500_000), c.factory.interface, 'InvalidChild');
  await rejects(c.factory.mintBatch.staticCall(c.route.target, c.fee, [0], [publicPayload(c)], 1, 99_999), c.factory.interface, 'InvalidGasLimit');
  const nextRoute = await deploy(c.owner, fixture('MockGenesisChildSeaDrop'), [c.signer.address, c.fee]);
  await (await c.nft.setRoute(nextRoute.target)).wait();
  await rejects(c.factory.mintBatch.staticCall(c.route.target, c.fee, [0], [publicPayload(c)], 1, 500_000), c.factory.interface, 'RouteNotAllowed');
  c.route = nextRoute;
  const next = await mint(c, [await signedPayload(c, 0)]); assert.equal(result(c, next).minted, 1n);
});

test('receiver callbacks are authenticated and failed transfers roll back only their child', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider, { receiver: true, count: 2 });
  const first = await mint(c, [publicPayload(c)]); assert.equal(result(c, first).minted, 1n);
  assert.equal(await c.recipient.reentryRejected(), true); assert.equal(await c.factory.childCount(), 2n);
  await (await c.recipient.configure(c.factory.target, true)).wait();
  const failed = await mint(c, [publicPayload(c)], { indices: [1] }); assert.equal(result(c, failed).minted, 0n);
  assert.equal(await c.nft.total(), 1n); assert.equal(await new Contract(c.children[1], CHILD.abi, c.owner).spent(), false);
  await (await c.recipient.configure(c.factory.target, false)).wait();
  assert.equal(result(c, await mint(c, [publicPayload(c)], { indices: [1] })).minted, 1n);
});

test('bounded getter failure and low remaining parent gas preserve already completed mints', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider);
  await (await c.nft.setFailFactoryStatsAt(1)).wait();
  const getter = await mint(c, c.children.map(() => publicPayload(c)));
  assert.equal(result(c, getter).minted, 1n); assert.equal(result(c, getter).attempted, 1n);
  await (await c.nft.setFailFactoryStatsAt(0)).wait();
  const lowGas = await mint(c, c.children.slice(1).map(() => publicPayload(c)),
    { indices: c.children.slice(1).map((_, i) => i + 1), gasPerChild: 250_000, gasLimit: 600_000 });
  assert.ok(result(c, lowGas).minted > 0n); assert.ok(result(c, lowGas).minted < 9n);
  assert.equal(await c.nft.balanceOf(c.recipientAddress), 1n + result(c, lowGas).minted);
});

test('a recipient that owns its factory passes owner authorization but is blocked by the reentrancy guard', { timeout: 60_000 }, async t => {
  const provider = await anvil(t); if (!provider) return;
  const c = await setup(provider, { count: 1 });
  const receiver = await deploy(c.owner, fixture('GenesisChildOwnerReceiver'), [c.nft.target]);
  await (await receiver.prepare({ gasLimit: 2_000_000 })).wait();
  const factory = new Contract(await receiver.factory(), FACTORY.abi, c.owner);
  const receipt = await (await receiver.runMint(c.route.target, c.fee, publicPayload(c), { gasLimit: 1_000_000 })).wait();
  assert.equal(result({ ...c, factory }, receipt).minted, 1n);
  assert.equal(await receiver.reentryRejected(), true);
  assert.equal(await factory.childCount(), 1n);
  assert.equal(await c.nft.ownerOf(1), receiver.target);
});
