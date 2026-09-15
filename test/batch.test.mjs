import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Transaction, Wallet, ZeroAddress, getCreateAddress, keccak256, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, NFT_ABI } from '../mint.mjs';
import {
  loadArtifact, parseBatchArgs, preflightBatch, resolveBatchOptions,
  verifyBatchReceipt, verifyDirectReceipt, verifyFactoryCode,
} from '../batch.mjs';

// Public synthetic wallet material and a fresh local RPC fixture only.
const TEST_KEY = `0x${'11'.repeat(32)}`;
const SENDER = new Wallet(TEST_KEY).address;
const RECIPIENT = '0x1000000000000000000000000000000000000001';
const FACTORY = '0x1000000000000000000000000000000000000002';
const HELPERS = ['0x2000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002'];
const CLI = fileURLToPath(new URL('../batch.mjs', import.meta.url));
const ARTIFACT = await loadArtifact();
const ABI = new Interface(ARTIFACT.abi);
const SEA_ABI = new Interface(JSON.parse(await readFile(new URL('../research/seadrop-abi.json', import.meta.url), 'utf8')));
const TOKEN_ABI = new Interface(NFT_ABI);
const NFT_CODE = (await readFile(new URL('../research/nft-runtime.hex', import.meta.url), 'utf8')).trim();
const BASE_CONFIG = { factory: FACTORY, rpcUrls: ['http://127.0.0.1:1'], quantity: 3, minQuantity: 2 };
const SINGLE_CONFIG = { quantity: 1, minQuantity: null, factory: null, recipient: null };
const options = (config = {}, args = {}) => resolveBatchOptions({ command: 'mint', from: SENDER, ...args }, { ...BASE_CONFIG, ...config });

function factoryRuntime(owner = SENDER, recipient = SENDER) {
  const bytes = Buffer.from(ARTIFACT.deployedBytecode.slice(2), 'hex');
  const groups = Object.values(ARTIFACT.immutableReferences);
  for (const [index, group] of groups.entries()) {
    const word = Buffer.from(zeroPadValue([owner, recipient][index], 32).slice(2), 'hex');
    for (const { start } of group) word.copy(bytes, start);
  }
  return `0x${bytes.toString('hex')}`;
}
function event(name, values, factory = FACTORY) {
  return { address: factory, ...ABI.encodeEventLog(ABI.getEvent(name), values) };
}
function batchReceipt(recipient = SENDER) {
  return { status: '0x1', blockNumber: '0x65', logs: [
    event('TokenMinted', [HELPERS[0], recipient, 901n]),
    event('TokenMinted', [HELPERS[1], recipient, 902n]),
    event('BatchMinted', [recipient, 2n]),
  ] };
}
function transferEvent(from = ZeroAddress, to = SENDER, tokenId = 903n) {
  return { address: CONFIG.nftContract, ...TOKEN_ABI.encodeEventLog(TOKEN_ABI.getEvent('Transfer'), [from, to, tokenId]) };
}
function seaDropMintEvent(overrides = {}) {
  const values = {
    nftContract: CONFIG.nftContract, minter: SENDER, feeRecipient: CONFIG.feeRecipient,
    payer: SENDER, quantityMinted: 1n, unitMintPrice: 0n, feeBps: 1000n, dropStageIndex: 0n,
    ...overrides,
  };
  return { address: CONFIG.seaDrop, ...SEA_ABI.encodeEventLog(SEA_ABI.getEvent('SeaDropMint'), [
    values.nftContract, values.minter, values.feeRecipient, values.payer,
    values.quantityMinted, values.unitMintPrice, values.feeBps, values.dropStageIndex,
  ]) };
}
function directReceipt() {
  return { status: '0x1', blockNumber: '0x65', logs: [transferEvent(), seaDropMintEvent()] };
}

