# Rust WebSocket feed benchmark

Two implementations share one scheduler, report format, TLS transport, ping payload and deadlines:

- `--engine tungstenite` (default): established `tokio-tungstenite` implementation.
- `--engine raw`: this project's small RFC 6455 client codec. It parses frames incrementally, validates UTF-8 and fragmentation, counts and discards feed payloads without allocating a whole message, and handles ping/pong control frames. TLS and certificate verification still use `rustls`; cryptography is not reimplemented.

Both create **one persistent TCP/TLS/WebSocket connection**, set `TCP_NODELAY`, send at most one outstanding ping, and reuse the connection for every ping. There are no reconnects, redirects, compression, wallet keys, JSON-RPC requests or transaction broadcasts. Incoming messages are continuously drained without parsing feed JSON.

The default endpoint is the official receiving feed, `wss://feed.mainnet.chain.robinhood.com`. **Feed ping/pong measures control-frame round trips, not transaction acceptance, execution or inclusion.** The official transaction submission endpoint is HTTPS, `https://sequencer.mainnet.chain.robinhood.com`; see [Robinhood connecting documentation](https://docs.robinhood.com/chain/connecting/).

## Build and run

Rust 1.88 or newer; the lockfile is committed. A release build matters for comparisons.

```sh
cargo build --release --locked --jobs 1 --manifest-path rust-websocket-probe/Cargo.toml

rust-websocket-probe/target/release/rust-websocket-probe \
  --engine tungstenite --label ohio-library \
  --duration-seconds 600 --interval-ms 1000 --timeout-ms 5000 \
  --warmup 5 --output rust-ws-library.json

rust-websocket-probe/target/release/rust-websocket-probe \
  --engine raw --label ohio-raw \
  --duration-seconds 600 --interval-ms 1000 --timeout-ms 5000 \
  --warmup 5 --output rust-ws-raw.json
```

The output path must be new and its parent directory must exist. Reports are created exclusively with mode `0600` on Unix; existing files and symlinks are refused. An initial report is written before network activity, then the final/partial report on completion, SIGINT or SIGTERM. A forced kill can leave the initial incomplete report. Report creation failures happen before connection attempts.

For a fairer comparison, resolve a currently advertised IPv4 address and pass the **same** `--connect-ip ADDRESS` to Node, Rust library and Rust raw clients. Pinning changes only the TCP destination: the original hostname remains in HTTP Host, TLS SNI and certificate verification. Public endpoints can have several backends behind one IP, so pinning does not guarantee the same backend or eliminate run-to-run network changes. Do not hardcode an old IP permanently.

`--start-at 2026-09-17T12:00:00Z` waits until the given UTC time before connecting. Choose a future timestamp within 24 hours. `--duration-seconds` runs from successful upgrade; the first `--warmup` pings are excluded from percentiles, matching the Node feed probe. Schedule different clients a fraction of a second apart if sharing an endpoint. Defaults are IPv4 only, 600 seconds, one ping per second, 5-second timeout and five warmup pings.

## Reports and comparison

The terminal prints p50/p95/p99 and error/reconnect/feed counters. JSON includes:

- `connection`: destination IP, TLS version, HTTP upgrade status, connection count, opening timestamp and elapsed time.
- `samples`: ping ID, UTC `sentAt`, `sentAfterOpenMs`, warmup flag, success, measured RTT or error. Only a pong with the exact outstanding `vinos-ping-ID` payload counts as success. Timed-out, cancelled and unmatched responses never become RTT observations.
- `stream`: complete messages and payload bytes consumed; no feed content is saved.
- `counts`, `measuredCounts`, `pingRttMs`, elapsed duration and clock drift. Percentiles use nearest-rank observations and exclude warmup and failures.
- `completed` means the observation duration ended normally. `eligibleForComparison` additionally requires at least 100 successful measured pings, at least 99% success, at least 80% scheduled sample coverage and clock drift within one second. Always inspect failures and sample sizes before ranking clients.

Exit codes: `0` = completed with measured successes and no timeout/failure; `2` = incomplete, interrupted, no measured successes or network errors; `1` = invalid configuration/report I/O/internal error. Clap argument syntax errors also use `2`. A short healthy smoke run can exit `0` while `eligibleForComparison` remains false.

RTT includes the client, network and remote pong handler. A smaller raw codec can reduce allocations, but does not establish a network latency advantage. Compare repeated runs on the same machine, release builds, destination IP, sampling cadence and overlapping request-start windows. Node uses OpenSSL and Rust uses rustls. Library and raw Rust use the same TLS stack, isolating codec differences more closely.

## Bounds and implementation scope

The raw reader uses an 8 KiB streaming read buffer and a 16 KiB upgrade-header limit. A frame or aggregated message cannot exceed 8 MiB; fragmented messages allow at most 4096 fragments. Server frames must be unmasked with valid opcodes, lengths and RSV bits; server ping payloads are echoed as masked pongs. Client frame masks and upgrade keys use OS randomness. Cancelled writes poison the raw writer because retrying a partially written frame would corrupt the stream. Network operations have deadlines and the event loop supports cancellation. Raw mode is a focused benchmark client, not a general-purpose application WebSocket SDK.

The library backend caps frames and messages at 8 MiB and its outgoing buffer at 4096 bytes; its internal fragment handling differs from the custom codec. Both drop the connection at the measurement deadline without waiting for a close handshake, matching the Node benchmark. During a server close or protocol error they record a partial report and exit; they do not reconnect.

## Checks

```sh
cargo fmt --manifest-path rust-websocket-probe/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust-websocket-probe/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path rust-websocket-probe/Cargo.toml --all-targets --all-features
```

Tests use local loopback servers and in-memory duplex streams. They cover both backends' reuse, feed draining, matching/unmatched pongs, server pings, upgrade rejection, deadlines, cancellation and report no-clobber behavior. Codec tests cover malformed/oversized/masked frames, fragmentation, UTF-8, limits, cancellation in partial reads and interrupted writes. Production code contains no unsafe Rust.
