import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Transaction, Wallet, ZeroAddress, keccak256, toQuantity, zeroPadValue } from 'ethers';
import { CONFIG, NFT_ABI } from '../mint.mjs';
import { gasQuote, loadArtifact, prepareBatch, preflightBatch, readPublicStage, resolveBatchOptions } from '../batch.mjs';

const SYNTHETIC_KEY = `0x${'47'.repeat(32)}`;
const SENDER = new Wallet(SYNTHETIC_KEY).address;
const OTHER = '0x2000000000000000000000000000000000000001';
const FACTORY = '0x2000000000000000000000000000000000000002';
const CLI = fileURLToPath(new URL('../batch.mjs', import.meta.url));
const ARTIFACT = await loadArtifact();
const FACTORY_ABI = new Interface(ARTIFACT.abi);
const SEA_ABI = new Interface(JSON.parse(await readFile(new URL('../research/seadrop-abi.json', import.meta.url), 'utf8')));
const TOKEN_ABI = new Interface(NFT_ABI);
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';
const ARB_GAS_ABI = new Interface(['function getMaxTxGasLimit() view returns (uint256)']);
const NFT_CODE = (await readFile(new URL('../research/nft-runtime.hex', import.meta.url), 'utf8')).trim();
const block = timestamp => ({ number: '0x100', timestamp: toQuantity(timestamp), gasLimit: '0x1c9c380', baseFeePerGas: '0x64' });
const options = (quantity = 3, extra = {}) => resolveBatchOptions({ command: 'mint', from: SENDER }, {
  quantity, factory: FACTORY, recipient: null, minQuantity: null, ...extra,
});
function runtime() {
  const bytes = Buffer.from(ARTIFACT.deployedBytecode.slice(2), 'hex');
  const word = Buffer.from(zeroPadValue(SENDER, 32).slice(2), 'hex');
  for (const group of Object.values(ARTIFACT.immutableReferences)) for (const { start } of group) word.copy(bytes, start);
  return `0x${bytes.toString('hex')}`;
}
function fixture() {
  const calls = [];
  let blockReads = 0;
  let currentTime = 90n;
  return { calls, async send(method, params) {
    calls.push({ method, params, timestamp: currentTime });
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') {
      assert.deepEqual(params, ['latest', false]);
      if (++blockReads >= 3) currentTime = 100n;
      return block(currentTime);
    }
    if (['eth_getCode', 'eth_call', 'eth_estimateGas'].includes(method)) {
      assert.equal(params.length, 2, 'No state override or artificial block time is permitted.');
      assert.equal(params[1], 'latest');
    }
    if (method === 'eth_getCode') {
      if (params[0].toLowerCase() === CONFIG.nftContract.toLowerCase()) return NFT_CODE;
      return params[0].toLowerCase() === FACTORY.toLowerCase() ? runtime() : '0x6000';
    }
    if (method === 'eth_call') {
      const [tx] = params;
      if (tx.to.toLowerCase() === ARB_GAS_INFO) {
        assert.equal(tx.data, ARB_GAS_ABI.encodeFunctionData('getMaxTxGasLimit'));
        return ARB_GAS_ABI.encodeFunctionResult('getMaxTxGasLimit', [32_000_000n]);
      }
      if (tx.to.toLowerCase() === FACTORY.toLowerCase()) {
        const decoded = FACTORY_ABI.parseTransaction(tx);
        return FACTORY_ABI.encodeFunctionResult(decoded.name, [decoded.name === 'mintBatch' ? 2n : SENDER]);
      }
      if (tx.to.toLowerCase() === CONFIG.nftContract.toLowerCase()) {
        assert.equal(TOKEN_ABI.parseTransaction(tx).name, 'getMintStats');
        return TOKEN_ABI.encodeFunctionResult('getMintStats', [0n, 900n, 1024n]);
      }
      assert.equal(tx.to.toLowerCase(), CONFIG.seaDrop.toLowerCase());
      const decoded = SEA_ABI.parseTransaction(tx);
      if (decoded.name === 'getPublicDrop') return SEA_ABI.encodeFunctionResult('getPublicDrop', [[0n, 100n, 200n, 1n, 1000n, true]]);
      assert.equal(decoded.name, 'mintPublic');
      return '0x';
    }
    if (method === 'eth_estimateGas') return toQuantity(1_000_000n);
    if (method === 'eth_maxPriorityFeePerGas') return '0x3';
    if (method === 'eth_gasPrice') return '0x65';
    if (method === 'eth_getBalance') return toQuantity(10n ** 18n);
    if (method === 'eth_getTransactionCount') return '0x7';
    assert.fail(`Unexpected local fixture method: ${method}`);
  } };
}

