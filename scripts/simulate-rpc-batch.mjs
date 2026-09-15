#!/usr/bin/env node
// Read-only proof of the factory route, including when --quantity is 1.
// State and block overrides exist only inside eth_call; nothing is deployed.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Interface, ZeroAddress, getAddress, isHexString, keccak256, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, SEADROP_ABI, MintError, createProvider, parseUint } from '../mint.mjs';
import { loadArtifact, safeBatchError, verifyFactoryCode } from '../batch.mjs';

const DEFAULT_RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
const READ_METHODS = new Set(['eth_call', 'eth_getCode', 'eth_chainId', 'eth_getBlockByNumber']);
const NFT_CODE_HASH = '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c';
const OUTPUT = new URL('../research/batch-state-override.json', import.meta.url);
const GAS = toQuantity(12_000_000n);
const SEA = new Interface(SEADROP_ABI);
const NFT = new Interface(['function getMintStats(address) view returns (uint256,uint256,uint256)']);
const HELP = `Read-only full factory-route simulation on Robinhood Chain.
  node scripts/simulate-rpc-batch.mjs [--quantity 10] [--rpc HTTPS_URL ...]

--quantity N  Exact factory mint count, 1-1024; default 10.
--rpc URL     Repeat for up to 8 RPCs; defaults to the two public endpoints.
--help        Show this help without making network requests.

Always invokes the factory's mintBatch(N,N), including for N=1.
Injects the compiled factory runtime at a random address with empty on-chain
code, assigns synthetic owner/recipient, and overrides block time to public
startTime + 1. NFT, SeaDrop, registry and hook code/storage are unchanged.
Gas is capped at 12 million; large counts may exceed gas or remaining supply.
No keys are generated or read. No transactions are signed or broadcast.
Writes research/batch-state-override.json. A successful simulation does not
establish that the public stage is currently active or guarantee inclusion.`;

function check(condition, message) { if (!condition) throw new MintError(message); }
function parseArgs(argv) {
  let quantity = 10n;
  let quantitySet = false;
  const rpcUrls = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    check((arg === '--quantity' || arg === '--rpc') && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown option or missing value; see --help.');
    if (arg === '--quantity') {
      check(!quantitySet, '--quantity may be specified only once.');
      quantity = parseUint(argv[++i], 'quantity');
      quantitySet = true;
      check(quantity >= 1n && quantity <= 1024n, 'quantity must be between 1 and 1024.');
    } else rpcUrls.push(argv[++i]);
  }
  check(rpcUrls.length <= 8, 'Specify at most 8 RPC endpoints.');
  return { quantity, rpcUrls: rpcUrls.length ? [...new Set(rpcUrls)] : DEFAULT_RPCS };
}
function syntheticAddress() {
  let address;
  do { address = getAddress(`0x${randomBytes(20).toString('hex')}`); } while (address === ZeroAddress);
  return address;
}
function safeRpcFailure(error) {
  const result = { message: safeBatchError(error) };
  // Preserve only bounded revert bytes; provider messages may contain RPC URL credentials.
  const data = [error?.data, error?.error?.data, error?.info?.error?.data]
    .find(value => typeof value === 'string' && value.length <= 8194 && isHexString(value));
  if (data) result.data = data;
  return result;
}
async function rpc(provider, method, params) {
  check(READ_METHODS.has(method), 'The simulation permits read-only RPC methods only.');
  try { return { result: await provider.send(method, params) }; }
  catch (error) { return { error: safeRpcFailure(error) }; }
}