test('batch configuration defaults to up-to quantity with minimum one and preserves explicit limits', () => {
  const resolved = options({ quantity: 7, minQuantity: null, recipient: null });
  assert.equal(resolved.quantity, 7n);
  assert.equal(resolved.minQuantity, 1n);
  assert.equal(resolved.recipient, SENDER);
  const withoutMinimum = { ...BASE_CONFIG, quantity: 7 };
  delete withoutMinimum.minQuantity;
  assert.equal(resolveBatchOptions({ command: 'mint', from: SENDER }, withoutMinimum).minQuantity, 1n);
  assert.equal(options({ quantity: 7, minQuantity: 7 }).minQuantity, 7n);
  assert.equal(options({ quantity: 7, minQuantity: 3 }).minQuantity, 3n);
  const overridden = options({ quantity: 7, minQuantity: null }, { quantity: '4', 'min-quantity': '1', recipient: RECIPIENT });
  assert.equal(overridden.quantity, 4n);
  assert.equal(overridden.minQuantity, 1n);
  assert.equal(overridden.recipient, RECIPIENT);
  assert.equal(options({ quantity: 1024, minQuantity: 1 }).quantity, 1024n);
});

test('quantity one selects direct mint without a factory and binds the recipient to the payer', () => {
  const resolved = options(SINGLE_CONFIG);
  assert.equal(resolved.route, 'direct');
  assert.equal(resolved.factory, undefined);
  assert.equal(resolved.quantity, 1n);
  assert.equal(resolved.minQuantity, 1n);
  assert.equal(resolved.recipient, SENDER);
  assert.equal(options({ ...SINGLE_CONFIG, factory: 'unused-invalid-factory' }).factory, undefined);
  assert.throws(() => options({ ...SINGLE_CONFIG, recipient: RECIPIENT }), /recipient|wallet/);
  assert.throws(() => options({ quantity: 2, minQuantity: 2, factory: null }), /factory/);
});

test('batch rejects invalid counts, gas amounts, endpoints and broadcast limits before execution', () => {
  for (const config of [
    { quantity: 0 }, { quantity: -1 }, { quantity: 1025 }, { quantity: 1.5 }, { quantity: '1e2' },
    { quantity: Number.MAX_SAFE_INTEGER + 1 }, { minQuantity: 0 }, { minQuantity: 4 },
    { maxGasCostEth: -1 }, { maxGasCostEth: '-1' }, { maxGasCostEth: 'NaN' },
    { maxGasCostEth: '0.0000000000000000001' }, { recipient: ZeroAddress }, { factory: ZeroAddress },
    { rpcUrls: [] }, { rpcUrls: Array(9).fill('http://127.0.0.1:1') }, { rpcUrls: [null] },
    { concurrency: 0 }, { concurrency: 9 }, { attempts: 0 }, { attempts: 6 },
    { retryDelayMs: 5001 }, { receiptTimeoutSeconds: 601 }, { typoQuantity: 10 },
  ]) assert.throws(() => options(config), undefined, JSON.stringify(config));
  assert.throws(() => resolveBatchOptions({ command: 'mint', from: SENDER }, []));
  assert.equal(options({ retryDelayMs: 5000 }).retryDelayMs, 5000);
  assert.throws(() => parseBatchArgs(['mint', '--quantity', '2', '--max-count', '3']));
  assert.throws(() => parseBatchArgs(['mint', '--quantity', '2', '--quantity', '3']));
  assert.equal(parseBatchArgs(['deploy', '--quantity', '2']).quantity, '2');
  assert.throws(() => parseBatchArgs(['mint', '--unknown']));
  assert.equal(parseBatchArgs(['mint', '--send']).send, true);
});

test('factory runtime permits consistent immutable substitutions and rejects changed instructions', () => {
  assert.equal(verifyFactoryCode(factoryRuntime(SENDER, RECIPIENT), ARTIFACT), true);
  const changed = Buffer.from(factoryRuntime().slice(2), 'hex');
  changed[0] ^= 1;
  assert.throws(() => verifyFactoryCode(`0x${changed.toString('hex')}`, ARTIFACT), /runtime/);
  assert.throws(() => verifyFactoryCode(`${factoryRuntime()}00`, ARTIFACT), /runtime/);
  const inconsistent = Buffer.from(factoryRuntime().slice(2), 'hex');
  inconsistent[Object.values(ARTIFACT.immutableReferences)[0][0].start + 31] ^= 1;
  assert.throws(() => verifyFactoryCode(`0x${inconsistent.toString('hex')}`, ARTIFACT), /inconsistent immutable/);
});

