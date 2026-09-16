# Robinhood real-transaction transport and block metrics

Researched **2026-09-16, 07:10–07:12 UTC**. Scope: public documentation, bounded read-only RPC/WebSocket observations and one empty-parameter method-dispatch check. No private keys, signed transactions, deployments or gas spending. This covers transport and measurement design; it is not an audit of the production Genesis mint contract.

## Transport choice

Robinhood mainnet is chain **4663 / `0x1237`**. The official endpoint list separates a sequencer HTTPS endpoint from its receiving WebSocket feed; it also lists provider WebSocket RPC endpoints for read/write access. Public services have rate limits. [Robinhood endpoint documentation](https://docs.robinhood.com/chain/connecting/)

| Endpoint | Role and evidence | Live observation |
| --- | --- | --- |
| `https://sequencer.mainnet.chain.robinhood.com` | Official direct sequencer submission path. Nitro's standard submission method is `eth_sendRawTransaction`; valid submission was not exercised here. | `arb_checkPublisherHealth` → `null`; `rpc_modules` advertises `arb`, `eth`, `rpc`; `eth_chainId` → `-32601`. Use a separate reader to validate chain ID. |
| `wss://sequencer.mainnet.chain.robinhood.com` | Hypothetical upgrade of the HTTPS host, not a published RPC WebSocket endpoint. | HTTP **400**, no upgrade. |
| `wss://feed.mainnet.chain.robinhood.com` | Official receiving sequencer feed. It is not a JSON-RPC submission endpoint. | Earlier probes in this project verified upgrade/ping/pong. Do not send mint transactions to it. |
| `https://rpc.mainnet.chain.robinhood.com` | Official general-purpose read/write RPC. | `eth_chainId` → `0x1237`; block reads and `eth_call` work. |
| `wss://robinhood-rpc.publicnode.com` | PublicNode publishes this exact **Mainnet WS RPC** address in its public page. A provider gateway, not the official direct sequencer. | HTTP **101**, TLS 1.3, `eth_chainId` → `0x1237`; `eth_subscribe(newHeads)` delivered 60 heads; unsubscribe → `true`. |
| `wss://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` | Officially listed provider RPC WebSocket endpoint. Requires the user's provider key. | Not probed; no credentials accessed. |
| `wss://robinhood.nownodes.io/wss/{API_KEY}` | Provider explicitly documents Robinhood WSS `eth_chainId`, `newHeads` and `eth_sendRawTransaction`. | Documentation only; no credentials accessed. |

Sources: [PublicNode's Robinhood page](https://robinhood.publicnode.com/), [NOWNodes Robinhood WSS methods](https://docs.nownodes.io/robinhood/mainnet/wss/wss/), [Arbitrum endpoint behavior](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info), [sequencer feed format](https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed).

The PublicNode WSS dispatch check sent exactly:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":[]}
```

Response: **`-32600`, `missing required transaction hash parameter`**. This is a method-specific validation response, rather than method-not-found. It supports using PublicNode as a WSS submission candidate; it does **not** prove acceptance of a valid signed transaction or identical behavior to the sequencer. No raw transaction was supplied, so this check could not create a transaction. The first authorized deploy can establish valid-send support; failure must be reported without silently changing the measured transport.

Therefore the practical comparison is **Rust persistent HTTPS → official sequencer** versus **Rust persistent JSON-RPC WSS → PublicNode**. It compares complete routes, including the provider's forwarding, not only HTTPS versus WebSocket framing. A controlled transport-only comparison would use the same provider's HTTPS and WSS endpoints as an additional experiment.

## What “first block” means

On this chain, Solidity `block.number` is the approximate Ethereum ancestor block number. RPC `blockNumber` and `ArbSys(address(0x64)).arbBlockNumber()` are the Robinhood L2 number. Timestamps are nondecreasing but can repeat across adjacent L2 blocks. Do not use Solidity `block.number` for a target expressed in L2 blocks. [Arbitrum block-number and timestamp semantics](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time)

Direct read-only verification at fixed Robinhood block `0x3d570f6`:

| Read | Result |
| --- | --- |
| RPC block number | `0x3d570f6` |
| `eth_call` to ArbSys, selector `0xa3b1b31d` (`arbBlockNumber()`) | `0x3d570f6` |
| `eth_call` executing EVM `NUMBER` and returning its value | `0x18c8d6b` |
| Header `l1BlockNumber` | `0x18c8d6b` |

The EVM call was a simulation with no `to`, using init code `0x4360005260206000f3`; it did not deploy a contract.

### Observed cadence and timestamp boundaries

PublicNode delivered **60 consecutive, parent-linked L2 headers**, blocks **64,319,061–64,319,120**, in approximately six seconds. Client-observed arrival gaps: median **100.976 ms**, mean **100.608 ms**, min **67.980 ms**, max **134.603 ms**. This is a short observation from the local machine, not an Ohio latency result or a guaranteed block interval.

| Header timestamp (UTC) | First observed L2 block | Last observed L2 block | Count |
| --- | ---: | ---: | ---: |
| 07:10:29 | 64,319,061 | 64,319,063 | 3, partial second |
| 07:10:30 | 64,319,064 | 64,319,073 | 10 |
| 07:10:31 | 64,319,074 | 64,319,083 | 10 |
| 07:10:32 | 64,319,084 | 64,319,093 | 10 |
| 07:10:33 | 64,319,094 | 64,319,103 | 10 |
| 07:10:34 | 64,319,104 | 64,319,113 | 10 |
| 07:10:35 | 64,319,114 | 64,319,120 | 7, partial second |

Example boundary: block **64,319,063** has timestamp **1789542629**, and its child **64,319,064** has timestamp **1789542630**. Thus for a contract gate `block.timestamp >= 1789542630`, the first eligible L2 block was **64,319,064**. Several later blocks have exactly the same second, so comparing timestamp equality alone cannot identify a first-block hit.

For each mint target `T` (integer Unix seconds), define:

```text
firstEligibleBlock = minimum canonical L2 block n with timestamp(n) >= T
blockLag           = receipt.blockNumber - firstEligibleBlock
firstBlockHit      = receipt.status == 1 && actualMinted > 0 && blockLag == 0
fullBatchHit       = firstBlockHit && actualMinted == requestedQuantity
```

Determine the boundary from adjacent headers with `timestamp(n-1) < T <= timestamp(n)`. Start observing before the target and backfill missed headers through the read RPC. If the boundary cannot be established, record **unknown**, not a success or failure. Recheck hashes/parent linkage after receipts; initial observations are not finalized-chain guarantees. A transaction may hit the first block at a nonzero transaction index, so record `transactionIndex` separately rather than requiring index zero.

## Measurements for deploy + ten scheduled mint transactions

Use a monotonic clock for durations, record UTC timestamps for correlation, and schedule targets `T+i` for `i = 0..9`. Keep the connection warm, sign before the target when the nonce and fee policy permit, then record:

| Metric | Definition |
| --- | --- |
| `scheduleSlipMs` | Actual send start minus intended local send time. Record clock-sync evidence; local UTC is not the sequencer's clock. |
| `submitResponseMs` | Send start to matching JSON-RPC response/hash. Do not call this network RTT or finality. |
| `receiptObservedMs` | Send start to first successful receipt read. Includes reader propagation and polling interval. |
| `firstEligibleBlock`, `blockLag`, `transactionIndex` | Chain-position evidence defined above. |
| `requestedQuantity`, `actualMinted`, `supplyBefore/After` | Derived from validated test-contract events/state, not receipt success alone. |
| `gasUsed`, `effectiveGasPrice`, `feeWei` | Actual receipt cost, with the receipt and its chain-specific fields retained. |

Arbitrum documents that its direct sequencer's successful send response follows sequencing/execution, while parent-chain finality is separate. That documentation describes Arbitrum's endpoint behavior; do not assume a third-party Robinhood gateway returns at the identical stage. Keep receipt verification independent of submission responses. [Arbitrum sequencer response semantics](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info)

Ten samples are useful for functional and first-block checks; nearest-rank p95/p99 both become the maximum for `N=10`. Print all ten results, successes/errors and first-block hit count; do not present those tail values as a stable latency forecast. Broadcasting the same signed transaction through both transports would obscure attribution, so each timed trial needs a single labeled submission route.

## Contract and budget implications for the requested experiment

- A test collection with total supply 10,000 and a permanent one-mint-per-`msg.sender` rule needs fresh helper addresses across attempts: ten transactions × up to ten mints = up to **100 distinct minters**. Transferring an NFT away must not reset that minter's allowance. This tests the owned fixture's rules, not an assumption about Genesis restrictions.
- Helpers can share funding from one EOA, but the EOA's nonce ordering serializes its transactions. A delayed earlier transaction can affect later targets; expose this in the report rather than attributing all delay to transport.
- “One transaction per second” does not mean “one transaction per L2 block”: the observed cadence was around ten L2 blocks per second.
- A balance of 0.02 ETH is a budget, not a measured fee estimate. Before broadcasting, estimate the actual deployment and ten batch calls, apply explicit gas/fee ceilings, reserve their maximum permitted costs and reject a plan exceeding the available budget. Show deployment separately from warmed mint-call latency.

Robinhood currently describes ordering by sequencer arrival, with higher fees not overriding earlier arrivals. This does not remove nonce dependencies, execution limits or endpoint latency. [Robinhood ordering model](https://docs.robinhood.com/chain/)

## Reproducible evidence

- [Transport responses and all 60 headers](REAL_TX_TRANSPORT_OBSERVATIONS.json)
- [Fixed-block L1/L2 number calls and sequencer WS rejection](REAL_TX_BLOCK_NUMBER_OBSERVATIONS.json)
- [PublicNode empty-parameter send-method response](REAL_TX_WS_METHOD_OBSERVATION.json)

These artifacts contain public RPC data only. They establish read/subscribe capability and the exact dispatch error; successful signed-transaction submission remains untested by this research.

## State-override preflight, verified 07:23–07:25 UTC

Both the official read RPC and PublicNode HTTPS accepted an explicit block-number argument plus a **third-parameter state override** for `eth_call` and `eth_estimateGas`. Overrides replace code, storage or account balance only inside the simulation; they do not deploy or fund real accounts. This is an implementation extension whose availability was checked directly, rather than inferred from the generic JSON-RPC interface. [Geth state-override objects](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects)

| Control | Official RPC | PublicNode HTTPS |
| --- | --- | --- |
| Inject runtime that returns storage slot 0, override that slot to 42 | `eth_call` returned exact uint256(42) | Same |
| Estimate the same overridden runtime | 23,455 gas | 23,455 gas |
| Replace runtime with an unconditional revert | Both methods returned code **3**, `execution reverted` | Same |

The negative estimate control matters: it demonstrates that the estimate actually executed overridden code instead of silently estimating an empty account. Fresh random simulation addresses had no real code, and the simulated sender had zero real balance. Each endpoint received eight bounded read-only requests. [Exact capability requests and responses](REAL_TX_STATE_OVERRIDE_OBSERVATIONS.json)

A second check used the **current compiled benchmark contracts** on the official RPC, at fixed block `0x3d59200`:

- Patched the NFT and factory runtime immutable references using the artifact's named immutable IDs; supplied a virtual owner balance of **0.02 ETH**, contract account nonces of 1 and empty initial storage.
- Set the NFT `startTime` slot, obtained from its storage layout, to that same block's timestamp. This deliberately opens round zero inside the simulation.
- `eth_call(mintBatch(0, 10), fixedBlock, overrides)` returned **minted = 10, status = 0**.
- `eth_estimateGas` with the same call, block and overrides returned **1,560,422 gas**.
- Subsequent normal `eth_getCode` calls confirmed that both contracts remained absent on the real chain. No key, deployment or signed transaction was used. [Full-batch override evidence and artifact SHA-256](REAL_TX_FULL_BATCH_OVERRIDE_OBSERVATIONS.json)

This establishes a usable pre-deployment mint-path check. Use the identical fixed block for the call and estimate, with `startTime` derived from that block; separate `latest` calls can cross the one-second window and cheaply return `Expired`. A production preflight must require both **minted = requested quantity** and **status = Minted**, reject unsupported or failed overrides, and separately validate deployment costs, aggregate fee reserves and real deployed contract state. The observed estimate is a simulation of this artifact and state, not a fixed future fee or a proof of timely inclusion.
