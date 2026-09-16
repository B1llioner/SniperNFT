# Code Review Report

Review date: 2026-09-16. **Independent review complete: no unresolved blocking code finding remains in the reviewed snapshot; local verification passed. Ready for installation and controlled testing within the stated limits. Paid mainnet execution has not been performed.** Original finding line numbers identify the first reviewed snapshot; current fix locations are listed below. [Reviewed source hashes](REAL_TX_REVIEW_SOURCE_HASHES.json)

## Findings

### Follow-up disposition

| Finding | Current source disposition | Verification / limitation |
| --- | --- | --- |
| R1 | Fixed: persistent wallet marker is checked before preflight/key input and again under the lock; created durably before the first intent; cleared only after complete durable result and finished journal record. `journal.rs:20,65,97,146`; `main.rs:67,103`. | Restart tests passed for both uncertain-send cases; fresh-output retry performed zero RPCs and no additional sends. Clean completion clears the marker. |
| R2 | Fixed: each missing lock-directory ancestor is created privately and its parent synchronized; report root/parent, marker and report-directory entries are synchronized. `journal.rs:35,83,110,140,149,163`. | Final local suite passed; power-loss behavior remains dependent on filesystem/storage honoring synchronization. |
| R3 | Fixed: live preflight calls bounded Chrony verification before RPC/key input; verification repeats before each route's first deployment and before arming. Each timed send checks wall/monotonic drift; invalid drift is retained as `clockValid=false` and cannot qualify as an all-first-block result. `clock_check.rs:125,165`; `plan.rs:144`; `run.rs:137`. | Parser/platform checks passed. Live Linux Chrony invocation remains a deployment readiness check, not exercised by the macOS local suite. |
| R4 | Fixed: transport-specific URL scheme validation and parsed loopback scope; actual `senderHost` is included. `config.rs:111,158,171`. | Configuration tests and both route integration cases passed. |
| R5 | Fixed for the observed chain cadence: accepted start delay is capped at 120 seconds. `config.rs:125`. | Final suite passed; extreme chain/provider behavior remains bounded and fails closed. |
| R6 | Fixed: aggregate report states one global query per 100ms and approximately one-second revisit with ten pending hashes. `run.rs`, aggregate `limitations`. | Final report behavior and source wording reviewed. |

The detailed entries below preserve the original findings and their reasoning; the disposition table controls whether they remain open. Additional reporting follow-ups are addressed: unresolved receipts now have null mint/hit values and an unknown count, cross-round helpers are checked for uniqueness, and the route report explicitly labels canonicality as an unfinalized observed-branch snapshot.

### [High] R1 — Uncertain submissions are not blocked across process restarts

- **File / line:** `rust-mint-benchmark/src/journal.rs:16–44`, `main.rs:68–75`, `plan.rs:46–50`, `run.rs:59–65`.
- **Rule area:** Transaction safety, idempotency, durable state; Rust/security failure handling.
- **Impact:** A new invocation can sign a different transaction at an unresolved nonce, or deploy another fixture after an earlier invocation already deployed one. Stopping the current process is insufficient to enforce the advertised reconciliation requirement across restarts.
- **Reachability:** A send reaches the sequencer but its acknowledgement is lost; the independent read RPC temporarily reports the previous `latest` and `pending` nonce. The program stops. The operator retries with the fresh output path demanded by the CLI. The OS lock was released and the new run never reads the old journal, so the same nonce is accepted again. A SIGINT/process crash creates the same uncertainty.
- **Evidence:** The wallet lock file has no persistent unresolved state; new output directories are independent. `latest == pending` only checks the reader's present view. The previous journal is referenced in error text but not enforced.
- **Recommended fix:** Persist a per-wallet active/unresolved-run marker under the shared wallet lock before any potentially broadcast intent. Refuse another live run while that marker exists. Clear it only after all possible submissions have been reconciled; document an explicit recovery process, without automatic rebroadcast or guessing that an invisible hash was never submitted.
- **Required tests:** Accepted-but-unobservable transaction, terminate the first CLI, start a second CLI with a different output directory and stale reader nonce; assert zero additional sends. Also cover interruption before/after network write and clean completion unlocking a later run.
- **False-positive considerations:** This is not an automatic retry within one invocation; that path already stops correctly. Explicitly following the manual reconciliation message avoids the issue, but the safety property is not enforced by the program.

