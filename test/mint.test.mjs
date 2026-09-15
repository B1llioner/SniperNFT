import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Interface, ZeroAddress, getBytes } from 'ethers';
import {
  CONFIG,
  NFT_ABI,
  SEADROP_ABI,
  buildPayload,
  buildPublicMint,
  decodePayload,
  parseUint,
  preflight,
  recoverMintSigner,
  safeError,
  signedMintDigest,
  validatePayload,
} from '../mint.mjs';

const readJson = (name) => JSON.parse(readFileSync(new URL(`../research/${name}`, import.meta.url), 'utf8'));
const reference = readJson('reference-transaction.json');
const sea = new Interface(SEADROP_ABI);
const nft = new Interface(NFT_ABI);
const signer = '0xfCe4b31128100915f2980BBC3a08894Ee5e8F8C3';
const anotherWallet = '0x0000000000000000000000000000000000000123';
const feeRecipient = '0x0000a26b00c1f0df003000390027140000faa719';

function changeSignedArgs(change) {
  const args = sea.decodeFunctionData('mintSigned', reference.data).toArray(true);
  change(args);
  return { ...reference, data: sea.encodeFunctionData('mintSigned', args) };
}

// Contract getters use actual ABI encoding, while time and supply are controlled
// locally. Mint simulation can fail without sending any transaction.
function mockProvider(overrides = {}) {
  const state = {
    chainId: 4663n,
    timestamp: 1789469130,
    minted: 0n,
    supply: 906n,
    maxSupply: 1024n,
    signers: [signer],
    feeRecipients: [feeRecipient],
    publicDrop: [0n, 1789488020n, 1789491620n, 1n, 1000n, true],
    validation: [0n, 1024n, 1789408820n, 1789578020n, 1024n, 1000n, 1000n],
    simulationError: null,
    gas: 300000n,
    ...overrides,
  };
  const calls = [];
  const provider = {
    calls,
    state,
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
      if (method === 'eth_getBlockByNumber') return {
        number: '0x3ca6ca3', timestamp: `0x${state.timestamp.toString(16)}`,
      };
      if (method === 'eth_getCode') return params[0].toLowerCase() === reference.to.toLowerCase()
        ? readJson('seadrop-code.json').result
        : readFileSync(new URL('../research/nft-runtime.hex', import.meta.url), 'utf8').trim();
      if (method === 'eth_estimateGas') {
        if (state.simulationError) throw state.simulationError;
        return `0x${state.gas.toString(16)}`;
      }
      assert.equal(method, 'eth_call', `unexpected RPC method ${method}`);
      const [transaction] = params;
      const iface = transaction.to.toLowerCase() === reference.to.toLowerCase() ? sea : nft;
      const decoded = iface.parseTransaction({ data: transaction.data });
      let result;
      switch (decoded.name) {
        case 'getMintStats': result = [state.minted, state.supply, state.maxSupply]; break;
        case 'getPublicDrop': result = [state.publicDrop]; break;
        case 'getSignedMintValidationParams': result = [state.signers.some(
          address => address.toLowerCase() === decoded.args.signer.toLowerCase(),
        ) ? state.validation : [0n, 0n, 0n, 0n, 0n, 0n, 0n]]; break;
        case 'getFeeRecipientIsAllowed': result = [state.feeRecipients.some(
          address => address.toLowerCase() === decoded.args.feeRecipient.toLowerCase(),
        )]; break;
        case 'mintSigned':
        case 'mintPublic':
          if (state.simulationError) throw state.simulationError;
          return '0x';
        default: throw new Error(`Unexpected test getter: ${decoded.name}`);
      }
      return iface.encodeFunctionResult(decoded.fragment, result);
    },
  };
  return provider;
}

test('large unsigned values retain precision and unsafe numbers are rejected', () => {
  const salt = '65118321391632838439213562071566853052509486733471647480216242284501872058635';
  assert.equal(parseUint(salt), BigInt(salt));
  for (const bad of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, '-1', '1.1']) {
    assert.throws(() => parseUint(bad), `accepted invalid integer ${bad}`);
  }
});

