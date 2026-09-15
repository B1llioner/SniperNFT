import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Transaction, Wallet, ZeroAddress, keccak256, toQuantity } from 'ethers';
import { CONFIG, NFT_ABI, SEADROP_ABI } from '../mint.mjs';

// Fixed, public test material; never load the caller's wallet or RPC environment.
const TEST_KEY = `0x${'11'.repeat(32)}`;
const TEST_WALLET = new Wallet(TEST_KEY).address;
const CLI = fileURLToPath(new URL('../mint.mjs', import.meta.url));
const SEA = new Interface(SEADROP_ABI);
const NFT = new Interface(NFT_ABI);
const NOW = 1_800_000_000n;
const BASE_FEE = 70_000_000n;
const PRIORITY = 1_000n;
const ESTIMATE = 200_000n;

async function rpcStub(t, options = {}) {
  const calls = [];
  const failures = [];
  const price = options.price ?? 0n;
  let submitted;
  let raw;
  let url;
  const server = createServer(async (request, response) => {
    let id = null;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 65536, 'RPC request exceeded fixture limit');
      }
      const message = JSON.parse(body);
      assert.ok(!Array.isArray(message), 'CLI must use individual RPC requests');
      ({ id } = message);
      const { method, params } = message;
      calls.push({ method, params });
      let result;
      switch (method) {
        case 'eth_chainId': result = toQuantity(CONFIG.chainId); break;
        case 'eth_getBlockByNumber':
          result = { number: '0x64', timestamp: toQuantity(NOW), gasLimit: toQuantity(30_000_000n), baseFeePerGas: toQuantity(BASE_FEE) };
          break;
        case 'eth_getCode': result = '0x6000'; break;
        case 'eth_call': {
          const [tx] = params;
          if (tx.to.toLowerCase() === CONFIG.nftContract.toLowerCase()) {
            const decoded = NFT.parseTransaction(tx);
            assert.equal(decoded.name, 'getMintStats');
            assert.equal(decoded.args[0], TEST_WALLET);
            result = NFT.encodeFunctionResult('getMintStats', [0n, 40n, 1024n]);
          } else {
            assert.equal(tx.to.toLowerCase(), CONFIG.seaDrop.toLowerCase());
            const decoded = SEA.parseTransaction(tx);
            switch (decoded.name) {
              case 'getPublicDrop':
                result = SEA.encodeFunctionResult('getPublicDrop', [[price, NOW - 60n, NOW + 3600n, 5n, 1000n, true]]);
                break;
              case 'getFeeRecipientIsAllowed':
                result = SEA.encodeFunctionResult('getFeeRecipientIsAllowed', [true]);
                break;
              case 'mintPublic':
                assert.equal(tx.from.toLowerCase(), TEST_WALLET.toLowerCase());
                result = '0x';
                break;
              default: assert.fail(`Unexpected contract call: ${decoded.name}`);
            }
          }
          break;
        }
        case 'eth_estimateGas': result = toQuantity(ESTIMATE); break;
        case 'eth_maxPriorityFeePerGas': result = toQuantity(PRIORITY); break;
        case 'eth_getBalance': result = toQuantity(10n ** 18n); break;
        case 'eth_getTransactionCount': result = '0x7'; break;
        case 'eth_sendRawTransaction': {
          [raw] = params;
          submitted = Transaction.from(raw);
          if (options.broadcastError) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `synthetic-provider-detail ${TEST_KEY} ${raw} ${url}` } }));
            return;
          }
          result = keccak256(raw);
          break;
        }
        case 'eth_getTransactionReceipt': {
          assert.ok(submitted, 'Receipt lookup preceded submission');
          assert.equal(params[0], keccak256(raw));
          const count = Number(SEA.parseTransaction(submitted).args.quantity);
          const logs = options.missingMintEvents ? [] : Array.from({ length: count }, (_, index) => ({
            address: CONFIG.nftContract,
            ...NFT.encodeEventLog(NFT.getEvent('Transfer'), [ZeroAddress, TEST_WALLET, 41n + BigInt(index)]),
          }));
          result = { status: options.receiptStatus ?? '0x1', blockNumber: '0x65', transactionHash: keccak256(raw), logs };
          break;
        }
        default: assert.fail(`Unexpected RPC method: ${method}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Fixture assertion failed' } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/synthetic-api-token`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'RPC fixture assertions failed');
  });
  return { url, calls, get submitted() { return submitted; }, get raw() { return raw; } };
}

