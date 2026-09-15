#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Interface, Transaction, Wallet, ZeroAddress, getAddress, isHexString, keccak256 } from 'ethers';
import { CONFIG, MintError, createProvider, parseUint } from './mint.mjs';
import { main as runBatch, parseBatchArgs, readBatchConfig, resolveBatchOptions, loadArtifact,
  prepareBatch, preflightBatch, readPublicStage, waitReceipt, safeBatchError, checkGasLimit } from './batch.mjs';
import { broadcastIdentical } from './lib/broadcast.mjs';
import { openFactoryState } from './lib/factory-state.mjs';
import { openSequencer } from './lib/sequencer.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const check = (ok, message) => { if (!ok) throw new MintError(message); };
const print = value => console.log(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2));
const HELP = `Persistent factory launcher / Robinhood Chain (4663)
  node batch.mjs setup --config batch.config.json --send
  node batch.mjs start --config batch.config.json --send
  node batch.mjs deploy --config batch.config.json --send
setup: reuse or deploy a factory, verify it, then wait and mint.
start: use a verified existing factory, then wait and mint. Never deploys.
deploy: reuse or deploy and verify the factory, then exit.
Quantity 1 needs no factory: setup/start directly run mint --wait.
Without --send, only read-only checks/simulation run. A missing factory can be
simulated by setup/deploy, but waiting for a mint requires an actual factory.
All usual batch options apply. Additional option:
--state-file FILE  Override .state/factory-4663-WALLET.json in the project.
--sequencer        Deploy and mint through the official send-only sequencer.
--sequencer-url URL  Override the Nitro send endpoint; also enables sequencer mode.
--wait-until-timestamp N  Wait for chain Unix time and the actual public stage.
--wait-until-block N      Also wait until this block height is observed.
Deploy starts immediately; time/block conditions apply to the mint.
rpcUrls/--rpc remain read RPCs for chain checks, simulation, nonce and receipts.
One state file must be shared by all runs for a wallet. Never delete a pending
state to retry: setup --send recovers the same deployment transaction.
PRIVATE_KEY is read only with --send. State never contains the private key.`;

export function parseFactoryArgs(argv) {
  const [action, ...tokens] = argv;
  check(['setup', 'start', 'deploy'].includes(action), 'Choose setup, start or deploy.');
  const rest = [];
  let stateFile;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== '--state-file') { rest.push(tokens[index]); continue; }
    check(stateFile == null && tokens[index + 1] && !tokens[index + 1].startsWith('--'), 'Provide one --state-file path.');
    stateFile = resolve(tokens[++index]);
  }
  return { action, stateFile, args: parseBatchArgs([action === 'deploy' ? 'deploy' : 'mint', ...rest]) };
}
function childArgs(command, args, factory, wait = false) {
  const tokens = [command];
  for (const [key, value] of Object.entries(args)) {
    if (['command', 'factory', 'wait'].includes(key)) continue;
    tokens.push(`--${key}`);
    if (value !== true) tokens.push(String(value));
  }
  if (factory && command === 'mint') tokens.push('--factory', factory);
  if (wait) tokens.push('--wait');
  return tokens;
}
function canonicalAddress(value) {
  try { const result = getAddress(value); check(result !== ZeroAddress, 'Factory address cannot be zero.'); return result; }
  catch { throw new MintError('Invalid factory address.'); }
}