### [Medium] R2 — The pre-send journal is not fully durable against host failure

- **File / line:** `rust-mint-benchmark/src/journal.rs:35–44`, `47–51`, `55–63`.
- **Rule area:** Durable transaction intent and crash consistency.
- **Impact:** A host/power failure after a send can leave the journal filename or new output directory absent even though the file's data was synchronized. This removes the recovery record for a possibly accepted transaction.
- **Reachability:** The output directory and `journal.jsonl` are newly created for each run. `sync_data` is applied to the file, but neither its directory nor the newly created directory's parent is synchronized before sending.
- **Evidence:** There is no directory synchronization in `Journal::create` or `save`.
- **Recommended fix:** Synchronize the journal file and the relevant directory entries before allowing the first send. Apply the same durable-creation ordering to R1's marker. Continue failing closed on synchronization errors.
- **Required tests:** Verify creation/permission/lock behavior and injected synchronization errors; document the filesystem assumption. A normal process-kill test alone does not establish power-loss durability.
- **False-positive considerations:** Ordinary process termination usually preserves the file. This finding concerns host/storage crash consistency, not a demonstrated secret leak or a failure of every filesystem.

### [Medium] R3 — Accepted clock skew can invalidate every one-second mint window

- **File / line:** `rust-mint-benchmark/src/plan.rs:86–89`; `run.rs:127`, `143–145`, `155–162`, `235`.
- **Rule area:** Time-dependent domain logic and measurement validity.
- **Impact:** A host with a stable two-second offset passes preflight, deploys and arms the contracts, then can spend fees on ten `TooEarly` or `Expired` results. The post-run drift check does not detect a constant offset.
- **Reachability:** Preflight explicitly accepts up to five seconds of difference; scheduling uses local Unix time, while the contracts use chain timestamps and one-second windows.
- **Evidence:** A constant offset produces approximately zero change between the wall and monotonic clocks during the run, satisfying the 20ms drift check.
- **Recommended fix:** Refuse an obviously incompatible chain/local-time offset before paid setup and recheck readiness before arming. Record trustworthy host clock synchronization evidence and its error bound. Treat integer block timestamps as a coarse freshness check, not a submillisecond clock calibration or a guarantee of first-block inclusion.
- **Required tests:** Constant positive/negative two-second offset, stale block, and wall-clock step after preparation. An invalid clock must stop before paid setup; a step must not yield a ranked result.
- **False-positive considerations:** The intended synchronized EC2 host may satisfy the assumption. Unknown sequencer clock phase and network latency still prevent a universal first-block guarantee even after this fix.

### [Medium] R4 — Route labels do not enforce the actual URL transport

- **File / line:** `rust-mint-benchmark/src/config.rs:47–52`, `92–108`; `plan.rs:57–69`; `rpc.rs:147–167`.
- **Rule area:** Configuration/API contracts and benchmark attribution.
- **Impact:** `--transport wss --wss-url https://…` can execute HTTP requests while reporting `wss-rpc-provider`. The HTTP route can likewise accept a WebSocket URL if that endpoint implements the health method. A completed comparison can be mislabeled.
- **Reachability:** Custom endpoint flags are public CLI inputs. `RpcClient` correctly chooses its implementation from the URL scheme, but `Mode` independently determines report labels and warmup methods.
- **Recommended fix:** Validate that the HTTPS route uses `https`, or `http` only for loopback tests; the WSS route uses `wss`, or loopback `ws`. Keep the read endpoint's supported schemes separate. Explicitly label custom HTTPS providers rather than asserting they are the official sequencer.
- **Required tests:** Reject crossed HTTP/WS schemes before any key read or send; allow the existing matching loopback integration fixtures.
- **False-positive considerations:** Defaults select the correct official HTTPS sequencer and PublicNode WSS. This is a configuration correctness issue, not arbitrary remote code execution.

### [Medium] R5 — A permitted start delay can exceed the report's block-range limit

