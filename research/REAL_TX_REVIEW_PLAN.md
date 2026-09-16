# Real-transaction benchmark review plan

**Status: design checkpoint, not final approval.** Reviewed the initial Rust configuration, journal, artifact loader, signer, RPC client and metrics modules, plus the contract interfaces. The transaction runner, full preflight and orchestration were still being implemented. No concrete blocking defect was established in this snapshot; the checks below remain required before live use.

Profiles applied: Rust CLI/performance, security, strict review, smart-contract research and Solidity interface/invariant review. PostgreSQL is not applicable. Contract-level testing belongs to the parallel contract review; this plan focuses on cross-module behavior.

## Required invariants and focused tests

| Area | Invariant | Negative / integration test |
| --- | --- | --- |
| Authorization | Read-only mode never obtains a key or sends a transaction. Entered signer must match the explicit wallet; chain must be 4663. | Missing `--send`, wrong key/address, wrong chain, invalid endpoints, feed URL and malformed response. Assert zero send calls. |
| Nonce ownership | One process owns the wallet's nonce stream; unexpected pending transactions stop the run. No automatic nonce replacement. | Concurrent process using the same wallet lock; pending/latest mismatch; another sender consumes a nonce between planning and broadcast. |
| Ambiguous send | Persist locally computed hash, nonce, destination, intent and reserved cost **before** writing signed bytes to the socket. Lost acknowledgement is not proof of rejection. | Server accepts then disconnects/timeouts; wrong response hash; malformed JSON; cancellation during send. Reconcile by local hash and stop unresolved work; never deploy another factory as a blind retry. |
| Budget | One cumulative ceiling covers **both** selected transport runs, all collection/factory deployments, arming and mint transactions, including unresolved reservations. Preserve at least the requested reserve. | Exact ceiling, one wei over, arithmetic overflow, second run exceeds remaining budget, fee rise, reverted receipt, ambiguous first-run transaction. Only verified receipts release unused reservations. |
| Deploy identity | Predicted CREATE address, receipt address, runtime bytecode, patched immutable values, owner, run ID, collection and recipient agree. | Stale artifact, wrong source hash, altered immutable, empty code, wrong deployment address, constructor revert, receipt from another hash. |
| Preflight simulation | Gas estimate covers actual helper creation/mint/transfer execution, rather than the inexpensive `NotArmed`, `TooEarly` or `Expired` return. Overrides affect simulation only. | Assert simulated status and minted count; verify exact `startTime` storage slot/layout and block timestamp; repeat at a fixed block so clock movement cannot change branches. Unsupported overrides fail closed with a useful error. |
| Arm and clock | Arm once after deploy verification, using a sufficiently future chain target. Local schedule and on-chain second are distinct observations. | Delayed arm receipt, target already passed, stale reader, ±clock offset, clock step, signal while waiting. Do not silently re-arm or shift already announced windows. |
| Ten windows | Round `i` is valid only for `start+i <= block.timestamp < start+i+1`. No burst catches up expired rounds. | Early and late inclusion, slow preceding nonce, expired slot before send, final window boundary. State whether a skipped round consumed a nonce. |
| Outcome | Receipt success alone is not mint success. `BatchResult` status, round, requested/minted counts and NFT transfers must agree. | Status 1 receipt with `Expired`, `TooEarly`, `SoldOut` or `AlreadyAttempted`; missing/duplicate event, wrong factory/collection, wrong round, wrong recipient, inconsistent amount. Preserve status 0 receipts and their gas cost. |
| Token identity | Each counted mint has a distinct token ID and helper→recipient transfer; permanent per-minter eligibility stays consumed after transfer. | Duplicate transfer records, inconsistent token IDs/firstTokenId, missing onward transfer, ownerOf mismatch. Confirm up to 100 distinct helpers per ten-round run. |
| First-block proof | Use L2 receipt block number. Establish adjacent parent-linked headers with `previous.timestamp < target <= first.timestamp`; receipt hash must match its canonical header. | Repeated timestamp across ten blocks, skipped headers, changed hash, inconsistent parent, no boundary found, receipt before/after target. Missing proof produces `unknown`; mint=0 never counts as a hit. |
| Measurement | Use monotonic durations; show scheduling slip, response time and receipt-observation delay separately. Each timed transaction uses one labeled route. | Slow reader and polling granularity, acknowledgement before/after receipt, different TLS/provider route, cancelled or errored sample. Do not substitute feed ping RTT or header seconds for inclusion milliseconds. |
| Durability / secrets | A new report directory is exclusive; journal writes are durable before sends. No key, raw transaction or credential-bearing URL enters logs. | Existing output/symlink, permission or disk failure before send, signal after broadcast, second writer, synthetic secret echoed in RPC error. Inspect stdout/stderr and artifacts. |

## Snapshot-specific review targets

- [`metrics.rs`](../rust-mint-benchmark/src/metrics.rs): `batch_result` currently counts matching mint/recipient transfers. Verify token-ID correspondence or equivalent post-receipt ownership checks in the completed runner; count equality alone does not prove which NFTs arrived.
- [`journal.rs`](../rust-mint-benchmark/src/journal.rs): locking is a local file lock and the configured directory can vary. Ensure the launcher uses a stable directory, document that it does not coordinate another host, and test its concurrency behavior. Do not unlink the lock inode while held.
- [`artifact.rs`](../rust-mint-benchmark/src/artifact.rs): named immutable offsets and the `startTime` slot are available. The simulation and runtime comparison must actually use them; do not duplicate magic offsets in the runner.
- [`rpc.rs`](../rust-mint-benchmark/src/rpc.rs): transport timeout/cancellation poisons the client and automatic HTTP retries are disabled. The orchestration must preserve ambiguity handling when it reconnects; RPC errors do not authorize a fresh deployment.

## Required verification before upload / live use

1. Freeze sources and regenerate the embedded Solidity artifact; verify deterministic compiler/settings/source hashes.
2. Run Rust format, Clippy with `-D warnings`, unit and local HTTP/WSS integration tests; run the existing local timed-contract EVM tests once their implementation is complete.
3. Run an isolated end-to-end fixture through both routes with synthetic keys: normal minting, expired windows, depleted supply, lost acknowledgement and budget exhaustion between runs.
4. Inspect final reports and journal against fixture receipts, logs, balances and canonical block boundaries. Confirm N=10 p95/p99 are explicitly labeled as sample maxima.
5. Perform a final independent review of the completed runner and final diff. Record commands/results, unresolved assumptions and any findings with file/line references. This design checkpoint does not replace that review.
