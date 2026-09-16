# Rust sequencer micro probe

Read-only latency test against the official Robinhood mainnet submission endpoint:
`https://sequencer.mainnet.chain.robinhood.com`. Sends only
`arb_checkPublisherHealth`; no wallets, deployment or transactions.

## Build and run

Requires Rust >= 1.88; tested with Rust 1.93.0. On Amazon Linux 2023 install
GCC (`sudo dnf install -y gcc`) and a Rust toolchain, then build **on Linux x86_64**:

```sh
cargo build --release --locked --jobs 1
./target/release/rust-sequencer-probe \
  --label ohio-a-rust --duration-seconds 600 --interval-ms 1000 \
  --warmup 5 --timeout-ms 5000 --output rust-a.json
```

Copy only the resulting executable to matching Amazon Linux 2023 x86_64 instances.
It uses rustls + ring and embedded public CA roots; OpenSSL is not needed.
The macOS build does **not** run on Linux. `Cargo.lock` pins dependencies.

For coordinated tests add `--start-at 2026-09-16T04:48:00.500Z`, replacing the
timestamp with a future UTC time within 24 hours. Initial warmup and subsequent
keepalive requests before that timestamp are excluded from the measured samples.
Allow enough preparation time: an already-passed start is rejected.

`--endpoint` accepts HTTPS or local HTTP for mock tests. Defaults: 1,800 seconds,
1 request/second, 5 warmup samples, 5-second full-request timeout. Duration is
bounded to 7,200 seconds; interval is 100–60,000 ms. Use the default 1-second
interval for the public endpoint. No automatic retries or redirects.

For a controlled comparison, pass `--connect-ip <IPv4>` with a current IPv4 address
of the official endpoint and configure the other client with that same IP. This
bypasses DNS for TCP connections while retaining the URL's HTTP `Host`, TLS SNI
and certificate verification. It does not change the URL to an IP address or
disable TLS checks. The default remains ordinary DNS resolution; a pinned IP can
become unavailable, so use this option for a bounded benchmark and refresh DNS
between runs. A matching IP reduces one source of variation; load balancers may
still route connections to different upstreams.
For parity with the Node client, an IP-literal URL must match the supplied IPv4
pin exactly; IPv6-literal URLs cannot use this IPv4-only pin. Use the hostname URL
for normal endpoint benchmarking.

## What is measured

One explicit persistent HTTP/1.1 connection, IPv4, TCP_NODELAY, TLS certificate
verification. Each sample records whether it actually used the existing connection;
`connectionId` changes on a successful reconnect. A failed connection is discarded.
This connection reuse was already present in the original micro probe: the TLS
client configuration and HTTP sender are created once and retained across requests.
They are not recreated for every sample. Warm requests do not repeat DNS, TCP or
TLS setup while the connection remains usable.
The timer starts before request work and ends after the complete response body and
JSON-RPC version, request ID and `result: null` have been checked. Response bodies
are capped at 64 KiB. The full timeout includes DNS, TCP, TLS and stalled bodies.

This micro version measures **warm requests only**. Its schema is distinct from the
JavaScript AZ report: it does not provide cold DNS/TCP/TLS phase timings or IMDS
metadata. Use labels to map the Rust report to the EC2 instance and zone. Compare
successful `reusedSocket: true` requests with the equivalent JavaScript samples,
using the same host, endpoint, interval and overlapping time window. The fixed
IPv4 policy matches the JavaScript CLI default `--family 4`.

`totalMs` is an application-level health response round trip. It does not measure
transaction inclusion, order at the sequencer or pure CPU runtime overhead.
TLS stacks, CPU scheduling, network variation and backend load can affect the
difference. Run both clients in the same time window; repeat before attributing
a small difference to the language. The JS command also emits occasional cold
requests; account for that in the test description.

JSON includes all measured successes and failures, individual `totalMs`, UTC
timestamps anchored to a monotonic clock, skipped scheduling slots, warmup counts,
connection IDs, remote IPs, errors and nearest-rank p50/p95/p99 in milliseconds.
Successful reused and fresh connections are summarized separately. Slow requests
cause skipped slots, never catch-up bursts. Progress prints every 30 seconds.

`settings.connectIp` records the optional destination pin. `connectionStats`
contains actual lifetime transport counters, **including warmup and interrupted
requests**: DNS lookups, TCP connect attempts, established TCP connections,
completed TLS handshakes, HTTP connections, attempted requests and requests on an
already-used HTTP connection. For example, 605 requests with 604 reused requests,
one TCP connection and one TLS handshake confirms one persistent HTTPS session.
Attempted/reused counts can include failures; use sample `ok` and the existing
success distributions when comparing latency. The existing `metrics.reconnects`
continues to cover measured samples only. Transport counters also print at exit.

`eligibleForComparison` requires completion, at least 100 successful reused
samples, at most 1% errors, at least 95% connection reuse among successes, at least
80% of expected requests and at most 1-second wall-clock drift. It is a per-report
quality gate, **not** a cross-report comparison or declaration of a winner.
Compare raw distributions, sample counts and error rates together.

Output must be a new file in an existing directory; it is opened exclusively with
0600 permissions on Unix. SIGINT/SIGTERM save a valid partial report. Abrupt process
kill or host failure cannot guarantee the final report; there are no periodic disk
checkpoints in this micro version. Exit codes: `0` eligible completed report,
`2` partial/ineligible report (including short smoke tests), `1` operational error;
argument parsing errors also use `2` before any report is created.

## Local verification

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```

Tests use local HTTP fixtures: real socket reuse/reconnect, protocol errors,
redirect rejection, oversized bodies, timeout, exclusive output and signal-driven
partial report. They verify 16 requests reach one accepted TCP connection and
pinned TCP routing preserves the original HTTP Host without a DNS lookup. They
never call a live sequencer.