- **File / line:** `rust-mint-benchmark/src/config.rs:96`; `run.rs:129`, `181–182`.
- **Rule area:** Configuration bounds and post-send reporting.
- **Impact:** A valid `--start-delay-seconds 600` run can deploy, arm and submit all ten transactions, then reject its report because the arming block is over 4,096 L2 blocks behind the observation head.
- **Reachability:** The observed Robinhood cadence was about ten L2 blocks per second. A 600-second wait alone spans roughly 6,000 blocks; the configured 120-second receipt timeout can extend the range further.
- **Recommended fix:** Establish a fresh, canonical pre-target measurement anchor after the long wait, or make the allowed delay/timeout and scan bounds compatible. Preserve a proven timestamp before the first target for binary-search boundary checks.
- **Required tests:** Largest permitted start delay and receipt timeout with accelerated synthetic headers; ensure a valid configuration does not fail only after spending gas.
- **False-positive considerations:** The default 30-second delay fits the current observed cadence. The limitation is reachable through documented accepted arguments and is not a claim that block cadence is permanently fixed.

### [Low] R6 — Receipt polling notes understate possible observation delay

- **File / line:** `rust-mint-benchmark/src/run.rs:103`, `240`; `observer.rs:1–6`, `261–269`.
- **Rule area:** Measurement observability.
- **Impact:** Readers can interpret “100ms polling” as one lookup per hash every 100ms. The observer polls **one pending hash globally** per 100ms; ten pending hashes imply approximately one second per hash, plus RPC time.
- **Recommended fix:** Put the global cadence, round-robin policy and active-pending count limitation in the saved report and README. Keep `receiptObserved` distinct from submission acknowledgement and exact chain execution time.
- **Required tests:** Existing round-robin observer coverage is relevant; verify the final report states the same policy as the implementation.
- **False-positive considerations:** The metric is already named RPC-visible receipt latency. This is a precision-of-explanation issue, not a bug in the measured monotonic duration.

## Summary

- **Review scope:** All modules in `rust-mint-benchmark/src`, Cargo configuration, artifact generation/binding, both benchmark contract interfaces, local Rust transport/observer tests and Node/Anvil end-to-end test design.
- **Profiles applied:** Strict review, Rust, secure code, smart-contract research, Solidity vulnerability analysis/patterns. Their full references were read in this task thread. PostgreSQL is not applicable.
- **Overall risk:** The initial high-severity restart-safety finding and bounded correctness/durability findings are resolved as described above. No direct key disclosure, signing-chain escape, unlimited send loop or within-invocation fee-budget bypass was found in the reviewed paths. No blocking source finding remains; operational/provider and unfinalized-chain limits are listed below.
- **Verification status:** Static review and fix re-review completed against the matching source-hash manifest. The owner reports format, Clippy, debug build, all 46 Rust unit tests and all 13 local EVM cases passed, with the targeted fixture rerun described below. This reviewer did not edit implementation code, upload a binary or broadcast a real transaction.

## Domain Logic Assessment

- **Invariants reviewed:** Chain 4663; entered key matches the expected wallet; zero ETH transfer value; no pending nonce at startup; two deployments, one arm and ten bounded attempts per selected route; combined reservation across both routes; at least 0.001 ETH reserved; each helper mints once; maximum supply 10,000; timing/supply no-ops distinguished from successful minting.
- **State transitions:** Read-only preflight → optional hidden key entry → locked fresh preflight → deploy collection/factory → verify immutable-patched runtime → full mint simulation → arm once → prepare bounded nonce sequence → warmed scheduled submission → receipt/event/ownership/header verification. An ambiguous send stops the current invocation, without trying another route.
- **Accounting:** Maximum signed gas limits times the fixed maximum fee are reserved for both runs together; receipt gas and effective price are checked against those ceilings. The second run checks the remaining overall reservation. Setup cost and failed transaction cost are included. A changed external wallet balance can stop later work; an external writer must not share this wallet.
- **Open questions:** Persistent recovery now deliberately requires inspecting/reconciling hashes before manually clearing a blocked marker. A fixed shared lock directory and exclusive wallet use remain operational requirements. The user must choose one or both runs explicitly under the combined budget.

## Rust Quality Assessment

- **Error handling/type safety:** Signing/RPC errors are redacted, quantities use checked integer arithmetic, addresses/hashes use Alloy types, response IDs and receipt hashes are checked. Reports use generic JSON objects at orchestration boundaries, so integration assertions remain important.
- **Async/concurrency:** One sequential sender per route; independent bounded receipt watcher, at most ten hashes, one owned task, per-request and per-hash deadlines. The observer aborts its task on drop or cancelled `finish`; its registration mutex does not cross an await. Transport cancellation poisons the client and avoids silent reuse.
- **Unsafe:** Crate forbids unsafe code. Cryptographic signing/TLS use maintained libraries rather than a custom implementation.
- **Performance limits:** Receipt polling and final ownership/header verification are separate from timed sends. Sender acknowledgements are sequential, so a slow acknowledgement can delay the next deadline; the CLI stops on an expired deadline instead of sending a catch-up burst. This is an explicit behavior to report, not proof that all ten sends will stay exactly one second apart under failures.

