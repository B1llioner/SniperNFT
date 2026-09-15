import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractFactory, FetchRequest, JsonRpcProvider, ZeroAddress, zeroPadValue } from 'ethers';
import solc from 'solc';
import { expectedBenchmarkRuntime, loadBenchmarkArtifact } from '../lib/benchmark-contract.mjs';

const ARTIFACT = await loadBenchmarkArtifact();
const OWNER = '0x1000000000000000000000000000000000000001';
const RUN_ID = `0x${'a7'.repeat(32)}`;

test('benchmark artifact matches a fresh pinned compilation and AST-derived immutable names', async () => {
  const source = await readFile(new URL('../contracts/SequencerBenchmarkNFT.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
    sources: { [ARTIFACT.source]: { content: source } }, settings: ARTIFACT.settings })));
  assert.deepEqual((compiled.errors ?? []).filter(error => error.severity === 'error'), []);
  const contract = compiled.contracts[ARTIFACT.source][ARTIFACT.contractName];
  assert.equal(ARTIFACT.bytecode, `0x${contract.evm.bytecode.object}`);
  assert.equal(ARTIFACT.deployedBytecode, `0x${contract.evm.deployedBytecode.object}`);
  assert.deepEqual(ARTIFACT.abi, contract.abi);
  assert.deepEqual(ARTIFACT.immutableReferences, contract.evm.deployedBytecode.immutableReferences);
  const ast = compiled.sources[ARTIFACT.source].ast.nodes.find(node => node.name === ARTIFACT.contractName);
  const ids = Object.fromEntries(ast.nodes.filter(node => node.nodeType === 'VariableDeclaration'
    && node.stateVariable && node.mutability === 'immutable').map(node => [node.name, String(node.id)]));
  assert.deepEqual(ARTIFACT.immutableIds, ids);
});

test('benchmark runtime patches named immutable groups independently of object ordering', () => {
  const artifact = structuredClone(ARTIFACT);
  artifact.immutableIds = { runId: ARTIFACT.immutableIds.runId, owner: ARTIFACT.immutableIds.owner };
  artifact.immutableReferences = Object.fromEntries(Object.entries(ARTIFACT.immutableReferences).reverse());
  const runtime = expectedBenchmarkRuntime(artifact, OWNER, RUN_ID);
  assert.equal(runtime, expectedBenchmarkRuntime(ARTIFACT, OWNER, RUN_ID));
  const bytes = Buffer.from(runtime.slice(2), 'hex');
  for (const [name, id] of Object.entries(ARTIFACT.immutableIds)) {
    const expected = name === 'owner' ? zeroPadValue(OWNER, 32) : RUN_ID;
    for (const { start } of ARTIFACT.immutableReferences[id]) {
      assert.equal(`0x${bytes.subarray(start, start + 32).toString('hex')}`, expected);
    }
  }
  assert.notEqual(runtime, expectedBenchmarkRuntime(ARTIFACT, OWNER, `0x${'b8'.repeat(32)}`));
  assert.notEqual(runtime, expectedBenchmarkRuntime(ARTIFACT, '0x2000000000000000000000000000000000000002', RUN_ID));
});

test('benchmark runtime rejects malformed immutable metadata and invalid constructor identities', () => {
  for (const mutate of [
    artifact => { artifact.immutableIds.owner = artifact.immutableIds.runId; },
    artifact => { delete artifact.immutableIds.owner; },
    artifact => { artifact.immutableReferences['999999'] = []; },
    artifact => { artifact.immutableReferences[artifact.immutableIds.owner] = []; },
    artifact => { artifact.immutableReferences[artifact.immutableIds.owner][0].length = 31; },
    artifact => { artifact.immutableReferences[artifact.immutableIds.owner][0].start = -1; },
    artifact => { artifact.immutableReferences[artifact.immutableIds.owner][0].start = 100_000; },
    artifact => { artifact.immutableReferences[artifact.immutableIds.owner][0] = artifact.immutableReferences[artifact.immutableIds.runId][0]; },
    artifact => { artifact.deployedBytecode = expectedBenchmarkRuntime(ARTIFACT, OWNER, RUN_ID); },
  ]) {
    const artifact = structuredClone(ARTIFACT);
    mutate(artifact);
    assert.throws(() => expectedBenchmarkRuntime(artifact, OWNER, RUN_ID), /benchmark|Benchmark/);
  }
  assert.throws(() => expectedBenchmarkRuntime(ARTIFACT, ZeroAddress, RUN_ID), /owner/);
  assert.throws(() => expectedBenchmarkRuntime(ARTIFACT, OWNER, '0xa7'), /run ID/);
  assert.throws(() => expectedBenchmarkRuntime(ARTIFACT, 'invalid-address', RUN_ID), /address/);
});