test('reference calldata retains attribution and decodes the exact signed mint', () => {
  const mint = decodePayload(reference);
  assert.equal(mint.mode, 'signed');
  assert.equal(mint.chainId, 4663n);
  assert.equal(mint.nftContract.toLowerCase(), '0x116eaa62241751e0c98da43d458600c6c17cd361');
  assert.equal(mint.to.toLowerCase(), reference.to);
  assert.equal(mint.minter.toLowerCase(), reference.from);
  assert.equal(mint.quantity, 1n);
  assert.equal(mint.value, 0n);
  assert.deepEqual(mint.mintParams, {
    mintPrice: 0n,
    maxTotalMintableByWallet: 1n,
    startTime: 1789416020n,
    endTime: 1789488020n,
    dropStageIndex: 4n,
    maxTokenSupplyForStage: 1024n,
    feeBps: 1000n,
    restrictFeeRecipients: true,
  });
  assert.equal(mint.salt, BigInt('0x8ff73d35cab02da42c273e02ad2d322171a8cab0476577f01d1196ba50b94a0b'));
  assert.equal(getBytes(mint.signature).length, 65);
  assert.equal(getBytes(mint.data).length, 584);
  assert.equal(mint.attribution, '0x3d958fe2');
  assert.equal(mint.data, reference.data);
});

test('EIP-712 digest and recovered signer match independently recovered reference values', () => {
  const mint = validatePayload(reference);
  assert.equal(signedMintDigest(mint), '0x177d80653c546eca6a79df4b868a40fbb6b5815d6c16241a44c7993c00845e77');
  assert.equal(recoverMintSigner(mint), signer);
  const canonical = { ...reference, data: reference.data.slice(0, -8) };
  assert.equal(getBytes(canonical.data).length, 580);
  assert.equal(signedMintDigest(decodePayload(canonical)), signedMintDigest(mint));
});