async function simulateEndpoint(url, index, context) {
  const { artifact, iface, factory, synthetic, code, quantity } = context;
  const evidence = { index };
  let provider;
  try {
    provider = createProvider(url);
    // Do not persist path/query values: an explicitly supplied RPC may contain API credentials.
    evidence.endpointOrigin = new URL(url).origin;
    console.log(JSON.stringify({ endpoint: index, phase: 'checking chain, code and public drop' }));
    const queries = [
      ['chainId', 'eth_chainId', []],
      ['block', 'eth_getBlockByNumber', ['latest', false]],
      ['factoryCode', 'eth_getCode', [factory, 'latest']],
      ['senderCode', 'eth_getCode', [synthetic, 'latest']],
      ['nftCode', 'eth_getCode', [CONFIG.nftContract, 'latest']],
      ['publicDrop', 'eth_call', [{ to: CONFIG.seaDrop, data: SEA.encodeFunctionData('getPublicDrop', [CONFIG.nftContract]) }, 'latest']],
      ['mintStats', 'eth_call', [{ to: CONFIG.nftContract, data: NFT.encodeFunctionData('getMintStats', [ZeroAddress]) }, 'latest']],
    ];
    const settled = await Promise.allSettled(queries.map(async ([name, method, params]) => [name, await rpc(provider, method, params)]));
    const baseline = Object.fromEntries(settled.map((entry, i) => entry.status === 'fulfilled'
      ? entry.value : [queries[i][0], { error: safeRpcFailure(entry.reason) }]));
    evidence.chainIdResponse = baseline.chainId;
    evidence.factoryCodeBefore = baseline.factoryCode;
    evidence.syntheticSenderCode = baseline.senderCode;
    evidence.publicDropResponse = baseline.publicDrop;
    evidence.mintStatsResponse = baseline.mintStats;
    const block = baseline.block.result;
    if (block) evidence.latestBlock = { number: block.number, hash: block.hash, timestamp: block.timestamp };
    else evidence.blockError = baseline.block.error;
    const nftCode = baseline.nftCode.result;
    if (isHexString(nftCode)) evidence.nftRuntimeKeccak256 = keccak256(nftCode);
    else evidence.nftCodeError = baseline.nftCode.error;
    check(baseline.chainId.result && parseUint(baseline.chainId.result) === CONFIG.chainId, 'RPC chain ID was not verified as 4663.');
    check(baseline.factoryCode.result === '0x', 'Synthetic factory address must have empty on-chain code.');
    check(baseline.senderCode.result === '0x', 'Synthetic owner/recipient must have empty on-chain code.');
    check(evidence.nftRuntimeKeccak256 === NFT_CODE_HASH, 'NFT runtime differs from the researched contract.');
    check(baseline.publicDrop.result && block?.number && block?.timestamp, 'Current public drop or latest block was unavailable.');
    const [drop] = SEA.decodeFunctionResult('getPublicDrop', baseline.publicDrop.result);
    evidence.publicDrop = { mintPrice: String(drop.mintPrice), startTime: String(drop.startTime), endTime: String(drop.endTime), maxTotalMintableByWallet: String(drop.maxTotalMintableByWallet) };
    check(drop.mintPrice === 0n && drop.maxTotalMintableByWallet > 0n && drop.startTime + 1n <= drop.endTime, 'Current public drop does not permit this free-mint simulation.');

    const stateOverrides = { [factory]: { code, state: {} } };
    const blockOverrides = { time: toQuantity(drop.startTime + 1n) };
    const call = { from: synthetic, to: factory, value: '0x0', gas: GAS, gasPrice: '0x0', data: iface.encodeFunctionData('mintBatch', [quantity, quantity]) };
    evidence.blockOverrides = blockOverrides;
    evidence.call = call;
    evidence.fullMintResponse = await rpc(provider, 'eth_call', [call, 'latest', stateOverrides, blockOverrides]);
    if (evidence.fullMintResponse.result) {
      const [count] = iface.decodeFunctionResult('mintBatch', evidence.fullMintResponse.result);
      evidence.decodedMintCount = String(count);
      evidence.status = count === quantity ? 'success' : 'unexpected-count';
    } else {
      evidence.status = 'full-call-unavailable-or-reverted';
      // Distinguish basic state override support from unsupported block overrides.
      evidence.stateOverrideControl = await rpc(provider, 'eth_call', [
        { from: synthetic, to: factory, data: iface.encodeFunctionData('owner') }, 'latest', stateOverrides,
      ]);
      if (evidence.stateOverrideControl.result) evidence.stateOverrideControlOwner = iface.decodeFunctionResult('owner', evidence.stateOverrideControl.result)[0];
    }
    evidence.factoryCodeAfter = await rpc(provider, 'eth_getCode', [factory, 'latest']);
    check(evidence.factoryCodeAfter.result === '0x', 'Could not confirm empty factory code after the read-only call.');
  } catch (error) {
    evidence.status = 'unavailable';
    evidence.failure = safeRpcFailure(error);
  } finally { provider?.destroy(); }
  console.log(JSON.stringify({ endpoint: index, status: evidence.status, decodedMintCount: evidence.decodedMintCount }));
  return evidence;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  // Validates the pinned compiler/settings and source SHA256 against the artifact.
  const artifact = await loadArtifact();
  const iface = new Interface(artifact.abi);
  const synthetic = syntheticAddress();
  let factory;
  do { factory = syntheticAddress(); } while (factory === synthetic);
  const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const word = Buffer.from(zeroPadValue(synthetic, 32).slice(2), 'hex');
  for (const group of Object.values(artifact.immutableReferences)) {
    for (const { start, length } of group) {
      check(length === 32, 'Unexpected immutable width.');
      word.copy(runtime, start);
    }
  }
  const code = `0x${runtime.toString('hex')}`;
  verifyFactoryCode(code, artifact);
  const report = {
    kind: 'public-rpc-read-only-eth-call-state-and-block-overrides', liveBroadcast: false,
    recordedAt: new Date().toISOString(), methodsAllowed: [...READ_METHODS],
    factory, syntheticOwnerAndRecipient: synthetic, noPrivateKeyGeneratedOrUsed: true,
    artifactSourceSha256: artifact.sourceSha256, compiler: artifact.compiler,
    runtimeKeccak256: keccak256(code), originalRuntimeKeccak256: keccak256(artifact.deployedBytecode),
    method: 'mintBatch(uint256,uint256)', arguments: [String(options.quantity), String(options.quantity)],
    documentation: ['https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth_call', 'https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#block-overrides'],
    overrideScope: 'Only synthetic factory code and state:{} are overridden. Both immutable groups receive the synthetic owner/recipient. Block time is publicDrop.startTime + 1 for this eth_call only. Original dependency code/storage is unchanged.',
    limitations: 'Always tests the factory route, even for quantity 1. Uses latest state with temporary block time, a 12-million gas cap and gasPrice 0. It does not simulate deployment, fees or transaction inclusion. No account nonce override is applied.',
    endpoints: [],
  };
  for (const [index, url] of options.rpcUrls.entries()) {
    report.endpoints.push(await simulateEndpoint(url, index, { artifact, iface, factory, synthetic, code, quantity: options.quantity }));
  }
  report.success = report.endpoints.some(endpoint => endpoint.status === 'success');
  report.conclusion = report.success
    ? 'Complete factory runtime returned the requested mint count with original dependency code/storage in read-only eth_call.'
    : 'No endpoint produced a verified successful full factory call; consult endpoint failures.';
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ success: report.success, evidence: 'research/batch-state-override.json' }));
  if (!report.success) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Error: ${safeBatchError(error)}`); process.exitCode = 1; });
}
