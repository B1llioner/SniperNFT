// Opt-in read-only remote state access. All deployments, time changes and mints run on a local fork.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, ZeroAddress, keccak256 } from 'ethers';

const artifact = JSON.parse(await readFile(new URL('../artifacts/GenesisChildFactory.json', import.meta.url), 'utf8'));
const NFT = '0x116EaA62241751E0c98dA43d458600c6C17cD361';
const ROUTE = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719';
const NFT_CODE_HASH = '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c';
const ROUTE_CODE_HASH = '0x53e4b9339cf624803c9a7d0195576cca5b917920813508d86b3eb93dcbabeb5c';
const nftAbi = ['function getMintStats(address) view returns(uint256,uint256,uint256)',
  'function ownerOf(uint256) view returns(address)', 'function balanceOf(address) view returns(uint256)'];
const routeAbi = ['function getPublicDrop(address) view returns(tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function mintPublic(address,address,address,uint256) payable'];
function provider(url, timeout) {
  const request = new FetchRequest(url); request.timeout = timeout;
  request.setThrottleParams({ maxAttempts: 1 }); request.retryFunc = async () => false;
  const rpc = new JsonRpcProvider(request, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  rpc.pollingInterval = 20; return rpc;
}

test('actual Genesis bytecode: predeployed receiver mint and optional ten-child fork simulation',
  { timeout: 180_000, skip: !process.env.GENESIS_FORK_RPC && 'Set GENESIS_FORK_RPC to an explicitly allowed public read endpoint.' }, async t => {
    const remoteURL = process.env.GENESIS_FORK_RPC;
    assert.ok(['https://robinhood-rpc.publicnode.com', 'https://rpc.mainnet.chain.robinhood.com'].includes(remoteURL),
      'Only known credential-free public read endpoints are accepted.');
    const remote = provider(remoteURL, 20_000); t.after(() => remote.destroy());
    assert.equal(BigInt(await remote.send('eth_chainId', [])), 4663n);
    const block = await remote.getBlock('latest'); assert.ok(block);
    console.info('GENESIS_FORK_PHASE ' + JSON.stringify({ phase: 'snapshot', block: block.number }));
    const reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663',
      // Genesis executes MCOPY in its safe receiver path; Shanghai-only local forks reject that opcode.
      '--hardfork', 'cancun', '--gas-limit', '32000000', '--fork-url', remoteURL, '--fork-block-number', String(block.number),
      '--retries', '0', '--timeout', '15000', '--no-storage-caching', '--steps-tracing', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let startupError = ''; child.stderr.on('data', data => { startupError = (startupError + data.toString()).slice(-2000); });
    const closed = new Promise(resolve => child.once('close', resolve));
    const local = provider(`http://127.0.0.1:${port}`, 120_000);
    t.after(async () => {
      local.destroy(); child.kill('SIGTERM'); await Promise.race([closed, delay(2000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
    });
    for (let i = 0; i < 80; ++i) {
      if (child.exitCode !== null) throw new Error('Local fork failed to start: ' + startupError);
      try { assert.match(await local.send('web3_clientVersion', []), /anvil/i); break; }
      catch (error) { if (i === 79) throw error; await delay(250); }
    }
    assert.equal(await local.getBlockNumber(), block.number);
    const [nftCode, routeCode] = await Promise.all([local.getCode(NFT), local.getCode(ROUTE)]);
    assert.equal(keccak256(nftCode), NFT_CODE_HASH); assert.equal(keccak256(routeCode), ROUTE_CODE_HASH);
    const nft = new Contract(NFT, nftAbi, local), route = new Contract(ROUTE, routeAbi, local);
    const [stats, drop] = await Promise.all([nft.getMintStats(ZeroAddress), route.getPublicDrop(NFT)]);
    assert.ok(stats[2] - stats[1] >= 11n, 'Pinned state has fewer than 11 NFTs remaining.');
    assert.equal(drop.mintPrice, 0n); assert.ok(drop.maxTotalMintableByWallet >= 1n);
    const timestamp = Math.max(block.timestamp + 30, Number(drop.startTime) + 1);
    assert.ok(timestamp + 20 <= Number(drop.endTime), 'Public stage at snapshot cannot fit this local test.');
    // Use fresh synthetic actors instead of public Anvil addresses with live mainnet history.
    // Their private material is generated only in memory, never printed and used only on loopback.
    const owner = Wallet.createRandom().connect(local);
    const actor = owner.address;
    const recipientAddress = Wallet.createRandom().address;
    for (const address of [actor, recipientAddress]) await local.send('anvil_setCode', [address, '0x']);
    await local.send('anvil_setBalance', [actor, '0x8ac7230489e80000']);
    await local.send('anvil_setNonce', [actor, '0x0']);
    const factory = await new ContractFactory(artifact.contracts.GenesisChildFactory.abi,
      artifact.contracts.GenesisChildFactory.bytecode, owner).deploy(NFT, recipientAddress, { gasLimit: 4_000_000 });
    await factory.deploymentTransaction().wait(1, 30_000);
    const prepared = await (await factory.prepareChildren(11, { gasLimit: 12_000_000 })).wait(1, 30_000);
    const children = await Promise.all(Array.from({ length: 11 }, (_, i) => factory.children(i)));
    for (const address of children) assert.ok((await local.getCode(address)).length > 2, 'Child must have deployed runtime before mint.');
    await local.send('evm_setNextBlockTimestamp', [timestamp]); await local.send('evm_mine', []);
    const initialBalance = await nft.balanceOf(recipientAddress);
    const gas = { prepare11: prepared.gasUsed.toString() };
    let cumulative = 0n;
    let simulatedBatchMinted = null;
    let batchSimulationStatus = 'not-run';
    for (const indices of [[0], Array.from({ length: 10 }, (_, i) => i + 1)]) {
      console.info('GENESIS_FORK_PHASE ' + JSON.stringify({ phase: 'mint', count: indices.length }));
      const payloads = indices.map(index => route.interface.encodeFunctionData('mintPublic', [NFT, FEE, children[index], 1]));
      if (indices.length === 10) {
        // Full exact-call execution verifies the adapter's ownership assertions for every NFT.
        // Old Anvil fork automining can leave a second transaction pending; this test does not
        // claim a committed ten-token receipt from that miner. The mock EVM suite tests commits.
        let simulated;
        try {
          simulated = await factory.mintBatch.staticCall(ROUTE, FEE, indices, payloads, 10, 1_000_000,
            { gasLimit: 15_000_000 });
        } catch (error) {
          const message = error.info?.error?.message ?? error.shortMessage ?? '';
          if (error.info?.error?.code === -32603 && message.includes('403 Forbidden')
            && message.includes('Archive requests require a personal token')) {
            batchSimulationStatus = 'blocked-publicnode-archive-token-required';
            await t.test('exact ten-child simulation against pinned real Genesis state', sub => {
              sub.skip('PublicNode refused an uncached historical storage read: archive access requires a personal token.');
            });
            break;
          }
          throw new Error('FORK_BATCH_SIMULATION_FAILED ' + JSON.stringify({ code: error.info?.error?.code,
            message, data: error.info?.error?.data }));
        }
        assert.equal(simulated, 10n);
        simulatedBatchMinted = '10';
        batchSimulationStatus = 'passed-exact-eth-call';
        assert.equal((await nft.getMintStats(ZeroAddress))[1], stats[1] + cumulative, 'eth_call must not persist simulated mints');
        assert.equal(await nft.balanceOf(recipientAddress), initialBalance + cumulative);
        continue;
      }
      const sent = await factory.mintBatch(ROUTE, FEE, indices, payloads, indices.length, 1_000_000,
        { gasLimit: 15_000_000 });
      // This is a local execution proof, not an Anvil autominer timing benchmark.
      await local.send('evm_mine', []);
      let receipt;
      try { receipt = await sent.wait(1, 30_000); }
      catch (error) {
        const [latestNonce, pendingNonce, transaction, rawReceipt, latestBlock] = await Promise.all([
          local.send('eth_getTransactionCount', [actor, 'latest']), local.send('eth_getTransactionCount', [actor, 'pending']),
          local.send('eth_getTransactionByHash', [sent.hash]), local.send('eth_getTransactionReceipt', [sent.hash]), local.getBlock('latest'),
        ]);
        t.diagnostic('LOCAL_PENDING_DIAGNOSTIC ' + JSON.stringify({ hash: sent.hash, nonce: sent.nonce,
          latestNonce, pendingNonce, transactionBlock: transaction?.blockNumber, receipt: rawReceipt,
          latestBlock: latestBlock?.number, baseFee: latestBlock?.baseFeePerGas?.toString(),
          blockGasLimit: latestBlock?.gasLimit?.toString(), anvilStderr: startupError,
          maxFee: sent.maxFeePerGas?.toString(), priorityFee: sent.maxPriorityFeePerGas?.toString() }));
        throw error;
      }
      assert.equal(receipt.status, 1);
      const logs = receipt.logs.filter(log => log.address.toLowerCase() === factory.target.toLowerCase())
        .map(log => factory.interface.parseLog(log));
      const result = logs.find(log => log.name === 'BatchResult');
      if (result.args.minted !== BigInt(indices.length)) {
        const helper = new Contract(children[indices[0]], artifact.contracts.GenesisMintChild.abi, local);
        try {
          await local.call({ from: factory.target, to: helper.target,
            data: helper.interface.encodeFunctionData('mint', [ROUTE, FEE, payloads[0]]), gasLimit: 1_000_000 });
        } catch (error) { t.diagnostic('LOCAL_CHILD_REVERT ' + JSON.stringify({ data: error.data ?? error.info?.error?.data })); }
        const trace = await local.send('debug_traceTransaction', [receipt.hash, { tracer: 'callTracer' }]);
        const failures = [];
        const walk = (call, depth = 0) => {
          if (call.error) failures.push({ depth, to: call.to, selector: call.input?.slice(0, 10),
            error: call.error, output: call.output?.slice(0, 138) });
          for (const childCall of call.calls ?? []) walk(childCall, depth + 1);
        };
        walk(trace); t.diagnostic('LOCAL_FORK_FAILURE ' + JSON.stringify({ failures, traceKeys: Object.keys(trace),
          gas: trace.gas, suspicious: trace.structLogs?.filter(step => step.error || ['INVALID', 'MCOPY', 'TLOAD', 'TSTORE'].includes(step.op))
            .map(step => ({ pc: step.pc, op: step.op, depth: step.depth, error: step.error })),
          tail: trace.structLogs?.slice(-10).map(step => ({ pc: step.pc, op: step.op, depth: step.depth, error: step.error })) }));
      }
      assert.equal(result.args.minted, BigInt(indices.length), JSON.stringify(logs.map(log => ({ name: log.name, args: log.args.toString() }))));
      assert.equal(result.args.attempted, BigInt(indices.length));
      cumulative += BigInt(indices.length);
      assert.equal((await nft.getMintStats(ZeroAddress))[1], stats[1] + cumulative);
      assert.equal(await nft.balanceOf(recipientAddress), initialBalance + cumulative);
      for (const log of logs.filter(log => log.name === 'ChildMinted')) {
        assert.equal((await nft.ownerOf(log.args.tokenId)).toLowerCase(), recipientAddress.toLowerCase());
        assert.equal((await nft.getMintStats(log.args.child))[0], 1n);
        assert.equal(await nft.balanceOf(log.args.child), 0n);
      }
      gas['public' + indices.length] = receipt.gasUsed.toString();
    }
    t.diagnostic('ACTUAL_GENESIS_LOCAL_FORK ' + JSON.stringify({ pinnedBlock: block.number, blockHash: block.hash,
      nftCodeHash: NFT_CODE_HASH, routeCodeHash: ROUTE_CODE_HASH, initialMinted: stats[1].toString(),
      simulatedTimestamp: timestamp, childCount: 11, committedMinted: cumulative.toString(), simulatedBatchMinted,
      batchSimulationStatus, gas,
      remoteTransactionsSent: 0, dependencyCodeOrStorageOverrides: false }));
  });