## PostgreSQL Assessment

Not applicable: no database, SQL, migrations or SQLx code is present in this change.

## Security Assessment

- **Auth/authz:** Exact signer-address binding; NFT arm and batch entry are owner-only. The fixture has no upgrade path, payable mint, admin mint, arbitrary call or user-selected recipient separate from the signing wallet.
- **Secret handling:** Normal keys are read from a hidden terminal prompt, wrapped in a zeroizing input buffer, not command-line arguments or configuration. Signers/raw transactions intentionally omit Debug/Serialize. Synthetic stdin keys require loopback endpoints. No real key or production secret was read for this review.
- **Redaction:** RPC error messages/data are discarded in favor of codes; URL and signed bytes are not included in ordinary reports. Output is new-directory/create-new with private Unix permissions. See R1/R2 for persistence limitations.
- **Network:** TLS verification remains enabled; remote plaintext, userinfo, fragments and the receive-only feed endpoint are rejected; redirects, HTTP retries, proxies and compression are disabled. Responses/messages/notification counts and calls have bounds. Custom endpoints are operator-controlled and remain a trust assumption.
- **Dependency risk:** Canonical Alloy/k256 signing and rustls/Tungstenite/Reqwest transport are used. A fresh vulnerability-advisory scan and the final locked artifact/build provenance were not independently completed by this reviewer.
- **Local-process risk:** File locks protect cooperative invocations using the same lock directory on the same host. They do not coordinate different hosts, different lock directories or unrelated wallet software; a dedicated otherwise-unused wallet is required for nonce isolation.

## Smart Contract Assessment

- **Present:** Dedicated `TimedBenchmarkNFT`, `TimedBenchmarkBatchMinter` and constructor-only mint helper. This is not an audit or emulation of the external Genesis collection's sale rules.
- **Dossier:** `REAL_TX_TRANSPORT_RESEARCH.md` and `REAL_TX_REVIEW_PLAN.md` record the transport, block semantics, topology, gas/budget and lifecycle assumptions.
- **Relevant rules:** Access control, ERC721 ownership/approval invariants, state-before-external-interaction, reentrancy, bounded loops/gas, arithmetic, race/order behavior and rollback (including SOL-1/4/8/11/12/14/15/19/23/31/35/38/45–47 considered where applicable).
- **Reviewed invariants:** The NFT lifetime allowance is not restored by transfer; the factory reads remaining supply before creating at most ten helpers; another transaction cannot interleave inside the atomic batch; routine supply/timing outcomes emit explicit status instead of reverting the whole loop. Unexpected dependency/helper failure reverts atomically. Immutable code/owner/recipient/collection bindings are patched from compiler references and checked against deployed runtime.
- **Event verification:** The earlier design target is resolved in the strengthened `metrics.rs`: exact token range, unique helper per token, canonical zero→helper→recipient paths, correct result status/supply and no transfers after the result event. The runner also queries `ownerOf` at each receipt's block.
- **Simulation:** Both fixed-block state overrides and the real 10-NFT path were independently verified read-only on the official RPC: minted=10/status=0 and estimate=1,560,422 gas for the recorded artifact. This does not predict future fees or inclusion order. The CLI requires actual mint output rather than accepting a cheap timing no-op.

## Test Assessment