async function runCli(stub, args, key = TEST_KEY) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--public', '--rpc', stub.url, ...args], {
      env: { PRIVATE_KEY: key, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, output: stdout + stderr }); });
  });
}
const sendCalls = stub => stub.calls.filter(call => call.method === 'eth_sendRawTransaction');
function assertRedacted(result, stub) {
  for (const secret of [TEST_KEY, stub.raw, stub.url, 'synthetic-api-token', 'synthetic-provider-detail'].filter(Boolean)) {
    assert.ok(!result.output.includes(secret), 'CLI output leaked synthetic sensitive data');
  }
}

test('public dry run succeeds with malformed PRIVATE_KEY and never broadcasts', async t => {
  const stub = await rpcStub(t);
  const result = await runCli(stub, ['--from', TEST_WALLET], 'not-a-valid-private-key');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"simulation": "passed"/);
  assert.match(result.stdout, /Dry run complete/);
  assert.equal(sendCalls(stub).length, 0);
  assert.ok(!stub.calls.some(call => call.method === 'eth_getTransactionCount'));
  assertRedacted(result, stub);
});

test('explicit send signs exact paid public mint and prints receipt token IDs', async t => {
  const stub = await rpcStub(t, { price: 10n ** 12n });
  const result = await runCli(stub, ['--send', '--quantity', '2', '--max-value-eth', '0.00001']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(sendCalls(stub).length, 1);
  const tx = stub.submitted;
  assert.equal(tx.from, TEST_WALLET);
  assert.equal(tx.to, CONFIG.seaDrop);
  assert.equal(tx.chainId, CONFIG.chainId);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.type, 2);
  assert.equal(tx.value, 2n * 10n ** 12n);
  assert.equal(tx.gasLimit, ESTIMATE * 120n / 100n);
  assert.equal(tx.maxPriorityFeePerGas, PRIORITY);
  assert.equal(tx.maxFeePerGas, BASE_FEE * 2n + PRIORITY);
  assert.equal(tx.data, SEA.encodeFunctionData('mintPublic', [CONFIG.nftContract, CONFIG.feeRecipient, ZeroAddress, 2n]));
  assert.match(result.stdout, /"status": "mined"/);
  assert.match(result.stdout, /"tokenIds": \[\s*"41",\s*"42"\s*\]/);
  assert.ok(result.stdout.includes(keccak256(stub.raw)));
  assertRedacted(result, stub);
});

test('broadcast error sends once and suppresses raw transaction, key and RPC details', async t => {
  const stub = await rpcStub(t, { broadcastError: true });
  const result = await runCli(stub, ['--send']);
  assert.equal(result.code, 1);
  assert.equal(sendCalls(stub).length, 1);
  assert.match(result.stderr, /Broadcast outcome is uncertain/);
  assert.ok(result.stdout.includes(keccak256(stub.raw)));
  assertRedacted(result, stub);
});

for (const [name, options, message] of [
  ['failed receipt', { receiptStatus: '0x0' }, /mined with failure status/],
  ['successful receipt without mint events', { missingMintEvents: true }, /mint events do not match/],
]) test(name, async t => {
  const stub = await rpcStub(t, options);
  const result = await runCli(stub, ['--send']);
  assert.equal(result.code, 1);
  assert.equal(sendCalls(stub).length, 1);
  assert.match(result.stderr, message);
  assert.ok(!result.stdout.includes('"status": "mined"'));
  assertRedacted(result, stub);
});

test('gas cost exceeding explicit ceiling stops before signing or broadcasting', async t => {
  const stub = await rpcStub(t);
  const result = await runCli(stub, ['--send', '--max-gas-cost-eth', '0']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Maximum gas cost exceeds/);
  assert.equal(sendCalls(stub).length, 0);
  assert.ok(!result.stdout.includes('Signed transaction hash'));
  assertRedacted(result, stub);
});