test('factory runtime rejects malformed or overlapping immutable reference metadata', () => {
  const malformed = structuredClone(ARTIFACT);
  const groups = Object.values(malformed.immutableReferences);
  groups[0][0].start = -1;
  assert.throws(() => verifyFactoryCode(ARTIFACT.deployedBytecode, malformed), /offset/);
  const overlap = structuredClone(ARTIFACT);
  const repeated = Object.values(overlap.immutableReferences);
  repeated[1][0] = { ...repeated[0][0] };
  assert.throws(() => verifyFactoryCode(ARTIFACT.deployedBytecode, overlap), /Overlapping/);
  assert.throws(() => verifyFactoryCode(ARTIFACT.deployedBytecode, { ...ARTIFACT, immutableReferences: {} }), /immutable references/);
});

test('batch receipt verifies bounds and returns unique helpers and IDs for the selected recipient', () => {
  const receipt = batchReceipt(RECIPIENT);
  receipt.logs.push(event('BatchMinted', [RECIPIENT, 99n], HELPERS[0]));
  const result = verifyBatchReceipt(receipt, ARTIFACT, options({ recipient: RECIPIENT }));
  assert.equal(result.count, 2n);
  assert.deepEqual(result.helpers, HELPERS);
  assert.deepEqual(result.tokenIds, [901n, 902n]);
});

test('batch receipt rejects wrong recipients, duplicate tokens/helpers, missing or false count events', () => {
  const mutations = [
    receipt => { receipt.logs[0] = event('TokenMinted', [HELPERS[0], RECIPIENT, 901n]); },
    receipt => { receipt.logs[1] = event('TokenMinted', [HELPERS[0], SENDER, 902n]); },
    receipt => { receipt.logs[1] = event('TokenMinted', [HELPERS[1], SENDER, 901n]); },
    receipt => { receipt.logs[0] = event('TokenMinted', [ZeroAddress, SENDER, 901n]); },
    receipt => { receipt.logs[0] = event('TokenMinted', [HELPERS[0], SENDER, 0n]); },
    receipt => { receipt.logs[2] = event('BatchMinted', [RECIPIENT, 2n]); },
    receipt => { receipt.logs[2] = event('BatchMinted', [SENDER, 4n]); },
    receipt => { receipt.logs[2] = event('BatchMinted', [SENDER, 1n]); },
    receipt => { receipt.logs.push(receipt.logs[2]); },
    receipt => { receipt.logs.pop(); },
    receipt => { receipt.logs[2].address = HELPERS[0]; },
  ];
  for (const mutate of mutations) {
    const receipt = batchReceipt();
    mutate(receipt);
    assert.throws(() => verifyBatchReceipt(receipt, ARTIFACT, options()));
  }
});

test('direct receipt confirms one matching NFT mint and the public SeaDrop mint event', () => {
  const receipt = directReceipt();
  receipt.logs.push({ ...transferEvent(), address: FACTORY });
  assert.deepEqual(verifyDirectReceipt(receipt, options(SINGLE_CONFIG)), { count: 1n, tokenIds: [903n] });
});

test('direct receipt rejects missing, duplicate, foreign, or inconsistent mint events', () => {
  const mutations = [
    receipt => { receipt.logs.shift(); },
    receipt => { receipt.logs.pop(); },
    receipt => { receipt.logs.push(receipt.logs[0]); },
    receipt => { receipt.logs.push(receipt.logs[1]); },
    receipt => { receipt.logs[0].address = FACTORY; },
    receipt => { receipt.logs[1].address = FACTORY; },
    receipt => { receipt.logs[0] = transferEvent(SENDER, SENDER); },
    receipt => { receipt.logs[0] = transferEvent(ZeroAddress, RECIPIENT); },
    receipt => { receipt.logs[0] = transferEvent(ZeroAddress, SENDER, 0n); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ nftContract: FACTORY }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ minter: RECIPIENT }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ payer: RECIPIENT }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ feeRecipient: RECIPIENT }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ quantityMinted: 2n }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ unitMintPrice: 1n }); },
    receipt => { receipt.logs[1] = seaDropMintEvent({ dropStageIndex: 4n }); },
  ];
  for (const mutate of mutations) {
    const receipt = directReceipt();
    mutate(receipt);
    assert.throws(() => verifyDirectReceipt(receipt, options(SINGLE_CONFIG)));
  }
});