export async function main(argv = process.argv.slice(2)) {
  const { action, stateFile: explicitStateFile, args } = parseFactoryArgs(argv);
  if (args.help) { console.log(HELP); return; }
  const config = await readBatchConfig(args.config);
  const quantity = parseUint(args.quantity ?? args['max-count'] ?? config.quantity ?? 10, 'quantity');
  if (quantity === 1n) {
    return runBatch(childArgs(action === 'deploy' ? 'deploy' : 'mint', args, undefined, action !== 'deploy'),
      { config, managedDeployment: true });
  }
  let wallet;
  if (args.send) {
    check(isHexString(process.env.PRIVATE_KEY, 32), '--send requires a 32-byte PRIVATE_KEY in the environment.');
    try { wallet = new Wallet(process.env.PRIVATE_KEY); } catch { throw new MintError('Invalid PRIVATE_KEY.'); }
    if (args.from) check(getAddress(args.from) === wallet.address, '--from differs from the PRIVATE_KEY wallet.');
  }
  // Resolve all normal limits before touching persistent state; a factory is
  // not yet required while determining whether deployment is necessary.
  const options = resolveBatchOptions({ ...args, command: 'deploy' }, config, wallet?.address);
  const explicitFactory = args.factory ?? config.factory;
  const configuredFactory = explicitFactory == null ? undefined : canonicalAddress(explicitFactory);
  const artifact = await loadArtifact();
  const deploymentData = artifact.bytecode + new Interface(artifact.abi).encodeDeploy([options.recipient]).slice(2);
  const identity = { chainId: String(CONFIG.chainId), owner: options.from, recipient: options.recipient,
    sourceSha256: artifact.sourceSha256, initCodeHash: keccak256(deploymentData) };
  const stateFile = explicitStateFile ?? resolve(ROOT, '.state', `factory-${CONFIG.chainId}-${options.from.toLowerCase()}.json`);
  const providers = [];
  const cancellation = new AbortController();
  const live = () => check(!cancellation.signal.aborted, 'Cancelled. Check the saved deployment and any printed transaction hash before restarting.');
  const cancel = () => { cancellation.abort(); for (const provider of providers) provider.destroy(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let store;
  let recoverySequencer;
  try {
    store = await openFactoryState(stateFile, identity);
    live();
    let saved = await store.read();
    let newlyDeployed = false;
    if (saved && configuredFactory) check(saved.factory === configuredFactory, 'Configured factory differs from the saved factory. No new deployment will be made.');
    let factory = saved?.factory ?? configuredFactory;
    check(action !== 'start' || factory, 'No saved/configured factory exists. Run setup --send first, or supply --factory.');
    const checked = await Promise.all(options.rpcUrls.map(async (url, endpoint) => {
      live();
      const provider = createProvider(url);
      providers.push(provider);
      try {
        check(parseUint(await provider.send('eth_chainId', [])) === CONFIG.chainId, 'Wrong RPC chain.');
        return { provider, endpoint };
      } catch { return null; }
    }));
    live();
    const verified = checked.filter(Boolean);
    check(verified.length, 'No RPC passed the factory network checks.');
    const provider = verified[0].provider;
    const mintOptions = address => ({ ...options, command: 'mint', route: 'batch', factory: address });
    const verifyExisting = async address => {
      live();
      await prepareBatch(provider, artifact, mintOptions(address));
      live();
    };
    const saveDeployed = async address => {
      const deployment = saved?.deployment
        ? { hash: saved.deployment.hash, nonce: saved.deployment.nonce } : undefined;
      saved = await store.write({ status: 'deployed', factory: address, ...(deployment ? { deployment } : {}) });
      print({ factoryStatus: 'verified and saved', factory: address, owner: options.from, recipient: options.recipient });
    };
    if (factory) {
      const code = await provider.send('eth_getCode', [factory, 'latest']);
      live();
      check(isHexString(code), 'RPC returned invalid factory code.');
      if (code !== '0x') {
        await verifyExisting(factory);
        if (!saved || saved.status !== 'deployed') await saveDeployed(factory);
        else print({ factoryStatus: 'reused and verified', factory, owner: options.from, recipient: options.recipient });
      } else {
        check(saved?.status === 'pending', 'The saved/configured factory has no code. Refusing to deploy another factory.');
        print({ factoryStatus: 'deployment requires recovery', factory, transactionHash: saved.deployment.hash });
        check(action !== 'start', 'Factory deployment is not yet verified. Run setup --send to recover the original transaction.');
        check(args.send, 'Pending deployment saved. Run setup --send to recover the same signed transaction.');
        const hash = saved.deployment.hash;
        let receipt = await provider.send('eth_getTransactionReceipt', [hash]);
        live();
        if (!receipt) {
          const [known, latestNonce, pendingNonce] = await Promise.all([
            provider.send('eth_getTransactionByHash', [hash]),
            provider.send('eth_getTransactionCount', [options.from, 'latest']),
            provider.send('eth_getTransactionCount', [options.from, 'pending']),
          ]);
          live();
          const nonce = parseUint(saved.deployment.nonce);
          check(parseUint(latestNonce) <= nonce, 'Deployment nonce was consumed, but the factory is unverified. Inspect the saved hash; no new deployment will be made.');
          check(!known || known.hash?.toLowerCase() === hash.toLowerCase(), 'RPC returned a different transaction for the saved deployment hash.');
          check(known || parseUint(pendingNonce) <= nonce, 'Another pending transaction may use the saved nonce. Inspect it before resuming deployment.');
          if (!known) {
            const transaction = Transaction.from(saved.deployment.rawTransaction);
            const cost = transaction.gasLimit * (transaction.maxFeePerGas ?? transaction.gasPrice);
            check(cost <= options.maxGasCost, 'Saved deployment exceeds the current gas budget. It will not be replaced automatically.');
            const simulation = await preflightBatch(provider, artifact, options);
            check(simulation.estimate <= transaction.gasLimit, 'Saved deployment gas limit is below the current estimate. No replacement will be signed.');
            const [, balance] = await Promise.all([
              checkGasLimit(provider, transaction.gasLimit, simulation.block),
              provider.send('eth_getBalance', [options.from, 'pending']),
            ]);
            check(parseUint(balance) >= cost, 'Wallet balance cannot cover the saved deployment gas limit.');
            live();
            print({ factoryStatus: 'resending saved deployment', transactionHash: hash, factory });
            if (options.sequencer) recoverySequencer = await openSequencer(options, {
              register: item => providers.push(item), onProgress: print, signal: cancellation.signal,
            });
            const sendEntries = recoverySequencer ? [{ provider: recoverySequencer.provider, endpoint: 'sequencer' }] : verified;
            live();
            await broadcastIdentical(saved.deployment.rawTransaction, sendEntries.map(entry => entry.provider), {
              signal: cancellation.signal,
              ...(recoverySequencer ? { lookupProviders: verified.map(entry => entry.provider) } : {}),
              concurrency: options.concurrency, attempts: options.attempts, retryDelayMs: options.retryDelayMs,
              onAttempt: event => print({ ...event, endpoint: sendEntries[event.endpoint].endpoint,
                ...(recoverySequencer && event.status === 'known' ? { observationSource: 'read RPC; sequencer acknowledgement unavailable' } : {}) }),
            });
            live();
          }
          receipt = await waitReceipt(provider, hash, options.receiptTimeoutSeconds);
        }
        live();
        check(receipt.transactionHash?.toLowerCase() === hash.toLowerCase(), 'Deployment receipt hash does not match the saved transaction.');
        check(parseUint(receipt.status) === 1n, 'The saved deployment reverted. Gas was spent; inspect the saved transaction before any new deployment.');
        check(canonicalAddress(receipt.contractAddress) === factory, 'Deployment receipt contains a different factory address.');
        await verifyExisting(factory);
        await saveDeployed(factory);
      }
    } else {
      if (action === 'setup') {
        const stage = await readPublicStage(provider, { ...options, command: 'mint', route: 'batch' });
        check(stage.mintPrice === 0n && stage.maxTotalMintableByWallet > 0n && stage.endTime >= stage.startTime && stage.endTime > 0n,
          'No configured free public stage is available for this launch.');
        check(stage.timestamp <= stage.endTime, 'Public stage has ended. Factory deployment was not started.');
        check(options.targetTimestamp == null || options.targetTimestamp <= stage.endTime, 'Requested wait timestamp is after the public stage ends. Factory deployment was not started.');
      }
      live();
      const result = await runBatch(childArgs('deploy', args), {
        config, managedDeployment: true, signal: cancellation.signal,
        beforeBroadcast: async ({ raw, hash, predictedFactory, nonce }) => {
          live();
          saved = await store.write({ status: 'pending', factory: predictedFactory,
            deployment: { hash, nonce: nonce.toString(), rawTransaction: raw } });
          live();
          print({ factoryStatus: 'deployment saved before submission', factory: predictedFactory, transactionHash: hash });
        },
        onDeployed: async result => { await saveDeployed(result.factory); },
      });
      live();
      if (!args.send) {
        print({ factoryStatus: 'deployment simulated; no factory created', next: 'Repeat with --send to deploy once and continue.' });
        return result;
      }
      check(result?.status === 'deployed' && saved?.status === 'deployed', 'Deployment did not produce a verified saved factory.');
      factory = saved.factory;
      newlyDeployed = true;
    }
    live();
    if (action === 'deploy') {
      const result = { status: 'deployed', factory, reused: !newlyDeployed };
      if (!newlyDeployed) print(result);
      return result;
    }
    // The state lock remains held throughout the wait and mint, preventing a
    // second launcher with the same state from signing concurrently.
    recoverySequencer?.close();
    for (const item of providers) item.destroy();
    return await runBatch(childArgs('mint', args, factory, true), { config, signal: cancellation.signal });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    recoverySequencer?.close();
    for (const provider of providers) provider.destroy();
    await store?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${safeBatchError(error)}`); process.exitCode = 1; });
}