- **Existing coverage inspected:** Signing roundtrip/recovery and chain binding; strict RPC correlation, limits, redaction, persistent connection, timeout/cancellation poisoning; observer registration order/capacity, delayed/malformed/missing receipts, deadlines and cancellation; adjacent-header proof and small-sample quantiles; adversarial event/token/helper validation; deterministic Solidity artifacts, 100 helper mints, timing/auth/lifetime cap, competing supply exhaustion, partial/sold-out fast paths and atomic rollback.
- **Owner-reported verification:** The frozen implementation passed format check, Clippy with `-D warnings`, debug build and all **46 Rust unit tests**, including observer 8/8, metrics 11/11 and Chrony parsing/platform checks. The first sandbox-only loopback attempt failed on environment permission; the authorized loopback run passed.
- **Final EVM results:** All **13 cases** passed across the final run and targeted rerun: six contract tests plus seven CLI tests. The full CLI scenario executed **26 signed transactions**, minting **100 NFTs per route**, with ten full batches and ten first-block hits on each local route. Two restart assertions initially failed only because macOS canonicalized `/var` as `/private/var`; the expected fixture path was changed to `realpath`, and both cases passed on rerun. The reviewer inspected that assertion and confirmed no production fix was required. These local first-block results are not a mainnet performance claim.
- **End-to-end design inspected:** A fresh non-forked local Anvil chain with public synthetic keys; both routes, 26 signed zero-value transactions, full state-override simulation, exact nonce/gas/cost/ownership/event/report comparisons, read-only mode, inadequate budget, mismatched key, externally consumed nonce and lost-ack/no-resend cases. These tests do not send public-chain transactions or prove live TLS/provider behavior.
- **Coverage limits / follow-up tests:** Restart ambiguity, route binding, budget rejection and the positive full-mint path are exercised. Not every orchestration fault was injected end-to-end: signal/disk-write failure around intent persistence, wallet-lock contention, a deadline missed mid-run, a status-0 mint receipt, changed balance between runs, and shallow reorg/missing-header behavior. Their code paths were reviewed; local contract tests separately cover expired/partial/sold-out states. Extend fault injection before treating this bounded manual benchmark as unattended production automation.
- **Commands this reviewer ran:** Read-only inspection and `git diff --check` for review artifacts. Earlier bounded read-only RPC capability/full-batch checks are recorded separately. No code-changing or live-transaction verification command was run.
- **Commands delegated to owners, not duplicated:** `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-targets --all-features`, debug build and the non-skipped local contract/Rust-Anvil tests passed as reported above. The final Chrony subprocess environment hardening affects only the live Linux path; the owner will rebuild the final install binary from this reviewed source. Rerun relevant suites and update the source manifest if implementation changes.

## Recommendations

- **Installation/testing disposition:** R1–R6 are resolved and the source manifest matches. Installation may proceed from this reviewed source. Before any funded run, the installed binary must pass its Linux Chrony and endpoint/budget preflight under the selected one- or two-route configuration. Packaging/install scripts are a separate review scope.
- **Transport disclosure:** This transaction WSS client uses **Tungstenite JSON-RPC** to PublicNode. The earlier self-developed raw WebSocket codec measured receive-only feed ping/pong and is not the sender used here. HTTPS directly targets the official sequencer; WSS traverses a different provider route, so route results cannot isolate framing or programming language as the cause.
- **Keep:** Single-route attribution per signed transaction, no hidden fallback, no automatic rebroadcast, full-budget caps and raw sample/receipt-hash output. Ten samples cannot establish a reliable p99; nearest-rank p95/p99 equal the maximum at N=10.

## Residual Risk

- Read RPCs and their canonical-state views are trusted. Chain-ID checks do not make a malicious or stale endpoint trustworthy. Successful empty-parameter method dispatch is not a valid transaction acceptance test; the first authorized signed submission will establish that behavior.
- Adjacent block timestamps and parent linkage prove the first eligible L2 boundary for the observed branch. Solidity `block.number` is not used as an L2 number. The current analysis rechecks the old arming anchor, but a later shallow reorg can leave that anchor unchanged while invalidating newer cached receipts/boundaries. Revalidate relevant hashes at report completion or explicitly treat the report as an unfinalized observation, never finality.
- A missing receipt/boundary is incomplete evidence; it must not be advertised as a measured first-block miss or a successful run. No future inclusion guarantee follows from a low acknowledgement time.
- Global elapsed-time fee changes, endpoint limits, sequencer/provider behavior, host clock error, scheduler jitter and independent wallet activity remain operational risks. Signed gas/fee ceilings bound this invocation's own gas spending; they do not make failed mints free.
- **Remaining verification:** Linux deployment readiness (Chrony and actual endpoint checks), final installation-binary provenance, and the separate packaging/install review. Local tests and source-manifest equality are complete. The reviewed Solidity artifact SHA-256 is `76c53d4fd21f095d6620449287e89f61b8ac9303c6a0db8fcdfcf35f13ff8b11`; final `clock_check.rs` SHA-256 is `d1ebcc47fd46d4ad53a5381daf2ea771b1300d7d9ba9622584807638c85961ad`. A later implementation change requires review of its diff.