function mockRpc(overrides = {}) {
  const calls = [];
  return { calls, async send(method, params) {
    calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    switch (method) {
      case 'eth_chainId': return toQuantity(CONFIG.chainId);
      case 'eth_getBlockByNumber': return { number: '0x64', timestamp: '0x6b49d200', gasLimit: '0x1c9c380', baseFeePerGas: '0x4248c00' };
      case 'eth_getCode':
        if (params[0].toLowerCase() === CONFIG.nftContract.toLowerCase()) return NFT_CODE;
        return params[0].toLowerCase() === FACTORY.toLowerCase() ? factoryRuntime() : '0x6000';
      case 'eth_call': {
        const [tx] = params;
        if (tx.to == null) return factoryRuntime();
        if (tx.to.toLowerCase() === CONFIG.seaDrop.toLowerCase()) {
          const decoded = SEA_ABI.parseTransaction(tx);
          assert.equal(decoded.name, 'mintPublic');
          assert.equal(decoded.args.quantity, 1n);
          return '0x';
        }
        const decoded = ABI.parseTransaction(tx);
        if (decoded.name === 'owner' || decoded.name === 'recipient') return ABI.encodeFunctionResult(decoded.name, [SENDER]);
        assert.equal(decoded.name, 'mintBatch');
        return ABI.encodeFunctionResult('mintBatch', [2n]);
      }
      case 'eth_estimateGas': return toQuantity(1_000_000n);
      case 'eth_maxPriorityFeePerGas': return '0x3e8';
      case 'eth_getBalance': return toQuantity(10n ** 18n);
      case 'eth_getTransactionCount': return '0x7';
      default: assert.fail(`Unexpected fixture method: ${method}`);
    }
  } };
}

test('preflight verifies runtime and ownership, and encodes configured maximum and minimum counts', async () => {
  const rpc = mockRpc();
  const result = await preflightBatch(rpc, ARTIFACT, options());
  assert.equal(result.tx.to, FACTORY);
  assert.equal(result.tx.from, SENDER);
  assert.equal(result.tx.value, '0x0');
  assert.equal(result.tx.data, ABI.encodeFunctionData('mintBatch', [3n, 2n]));
  assert.equal(result.predictedCount, 2n);
  assert.equal(result.estimate, 1_000_000n);
  assert.ok(!rpc.calls.some(call => call.method === 'eth_sendRawTransaction'));
  const deployed = await preflightBatch(mockRpc(), ARTIFACT, options({}, { command: 'deploy' }));
  assert.equal(deployed.tx.to, undefined);
  assert.equal(deployed.tx.data, ARTIFACT.bytecode + ABI.encodeDeploy([SENDER]).slice(2));
});

test('default up-to ten accepts a remaining count of three in both simulation and receipt', async () => {
  const selected = options({ quantity: 10, minQuantity: null });
  const rpc = mockRpc({ eth_call: ([tx]) => {
    const decoded = ABI.parseTransaction(tx);
    if (decoded.name === 'owner' || decoded.name === 'recipient') return ABI.encodeFunctionResult(decoded.name, [SENDER]);
    assert.equal(decoded.name, 'mintBatch');
    assert.deepEqual(Array.from(decoded.args), [10n, 1n]);
    return ABI.encodeFunctionResult('mintBatch', [3n]);
  } });
  const simulated = await preflightBatch(rpc, ARTIFACT, selected);
  assert.equal(simulated.predictedCount, 3n);
  const receipt = batchReceipt();
  receipt.logs.splice(2, 1,
    event('TokenMinted', ['0x2000000000000000000000000000000000000003', SENDER, 903n]),
    event('BatchMinted', [SENDER, 3n]));
  const verified = verifyBatchReceipt(receipt, ARTIFACT, selected);
  assert.equal(verified.count, 3n);
  assert.deepEqual(verified.tokenIds, [901n, 902n, 903n]);
  assert.ok(!rpc.calls.some(call => call.method === 'eth_sendRawTransaction'));
});

