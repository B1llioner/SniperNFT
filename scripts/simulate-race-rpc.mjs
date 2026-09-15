#!/usr/bin/env node
// Every race is one read-only eth_simulateV1 request. No signing or broadcast API exists here.
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Interface, ZeroAddress, getAddress, getCreateAddress, isHexString, keccak256, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, SEADROP_ABI, MintError } from '../mint.mjs';
import { loadArtifact, verifyFactoryCode } from '../batch.mjs';

const ENDPOINTS = {
  publicnode: 'https://robinhood-rpc.publicnode.com',
  official: 'https://rpc.mainnet.chain.robinhood.com',
};
const ALLOWED = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_simulateV1']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_GAS = 32_000_000n;
const BALANCE = 100_000_000_000_000_000n;
const SEA = new Interface(SEADROP_ABI);
const NFT = new Interface([
  'function getMintStats(address) view returns (uint256,uint256,uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);
const GAS_INFO = new Interface(['function getMaxTxGasLimit() view returns (uint256)']);
const CODE_HASHES = {
  nft: '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c',
  seaDrop: '0x53e4b9339cf624803c9a7d0195576cca5b917920813508d86b3eb93dcbabeb5c',
};
function casesFor(targetSupply) {
  const remaining = 1024n - targetSupply;
  check(remaining > 10n, 'These four cases require more than ten NFTs remaining.');
  return [
    { name: 'control', direct: 0n, competitor: 0n, expected: remaining },
    { name: 'ten-independent-minters', direct: 10n, competitor: 0n, expected: remaining - 10n },
    { name: `competitor-mints-${remaining - 6n}`, direct: 0n, competitor: remaining - 6n, expected: 6n },
    { name: `competitor-mints-${remaining}`, direct: 0n, competitor: remaining, expected: 0n },
  ];
}
const OUTPUT = new URL('../research/race-rpc-simulation.json', import.meta.url);
const HELP = `Read-only stateful mint race simulations on Robinhood Chain.
  node scripts/simulate-race-rpc.mjs [--rpc publicnode|official] [--target-supply N|latest] [--case NAME]

Defaults: PublicNode, all four cases. Each case makes one V1 request.
Target supply defaults to 910; use latest when current supply has passed 910.
Factory runtimes are virtual overrides with compiled immutables and nonce 1.
Helpers execute real CREATE/mint/transfer code inside the simulation. NFT and
SeaDrop code/storage are unchanged. Only synthetic accounts receive balances.
This does not simulate deployment of the factory, signing, or network ordering.
Writes research/race-rpc-simulation.json; no environment keys/config are read.`;

function check(value, message) { if (!value) throw new MintError(message); }
function json(value) { return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item); }
function print(value) { console.log(json(value)); }
function safeFailure(error) {
  return { message: error instanceof MintError ? error.message : 'Read-only RPC operation failed.',
    ...(Number.isInteger(error?.rpcCode) ? { code: error.rpcCode } : {}),
    ...(isHexString(error?.rpcData) && error.rpcData.length <= 4098 ? { data: error.rpcData } : {}) };
}
function parseArgs(argv) {
  const names = []; let selected; let targetSupply = 910n; let targetSet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    check(['--rpc', '--case', '--target-supply'].includes(argv[i]) && argv[i + 1], 'Unknown option or missing value.');
    const key = argv[i]; const value = argv[++i];
    if (key === '--rpc') { check(Object.hasOwn(ENDPOINTS, value), 'RPC must be publicnode or official.'); names.push(value); }
    else if (key === '--target-supply') {
      check(!targetSet && (value === 'latest' || /^(0|[1-9][0-9]{0,3})$/.test(value)), 'Invalid or duplicate target supply.');
      targetSet = true; targetSupply = value === 'latest' ? value : BigInt(value);
      check(targetSupply === 'latest' || targetSupply < 1014n, 'Target supply must leave more than ten NFTs.');
    } else { check(!selected, 'Duplicate case.'); selected = value; }
  }
  return { endpoints: names.length ? [...new Set(names)] : ['publicnode'], selected, targetSupply };
}
function transport(url) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 3 });
  let nextId = 0;
  return { destroy: () => agent.destroy(), async request(method, params) {
    check(ALLOWED.has(method), 'Only read and simulation methods are allowed.');
    const id = ++nextId;
    const body = json({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolveRequest, reject) => {
      let request; let response; let timer; let settled = false;
      function finish(error, result) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) { request?.destroy(); response?.destroy(); reject(error); } else resolveRequest(result);
      }
      timer = setTimeout(() => finish(new MintError('Read-only RPC request exceeded 60 seconds.')), 60000);
      request = https.request(url, { method: 'POST', agent, headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity',
      } }, incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) return finish(new MintError(`Read-only RPC returned HTTP ${incoming.statusCode}.`));
        if (Number(incoming.headers['content-length']) > MAX_BYTES) return finish(new MintError('RPC response exceeds 8 MiB.'));
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) finish(new MintError('RPC response exceeds 8 MiB.')); else chunks.push(chunk);
        });
        incoming.once('error', () => finish(new MintError('RPC response was interrupted.')));
        incoming.once('aborted', () => finish(new MintError('RPC response was interrupted.')));
        incoming.once('end', () => {
          if (settled) return;
          try {
            const raw = Buffer.concat(chunks); const value = JSON.parse(raw.toString('utf8'));
            check(value.id === id, 'RPC response ID does not match the request.');
            if (value.error) {
              const message = String(value.error.message ?? 'unspecified RPC error').slice(0, 500);
              const error = new MintError(`RPC rejected ${method}: ${message}`);
              error.rpcCode = value.error.code; error.rpcData = value.error.data;
              return finish(error);
            }
            check(Object.hasOwn(value, 'result'), 'RPC result is missing.');
            finish(null, { result: value.result, responseBytes: bytes, responseSha256: createHash('sha256').update(raw).digest('hex') });
          } catch (error) { finish(error instanceof MintError ? error : new MintError('RPC response is not valid JSON.')); }
        });
      });
      request.once('error', () => finish(new MintError('Read-only RPC connection failed.')));
      request.end(body);
    });
  } };
}
function makeActors(artifact) {
  const reserved = new Set([CONFIG.nftContract, CONFIG.seaDrop, CONFIG.feeRecipient, ZeroAddress].map(a => a.toLowerCase()));
  const address = () => {
    let value;
    do { value = getAddress(`0x${randomBytes(20).toString('hex')}`); } while (reserved.has(value.toLowerCase()));
    reserved.add(value.toLowerCase()); return value;
  };
  const observer = address();
  const factories = Object.fromEntries(['preparer', 'competitor', 'ours'].map(role => {
    const owner = address(); const factory = address();
    const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
    const word = Buffer.from(zeroPadValue(owner, 32).slice(2), 'hex');
    // Both immutables intentionally use the same synthetic EOA: owner === recipient.
    for (const group of Object.values(artifact.immutableReferences)) for (const { start, length } of group) {
      check(length === 32, 'Factory immutable width differs from the verified artifact.'); word.copy(runtime, start);
    }
    const code = `0x${runtime.toString('hex')}`; verifyFactoryCode(code, artifact);
    return [role, { owner, recipient: owner, factory, code, runtimeKeccak256: keccak256(code) }];
  }));
  return { observer, factories, directMinters: Array.from({ length: 10 }, address) };
}
function decodeEvents(logs, address, iface, name) {
  return logs.filter(log => log.address.toLowerCase() === address.toLowerCase()).flatMap(log => {
    try { const event = iface.parseLog(log); return event?.name === name ? [event] : []; } catch { return []; }
  });
}
function verifyFactoryMint(result, actor, count, supplyBefore, iface) {
  check(result.status === '0x1', 'A required factory mint reverted.');
  check(iface.decodeFunctionResult('mintBatch', result.returnData)[0] === count, 'Factory returned an unexpected count.');
  const batch = decodeEvents(result.logs, actor.factory, iface, 'BatchMinted');
  const tokens = decodeEvents(result.logs, actor.factory, iface, 'TokenMinted');
  const transfers = decodeEvents(result.logs, CONFIG.nftContract, NFT, 'Transfer');
  check(batch.length === 1 && batch[0].args.recipient === actor.owner && batch[0].args.count === count, 'BatchMinted does not confirm the requested recipient/count.');
  check(BigInt(tokens.length) === count && BigInt(transfers.length) === count * 2n, 'Mint/transfer event counts differ from the factory return.');
  for (let i = 0; i < tokens.length; i++) {
    const tokenId = supplyBefore + BigInt(i) + 1n;
    const helper = getCreateAddress({ from: actor.factory, nonce: i + 1 });
    check(tokens[i].args.helper === helper && tokens[i].args.recipient === actor.owner && tokens[i].args.tokenId === tokenId,
      'Helper CREATE address, NFT ID, or recipient differs from the expected factory nonce sequence.');
    const matching = transfers.filter(event => event.args.tokenId === tokenId);
    check(matching.length === 2 && matching[0].args.from === ZeroAddress && matching[0].args.to === helper
      && matching[1].args.from === helper && matching[1].args.to === actor.owner, 'NFT mint and transfer chain is incomplete.');
  }
  return { count, firstTokenId: supplyBefore + 1n, lastTokenId: supplyBefore + count,
    helperCount: tokens.length, nftTransferCount: transfers.length };
}
function buildCase(scenario, baseline, actors, iface) {
  const targetSupply = baseline.targetSupply;
  const nonce = new Map(); const expected = [];
  const call = (label, from, to, data, gas, assertion) => {
    const value = nonce.get(from) ?? 0n; nonce.set(from, value + 1n);
    const tx = { from, to, data, nonce: toQuantity(value), value: '0x0', gas: toQuantity(gas),
      maxFeePerGas: toQuantity(baseline.baseFee * 4n), maxPriorityFeePerGas: '0x0', chainId: '0x1237' };
    expected.push({ label, assertion }); return tx;
  };
  const read = (label, to, abi, method, args, assertion) => call(label, actors.observer, to, abi.encodeFunctionData(method, args), 150_000n, assertion);
  const blocks = []; const plans = [];
  const addBlock = (label, calls, overrides) => {
    check(calls.reduce((sum, tx) => sum + BigInt(tx.gas), 0n) <= MAX_GAS, 'Declared calls exceed the virtual block gas limit.');
    blocks.push({ blockOverrides: { time: toQuantity(baseline.time + BigInt(blocks.length)), gasLimit: toQuantity(MAX_GAS), baseFeePerGas: toQuantity(baseline.baseFee) },
      ...(overrides ? { stateOverrides: overrides } : {}), calls });
    plans.push({ label, calls });
  };
  const overrides = {};
  for (const owner of [actors.observer, ...Object.values(actors.factories).map(actor => actor.owner), ...actors.directMinters]) {
    overrides[owner] = { balance: toQuantity(BALANCE), nonce: '0x0', code: '0x', state: {} };
  }
  for (const actor of Object.values(actors.factories)) overrides[actor.factory] = { code: actor.code, nonce: '0x1', balance: '0x0', state: {} };
  const stats = (label, supply) => read(label, CONFIG.nftContract, NFT, 'getMintStats', [ZeroAddress], result => {
    const [, actual, maximum] = NFT.decodeFunctionResult('getMintStats', result.returnData);
    check(actual === supply && maximum === 1024n, `Supply assertion failed: ${label}.`);
    return { supply: actual, maxSupply: maximum };
  });
  const first = [stats('snapshot-supply', baseline.supply)];
  for (const [role, actor] of Object.entries(actors.factories)) for (const method of ['owner', 'recipient']) {
    first.push(read(`${role}-${method}`, actor.factory, iface, method, [], result => {
      const [value] = iface.decodeFunctionResult(method, result.returnData);
      check(value === actor.owner, 'Virtual factory immutable getter differs from its synthetic owner/recipient.'); return { value };
    }));
  }
  addBlock('install virtual factories and assert baseline', first, overrides);
  const prep = targetSupply - baseline.supply;
  if (prep > 0n) {
    const actor = actors.factories.preparer;
    const gas = 500_000n + prep * 280_000n;
    check(gas <= MAX_GAS, 'Preparing the requested supply exceeds this bounded simulation gas allowance.');
    addBlock('prepare supply with real helper mints', [call(`prepare-to-${targetSupply}`, actor.owner, actor.factory,
      iface.encodeFunctionData('mintBatch', [prep, prep]), gas,
      result => verifyFactoryMint(result, actor, prep, baseline.supply, iface)), stats('prepared-supply', targetSupply)]);
  }
  let consumed = 0n;
  if (scenario.direct) {
    const calls = actors.directMinters.map((owner, index) => call(`direct-competitor-${index + 1}`, owner, CONFIG.seaDrop,
      SEA.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n]), 250_000n, result => {
        const transfers = decodeEvents(result.logs, CONFIG.nftContract, NFT, 'Transfer');
        check(result.returnData === '0x' && transfers.length === 1 && transfers[0].args.from === ZeroAddress
          && transfers[0].args.to === owner && transfers[0].args.tokenId === targetSupply + BigInt(index) + 1n, 'Independent minter did not receive exactly its expected NFT.');
        return { tokenId: transfers[0].args.tokenId, recipient: owner };
      }));
    consumed = scenario.direct;
    calls.push(stats('after-independent-minters', targetSupply + consumed)); addBlock('ten distinct real SeaDrop public mints', calls);
  } else if (scenario.competitor) {
    const actor = actors.factories.competitor; consumed = scenario.competitor;
    addBlock('competitor consumes supply', [call('competitor-factory-mint', actor.owner, actor.factory,
      iface.encodeFunctionData('mintBatch', [consumed, consumed]), 31_000_000n,
      result => verifyFactoryMint(result, actor, consumed, targetSupply, iface)), stats('after-competitor', targetSupply + consumed)]);
  }
  const ours = actors.factories.ours;
  // Preserve the same stale gas allowance even after a competitor consumes supply.
  const ourGas = 31_000_000n;
  addBlock('our maximum request', [call('our-mint-1024-minimum-1', ours.owner, ours.factory,
    iface.encodeFunctionData('mintBatch', [1024n, 1n]), ourGas, result => {
      if (scenario.expected > 0n) return verifyFactoryMint(result, ours, scenario.expected, targetSupply + consumed, iface);
      check(result.status === '0x0', 'Sold-out mint unexpectedly succeeded.');
      const error = iface.parseError(result.returnData && result.returnData !== '0x' ? result.returnData : result.error?.data);
      check(error?.name === 'InsufficientSupply' && error.args.remaining === 0n && error.args.minimum === 1n, 'Sold-out call did not report InsufficientSupply(0,1).');
      check(BigInt(result.gasUsed) < 150_000n && (result.logs?.length ?? 0) === 0, 'Sold-out mint did not revert before helper creation.');
      return { expectedRevert: 'InsufficientSupply(0,1)', earlyRevert: true };
    })]);
  const final = [stats('final-supply', 1024n), read('our-final-balance', CONFIG.nftContract, NFT, 'balanceOf', [ours.owner], result => {
    const [value] = NFT.decodeFunctionResult('balanceOf', result.returnData);
    check(value === scenario.expected, 'Final recipient balance differs from the expected mint count.'); return { balance: value };
  })];
  if (scenario.expected > 0n) for (const tokenId of [targetSupply + consumed + 1n, 1024n]) {
    final.push(read(`final-owner-${tokenId}`, CONFIG.nftContract, NFT, 'ownerOf', [tokenId], result => {
      const [owner] = NFT.decodeFunctionResult('ownerOf', result.returnData);
      check(owner === ours.owner, 'Final ownerOf does not match our recipient.'); return { tokenId, owner };
    }));
  }
  addBlock('assert final NFT state inside the same simulation', final);
  check(baseline.time + BigInt(blocks.length) <= baseline.endTime, 'The virtual blocks do not fit in the public mint window.');
  return { payload: { blockStateCalls: blocks, validation: true, returnFullTransactions: false }, plans, expected };
}
async function inspect(client, actors, evidence, requestedTarget) {
  const get = async (method, params) => (await client.request(method, params)).result;
  const chainId = await get('eth_chainId', []); check(BigInt(chainId) === CONFIG.chainId, 'Wrong RPC chain.');
  const head = await get('eth_getBlockByNumber', ['latest', false]);
  const [nftCode, seaCode, dropData, statsData, capData] = await Promise.all([
    get('eth_getCode', [CONFIG.nftContract, 'latest']), get('eth_getCode', [CONFIG.seaDrop, 'latest']),
    get('eth_call', [{ to: CONFIG.seaDrop, data: SEA.encodeFunctionData('getPublicDrop', [CONFIG.nftContract]) }, 'latest']),
    get('eth_call', [{ to: CONFIG.nftContract, data: NFT.encodeFunctionData('getMintStats', [ZeroAddress]) }, 'latest']),
    get('eth_call', [{ to: '0x000000000000000000000000000000000000006c', data: GAS_INFO.encodeFunctionData('getMaxTxGasLimit') }, 'latest']),
  ]);
  check(keccak256(nftCode) === CODE_HASHES.nft && keccak256(seaCode) === CODE_HASHES.seaDrop, 'Dependency runtime differs from the researched snapshot.');
  const [, supply, maximum] = NFT.decodeFunctionResult('getMintStats', statsData);
  const targetSupply = requestedTarget === 'latest' ? supply : requestedTarget;
  evidence.observedSnapshot = { blockNumber: head.number, blockHash: head.hash, timestamp: head.timestamp, supply, maxSupply: maximum };
  check(maximum === 1024n && supply <= targetSupply, `This bounded race requires supply at most ${targetSupply} of 1024; observed ${supply} of ${maximum}.`);
  const [drop] = SEA.decodeFunctionResult('getPublicDrop', dropData);
  const [maxTxGas] = GAS_INFO.decodeFunctionResult('getMaxTxGasLimit', capData);
  check(maxTxGas >= MAX_GAS, 'The live transaction gas cap is below the 32-million simulation bound.');
  check(drop.mintPrice === 0n && drop.maxTotalMintableByWallet > 0n, 'Free public minting is disabled.');
  const headTime = BigInt(head.timestamp);
  const time = drop.startTime + 1n > headTime ? drop.startTime + 1n : headTime + 1n;
  check(time < drop.endTime, 'The public mint stage cannot be simulated at a future active timestamp.');
  const baseFee = BigInt(head.baseFeePerGas); check(baseFee > 0n, 'A positive reference base fee is required.');
  // Random virtual addresses must not replace a pre-existing deployed contract.
  for (const address of [actors.observer, ...Object.values(actors.factories).flatMap(a => [a.owner, a.factory]), ...actors.directMinters]) {
    check(await get('eth_getCode', [address, 'latest']) === '0x', 'A synthetic address unexpectedly has deployed code.');
  }
  return { supply, maximum, targetSupply, time, endTime: drop.endTime, baseFee, maxTxGas,
    head: { number: head.number, hash: head.hash, timestamp: head.timestamp, baseFeePerGas: head.baseFeePerGas },
    publicDrop: { mintPrice: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxTotalMintableByWallet: drop.maxTotalMintableByWallet },
    dependencyRuntimeHashes: CODE_HASHES };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); if (options.help) { console.log(HELP); return; }
  const artifact = await loadArtifact(); const iface = new Interface(artifact.abi); const actors = makeActors(artifact);
  let historicalCapability;
  try { historicalCapability = JSON.parse(await readFile(OUTPUT, 'utf8')).historicalCapability; }
  catch { /* There may be no earlier diagnostic report. */ }
  const report = { kind: 'single-request-stateful-eth-simulate-v1-mint-races', recordedAt: new Date().toISOString(),
    chainId: CONFIG.chainId, mainnetBroadcast: false, privateKeysRead: false, transactionsSigned: false,
    artifactSourceSha256: artifact.sourceSha256, compiler: artifact.compiler, observer: actors.observer,
    actors: { factories: Object.fromEntries(Object.entries(actors.factories).map(([role, { code, ...actor }]) => [role, actor])), directMinters: actors.directMinters },
    assumptions: { initialEoaBalanceWei: BALANCE, initialEoaNonce: 0, virtualFactoryNonce: 1, targetSupply: options.targetSupply,
      maxTransactionGas: MAX_GAS, maxVirtualBlockGas: MAX_GAS, maxResponseBytes: MAX_BYTES, timeoutMs: 60000 },
    scope: 'Virtual factory runtime with verified compiled owner/recipient immutables and nonce 1; factory CREATE deployment is not simulated. Factory helpers execute real CREATE, SeaDrop mintPublic and NFT safeTransferFrom inside one V1 request per case. Original NFT/SeaDrop/dependency code and storage are not overridden.',
    limitations: ['Virtual ordering is deliberately selected, not a prediction of sequencer order.',
      'The simulation starts at latest and checks the observed starting supply inside the same call sequence. Head/read values can change before the request.',
      'Positive base fee is frozen from the observed head and explicit maxFee is 4 times that value. This is not a future fee forecast.',
      'RPC whole-simulation gas limits may differ from transaction or per-block caps; rejected cases are recorded as failures.',
      'No separate eth_call is used to verify simulated post-state; all post-state assertions are calls within the same V1 request.'],
    ...(historicalCapability ? { historicalCapability } : {}), endpoints: [] };
  for (const name of options.endpoints) {
    const client = transport(ENDPOINTS[name]); const endpoint = { name, url: ENDPOINTS[name], cases: [] }; report.endpoints.push(endpoint);
    try {
      print({ endpoint: name, phase: 'inspect live state and virtual addresses' });
      const baseline = await inspect(client, actors, endpoint, options.targetSupply); endpoint.baseline = baseline;
      const scenarios = casesFor(baseline.targetSupply).filter(scenario => !options.selected || scenario.name === options.selected);
      check(scenarios.length > 0, 'The selected case does not exist for this target supply.');
      for (const scenario of scenarios) {
        const evidence = { name: scenario.name, expectedOurCount: scenario.expected, status: 'pending' }; endpoint.cases.push(evidence);
        try {
          const built = buildCase(scenario, baseline, actors, iface);
          evidence.plan = built.plans.map((plan, index) => ({ ...plan, blockOverrides: built.payload.blockStateCalls[index].blockOverrides }));
          evidence.requestSha256 = createHash('sha256').update(json([built.payload, 'latest'])).digest('hex');
          print({ endpoint: name, case: scenario.name, phase: 'one eth_simulateV1 request', virtualBlocks: built.plans.length });
          const begin = Date.now(); const response = await client.request('eth_simulateV1', [built.payload, 'latest']);
          evidence.elapsedMs = Date.now() - begin; evidence.responseBytes = response.responseBytes; evidence.responseSha256 = response.responseSha256;
          check(Array.isArray(response.result) && response.result.length === built.plans.length, 'Unexpected virtual block count.');
          const results = response.result.flatMap(block => block.calls);
          check(results.length === built.expected.length, 'Unexpected simulated call count.');
          evidence.calls = [];
          for (let index = 0; index < results.length; index++) {
            const result = results[index]; const expectation = built.expected[index];
            const record = { label: expectation.label, status: result.status, gasUsed: result.gasUsed,
              returnData: result.returnData, logCount: result.logs?.length ?? 0, ...(result.error ? { error: result.error } : {}) };
            evidence.calls.push(record);
            if (expectation.label !== 'our-mint-1024-minimum-1' || scenario.expected > 0n) check(result.status === '0x1', `Required call reverted: ${expectation.label}.`);
            record.assertion = expectation.assertion(result);
          }
          evidence.blocks = response.result.map(block => ({ number: block.number, timestamp: block.timestamp, gasUsed: block.gasUsed, baseFeePerGas: block.baseFeePerGas }));
          evidence.status = 'passed';
        } catch (error) { evidence.status = 'failed'; evidence.failure = safeFailure(error); }
        print({ endpoint: name, case: scenario.name, status: evidence.status,
          ourCall: evidence.calls?.find(call => call.label === 'our-mint-1024-minimum-1'), failure: evidence.failure });
      }
      const requests = endpoint.cases.map(scenario => scenario.plan?.flatMap(block => block.calls)
        .find(tx => tx.from === actors.factories.ours.owner && tx.to === actors.factories.ours.factory));
      endpoint.identicalOurTransactionRequest = requests.every(tx => tx != null && json(tx) === json(requests[0]));
      check(endpoint.identicalOurTransactionRequest, 'Our calldata, sender, nonce, fees or gas allowance changed between cases.');
      endpoint.factoryCodeAfter = (await client.request('eth_getCode', [actors.factories.ours.factory, 'latest'])).result;
      check(endpoint.factoryCodeAfter === '0x', 'Virtual factory code unexpectedly persisted on chain.');
    } catch (error) { endpoint.failure = safeFailure(error); print({ endpoint: name, failure: endpoint.failure, snapshot: endpoint.observedSnapshot }); }
    finally { client.destroy(); }
  }
  report.success = report.endpoints.some(endpoint => !endpoint.failure && endpoint.cases.length === (options.selected ? 1 : 4)
    && endpoint.cases.every(scenario => scenario.status === 'passed'));
  await writeFile(OUTPUT, `${JSON.stringify(JSON.parse(json(report)), null, 2)}\n`);
  print({ success: report.success, evidence: 'research/race-rpc-simulation.json' });
  if (!report.success) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(json(safeFailure(error))); process.exitCode = 1; });
}