test('final preflight refuses a head below the configured timestamp or block even after preparation', async () => {
  for (const target of [{ targetTimestamp: 101n }, { targetBlock: 10n ** 20n }]) {
    const rpc = fixture();
    const selected = { ...options(1), ...target };
    const prepared = await prepareBatch(rpc, null, selected);
    const before = rpc.calls.length;
    await assert.rejects(preflightBatch(rpc, null, selected, prepared), /Latest preflight block is below the requested wait/);
    assert.ok(rpc.calls.slice(before).every(call => !['eth_estimateGas', 'eth_call', 'eth_sendRawTransaction'].includes(call.method)));
  }
});

test('warm preparation validates contract and owner without attempting the full mint or estimating gas', async () => {
  for (const quantity of [1, 3]) {
    const rpc = fixture();
    const prepared = await prepareBatch(rpc, quantity === 1 ? null : ARTIFACT, options(quantity));
    assert.equal(prepared.tx.to, quantity === 1 ? CONFIG.seaDrop : FACTORY);
    assert.ok(rpc.calls.every(call => call.method !== 'eth_estimateGas' && call.method !== 'eth_sendRawTransaction'));
    const contractCalls = rpc.calls.filter(call => call.method === 'eth_call');
    assert.equal(contractCalls.length, quantity === 1 ? 0 : 2);
    if (quantity > 1) assert.deepEqual(contractCalls.map(call => FACTORY_ABI.parseTransaction(call.params[0]).name).sort(), ['owner', 'recipient']);
    assert.ok(rpc.calls.every(call => call.timestamp < 100n));
  }
});

test('prepared final preflight refreshes chain/head and still simulates with no repeated code or immutable reads', async () => {
  for (const quantity of [1, 3]) {
    const rpc = fixture();
    const selected = options(quantity);
    const artifact = quantity === 1 ? null : ARTIFACT;
    const prepared = await prepareBatch(rpc, artifact, selected);
    const before = rpc.calls.length;
    const result = await preflightBatch(rpc, artifact, selected, prepared);
    const finalCalls = rpc.calls.slice(before);
    assert.equal(result.tx, prepared.tx);
    assert.equal(result.predictedCount, quantity === 1 ? 1n : 2n);
    assert.deepEqual(finalCalls.map(call => call.method).sort(), ['eth_call', 'eth_chainId', 'eth_estimateGas', 'eth_getBlockByNumber']);
    assert.ok(finalCalls.filter(call => ['eth_call', 'eth_estimateGas'].includes(call.method)).every(call => call.params[1] === 'latest' && call.params.length === 2));
  }
});

test('prepared cache rejects another wallet, contract, count, RPC or fabricated wrapper', async () => {
  const rpc = fixture();
  const selected = options();
  const prepared = await prepareBatch(rpc, ARTIFACT, selected);
  for (const changed of [{ from: OTHER }, { recipient: OTHER }, { factory: OTHER }, { quantity: 4n }, { minQuantity: 2n }]) {
    await assert.rejects(preflightBatch(rpc, ARTIFACT, { ...selected, ...changed }, prepared), /Prepared transaction/);
  }
  await assert.rejects(preflightBatch(fixture(), ARTIFACT, selected, prepared), /Prepared transaction/);
  await assert.rejects(preflightBatch(rpc, ARTIFACT, selected, { ...prepared }), /Prepared transaction/);
  assert.throws(() => { prepared.tx = { ...prepared.tx, to: OTHER }; }, TypeError);
  assert.throws(() => { prepared.tx.data = '0x1234'; }, TypeError);
});

test('warm final preflight rejects a changed chain before mint simulation', async () => {
  const rpc = fixture();
  const selected = options();
  const prepared = await prepareBatch(rpc, ARTIFACT, selected);
  const previousSend = rpc.send.bind(rpc);
  rpc.send = (method, params) => method === 'eth_chainId' ? Promise.resolve('0x1') : previousSend(method, params);
  const before = rpc.calls.length;
  await assert.rejects(preflightBatch(rpc, ARTIFACT, selected, prepared), /changed chain/);
  assert.ok(rpc.calls.slice(before).every(call => call.method !== 'eth_call' && call.method !== 'eth_estimateGas'));
});