test('batch preflight works without historical state and reports the initially observed head', async () => {
  for (const [command, config] of [['mint', {}], ['deploy', {}], ['mint', SINGLE_CONFIG]]) {
    const backing = mockRpc();
    const latestOnly = { async send(method, params) {
      if (['eth_getCode', 'eth_call', 'eth_estimateGas'].includes(method)) {
        assert.equal(params[1], 'latest', `${method} must not require archive state`);
      }
      return backing.send(method, params);
    } };
    const result = await preflightBatch(latestOnly, command === 'mint' && config === SINGLE_CONFIG ? null : ARTIFACT, options(config, { command }));
    assert.equal(result.block.number, '0x64');
    assert.equal(result.estimate, 1_000_000n);
    const methods = new Set(backing.calls.map(call => call.method));
    assert.ok(['eth_getCode', 'eth_call', 'eth_estimateGas'].every(method => methods.has(method)));
  }
});

test('direct preflight needs no artifact or factory and simulates a single free mint to the payer', async () => {
  const rpc = mockRpc();
  const result = await preflightBatch(rpc, null, options(SINGLE_CONFIG));
  assert.equal(result.tx.to, CONFIG.seaDrop);
  assert.equal(result.tx.from, SENDER);
  assert.equal(result.tx.value, '0x0');
  assert.equal(result.tx.data, SEA_ABI.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 1n]));
  assert.equal(result.predictedCount, 1n);
  assert.ok(rpc.calls.every(call => call.method !== 'eth_call' || call.params[0].to === CONFIG.seaDrop));
  assert.ok(rpc.calls.every(call => call.method !== 'eth_getCode' || [CONFIG.nftContract, CONFIG.seaDrop].includes(call.params[0])));
  assert.ok(!rpc.calls.some(call => call.method === 'eth_sendRawTransaction'));
});

test('preflight rejects wrong chain, NFT runtime, factory owner/recipient, and simulated count', async () => {
  await assert.rejects(preflightBatch(mockRpc({ eth_chainId: () => '0x1' }), ARTIFACT, options()), /wrong chain/);
  await assert.rejects(preflightBatch(mockRpc({ eth_getCode: () => '0x6000' }), ARTIFACT, options()), /NFT runtime/);
  for (const method of ['owner', 'recipient']) {
    const rpc = mockRpc({ eth_call: params => {
      const decoded = ABI.parseTransaction(params[0]);
      return ABI.encodeFunctionResult(decoded.name, [decoded.name === method ? RECIPIENT : SENDER]);
    } });
    await assert.rejects(preflightBatch(rpc, ARTIFACT, options()), /does not own|recipient differs/);
  }
  const wrongCount = mockRpc({ eth_call: params => {
    const decoded = ABI.parseTransaction(params[0]);
    return ABI.encodeFunctionResult(decoded.name, [decoded.name === 'mintBatch' ? 4n : SENDER]);
  } });
  await assert.rejects(preflightBatch(wrongCount, ARTIFACT, options()), /unexpected mint count/);
});

