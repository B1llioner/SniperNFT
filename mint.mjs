#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FetchRequest, Interface, JsonRpcProvider, Signature, TypedDataEncoder, Wallet,
  ZeroAddress, getAddress, isHexString, keccak256, parseEther, formatEther,
  toQuantity, verifyTypedData,
} from 'ethers';
import { createRpcTransport, RpcTransportError } from './lib/rpc-transport.mjs';

export const CONFIG = Object.freeze({
  chainId: 4663n,
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  nftContract: getAddress('0x116eaa62241751e0c98da43d458600c6c17cd361'),
  seaDrop: getAddress('0x00005ea00ac477b1030ce78506496e8c2de24bf5'),
  feeRecipient: getAddress('0x0000a26b00c1f0df003000390027140000faa719'),
});
const UINT256_MAX = (1n << 256n) - 1n;
const PARAM_NAMES = ['mintPrice', 'maxTotalMintableByWallet', 'startTime', 'endTime',
  'dropStageIndex', 'maxTokenSupplyForStage', 'feeBps', 'restrictFeeRecipients'];
const PARAM_TUPLE = `(${PARAM_NAMES.map(n => `${n === 'restrictFeeRecipients' ? 'bool' : 'uint256'} ${n}`).join(',')})`;
export const SEADROP_ABI = [
  `function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${PARAM_TUPLE} mintParams,uint256 salt,bytes signature) payable`,
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'function getPublicDrop(address nftContract) view returns ((uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns (bool)',
  'function getSignedMintValidationParams(address nftContract,address signer) view returns ((uint80 minMintPrice,uint24 maxMaxTotalMintableByWallet,uint40 minStartTime,uint40 maxEndTime,uint40 maxMaxTokenSupplyForStage,uint16 minFeeBps,uint16 maxFeeBps))',
  'error SignatureAlreadyUsed()', 'error InvalidSignature(address recoveredSigner)',
  'error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)',
  'error FeeRecipientNotAllowed()', 'error PayerNotAllowed()',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total,uint256 allowed)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total,uint256 allowed)',
  'error IncorrectPayment(uint256 actual,uint256 expected)',
];
export const NFT_ABI = [
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
];
const sea = new Interface(SEADROP_ABI);
const nft = new Interface(NFT_ABI);
export const MINT_TYPES = {
  MintParams: PARAM_NAMES.map(name => ({ name, type: name === 'restrictFeeRecipients' ? 'bool' : 'uint256' })),
  SignedMint: [
    { name: 'nftContract', type: 'address' }, { name: 'minter', type: 'address' },
    { name: 'feeRecipient', type: 'address' }, { name: 'mintParams', type: 'MintParams' },
    { name: 'salt', type: 'uint256' },
  ],
};
const DOMAIN = { name: 'SeaDrop', version: '1.0', chainId: CONFIG.chainId, verifyingContract: CONFIG.seaDrop };
export class MintError extends Error {}
function requireThat(condition, message) { if (!condition) throw new MintError(message); }
export function parseUint(value, label = 'integer') {
  requireThat(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)), `${label}: expected an unsigned integer; use strings for large values.`);
  const result = BigInt(value);
  requireThat(result >= 0n && result <= UINT256_MAX, `${label}: outside uint256 range.`);
  return result;
}
function address(value, label) {
  try { return getAddress(value); } catch { throw new MintError(`${label}: invalid address.`); }
}
function bindFrom(payload, from) {
  const sender = address(from ?? payload.from ?? payload.minter, 'from/minter');
  requireThat(sender !== ZeroAddress, 'The mint recipient cannot be zero.');
  for (const value of [payload.from, payload.minter]) {
    if (value != null) requireThat(address(value, 'from/minter') === sender, 'Payload minter/from differs from the selected wallet.');
  }
  return sender;
}
function mintParams(value) {
  requireThat(value && typeof value === 'object', 'mintParams is required.');
  const result = Object.fromEntries(PARAM_NAMES.map(name => [name, name === 'restrictFeeRecipients'
    ? value[name] : parseUint(value[name], name)]));
  requireThat(typeof result.restrictFeeRecipients === 'boolean', 'restrictFeeRecipients must be boolean.');
  requireThat(result.startTime <= result.endTime, 'The mint window is invalid.');
  requireThat(result.feeBps <= 10000n, 'feeBps exceeds 10000.');
  return result;
}
function validateSignature(value) {
  requireThat(isHexString(value, 65), 'signature must contain exactly 65 bytes.');
  // OpenZeppelin ECDSA.recover(bytes) used here accepts 65-byte, low-s signatures.
  requireThat(['1b', '1c'].includes(value.slice(-2).toLowerCase()), 'signature v must be 27 or 28.');
  try { void Signature.from(value).s; } catch { throw new MintError('Invalid ECDSA signature.'); }
  return value.toLowerCase();
}
export function buildPayload(input, { from } = {}) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'Payload must be a JSON object.');
  const sender = bindFrom(input, from);
  const params = mintParams(input.mintParams);
  const payload = {
    chainId: input.chainId ?? CONFIG.chainId,
    to: input.to ?? CONFIG.seaDrop,
    from: sender,
    value: input.value ?? params.mintPrice * parseUint(input.quantity, 'quantity'),
    data: sea.encodeFunctionData('mintSigned', [
      address(input.nftContract ?? CONFIG.nftContract, 'nftContract'),
      address(input.feeRecipient ?? CONFIG.feeRecipient, 'feeRecipient'), ZeroAddress,
      parseUint(input.quantity, 'quantity'), params, parseUint(input.salt, 'salt'), validateSignature(input.signature),
    ]),
  };
  decodePayload(payload, { from: sender });
  return payload;
}
export function decodePayload(input, { from } = {}) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'Payload must be a JSON object.');
  requireThat(parseUint(input.chainId, 'chainId') === CONFIG.chainId, 'Payload chainId must be 4663 (Robinhood Chain).');
  requireThat(address(input.to, 'to') === CONFIG.seaDrop, 'Transaction destination must be the configured SeaDrop.');
  requireThat(typeof input.data === 'string' && input.data.length <= 8194 && isHexString(input.data), 'Invalid or oversized calldata.');
  requireThat(input.data.slice(0, 10).toLowerCase() === '0x4b61cd6f', 'Only mintSigned calldata is accepted in --payload mode.');
  const sender = bindFrom(input, from);
  let decoded;
  try { decoded = sea.decodeFunctionData('mintSigned', input.data); } catch { throw new MintError('Cannot decode mintSigned calldata.'); }
  const params = mintParams(decoded.mintParams);
  const minter = decoded.minterIfNotPayer === ZeroAddress ? sender : decoded.minterIfNotPayer;
  requireThat(minter === sender, 'Sponsored mints are unsupported: minter must match the sending wallet.');
  requireThat(decoded.nftContract === CONFIG.nftContract, 'Payload targets a different NFT collection.');
  requireThat(decoded.feeRecipient !== ZeroAddress, 'feeRecipient cannot be zero.');
  requireThat(params.restrictFeeRecipients, 'Signed mints must restrict fee recipients.');
  requireThat(decoded.quantity > 0n, 'quantity must be positive.');
  const expected = params.mintPrice * decoded.quantity;
  const value = parseUint(input.value, 'value');
  requireThat(value === expected, 'value must equal mintPrice multiplied by quantity.');
  const signature = validateSignature(decoded.signature);
  const canonical = sea.encodeFunctionData('mintSigned', decoded).toLowerCase();
  const data = input.data.toLowerCase();
  requireThat(data.startsWith(canonical), 'Non-canonical ABI calldata is unsupported.');
  return {
    mode: 'signed', chainId: CONFIG.chainId, to: CONFIG.seaDrop, nftContract: CONFIG.nftContract,
    from: sender, minter, feeRecipient: decoded.feeRecipient, quantity: decoded.quantity,
    mintParams: params, salt: decoded.salt, signature, value, data,
    attribution: `0x${data.slice(canonical.length)}`,
  };
}
export function validatePayload(input, { from, maxValue } = {}) {
  requireThat(input && typeof input === 'object', 'Payload must be a JSON object.');
  requireThat(!(input.data != null && input.mintParams != null), 'Payload mixes raw and structured formats.');
  const mint = decodePayload(input.data != null ? input : buildPayload(input, { from }), { from });
  if (maxValue != null) requireThat(mint.value <= parseUint(maxValue, 'maxValue'), 'Mint value exceeds --max-value-eth.');
  return mint;
}
export function signedMintDigest(mint) { return TypedDataEncoder.hash(DOMAIN, MINT_TYPES, mint); }
export function recoverMintSigner(mint) {
  try { return verifyTypedData(DOMAIN, MINT_TYPES, mint, mint.signature); }
  catch { throw new MintError('Could not recover the mint signer.'); }
}
export function buildPublicMint(drop, { from, quantity = 1n } = {}) {
  const sender = bindFrom({}, from);
  const count = parseUint(quantity, 'quantity');
  requireThat(count > 0n, 'quantity must be positive.');
  const params = mintParams({ ...drop, dropStageIndex: 0n, maxTokenSupplyForStage: UINT256_MAX });
  return {
    mode: 'public', chainId: CONFIG.chainId, to: CONFIG.seaDrop, nftContract: CONFIG.nftContract,
    from: sender, minter: sender, feeRecipient: CONFIG.feeRecipient, quantity: count,
    mintParams: params, value: parseUint(count * params.mintPrice, 'value'),
    data: sea.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, count]),
  };
}
export function createProvider(url = CONFIG.rpc, { timeoutMs = 20000 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new MintError('Invalid RPC URL.'); }
  requireThat(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)), 'RPC must use HTTPS (or HTTP on localhost).');
  requireThat(!parsed.username && !parsed.password, 'RPC URL user/password credentials are unsupported.');
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 20000, 'RPC timeoutMs must be an integer between 1000 and 20000.');
  const transport = createRpcTransport(parsed.href, timeoutMs);
  const request = new FetchRequest(parsed.href);
  request.timeout = timeoutMs;
  request.setHeader('user-agent', 'Mozilla/5.0');
  request.setThrottleParams({ maxAttempts: 1 });
  request.retryFunc = async () => false;
  // One HTTP attempt: especially do not retry eth_sendRawTransaction.
  // Preserve transport failures as transport failures so warm mode can select
  // a prepared fallback without masking application errors such as sold out.
  request.getUrlFunc = transport.getUrl;
  const provider = new JsonRpcProvider(request, Number(CONFIG.chainId), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  const destroy = provider.destroy.bind(provider);
  provider.destroy = () => { transport.destroy(); destroy(); };
  return provider;
}
async function readContract(provider, contract, iface, method, args, blockTag) {
  const result = await provider.send('eth_call', [{ to: contract, data: iface.encodeFunctionData(method, args) }, blockTag]);
  return iface.decodeFunctionResult(method, result);
}
function checkStage(mint, timestamp, stats, validation, feeAllowed) {
  const p = mint.mintParams;
  const time = seconds => {
    const date = new Date(Number(seconds) * 1000);
    return Number.isNaN(date.getTime()) ? `${seconds} Unix seconds` : date.toISOString();
  };
  requireThat(timestamp >= p.startTime && timestamp <= p.endTime,
    `Mint stage is inactive. Window: ${time(p.startTime)} through ${time(p.endTime)}; latest block: ${time(timestamp)}.`);
  requireThat(mint.quantity + stats.minterNumMinted <= p.maxTotalMintableByWallet, 'Mint exceeds the lifetime wallet mint limit.');
  requireThat(mint.quantity + stats.currentTotalSupply <= stats.maxSupply, 'Mint exceeds the collection supply limit.');
  requireThat(mint.quantity + stats.currentTotalSupply <= p.maxTokenSupplyForStage, 'Mint exceeds the stage total-supply limit.');
  requireThat(!p.restrictFeeRecipients || feeAllowed, 'Fee recipient is not allowed by the collection.');
  if (mint.mode !== 'signed') return;
  requireThat(validation.maxMaxTotalMintableByWallet > 0n, 'Recovered signer is not currently authorized; obtain a fresh signature for this wallet.');
  requireThat(p.mintPrice >= validation.minMintPrice && p.maxTotalMintableByWallet <= validation.maxMaxTotalMintableByWallet &&
    p.startTime >= validation.minStartTime && p.endTime <= validation.maxEndTime &&
    p.maxTokenSupplyForStage <= validation.maxMaxTokenSupplyForStage &&
    p.feeBps >= validation.minFeeBps && p.feeBps <= validation.maxFeeBps, 'Signed mint parameters exceed the authorized signer limits.');
}
export async function preflight(provider, input, { maxValue = 0n } = {}) {
  requireThat(parseUint(await provider.send('eth_chainId', []), 'RPC chainId') === CONFIG.chainId, 'RPC is connected to the wrong chain.');
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  requireThat(block && block.number && block.timestamp, 'RPC did not return the latest block.');
  const tag = block.number;
  let mint = input;
  if (input.mode === 'public') {
    const [drop] = await readContract(provider, CONFIG.seaDrop, sea, 'getPublicDrop', [CONFIG.nftContract], tag);
    mint = buildPublicMint(drop.toObject(), { from: input.from, quantity: input.quantity });
  }
  requireThat(mint.value <= maxValue, 'Mint value exceeds --max-value-eth.');
  const signer = mint.mode === 'signed' ? recoverMintSigner(mint) : undefined;
  const [codes, stats, allowed, validation] = await Promise.all([
    Promise.all([CONFIG.nftContract, CONFIG.seaDrop].map(a => provider.send('eth_getCode', [a, tag]))),
    readContract(provider, CONFIG.nftContract, nft, 'getMintStats', [mint.minter], tag),
    readContract(provider, CONFIG.seaDrop, sea, 'getFeeRecipientIsAllowed', [CONFIG.nftContract, mint.feeRecipient], tag),
    signer ? readContract(provider, CONFIG.seaDrop, sea, 'getSignedMintValidationParams', [CONFIG.nftContract, signer], tag) : Promise.resolve([undefined]),
  ]);
  requireThat(codes.every(code => isHexString(code) && code !== '0x' && !/^0x0*$/.test(code)), 'NFT or SeaDrop has no runtime code on this chain.');
  checkStage(mint, parseUint(block.timestamp), stats, validation[0], allowed[0]);
  const tx = { from: mint.from, to: mint.to, data: mint.data, value: toQuantity(mint.value) };
  // The contract is authoritative for replay protection and all mint restrictions.
  await provider.send('eth_call', [tx, tag]);
  const estimate = parseUint(await provider.send('eth_estimateGas', [tx, tag]), 'gas estimate');
  requireThat(estimate > 0n, 'RPC returned a zero gas estimate.');
  return { mint, block, estimate, signer, stats: stats.toObject() };
}
export function safeError(error) {
  if (error instanceof MintError || error instanceof RpcTransportError) return error.message;
  const data = [error?.data, error?.error?.data, error?.info?.error?.data].find(x => typeof x === 'string' && isHexString(x));
  if (data) {
    try { const decoded = sea.parseError(data); if (decoded && decoded.name !== 'Error') return `Contract reverted: ${decoded.name}.`; } catch { /* Do not print unknown revert data. */ }
  }
  if (error?.code === 'TIMEOUT') return 'RPC request timed out.';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'RPC hostname resolution failed.';
  if (['ECONNREFUSED', 'ECONNRESET', 'NETWORK_ERROR'].includes(error?.code)) return 'RPC network connection failed.';
  if (error?.code === 'INSUFFICIENT_FUNDS') return 'Wallet has insufficient funds.';
  if (error?.code === 'CALL_EXCEPTION') return 'Mint simulation reverted; check eligibility, window, limits and whether the signature was already used.';
  return 'Operation failed. Check the payload, RPC connection and wallet configuration; private error details were suppressed.';
}
function print(value) { console.log(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)); }
function describe(mint) {
  return { mode: mint.mode, chainId: mint.chainId, to: mint.to, nftContract: mint.nftContract,
    from: mint.from, minter: mint.minter, feeRecipient: mint.feeRecipient, quantity: mint.quantity,
    valueWei: mint.value, valueEth: formatEther(mint.value), mintParams: mint.mintParams,
    ...(mint.mode === 'signed' ? { digest: signedMintDigest(mint), recoveredSigner: recoverMintSigner(mint), attribution: mint.attribution } : {}) };
}
export function parseArgs(args) {
  const result = {};
  const booleans = new Set(['help', 'inspect', 'send', 'public']);
  const values = new Set(['payload', 'from', 'rpc', 'quantity', 'max-value-eth', 'max-gas-cost-eth', 'receipt-timeout']);
  for (let i = 0; i < args.length; i++) {
    requireThat(args[i].startsWith('--'), 'Use named CLI options; see --help.');
    const key = args[i].slice(2);
    requireThat(!(key in result), 'Duplicate CLI option.');
    if (booleans.has(key)) result[key] = true;
    else {
      requireThat(values.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--'), 'Unknown CLI option or missing value; see --help.');
      result[key] = args[++i];
    }
  }
  requireThat(!(result.inspect && (result.send || result.public)), '--inspect requires --payload and cannot be combined with --send or --public.');
  requireThat(!(result.public && result.payload), 'Choose either --public or --payload.');
  requireThat(!result.quantity || result.public, '--quantity is only available with --public; signed payload quantities are preserved.');
  return result;
}
async function readPayload(path) {
  requireThat(typeof path === 'string' && path.length > 0, '--payload FILE is required.');
  let handle;
  try {
    handle = await open(resolve(path), 'r');
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.size <= 65536, 'Payload must be a regular file of at most 64 KiB.');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    requireThat(bytesRead <= 65536, 'Payload exceeds 64 KiB.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof MintError) throw error;
    throw new MintError('Cannot read or parse the JSON payload file.');
  } finally { if (handle) await handle.close(); }
}
function ethLimit(value, fallback, label) {
  const text = value ?? fallback;
  requireThat(typeof text === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text), `${label} must be a non-negative ETH amount.`);
  try { return parseUint(parseEther(text), label); } catch { throw new MintError(`Invalid ${label}.`); }
}
async function gasQuote(provider, estimate, block, maxCost) {
  const gasLimit = (estimate * 120n + 99n) / 100n;
  requireThat(gasLimit <= parseUint(block.gasLimit), 'Estimated transaction exceeds the block gas limit.');
  let fees;
  if (block.baseFeePerGas != null) {
    const priority = parseUint(await provider.send('eth_maxPriorityFeePerGas', []), 'priority fee');
    fees = { type: 2, maxPriorityFeePerGas: priority, maxFeePerGas: parseUint(block.baseFeePerGas) * 2n + priority };
  } else fees = { type: 0, gasPrice: parseUint(await provider.send('eth_gasPrice', []), 'gas price') };
  const maxGasCost = gasLimit * (fees.maxFeePerGas ?? fees.gasPrice);
  requireThat(maxGasCost <= maxCost, 'Maximum gas cost exceeds --max-gas-cost-eth.');
  return { gasLimit, maxGasCost, fees };
}
async function waitReceipt(provider, hash, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
  return null;
}
const HELP = `Rare Friends Genesis / Robinhood Chain (4663)
  node mint.mjs --payload payload.json --from 0xYOUR_WALLET
  node mint.mjs --public --from 0xYOUR_WALLET [--quantity 1]
  node mint.mjs --inspect --payload research/reference-transaction.json
  PRIVATE_KEY=<set securely in environment> node mint.mjs --payload payload.json --send

Default: read-only preflight, eth_call, gas estimate. --send explicitly broadcasts.
--public                  Fetch the current public mint configuration (no signature).
--payload FILE            Raw {chainId,to,data,value,from?}, or structured signed mint.
--from ADDRESS            Required for simulation unless payload binds from/minter.
--inspect                 Offline decode/digest recovery; no eligibility validation.
--rpc URL                 HTTPS RPC, or RPC_URL environment variable.
--max-value-eth AMOUNT     Maximum mint payment; default 0 (free mint only).
--max-gas-cost-eth AMOUNT  gasLimit * maximum fee ceiling; default 0.001 ETH.
--receipt-timeout SECONDS Receipt polling duration; default 120, range 1–600.
--help                    Show this help.
PRIVATE_KEY is read only with --send. No private keys or signatures are printed.
Obtain a fresh signed payload for your wallet. A used signature cannot mint again.`;
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  let wallet;
  let from = options.from;
  if (options.send) {
    requireThat(isHexString(process.env.PRIVATE_KEY, 32), '--send requires a 32-byte PRIVATE_KEY in the environment.');
    try { wallet = new Wallet(process.env.PRIVATE_KEY); } catch { throw new MintError('Invalid PRIVATE_KEY.'); }
    if (from) requireThat(address(from, 'from') === wallet.address, '--from differs from PRIVATE_KEY wallet.');
    from = wallet.address;
  }
  const maxValue = ethLimit(options['max-value-eth'], '0', 'max-value-eth');
  const maxGasCost = ethLimit(options['max-gas-cost-eth'], '0.001', 'max-gas-cost-eth');
  const timeout = parseUint(options['receipt-timeout'] ?? '120', 'receipt-timeout');
  requireThat(timeout >= 1n && timeout <= 600n, 'receipt-timeout must be between 1 and 600 seconds.');
  const input = options.public
    ? { mode: 'public', from: bindFrom({}, from), quantity: parseUint(options.quantity ?? '1', 'quantity') }
    : validatePayload(await readPayload(options.payload), { from, ...(options.inspect ? {} : { maxValue }) });
  if (options.inspect) {
    print({ ...describe(input), notice: 'Offline inspection only. This does not establish signer authorization, eligibility or signature availability.' });
    return;
  }
  const provider = createProvider(options.rpc ?? process.env.RPC_URL ?? CONFIG.rpc);
  try {
    const checked = await preflight(provider, input, { maxValue });
    const { mint, estimate, block } = checked;
    const quote = await gasQuote(provider, estimate, block, maxGasCost);
    print({ ...describe(mint), blockNumber: parseUint(block.number), mintStats: checked.stats,
      gasEstimate: estimate, gasLimit: quote.gasLimit, ...quote.fees,
      maximumExecutionGasCostEth: formatEther(quote.maxGasCost), simulation: 'passed', broadcastRequested: Boolean(options.send) });
    if (!options.send) { console.log('Dry run complete. Use --send with your wallet only when ready.'); return; }
    const [chainId, balance, nonce] = await Promise.all([
      provider.send('eth_chainId', []), provider.send('eth_getBalance', [from, 'pending']),
      provider.send('eth_getTransactionCount', [from, 'pending']),
    ]);
    requireThat(parseUint(chainId) === CONFIG.chainId, 'RPC chain changed before signing.');
    requireThat(parseUint(balance) >= mint.value + quote.maxGasCost, 'Wallet balance cannot cover mint value plus the maximum execution gas cost.');
    const raw = await wallet.signTransaction({ to: mint.to, data: mint.data, value: mint.value,
      chainId: CONFIG.chainId, nonce: parseUint(nonce), gasLimit: quote.gasLimit, ...quote.fees });
    const hash = keccak256(raw);
    console.log(`Signed transaction hash: ${hash}`);
    console.log(`Track: https://robin.etherscan.io/tx/${hash}`);
    let returned;
    try { returned = await provider.send('eth_sendRawTransaction', [raw]); }
    catch { throw new MintError('Broadcast outcome is uncertain. Check the printed transaction hash before taking further action; no automatic retry was attempted.'); }
    requireThat(typeof returned === 'string' && returned.toLowerCase() === hash, 'RPC returned a different hash. Check the printed local transaction hash; do not resend blindly.');
    let receipt;
    try { receipt = await waitReceipt(provider, hash, Number(timeout)); }
    catch { throw new MintError('Transaction was submitted, but receipt lookup failed. Check the printed hash; do not resend blindly.'); }
    if (!receipt) throw new MintError('Transaction was submitted; receipt polling timed out. Check the printed hash; do not resend blindly.');
    requireThat(parseUint(receipt.status) === 1n, 'Transaction was mined with failure status. Gas was spent; check the printed hash.');
    const tokenIds = receipt.logs.filter(log => address(log.address, 'log address') === CONFIG.nftContract).flatMap(log => {
      try { const e = nft.parseLog(log); return e?.name === 'Transfer' && e.args.from === ZeroAddress && e.args.to === mint.minter ? [e.args.tokenId] : []; }
      catch { return []; }
    });
    requireThat(BigInt(tokenIds.length) === mint.quantity,
      'Transaction succeeded, but its NFT mint events do not match the requested quantity. Check the printed transaction hash.');
    print({ status: 'mined', transactionHash: hash, blockNumber: parseUint(receipt.blockNumber), tokenIds });
  } finally { provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${safeError(error)}`); process.exitCode = 1; });
}