async function localAnvil(t) {
  const binary = process.env.ANVIL_BIN ?? 'anvil';
  const version = spawnSync(binary, ['--version'], { timeout: 5000, stdio: 'ignore' });
  if (version.error?.code === 'ENOENT') { t.skip('Anvil is not installed; set ANVIL_BIN to enable local EVM contract verification.'); return; }
  assert.equal(version.status, 0, 'Anvil must start successfully.');
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const anvil = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--silent'], { stdio: 'ignore' });
  let spawnError;
  anvil.on('error', error => { spawnError = error; });
  const exited = once(anvil, 'close');
  const request = new FetchRequest(`http://127.0.0.1:${port}`);
  request.timeout = 1000;
  const provider = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 20;
  t.after(async () => {
    provider.destroy();
    if (anvil.exitCode == null) anvil.kill('SIGTERM');
    await Promise.race([exited, delay(2000)]);
    if (anvil.exitCode == null) { anvil.kill('SIGKILL'); await exited; }
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    try {
      assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal(BigInt(await provider.send('eth_chainId', [])), 4663n);
      return provider;
    } catch (error) { if (attempt === 39) throw error; await delay(50); }
  }
}

async function rejectsWith(operation, name) {
  await assert.rejects(operation, error => error.revert?.name === name);
}

test('benchmark NFT executes real deployment, unlimited repeated mints and ERC721 authorization locally', { timeout: 45_000 }, async t => {
  const provider = await localAnvil(t);
  if (!provider) return;
  // Anvil exposes synthetic unlocked accounts on this new, isolated local chain.
  const accounts = await provider.send('eth_accounts', []);
  const [owner, outsider, recipient] = await Promise.all(accounts.slice(0, 3).map(account => provider.getSigner(account)));
  const ownerAddress = await owner.getAddress();
  const outsiderAddress = await outsider.getAddress();
  const recipientAddress = await recipient.getAddress();
  const nft = await new ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, owner).deploy(RUN_ID);
  await nft.waitForDeployment();
  assert.equal(await provider.getCode(nft.target), expectedBenchmarkRuntime(ARTIFACT, ownerAddress, RUN_ID));
  assert.equal(await nft.owner(), ownerAddress);
  assert.equal(await nft.runId(), RUN_ID);
  assert.equal(await nft.totalSupply(), 0n);
  assert.equal(await nft.supportsInterface('0x01ffc9a7'), true);
  assert.equal(await nft.supportsInterface('0x80ac58cd'), true);
  assert.equal(await nft.supportsInterface('0x5b5e139f'), false);
  assert.equal(await nft.supportsInterface('0xffffffff'), false);
  await rejectsWith(nft.ownerOf(1), 'NonexistentToken');
  await rejectsWith(nft.balanceOf(ZeroAddress), 'InvalidAddress');
  await rejectsWith(nft.getApproved(1), 'NonexistentToken');
  await rejectsWith(nft.connect(outsider).mint.staticCall(1), 'NotOwner');
  await rejectsWith(nft.mint.staticCall(0), 'InvalidQuantity');
  await rejectsWith(nft.mint.staticCall(1001), 'InvalidQuantity');
  assert.equal(await nft.mint.staticCall(3), 1n);
  const minted = await (await nft.mint(3)).wait();
  const transfers = minted.logs.map(log => nft.interface.parseLog(log));
  assert.deepEqual(transfers.map(event => [event.name, ...event.args]), [1n, 2n, 3n].map(id => ['Transfer', ZeroAddress, ownerAddress, id]));
  assert.equal(await nft.totalSupply(), 3n);
  assert.equal(await nft.balanceOf(ownerAddress), 3n);
  assert.equal(await nft.ownerOf(3), ownerAddress);

  await rejectsWith(nft.connect(outsider).transferFrom.staticCall(ownerAddress, outsiderAddress, 1), 'NotAuthorized');
  await rejectsWith(nft.connect(outsider).approve.staticCall(outsiderAddress, 1), 'NotAuthorized');
  await rejectsWith(nft.transferFrom.staticCall(outsiderAddress, recipientAddress, 1), 'IncorrectOwner');
  await rejectsWith(nft.transferFrom.staticCall(ownerAddress, ZeroAddress, 1), 'InvalidAddress');
  await (await nft.approve(outsiderAddress, 1)).wait();
  assert.equal(await nft.getApproved(1), outsiderAddress);
  await (await nft.connect(outsider).transferFrom(ownerAddress, recipientAddress, 1)).wait();
  assert.equal(await nft.ownerOf(1), recipientAddress);
  assert.equal(await nft.getApproved(1), ZeroAddress);
  assert.equal(await nft.balanceOf(recipientAddress), 1n);
  assert.equal(await nft.balanceOf(ownerAddress), 2n);
  await (await nft.setApprovalForAll(outsiderAddress, true)).wait();
  assert.equal(await nft.isApprovedForAll(ownerAddress, outsiderAddress), true);
  await rejectsWith(nft.connect(outsider).mint.staticCall(1), 'NotOwner');
  await (await nft.connect(outsider)['safeTransferFrom(address,address,uint256)'](ownerAddress, recipientAddress, 2)).wait();
  await (await nft.setApprovalForAll(outsiderAddress, false)).wait();
  await rejectsWith(nft.connect(outsider).transferFrom.staticCall(ownerAddress, recipientAddress, 3), 'NotAuthorized');
  await rejectsWith(nft['safeTransferFrom(address,address,uint256)'].staticCall(ownerAddress, nft.target, 3), 'UnsafeRecipient');
  assert.equal(await nft.ownerOf(3), ownerAddress);

  // A receiver exercises callback arguments and return value without any upstream RPC.
  const receiverSource = 'pragma solidity 0.8.26; contract Receiver { address public operator; address public from; uint256 public id; bytes public data; function onERC721Received(address o,address f,uint256 i,bytes calldata d) external returns(bytes4) { operator=o; from=f; id=i; data=d; return 0x150b7a02; } }';
  const receiverOutput = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Receiver.sol': { content: receiverSource } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const receiverArtifact = receiverOutput.contracts['Receiver.sol'].Receiver;
  const receiver = await new ContractFactory(receiverArtifact.abi, `0x${receiverArtifact.evm.bytecode.object}`, owner).deploy();
  await receiver.waitForDeployment();
  await (await nft['safeTransferFrom(address,address,uint256,bytes)'](ownerAddress, receiver.target, 3, '0x1234')).wait();
  assert.equal(await nft.ownerOf(3), receiver.target);
  assert.equal(await receiver.operator(), ownerAddress);
  assert.equal(await receiver.from(), ownerAddress);
  assert.equal(await receiver.id(), 3n);
  assert.equal(await receiver.data(), '0x1234');

  assert.equal(await nft.mint.staticCall(1000), 4n);
  const repeated = await (await nft.mint(1000, { gasLimit: 29_000_000n })).wait();
  assert.equal(repeated.logs.length, 1000);
  assert.equal(await nft.totalSupply(), 1003n, 'Per-call quantity limit must not become a cumulative supply cap.');
  assert.equal(await nft.balanceOf(ownerAddress), 1000n);
  assert.equal(await nft.ownerOf(1003), ownerAddress);
  await rejectsWith(nft.ownerOf(1004), 'NonexistentToken');
  assert.equal(await nft.mint.staticCall(1), 1004n);
  assert.equal(await nft.totalSupply(), await nft.balanceOf(ownerAddress) + await nft.balanceOf(recipientAddress) + await nft.balanceOf(receiver.target));
});