async function httpRpc(t, { deployment = false, direct = false, soldOut = false } = {}) {
  const deployedFactory = getCreateAddress({ from: SENDER, nonce: 7 });
  const rpc = mockRpc(deployment ? { eth_getCode: ([target]) => {
    if (target.toLowerCase() === CONFIG.nftContract.toLowerCase()) return NFT_CODE;
    return target.toLowerCase() === deployedFactory.toLowerCase() ? factoryRuntime() : '0x6000';
  } } : {});
  const submissions = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    let id = null;
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length < 65536); }
      const message = JSON.parse(body);
      ({ id } = message);
      if (['eth_getCode', 'eth_call', 'eth_estimateGas'].includes(message.method)) {
        assert.equal(message.params[1], 'latest', 'The fixture does not provide historical state');
      }
      let result;
      if (soldOut && message.method === 'eth_call' && message.params[0].to?.toLowerCase() === FACTORY.toLowerCase()
        && ABI.parseTransaction(message.params[0]).name === 'mintBatch') {
        const decoded = ABI.parseTransaction(message.params[0]);
        assert.deepEqual(Array.from(decoded.args), [10n, 1n]);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted',
          data: ABI.encodeErrorResult('InsufficientSupply', [0n, 1n]) } }));
        return;
      }
      if (message.method === 'eth_sendRawTransaction') {
        const [raw] = message.params;
        submissions.push(raw);
        result = keccak256(raw);
      } else if (message.method === 'eth_getTransactionReceipt') {
        result = { ...(direct ? directReceipt() : batchReceipt()), transactionHash: message.params[0],
          ...(deployment ? { contractAddress: deployedFactory, logs: [] } : {}) };
      } else result = await rpc.send(message.method, message.params);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Fixture assertion failed' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); });
  return { url: `http://127.0.0.1:${server.address().port}/synthetic-api-token`, submissions, calls: rpc.calls };
}
async function runCli(t, endpoints, extra = [], key = TEST_KEY, command = 'mint', configOverride = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-batch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'synthetic-config.json');
  await writeFile(configPath, JSON.stringify({ ...BASE_CONFIG, factory: command === 'deploy' ? null : BASE_CONFIG.factory, recipient: null, ...configOverride,
    rpcUrls: endpoints.map(endpoint => endpoint.url), attempts: 2, concurrency: 2, retryDelayMs: 0 }));
  return new Promise((resolve, reject) => {
    const stateArgs = command === 'deploy' ? ['--state-file', join(directory, 'factory-state.json')] : [];
    const child = spawn(process.execPath, [CLI, command, '--config', configPath, '--from', SENDER, ...stateArgs, ...extra], {
      env: { PRIVATE_KEY: key, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Batch CLI fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, output: stdout + stderr }); });
  });
}

test('batch dry run uses config, ignores malformed PRIVATE_KEY, and sends to no endpoint', async t => {
  const endpoints = [await httpRpc(t), await httpRpc(t)];
  const result = await runCli(t, endpoints, [], 'not-a-private-key');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"quantity": "3"/);
  assert.match(result.stdout, /"minQuantity": "2"/);
  assert.match(result.stdout, /"simulation": "passed"/);
  assert.ok(endpoints.every(endpoint => endpoint.submissions.length === 0));
});

test('zero remaining supply rejects default up-to mint during preflight before signing or broadcasting', async t => {
  const endpoints = [await httpRpc(t, { soldOut: true }), await httpRpc(t, { soldOut: true })];
  const result = await runCli(t, endpoints, ['--send'], TEST_KEY, 'mint', { quantity: 10, minQuantity: null });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /InsufficientSupply/);
  assert.ok(endpoints.every(endpoint => endpoint.submissions.length === 0));
  assert.ok(!result.stdout.includes('Signed transaction hash'));
  assert.ok(endpoints.every(endpoint => !endpoint.calls.some(call => call.method === 'eth_estimateGas'
    || call.method === 'eth_getTransactionCount')));
});

test('quantity-one null-factory dry run ignores private-key contents and broadcasts nothing', async t => {
  const endpoints = [await httpRpc(t, { direct: true }), await httpRpc(t, { direct: true })];
  const result = await runCli(t, endpoints, [], 'not-a-private-key', 'mint', SINGLE_CONFIG);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"route": "direct"/);
  assert.match(result.stdout, /"quantity": "1"/);
  assert.match(result.stdout, /"simulation": "passed"/);
  assert.ok(endpoints.every(endpoint => endpoint.submissions.length === 0));
  assert.ok(!result.stdout.includes('Signed transaction hash'));
});