test('stage reads bind direct wallet limits to the sender and batch supply checks to zero address', async () => {
  for (const quantity of [1, 3]) {
    const rpc = fixture();
    const result = await readPublicStage(rpc, options(quantity));
    assert.equal(result.startTime, 100n);
    const statsCall = rpc.calls.find(call => call.method === 'eth_call' && call.params[0].to === CONFIG.nftContract);
    const decoded = TOKEN_ABI.parseTransaction(statsCall.params[0]);
    assert.equal(decoded.args.minter, quantity === 1 ? SENDER : ZeroAddress);
  }
});

test('fee multiplier changes the max fee cap and still respects the total gas budget', async () => {
  const base = await gasQuote(fixture(), 100n, block(100n), 100_000n);
  const larger = await gasQuote(fixture(), 100n, block(100n), 100_000n, 4);
  assert.equal(base.gasLimit, 120n);
  assert.equal(base.fees.maxFeePerGas, 203n);
  assert.equal(larger.fees.maxFeePerGas, 403n);
  assert.equal(larger.fees.maxPriorityFeePerGas, 3n);
  assert.equal(larger.maxGasCost, 48_360n);
  await assert.rejects(gasQuote(fixture(), 100n, block(100n), 40_000n, 4), /Maximum gas cost/);
  for (const multiplier of [0, 21, 1.5, Number.NaN]) await assert.rejects(gasQuote(fixture(), 100n, block(100n), 100_000n, multiplier));
});

test('Nitro transaction cap rejects a large batch despite the oversized header limit, and allows exactly the cap', async () => {
  const hugeHeader = { ...block(100n), gasLimit: toQuantity(1n << 50n) };
  const exact = await gasQuote(fixture(), 26_666_666n, hugeHeader, 10n ** 18n);
  assert.equal(exact.gasLimit, 32_000_000n);
  await assert.rejects(gasQuote(fixture(), 26_666_667n, hugeHeader, 10n ** 18n), error => {
    assert.match(error.message, /Total gas limit 32000001 exceeds Nitro maxTxGasLimit 32000000/);
    assert.match(error.message, /conservative check includes any L1 posting gas/);
    assert.match(error.message, /Limits and gas budget will not be increased/);
    return true;
  });
  await assert.rejects(gasQuote(fixture(), 100n, { ...hugeHeader, gasLimit: '0x77' }, 10n ** 18n), /block gas limit/);
});

test('gas quote refuses missing, malformed, zero or oversized Nitro caps without exposing RPC errors', async () => {
  const invalid = ['0x', '0x00', null, 32_000_000,
    ARB_GAS_ABI.encodeFunctionResult('getMaxTxGasLimit', [0n]),
    ARB_GAS_ABI.encodeFunctionResult('getMaxTxGasLimit', [1n << 64n]),
    `${ARB_GAS_ABI.encodeFunctionResult('getMaxTxGasLimit', [32_000_000n])}00`];
  for (const raw of invalid) {
    const rpc = fixture();
    const send = rpc.send.bind(rpc);
    rpc.send = async (method, params) => method === 'eth_call' && params[0].to === ARB_GAS_INFO ? raw : send(method, params);
    await assert.rejects(gasQuote(rpc, 100n, block(100n), 100_000n), /invalid Nitro transaction gas limit/);
  }
  const rpc = fixture();
  const send = rpc.send.bind(rpc);
  rpc.send = async (method, params) => {
    if (method === 'eth_call') throw new Error('https://private.example/api-secret: raw upstream failure');
    return send(method, params);
  };
  await assert.rejects(gasQuote(rpc, 100n, block(100n), 100_000n), error => {
    assert.match(error.message, /Cannot read the required Robinhood Nitro transaction gas limit/);
    assert.doesNotMatch(error.message, /private\.example|api-secret|upstream/);
    return true;
  });
});

test('Nitro cap and fee reads start together for both EIP-1559 and legacy quotes', async () => {
  for (const legacy of [false, true]) {
    const calls = [];
    let releaseCap;
    const waiting = new Promise(resolve => { releaseCap = resolve; });
    const rpc = { async send(method, params) {
      calls.push(method);
      if (method === 'eth_call') {
        assert.deepEqual(params, [{ to: ARB_GAS_INFO, data: ARB_GAS_ABI.encodeFunctionData('getMaxTxGasLimit') }, 'latest']);
        await waiting;
        return ARB_GAS_ABI.encodeFunctionResult('getMaxTxGasLimit', [32_000_000n]);
      }
      assert.equal(method, legacy ? 'eth_gasPrice' : 'eth_maxPriorityFeePerGas');
      return '0x3';
    } };
    const quote = gasQuote(rpc, 100n, { ...block(100n), ...(legacy ? { baseFeePerGas: null } : {}) }, 100_000n);
    const started = [...calls];
    releaseCap();
    const result = await quote;
    assert.deepEqual(started, ['eth_call', legacy ? 'eth_gasPrice' : 'eth_maxPriorityFeePerGas']);
    assert.equal(result.gasLimit, 120n);
    assert.equal(result.fees.type, legacy ? 0 : 2);
    assert.equal(result.fees.gasPrice ?? result.fees.maxFeePerGas, legacy ? 3n : 203n);
  }
});

