#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Interface, Wallet, ZeroAddress, getAddress, getCreateAddress, isHexString, keccak256, parseEther, formatEther } from 'ethers';
import { CONFIG, MintError, NFT_ABI, SEADROP_ABI, createProvider, safeError, parseUint } from './mint.mjs';
import { broadcastIdentical, BroadcastError } from './lib/broadcast.mjs';
import { waitForPublicStage } from './lib/warm.mjs';
import { SEQUENCER_URL, openSequencer } from './lib/sequencer.mjs';

const NFT_CODE_HASH = '0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c';
const CONFIG_KEYS = new Set(['quantity', 'minQuantity', 'recipient', 'factory', 'rpcUrls', 'concurrency', 'attempts', 'retryDelayMs', 'maxGasCostEth', 'receiptTimeoutSeconds', 'maxFeeMultiplier', 'waitTimeoutSeconds', 'pollIntervalMs', 'keepAliveIntervalMs', 'sequencer', 'sequencerUrl', 'waitUntilTimestamp', 'waitUntilBlock']);
const SEA_READ = new Interface(SEADROP_ABI);
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';
const ARB_GAS_ABI = new Interface(['function getMaxTxGasLimit() view returns (uint256)']);
const PREPARED = new WeakMap();
const DIRECT_SEADROP = new Interface([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'event SeaDropMint(address indexed nftContract,address indexed minter,address indexed feeRecipient,address payer,uint256 quantityMinted,uint256 unitMintPrice,uint256 feeBps,uint256 dropStageIndex)',
]);
const DIRECT_NFT = new Interface(NFT_ABI);
const ERROR_ABI = new Interface([
  'error WrongChain(uint256 chainId)', 'error NotOwner()', 'error Reentrancy()', 'error InvalidCount()',
  'error PaidMint(uint256 mintPrice)', 'error InactiveStage(uint256 timestamp,uint256 startTime,uint256 endTime)',
  'error WalletMintDisabled()', 'error InsufficientSupply(uint256 remaining,uint256 minimum)',
  'error UnexpectedMint(uint256 totalMinted,uint256 expectedTokenId)', 'error UnexpectedTokenOwner(uint256 tokenId)',
]);
function check(condition, message) { if (!condition) throw new MintError(message); }
function validateConfig(config) {
  check(config && typeof config === 'object' && !Array.isArray(config), 'Config must be a JSON object.');
  check(Object.keys(config).every(key => CONFIG_KEYS.has(key)), 'Config contains an unknown field.');
  return config;
}
function address(value, label) {
  let result;
  try { result = getAddress(value); } catch { throw new MintError(`${label}: invalid address.`); }
  check(result !== ZeroAddress, `${label}: zero address is not allowed.`);
  return result;
}
function print(value) { console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)); }
async function readBounded(path, limit = 65536) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= limit, 'Input must be a regular file within its size limit.');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= limit, 'Input file exceeds its size limit.');
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError('Cannot read the requested local file.');
  } finally { if (handle) await handle.close(); }
}
async function readJson(path, limit) {
  const bytes = await readBounded(path, limit);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new MintError('Invalid JSON file.'); }
}
export async function readBatchConfig(path) {
  return validateConfig(path ? await readJson(resolve(path)) : {});
}
export function parseBatchArgs(argv) {
  const args = [...argv];
  const result = {};
  if (args[0] && !args[0].startsWith('--')) result.command = args.shift();
  const flags = new Set(['help', 'send', 'wait', 'sequencer']);
  const values = new Set(['config', 'from', 'recipient', 'factory', 'rpc', 'quantity', 'min-quantity',
    'max-count', 'min-count', 'max-gas-cost-eth', 'receipt-timeout', 'concurrency', 'attempts', 'retry-delay-ms',
    'max-fee-multiplier', 'wait-timeout', 'poll-interval-ms', 'keep-alive-interval-ms',
    'sequencer-url', 'wait-until-timestamp', 'wait-until-block']);
  for (let i = 0; i < args.length; i++) {
    check(args[i].startsWith('--'), 'Use named options; see --help.');
    const key = args[i].slice(2);
    check(!(key in result), 'Duplicate CLI option.');
    if (flags.has(key)) result[key] = true;
    else {
      check(values.has(key) && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown option or missing value; see --help.');
      result[key] = args[++i];
    }
  }
  if (result.help) return result;
  check(['deploy', 'mint'].includes(result.command), 'Choose deploy or mint; see --help.');
  check(!(result.quantity && result['max-count']) && !(result['min-quantity'] && result['min-count']), 'Use one spelling for each quantity option.');
  check(result.command !== 'deploy' || !result.factory, 'The factory CLI option applies only to mint.');
  check(!result.wait || result.command === 'mint', '--wait applies only to mint.');
  return result;
}
export function resolveBatchOptions(args, config = {}, from) {
  validateConfig(config);
  const bounded = (value, min, max, name) => {
    const n = parseUint(value, name);
    check(n >= BigInt(min) && n <= BigInt(max), `${name} is outside the supported range.`);
    return Number(n);
  };
  const quantity = bounded(args.quantity ?? args['max-count'] ?? config.quantity ?? 10, 1, 1024, 'quantity');
  const minQuantity = bounded(args['min-quantity'] ?? args['min-count'] ?? config.minQuantity ?? 1, 1, quantity, 'minQuantity');
  const gasCost = args['max-gas-cost-eth'] ?? config.maxGasCostEth ?? '0.003';
  check(typeof gasCost === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(gasCost), 'maxGasCostEth must be a non-negative ETH amount string.');
  const rpcUrls = args.rpc ? [args.rpc] : config.rpcUrls ?? [process.env.RPC_URL ?? CONFIG.rpc];
  check(Array.isArray(rpcUrls) && rpcUrls.length >= 1 && rpcUrls.length <= 8 && rpcUrls.every(url => typeof url === 'string'), 'rpcUrls must contain between 1 and 8 URL strings.');
  check(config.sequencer == null || typeof config.sequencer === 'boolean', 'sequencer must be a boolean.');
  const sequencerUrl = args['sequencer-url'] ?? config.sequencerUrl;
  check(sequencerUrl == null || (typeof sequencerUrl === 'string' && sequencerUrl.length > 0), 'sequencerUrl must be a URL string.');
  check(config.sequencer !== false || sequencerUrl == null || args.sequencer || args['sequencer-url'], 'sequencerUrl conflicts with sequencer: false.');
  const sequencer = Boolean(args.sequencer || args['sequencer-url'] || config.sequencer || sequencerUrl);
  const optionalUint = (value, name) => value == null ? undefined : parseUint(value, name);
  const sender = address(from ?? args.from, 'from');
  const recipient = address(args.recipient ?? config.recipient ?? sender, 'recipient');
  const route = args.command === 'deploy' ? 'deploy' : quantity === 1 ? 'direct' : 'batch';
  check(route !== 'direct' || recipient === sender, 'Direct public mint requires recipient to match the sending wallet.');
  return { command: args.command, route, from: sender, recipient,
    factory: route === 'batch' ? address(args.factory ?? config.factory, 'factory') : undefined,
    quantity: BigInt(quantity), minQuantity: BigInt(minQuantity), rpcUrls: [...new Set(rpcUrls)],
    sequencer, sequencerUrl: sequencer ? sequencerUrl ?? SEQUENCER_URL : undefined,
    targetTimestamp: optionalUint(args['wait-until-timestamp'] ?? config.waitUntilTimestamp, 'waitUntilTimestamp'),
    targetBlock: optionalUint(args['wait-until-block'] ?? config.waitUntilBlock, 'waitUntilBlock'),
    maxGasCost: parseUint(parseEther(gasCost), 'maxGasCostEth'),
    receiptTimeoutSeconds: bounded(args['receipt-timeout'] ?? config.receiptTimeoutSeconds ?? 120, 1, 600, 'receiptTimeoutSeconds'),
    concurrency: bounded(args.concurrency ?? config.concurrency ?? 2, 1, 8, 'concurrency'),
    attempts: bounded(args.attempts ?? config.attempts ?? 2, 1, 5, 'attempts'),
    retryDelayMs: bounded(args['retry-delay-ms'] ?? config.retryDelayMs ?? 250, 0, 5000, 'retryDelayMs'),
    maxFeeMultiplier: bounded(args['max-fee-multiplier'] ?? config.maxFeeMultiplier ?? 2, 1, 20, 'maxFeeMultiplier'),
    waitTimeoutSeconds: bounded(args['wait-timeout'] ?? config.waitTimeoutSeconds ?? 21600, 1, 86400, 'waitTimeoutSeconds'),
    pollIntervalMs: bounded(args['poll-interval-ms'] ?? config.pollIntervalMs ?? 250, 100, 10000, 'pollIntervalMs'),
    keepAliveIntervalMs: bounded(args['keep-alive-interval-ms'] ?? config.keepAliveIntervalMs ?? 10000, 1000, 60000, 'keepAliveIntervalMs'),
  };
}
export async function loadArtifact() {
  const artifact = await readJson(new URL('./artifacts/RareFriendsBatchMinter.json', import.meta.url), 1024 * 1024);
  const source = await readBounded(new URL('./contracts/RareFriendsBatchMinter.sol', import.meta.url), 256 * 1024);
  check(artifact?.contractName === 'RareFriendsBatchMinter' && artifact.compiler === '0.8.26+commit.8a97fa7a.Emscripten.clang' && artifact.settings?.evmVersion === 'shanghai', 'Unexpected factory artifact/compiler settings.');
  check(createHash('sha256').update(source).digest('hex') === artifact.sourceSha256, 'Factory source differs from the compiled artifact; rebuild it first.');
  check(isHexString(artifact.bytecode) && artifact.bytecode.length > 2 && isHexString(artifact.deployedBytecode) && artifact.deployedBytecode.length > 2, 'Factory artifact contains invalid bytecode.');
  check(Array.isArray(artifact.abi), 'Factory ABI is missing.');
  verifyFactoryCode(artifact.deployedBytecode, artifact);
  return artifact;
}
export function verifyFactoryCode(code, artifact) {
  check(isHexString(code) && code.length === artifact.deployedBytecode.length, 'Factory runtime does not match the compiled artifact.');
  const actual = Buffer.from(code.slice(2), 'hex');
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const groups = Object.values(artifact.immutableReferences ?? {});
  check(groups.length === 2, 'Artifact must provide owner and recipient immutable references.');
  const occupied = new Set();
  for (const group of groups) {
    check(Array.isArray(group) && group.length > 0, 'Invalid immutable references in artifact.');
    let first;
    for (const { start, length } of group) {
      check(Number.isSafeInteger(start) && start >= 0 && length === 32 && start + length <= actual.length, 'Invalid immutable offset in artifact.');
      const value = actual.subarray(start, start + length).toString('hex');
      check(first == null || first === value, 'Factory contains inconsistent immutable values.');
      first = value;
      for (let i = start; i < start + length; i++) {
        check(!occupied.has(i), 'Overlapping immutable references in artifact.');
        occupied.add(i); actual[i] = 0; expected[i] = 0;
      }
    }
  }
  check(actual.equals(expected), 'Factory runtime does not match the compiled artifact.');
  return true;
}
async function readFactory(provider, factory, iface, method, tag) {
  const data = await provider.send('eth_call', [{ to: factory, data: iface.encodeFunctionData(method) }, tag]);
  return iface.decodeFunctionResult(method, data)[0];
}
export async function prepareBatch(provider, artifact, options) {
  const direct = options.command === 'mint' && options.quantity === 1n;
  check(!direct || options.recipient === options.from, 'Direct public mint requires recipient to match the sending wallet.');
  check(parseUint(await provider.send('eth_chainId', [])) === CONFIG.chainId, 'RPC is connected to the wrong chain.');
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  check(block?.number && block?.gasLimit, 'RPC did not return a complete latest block.');
  // Public RPCs may not expose historical state, even for a recently observed
  // head. Each call evaluates current state; block is the head observed above.
  const tag = 'latest';
  const [nftCode, seaCode] = await Promise.all([CONFIG.nftContract, CONFIG.seaDrop].map(a => provider.send('eth_getCode', [a, tag])));
  check(isHexString(nftCode) && keccak256(nftCode) === NFT_CODE_HASH, 'NFT runtime differs from the researched contract.');
  check(isHexString(seaCode) && seaCode !== '0x' && !/^0x0*$/.test(seaCode), 'SeaDrop runtime is missing.');
  const iface = direct ? null : new Interface(artifact.abi);
  let tx;
  if (direct) {
    tx = { from: options.from, to: CONFIG.seaDrop, value: '0x0',
      data: DIRECT_SEADROP.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n]) };
  } else if (options.command === 'deploy') {
    tx = { from: options.from, value: '0x0', data: artifact.bytecode + iface.encodeDeploy([options.recipient]).slice(2) };
  } else {
    const code = await provider.send('eth_getCode', [options.factory, tag]);
    verifyFactoryCode(code, artifact);
    const [owner, recipient] = await Promise.all(['owner', 'recipient'].map(method => readFactory(provider, options.factory, iface, method, tag)));
    check(owner === options.from, 'Selected wallet does not own this factory.');
    check(recipient === options.recipient, 'Factory recipient differs from the selected recipient.');
    tx = { from: options.from, to: options.factory, value: '0x0', data: iface.encodeFunctionData('mintBatch', [options.quantity, options.minQuantity]) };
  }
  const prepared = Object.freeze({ tx: Object.freeze(tx), block });
  PREPARED.set(prepared, { provider, key: preparationKey(options, artifact) });
  return prepared;
}
function preparationKey(options, artifact) {
  return [options.command, options.from, options.recipient, options.factory, options.quantity,
    options.minQuantity, artifact?.sourceSha256].map(String).join(':');
}
export async function readPublicStage(provider, options) {
  const [block, encodedDrop, encodedStats] = await Promise.all([
    provider.send('eth_getBlockByNumber', ['latest', false]),
    provider.send('eth_call', [{ to: CONFIG.seaDrop, data: SEA_READ.encodeFunctionData('getPublicDrop', [CONFIG.nftContract]) }, 'latest']),
    provider.send('eth_call', [{ to: CONFIG.nftContract, data: DIRECT_NFT.encodeFunctionData('getMintStats', [options.quantity === 1n ? options.from : ZeroAddress]) }, 'latest']),
  ]);
  const [drop] = SEA_READ.decodeFunctionResult('getPublicDrop', encodedDrop);
  const [walletMinted, minted, maximum] = DIRECT_NFT.decodeFunctionResult('getMintStats', encodedStats);
  check(maximum >= minted && maximum - minted >= options.minQuantity, 'Insufficient remaining NFT supply for the configured minimum.');
  if (options.quantity === 1n) check(walletMinted < drop.maxTotalMintableByWallet, 'The sending wallet has reached its public mint limit.');
  return { timestamp: parseUint(block?.timestamp, 'block timestamp'), blockNumber: parseUint(block?.number, 'block number'), startTime: drop.startTime, endTime: drop.endTime,
    mintPrice: drop.mintPrice, maxTotalMintableByWallet: drop.maxTotalMintableByWallet };
}
export async function preflightBatch(provider, artifact, options, prepared, timings = {}) {
  const direct = options.command === 'mint' && options.quantity === 1n;
  const iface = direct ? null : new Interface(artifact.abi);
  let checked;
  if (prepared) {
    const cached = PREPARED.get(prepared);
    check(cached?.provider === provider && cached.key === preparationKey(options, artifact), 'Prepared transaction does not match this wallet, contract, quantity or RPC.');
    const [chainId, block] = await Promise.all([
      provider.send('eth_chainId', []), provider.send('eth_getBlockByNumber', ['latest', false]),
    ]);
    check(parseUint(chainId) === CONFIG.chainId, 'RPC changed chain after preparation.');
    check(block?.number && block?.gasLimit, 'RPC did not return a complete latest block.');
    checked = { tx: prepared.tx, block };
  } else checked = await prepareBatch(provider, artifact, options);
  const { tx, block } = checked;
  if (options.command === 'mint') {
    check(options.targetTimestamp == null || parseUint(block?.timestamp, 'block timestamp') >= options.targetTimestamp,
      'Latest preflight block is below the requested wait timestamp. Submission stopped.');
    check(options.targetBlock == null || parseUint(block?.number, 'block number') >= options.targetBlock,
      'Latest preflight block is below the requested wait block. Submission stopped.');
  }
  const timed = async (name, operation) => {
    const started = performance.now();
    try { return await operation(); } finally { timings[name] = Math.round((performance.now() - started) * 100) / 100; }
  };
  let result, rawEstimate;
  if (prepared) {
    // Independent read-only simulations overlap in warm mode. Both must pass.
    [result, rawEstimate] = await Promise.all([
      timed('ethCall', () => provider.send('eth_call', [tx, 'latest'])),
      timed('estimateGas', () => provider.send('eth_estimateGas', [tx, 'latest'])),
    ]);
  } else result = await timed('ethCall', () => provider.send('eth_call', [tx, 'latest']));
  let predictedCount;
  if (direct) {
    // SeaDrop checks the live stage, price, supply, fee recipient and wallet
    // limit in this call. mintPublic has no return values.
    check(result === '0x', 'Direct mint simulation returned unexpected data.');
    predictedCount = 1n;
  } else if (options.command === 'mint') {
    [predictedCount] = iface.decodeFunctionResult('mintBatch', result);
    check(predictedCount >= options.minQuantity && predictedCount <= options.quantity, 'Simulation returned an unexpected mint count.');
  } else verifyFactoryCode(result, artifact);
  if (rawEstimate == null) rawEstimate = await timed('estimateGas', () => provider.send('eth_estimateGas', [tx, 'latest']));
  const estimate = parseUint(rawEstimate, 'gas estimate');
  check(estimate > 0n, 'RPC returned a zero gas estimate.');
  return { tx, block, estimate, predictedCount };
}
export async function checkGasLimit(provider, gasLimit, block) {
  check(gasLimit <= parseUint(block.gasLimit), 'Estimated transaction exceeds the block gas limit.');
  let encoded;
  try {
    encoded = await provider.send('eth_call', [{ to: ARB_GAS_INFO, data: ARB_GAS_ABI.encodeFunctionData('getMaxTxGasLimit') }, 'latest']);
  } catch {
    throw new MintError('Cannot read the required Robinhood Nitro transaction gas limit from ArbGasInfo. Submission stopped.');
  }
  check(isHexString(encoded, 32), 'RPC returned an invalid Nitro transaction gas limit. Submission stopped.');
  const [maxTxGasLimit] = ARB_GAS_ABI.decodeFunctionResult('getMaxTxGasLimit', encoded);
  check(maxTxGasLimit > 0n && maxTxGasLimit < (1n << 64n), 'RPC returned an invalid Nitro transaction gas limit. Submission stopped.');
  // Nitro accounts for L1 posting separately from L2 execution. Comparing the
  // entire buffered estimate against its transaction cap is conservative.
  check(gasLimit <= maxTxGasLimit,
    `Total gas limit ${gasLimit} exceeds Nitro maxTxGasLimit ${maxTxGasLimit}. This conservative check includes any L1 posting gas in the estimate. Limits and gas budget will not be increased automatically.`);
}
export async function gasQuote(provider, estimate, block, maxCost, maxFeeMultiplier = 2) {
  check(Number.isSafeInteger(maxFeeMultiplier) && maxFeeMultiplier >= 1 && maxFeeMultiplier <= 20, 'maxFeeMultiplier must be between 1 and 20.');
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const [, rawFee] = await Promise.all([
    checkGasLimit(provider, gasLimit, block),
    provider.send(block.baseFeePerGas != null ? 'eth_maxPriorityFeePerGas' : 'eth_gasPrice', []),
  ]);
  let fees;
  if (block.baseFeePerGas != null) {
    const priority = parseUint(rawFee);
    fees = { type: 2, maxPriorityFeePerGas: priority, maxFeePerGas: parseUint(block.baseFeePerGas) * BigInt(maxFeeMultiplier) + priority };
  } else fees = { type: 0, gasPrice: parseUint(rawFee) };
  const maxGasCost = gasLimit * (fees.maxFeePerGas ?? fees.gasPrice);
  check(maxGasCost <= maxCost, 'Maximum gas cost exceeds maxGasCostEth / --max-gas-cost-eth.');
  return { gasLimit, maxGasCost, fees };
}
export function verifyBatchReceipt(receipt, artifact, options) {
  const iface = new Interface(artifact.abi);
  check(Array.isArray(receipt.logs), 'Receipt logs are missing; inspect the printed transaction hash.');
  const events = receipt.logs.filter(log => typeof log.address === 'string' && log.address.toLowerCase() === options.factory.toLowerCase()).flatMap(log => {
    try { const event = iface.parseLog(log); return event ? [event] : []; } catch { return []; }
  });
  const batches = events.filter(e => e.name === 'BatchMinted');
  const minted = events.filter(e => e.name === 'TokenMinted');
  check(batches.length === 1 && batches[0].args.recipient === options.recipient, 'Receipt has no unique matching BatchMinted event.');
  const count = batches[0].args.count;
  check(count >= options.minQuantity && count <= options.quantity && BigInt(minted.length) === count, 'Receipt mint count is outside the requested bounds or differs from token events.');
  check(minted.every(e => e.args.recipient === options.recipient && e.args.helper !== ZeroAddress && e.args.tokenId > 0n), 'Receipt contains an unexpected mint recipient/helper/token.');
  const helpers = minted.map(e => e.args.helper);
  const tokenIds = minted.map(e => e.args.tokenId);
  check(new Set(helpers).size === helpers.length && new Set(tokenIds.map(String)).size === tokenIds.length, 'Receipt contains duplicate helper addresses or token IDs.');
  return { count, helpers, tokenIds };
}
export function verifyDirectReceipt(receipt, options) {
  check(Array.isArray(receipt.logs), 'Receipt logs are missing; inspect the printed transaction hash.');
  const decode = (contract, iface) => receipt.logs.filter(log => typeof log.address === 'string' && log.address.toLowerCase() === contract.toLowerCase()).flatMap(log => {
    try { const event = iface.parseLog(log); return event ? [event] : []; } catch { return []; }
  });
  const transfers = decode(CONFIG.nftContract, DIRECT_NFT).filter(event => event.name === 'Transfer' && event.args.from === ZeroAddress);
  check(transfers.length === 1 && transfers[0].args.to === options.from && transfers[0].args.tokenId > 0n,
    'Direct mint receipt must contain exactly one NFT mint to the sending wallet.');
  const mints = decode(CONFIG.seaDrop, DIRECT_SEADROP).filter(event => event.name === 'SeaDropMint');
  check(mints.length === 1 && mints[0].args.nftContract === CONFIG.nftContract && mints[0].args.minter === options.from &&
    mints[0].args.payer === options.from && mints[0].args.feeRecipient === CONFIG.feeRecipient &&
    mints[0].args.quantityMinted === 1n && mints[0].args.unitMintPrice === 0n && mints[0].args.dropStageIndex === 0n,
  'Direct mint receipt has no unique matching free public SeaDropMint event.');
  return { count: 1n, tokenIds: [transfers[0].args.tokenId] };
}
export async function waitReceipt(provider, hash, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
  throw new MintError('Receipt polling timed out. Check the printed hash before taking further action.');
}
export function safeBatchError(error) {
  if (error instanceof MintError || error instanceof BroadcastError) return error.message;
  const data = [error?.data, error?.error?.data, error?.info?.error?.data].find(value => typeof value === 'string' && isHexString(value));
  if (data) {
    try { const decoded = ERROR_ABI.parseError(data); if (decoded && decoded.name !== 'Error') return `Factory reverted: ${decoded.name}.`; } catch { /* Only known errors are printed. */ }
  }
  return safeError(error);
}
const HELP = `Rare Friends batch factory / Robinhood Chain (4663)
  node batch.mjs setup --config batch.config.json --send
  node batch.mjs start --config batch.config.json --send
  node batch.mjs mint --quantity 1 --from 0xYOUR_WALLET
  node batch.mjs mint --wait --config batch.config.json --from 0xYOUR_WALLET
  node batch.mjs deploy --from 0xYOUR_WALLET [--config batch.config.json]
  node batch.mjs mint --factory 0xYOUR_FACTORY --from 0xYOUR_WALLET [--config batch.config.json]
  Add --send to sign with PRIVATE_KEY from the environment and broadcast.
Setup deploys/reuses a saved factory and waits. Start uses an existing factory and waits.
Setup/start/deploy accept --state-file FILE; the default is .state/factory-4663-WALLET.json.

Default: simulation and gas estimate only. Mint payment is always zero.
--config FILE             JSON configuration; explicit CLI options override it.
--from ADDRESS            Wallet paying gas and owning the factory.
--recipient ADDRESS       NFT recipient; defaults to the same wallet.
--factory ADDRESS         Deployed factory; required only when quantity is above 1.
--quantity N              Maximum quantity, 1–1024 (alias: --max-count).
--min-quantity N          Minimum quantity, defaults to 1 (alias: --min-count).
--rpc URL                 Override config.rpcUrls with a single RPC.
--max-gas-cost-eth AMOUNT  Maximum execution gas cost, default 0.003 ETH.
--max-fee-multiplier N    Base fee multiplier, default 2, range 1–20.
--receipt-timeout SECONDS Receipt polling duration, default 120, range 1–600.
--concurrency N           Concurrent RPC broadcasts, default 2, range 1–8.
--attempts N              Attempts per RPC, default 2, range 1–5.
--retry-delay-ms N        Delay between attempts, default 250, range 0–5000.
--wait                    Prepare once, keep RPCs alive, wait for public stage.
--wait-timeout SECONDS    Maximum wait, default 21600, range 1–86400.
--poll-interval-ms N      Near-start block polling, default 250, range 100–10000.
--keep-alive-interval-ms N Heartbeat/stage refresh, default 10000, range 1000–60000.
--sequencer               Send directly to the official Robinhood sequencer.
--sequencer-url URL       Override the send-only Nitro endpoint; enables sequencer mode.
--wait-until-timestamp N   Wait until chain Unix time AND the public stage is open.
--wait-until-block N       Wait until block height AND all configured time conditions.
Time/block targets enable waiting for mint; deployment starts immediately.
Sequencer mode uses --rpc/config rpcUrls for all reads, simulation and receipts.
All RPC submissions use one identical signed transaction, nonce and hash.
Quantity 1 calls SeaDrop directly, with the sending wallet as recipient.
Deploy with quantity 1 does nothing. Larger quantities use the factory.
Run mint when the public stage is active, or start earlier with --wait.`;
export async function main(argv = process.argv.slice(2), hooks = {}) {
  if (['setup', 'start'].includes(argv[0]) || (argv[0] === 'deploy' && !hooks.managedDeployment)) {
    const { main: factoryMain } = await import('./factory.mjs');
    return factoryMain(argv);
  }
  const args = parseBatchArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const config = hooks.config == null ? await readBatchConfig(args.config) : validateConfig(hooks.config);
  if (args.command === 'deploy' && parseUint(args.quantity ?? args['max-count'] ?? config.quantity ?? 10, 'quantity') === 1n) {
    print({ command: 'deploy', route: 'direct', quantity: 1n, status: 'unnecessary', broadcastRequested: false });
    console.log('Deployment is unnecessary for quantity 1. Run mint to call SeaDrop directly.');
    return;
  }
  let wallet;
  if (args.send) {
    check(isHexString(process.env.PRIVATE_KEY, 32), '--send requires a 32-byte PRIVATE_KEY in the environment.');
    try { wallet = new Wallet(process.env.PRIVATE_KEY); } catch { throw new MintError('Invalid PRIVATE_KEY.'); }
    if (args.from) check(address(args.from, 'from') === wallet.address, '--from differs from the PRIVATE_KEY wallet.');
  }
  const options = resolveBatchOptions(args, config, wallet?.address);
  const waitMode = options.command === 'mint' && (args.wait || options.targetTimestamp != null || options.targetBlock != null);
  const artifact = options.route === 'direct' ? null : await loadArtifact();
  const allProviders = [];
  let sequencerSession;
  const started = performance.now();
  const timings = {};
  const measure = async (name, operation) => {
    const begin = performance.now();
    try { return await operation(); } finally { timings[name] = Math.round((performance.now() - begin) * 100) / 100; }
  };
  const cancellation = new AbortController();
  const cancel = () => {
    cancellation.abort();
    for (const provider of allProviders) provider.destroy();
  };
  const checkCancelled = () => check(!cancellation.signal.aborted, 'Cancelled. Check any printed transaction hash before restarting.');
  const ownSignals = (waitMode || options.sequencer) && !hooks.signal;
  if (ownSignals) {
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
  }
  hooks.signal?.addEventListener('abort', cancel, { once: true });
  if (hooks.signal?.aborted) cancel();
  try {
    checkCancelled();
    const candidates = await measure('rpcChecks', () => Promise.all(options.rpcUrls.map(async (url, endpoint) => {
      let provider;
      try {
        provider = createProvider(url); allProviders.push(provider);
        check(parseUint(await provider.send('eth_chainId', [])) === CONFIG.chainId, 'Wrong RPC chain.');
        print({ endpoint, rpcStatus: 'chain verified' });
        return { provider, endpoint };
      } catch { print({ endpoint, rpcStatus: 'unavailable or wrong chain; skipped' }); return null; }
    })));
    checkCancelled();
    let verified = candidates.filter(Boolean);
    check(verified.length > 0, 'No configured RPC endpoint passed the chain check.');
    if (options.sequencer) {
      sequencerSession = await measure('sequencerConnect', () => openSequencer(options, {
        register: item => allProviders.push(item), onProgress: print, signal: cancellation.signal,
      }));
      checkCancelled();
    }
    let provider = verified[0].provider;
    let prepared;
    if (waitMode) {
      const ready = await measure('prepareAndWait', () => waitForPublicStage({
        entries: verified, options, signal: cancellation.signal, onProgress: print,
        prepare: async entry => {
          const begin = performance.now();
          const result = await prepareBatch(entry.provider, artifact, options);
          print({ endpoint: entry.endpoint, preparationMs: Math.round((performance.now() - begin) * 100) / 100 });
          return result;
        },
        getStage: entry => readPublicStage(entry.provider, options),
      }));
      checkCancelled();
      verified = ready.entries;
      provider = ready.entry.provider;
      prepared = ready.prepared;
      timings.stageReadyAfterStart = Math.round((performance.now() - started) * 100) / 100;
    }
    const providers = verified.map(item => item.provider);
    const sendEntries = sequencerSession ? [{ provider: sequencerSession.provider, endpoint: 'sequencer' }] : verified;
    const sendProviders = sendEntries.map(item => item.provider);
    await sequencerSession?.ensureHealthy();
    const checked = await measure('finalPreflight', () => preflightBatch(provider, artifact, options, prepared, timings));
    checkCancelled();
    const [quote, walletState] = await Promise.all([
      measure('gasQuote', () => gasQuote(provider, checked.estimate, checked.block, options.maxGasCost, options.maxFeeMultiplier)),
      args.send ? measure('walletRefresh', () => Promise.all([
        provider.send('eth_chainId', []), provider.send('eth_getBalance', [options.from, 'pending']),
        provider.send('eth_getTransactionCount', [options.from, 'pending']),
      ])) : null,
    ]);
    checkCancelled();
    print({ command: options.command, route: options.route, chainId: CONFIG.chainId, from: options.from, recipient: options.recipient,
      to: checked.tx.to,
      factory: options.factory, quantity: options.quantity, minQuantity: options.minQuantity,
      predictedCount: checked.predictedCount, blockNumber: parseUint(checked.block.number), valueWei: '0',
      gasEstimate: checked.estimate, gasLimit: quote.gasLimit, ...quote.fees,
      maxFeeMultiplier: options.maxFeeMultiplier, waitMode: Boolean(waitMode),
      submission: options.sequencer ? 'direct sequencer' : 'configured RPCs',
      targetTimestamp: options.targetTimestamp, targetBlock: options.targetBlock,
      maximumExecutionGasCostEth: formatEther(quote.maxGasCost), simulation: 'passed', broadcastRequested: Boolean(args.send) });
    if (!args.send) { console.log('Dry run complete. Add --send when ready.'); return { status: 'dry-run', route: options.route }; }
    const [chainId, balance, nonceValue] = walletState;
    check(parseUint(chainId) === CONFIG.chainId, 'RPC chain changed before signing.');
    check(parseUint(balance) >= quote.maxGasCost, 'Wallet balance cannot cover the maximum execution gas cost.');
    const nonce = parseUint(nonceValue);
    checkCancelled();
    const raw = await measure('signing', () => wallet.signTransaction({ to: checked.tx.to, data: checked.tx.data, value: 0n,
      nonce, chainId: CONFIG.chainId, gasLimit: quote.gasLimit, ...quote.fees }));
    checkCancelled();
    const hash = keccak256(raw);
    const predictedFactory = options.command === 'deploy' ? getCreateAddress({ from: options.from, nonce }) : undefined;
    console.log(`Signed transaction hash: ${hash}`);
    console.log(`Track: https://robin.etherscan.io/tx/${hash}`);
    if (predictedFactory) console.log(`Expected factory: ${predictedFactory}`);
    await hooks.beforeBroadcast?.({ raw, hash, predictedFactory, nonce, options });
    checkCancelled();
    const broadcastStarted = performance.now();
    timings.readyToBroadcast = timings.stageReadyAfterStart == null ? undefined
      : Math.round((broadcastStarted - started - timings.stageReadyAfterStart) * 100) / 100;
    checkCancelled();
    const sent = await measure('broadcastAllSettled', () => broadcastIdentical(raw, sendProviders, { concurrency: options.concurrency, attempts: options.attempts,
      signal: cancellation.signal,
      ...(sequencerSession ? { lookupProviders: providers } : {}),
      retryDelayMs: options.retryDelayMs, onAttempt: event => {
        if ((event.status === 'accepted' || (event.status === 'known' && !sequencerSession)) && timings.firstRpcAcknowledgement == null) {
          timings.firstRpcAcknowledgement = Math.round((performance.now() - broadcastStarted) * 100) / 100;
        }
        if (event.status === 'known' && sequencerSession && timings.firstReadRpcObservation == null) {
          timings.firstReadRpcObservation = Math.round((performance.now() - broadcastStarted) * 100) / 100;
        }
        print({ ...event, endpoint: sendEntries[event.endpoint].endpoint,
          ...(sequencerSession && event.status === 'known' ? { observationSource: 'read RPC; sequencer acknowledgement unavailable' } : {}) });
      } }));
    check(sent.hash === hash, 'Broadcast returned an unexpected hash. Inspect the printed local hash.');
    print({ transactionHash: hash, acceptedBy: sent.acceptedBy.map(index => sendEntries[index].endpoint),
      ...(sequencerSession ? { knownViaReadRpc: sent.knownBy.length > 0 } : { knownBy: sent.knownBy.map(index => sendEntries[index].endpoint) }) });
    const receiptProvider = sequencerSession ? provider : providers[sent.acceptedBy[0] ?? sent.knownBy[0] ?? 0];
    let receipt;
    try { receipt = await measure('receiptAfterBroadcastSettled', () => waitReceipt(receiptProvider, hash, options.receiptTimeoutSeconds)); }
    catch { throw new MintError('Transaction was submitted, but its receipt is unavailable or timed out. Check the printed hash before taking further action.'); }
    check(typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() === hash, 'Receipt hash differs from the submitted transaction.');
    check(parseUint(receipt.status) === 1n, 'Transaction was mined with failure status. Gas was spent; check the printed hash.');
    if (options.command === 'deploy') {
      check(address(receipt.contractAddress, 'deployed factory') === predictedFactory, 'Deployment receipt contains an unexpected factory address.');
      const code = await receiptProvider.send('eth_getCode', [predictedFactory, 'latest']);
      verifyFactoryCode(code, artifact);
      const iface = new Interface(artifact.abi);
      const [owner, recipient] = await Promise.all(['owner', 'recipient'].map(method => readFactory(receiptProvider, predictedFactory, iface, method, 'latest')));
      check(owner === options.from && recipient === options.recipient, 'Deployed factory ownership/recipient differs from the request.');
      const result = { status: 'deployed', route: options.route, transactionHash: hash, factory: predictedFactory, owner, recipient };
      await hooks.onDeployed?.(result);
      print(result);
      return result;
    }
    const result = { status: 'mined', route: options.route, transactionHash: hash,
      ...(options.route === 'direct' ? verifyDirectReceipt(receipt, options) : verifyBatchReceipt(receipt, artifact, options)) };
    print(result);
    return result;
  } finally {
    if (ownSignals) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    hooks.signal?.removeEventListener('abort', cancel);
    sequencerSession?.close();
    for (const provider of allProviders) provider.destroy();
    timings.total = Math.round((performance.now() - started) * 100) / 100;
    print({ timingsMs: timings, timingNote: 'RPC acknowledgement and receipt polling are distinct from sequencer arrival and finality.' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${safeBatchError(error)}`); process.exitCode = 1; });
}