test('quantity-one send fans out identical direct SeaDrop bytes and confirms the recipient NFT', async t => {
  const endpoints = [await httpRpc(t, { direct: true }), await httpRpc(t, { direct: true })];
  const result = await runCli(t, endpoints, ['--send'], TEST_KEY, 'mint', SINGLE_CONFIG);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(endpoints.map(endpoint => endpoint.submissions.length), [1, 1]);
  const [raw] = endpoints[0].submissions;
  assert.equal(endpoints[1].submissions[0], raw);
  const tx = Transaction.from(raw);
  assert.equal(tx.chainId, CONFIG.chainId);
  assert.equal(tx.from, SENDER);
  assert.equal(tx.to, CONFIG.seaDrop);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.value, 0n);
  const decoded = SEA_ABI.parseTransaction(tx);
  assert.equal(decoded.name, 'mintPublic');
  assert.equal(decoded.args.nftContract, CONFIG.nftContract);
  assert.equal(decoded.args.feeRecipient, CONFIG.feeRecipient);
  assert.equal(decoded.args.minterIfNotPayer, ZeroAddress);
  assert.equal(decoded.args.quantity, 1n);
  assert.match(result.stdout, /"status": "mined"/);
  assert.match(result.stdout, /"tokenIds": \[\s*"903"\s*\]/);
  for (const sensitive of [TEST_KEY, raw, ...endpoints.map(endpoint => endpoint.url), 'synthetic-api-token']) {
    assert.ok(!result.output.includes(sensitive), 'Direct CLI output leaked synthetic sensitive data');
  }
});

test('deploy quantity one is unnecessary and does not read the key or contact RPCs', async t => {
  const endpoints = [await httpRpc(t), await httpRpc(t)];
  const result = await runCli(t, endpoints, ['--send'], 'not-a-private-key', 'deploy', SINGLE_CONFIG);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"status": "unnecessary"/);
  assert.ok(!result.stdout.includes('Signed transaction hash'));
  assert.ok(endpoints.every(endpoint => endpoint.submissions.length === 0 && endpoint.calls.length === 0));
});

test('batch send fans out one identical signed transaction and reports the two received NFTs', async t => {
  const endpoints = [await httpRpc(t), await httpRpc(t)];
  const result = await runCli(t, endpoints, ['--send']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(endpoints.map(endpoint => endpoint.submissions.length), [1, 1]);
  const [raw] = endpoints[0].submissions;
  assert.equal(endpoints[1].submissions[0], raw);
  const tx = Transaction.from(raw);
  assert.equal(tx.chainId, CONFIG.chainId);
  assert.equal(tx.from, SENDER);
  assert.equal(tx.to, FACTORY);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.value, 0n);
  assert.equal(tx.gasLimit, 1_200_000n);
  assert.equal(tx.data, ABI.encodeFunctionData('mintBatch', [3n, 2n]));
  assert.match(result.stdout, /"status": "mined"/);
  assert.match(result.stdout, /"tokenIds": \[\s*"901",\s*"902"\s*\]/);
  for (const sensitive of [TEST_KEY, raw, ...endpoints.map(endpoint => endpoint.url), 'synthetic-api-token']) {
    assert.ok(!result.output.includes(sensitive), 'Batch CLI output leaked synthetic sensitive data');
  }
});

test('deployment verifies runtime and immutable getters through a latest-only RPC', async t => {
  const endpoint = await httpRpc(t, { deployment: true });
  const result = await runCli(t, [endpoint], ['--send'], TEST_KEY, 'deploy');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"status": "deployed"/);
  assert.equal(endpoint.submissions.length, 1);
  const deployedFactory = getCreateAddress({ from: SENDER, nonce: 7 });
  const runtimeReads = endpoint.calls.filter(call => call.method === 'eth_getCode'
    && call.params[0].toLowerCase() === deployedFactory.toLowerCase());
  assert.equal(runtimeReads.length, 1);
  assert.equal(runtimeReads[0].params[1], 'latest');
  const getterReads = endpoint.calls.filter(call => call.method === 'eth_call'
    && call.params[0].to?.toLowerCase() === deployedFactory.toLowerCase());
  assert.equal(getterReads.length, 2);
  assert.ok(getterReads.every(call => call.params[1] === 'latest'));
});

test('batch gas ceiling prevents signing and all endpoint submissions', async t => {
  const endpoints = [await httpRpc(t), await httpRpc(t)];
  const result = await runCli(t, endpoints, ['--send', '--max-gas-cost-eth', '0']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Maximum gas cost exceeds/);
  assert.ok(endpoints.every(endpoint => endpoint.submissions.length === 0));
  assert.ok(!result.stdout.includes('Signed transaction hash'));
});