test('structured payload encoding round-trips the large salt and signature', () => {
  const mint = decodePayload(reference);
  const structured = {
    from: mint.from, quantity: mint.quantity.toString(),
    mintParams: Object.fromEntries(Object.entries(mint.mintParams).map(
      ([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value],
    )),
    salt: mint.salt.toString(), signature: mint.signature,
  };
  const payload = buildPayload(structured);
  assert.equal(payload.data, reference.data.slice(0, -8));
  assert.equal(signedMintDigest(validatePayload(structured)), signedMintDigest(mint));
  assert.equal(decodePayload(payload).salt, mint.salt);
});

test('payload rejects a changed network, target, collection, method, or recipient', () => {
  assert.throws(() => validatePayload({ ...reference, chainId: 46630 }), /chainId/);
  assert.throws(() => validatePayload({ ...reference, to: anotherWallet }), /destination/);
  assert.throws(() => validatePayload(changeSignedArgs(args => { args[0] = anotherWallet; })), /collection/);
  assert.throws(() => validatePayload({ ...reference, data: sea.encodeFunctionData('mintPublic', [
    CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n,
  ]) }), /mintSigned/);
  assert.throws(() => validatePayload(reference, { from: anotherWallet }), /wallet/);
  assert.throws(() => validatePayload(changeSignedArgs(args => { args[2] = anotherWallet; })), /minter/);
  assert.throws(() => validatePayload(changeSignedArgs(args => { args[1] = ZeroAddress; })), /feeRecipient/);
});

test('payment must equal quantity times price and stay within the explicit cap', () => {
  assert.throws(() => validatePayload({ ...reference, value: '1' }), /value/);
  const priced = changeSignedArgs(args => { args[4][0] = 2n; });
  priced.value = '2';
  assert.equal(validatePayload(priced, { maxValue: 2n }).value, 2n);
  assert.throws(() => validatePayload(priced, { maxValue: 1n }), /max-value/);
  assert.throws(() => validatePayload(changeSignedArgs(args => { args[3] = 0n; })), /quantity/);
});

test('truncated signatures and noncanonical ABI representations are rejected', () => {
  assert.throws(() => validatePayload(changeSignedArgs(args => { args[6] = args[6].slice(0, -2); })), /65 bytes/);
  const oddLength = { ...reference, data: reference.data.slice(0, -1) };
  assert.throws(() => validatePayload(oddLength));
  const corruptedPadding = { ...reference, data: reference.data.slice(0, -10) + '01' + reference.data.slice(-8) };
  assert.throws(() => validatePayload(corruptedPadding), /Non-canonical/);
});

test('preflight uses a single block snapshot and only read RPC methods', async () => {
  const provider = mockProvider();
  const checked = await preflight(provider, validatePayload(reference));
  assert.equal(checked.estimate, 300000n);
  assert.equal(checked.signer, signer);
  assert.deepEqual(checked.stats, { minterNumMinted: 0n, currentTotalSupply: 906n, maxSupply: 1024n });
  assert.equal(checked.mint.data, reference.data);
  const stateReads = provider.calls.filter(({ method }) => ['eth_call', 'eth_getCode', 'eth_estimateGas'].includes(method));
  assert.ok(stateReads.length >= 6);
  assert.ok(stateReads.every(({ params }) => params.at(-1) === checked.block.number));
  assert.ok(provider.calls.every(({ method }) => !method.startsWith('eth_send')));
});

test('mint window accepts both boundaries and rejects times outside them', async () => {
  const mint = validatePayload(reference);
  for (const timestamp of [1789416020, 1789488020]) {
    await preflight(mockProvider({ timestamp }), mint);
  }
  for (const timestamp of [1789416019, 1789488021]) {
    await assert.rejects(preflight(mockProvider({ timestamp }), mint), /inactive/);
  }
});

test('preflight rejects wallet, collection, and stage supply limits independently', async () => {
  const mint = validatePayload(reference);
  await assert.rejects(preflight(mockProvider({ minted: 1n }), mint), /wallet mint limit/);
  await assert.rejects(preflight(mockProvider({ supply: 1024n }), mint), /collection supply limit/);
  await assert.rejects(preflight(mockProvider({ supply: 1024n, maxSupply: 2048n }), mint), /stage total-supply limit/);
});

test('preflight rejects wrong RPC chain and disallowed fee recipient or signer', async () => {
  const mint = validatePayload(reference);
  await assert.rejects(preflight(mockProvider({ chainId: 46630n }), mint), /wrong chain/);
  await assert.rejects(preflight(mockProvider({ feeRecipients: [] }), mint), /Fee recipient/);
  await assert.rejects(preflight(mockProvider({ signers: [] }), mint), /signer/);
  const foreignWallet = validatePayload({ ...reference, from: anotherWallet });
  assert.notEqual(recoverMintSigner(foreignWallet), signer);
  await assert.rejects(preflight(mockProvider(), foreignWallet), /signer/);
});

test('an on-chain replay rejection stops preflight before gas estimation', async () => {
  const replayError = Object.assign(new Error('RPC execution reverted'), {
    code: 'CALL_EXCEPTION', data: sea.encodeErrorResult('SignatureAlreadyUsed', []),
  });
  const provider = mockProvider({ simulationError: replayError });
  await assert.rejects(preflight(provider, validatePayload(reference)), error => error === replayError);
  assert.equal(safeError(replayError), 'Contract reverted: SignatureAlreadyUsed.');
  assert.ok(!provider.calls.some(({ method }) => method === 'eth_estimateGas'));
});

test('public mint needs no signature and uses the configured free phase', async () => {
  const provider = mockProvider({ timestamp: 1789488020 });
  const checked = await preflight(provider, { mode: 'public', from: anotherWallet, quantity: 1n });
  assert.equal(checked.mint.mode, 'public');
  assert.equal(checked.mint.value, 0n);
  assert.equal(checked.signer, undefined);
  assert.equal(checked.mint.mintParams.dropStageIndex, 0n);
  assert.equal(checked.mint.data.slice(0, 10), '0x161ac21f');
  const args = sea.decodeFunctionData('mintPublic', checked.mint.data);
  assert.equal(args.quantity, 1n);
  assert.equal(args.minterIfNotPayer, ZeroAddress);
  const direct = buildPublicMint({
    mintPrice: 0n, startTime: 1789488020n, endTime: 1789491620n,
    maxTotalMintableByWallet: 1n, feeBps: 1000n, restrictFeeRecipients: true,
  }, { from: anotherWallet, quantity: 1n });
  assert.equal(direct.data, checked.mint.data);
  await assert.rejects(preflight(mockProvider(), { mode: 'public', from: anotherWallet, quantity: 1n }), /inactive/);
});