function logsFor(quantity) {
  if (quantity === 1) return [
    { address: CONFIG.nftContract, ...TOKEN_ABI.encodeEventLog(TOKEN_ABI.getEvent('Transfer'), [ZeroAddress, SENDER, 901n]) },
    { address: CONFIG.seaDrop, ...SEA_ABI.encodeEventLog(SEA_ABI.getEvent('SeaDropMint'), [CONFIG.nftContract, SENDER, CONFIG.feeRecipient, SENDER, 1n, 0n, 1000n, 0n]) },
  ];
  return [901n, 902n].map((tokenId, index) => ({ address: FACTORY,
    ...FACTORY_ABI.encodeEventLog(FACTORY_ABI.getEvent('TokenMinted'), [
      `0x300000000000000000000000000000000000000${index + 1}`, SENDER, tokenId,
    ]),
  })).concat({ address: FACTORY, ...FACTORY_ABI.encodeEventLog(FACTORY_ABI.getEvent('BatchMinted'), [SENDER, 2n]) });
}
async function serve(t, quantity) {
  const rpc = fixture();
  const sent = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    let id = null;
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length <= 65536); }
      const message = JSON.parse(body);
      ({ id } = message);
      let result;
      if (message.method === 'eth_sendRawTransaction') {
        sent.push(message.params[0]); result = keccak256(message.params[0]);
      } else if (message.method === 'eth_getTransactionReceipt') {
        result = { status: '0x1', transactionHash: message.params[0], blockNumber: '0x101', logs: logsFor(quantity) };
      } else result = await rpc.send(message.method, message.params);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Local fixture failure' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); });
  return { sent, calls: rpc.calls, url: `http://127.0.0.1:${server.address().port}/synthetic-private-rpc-token` };
}
async function runWarmCli(t, quantity, endpoints) {
  const directory = await mkdtemp(join(tmpdir(), 'vinos-warm-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'synthetic-warm.json');
  await writeFile(config, JSON.stringify({ quantity, factory: quantity === 1 ? null : FACTORY,
    recipient: null, minQuantity: null, rpcUrls: endpoints.map(endpoint => endpoint.url),
    concurrency: 2, attempts: 2, retryDelayMs: 0, maxFeeMultiplier: 4,
    waitTimeoutSeconds: 2, pollIntervalMs: 100, keepAliveIntervalMs: 1000 }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mint', '--wait', '--send', '--config', config], {
      env: { PRIVATE_KEY: SYNTHETIC_KEY, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Warm CLI fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
for (const quantity of [1, 3]) test(`warm CLI quantity ${quantity} prepares once and sends one identical transaction through two RPCs`, async t => {
  const endpoints = [await serve(t, quantity), await serve(t, quantity)];
  const result = await runWarmCli(t, quantity, endpoints);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"warmStatus": "stage ready"/);
  assert.match(result.stdout, /"waitMode": true/);
  assert.match(result.stdout, /"maxFeeMultiplier": 4/);
  assert.match(result.stdout, /"status": "mined"/);
  assert.deepEqual(endpoints.map(endpoint => endpoint.sent.length), [1, 1]);
  assert.equal(endpoints[0].sent[0], endpoints[1].sent[0]);
  const signed = Transaction.from(endpoints[0].sent[0]);
  assert.equal(signed.to, quantity === 1 ? CONFIG.seaDrop : FACTORY);
  assert.equal(signed.from, SENDER);
  assert.equal(signed.nonce, 7);
  assert.equal(signed.maxFeePerGas, 403n);
  assert.equal(endpoints.flatMap(endpoint => endpoint.calls).filter(call => call.method === 'eth_getTransactionCount').length, 1);
  for (const endpoint of endpoints) {
    const codeReads = endpoint.calls.filter(call => call.method === 'eth_getCode');
    assert.equal(codeReads.length, quantity === 1 ? 2 : 3);
    assert.ok(codeReads.every(call => call.timestamp < 100n));
  }
  for (const secret of [SYNTHETIC_KEY, endpoints[0].sent[0], ...endpoints.map(endpoint => endpoint.url)]) {
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});
