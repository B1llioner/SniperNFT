# Robinhood WebSocket micro-probe

Small Node 22 CLI, one pinned dependency (`ws`), one WebSocket connection, no wallet or transactions.

The [official Robinhood endpoints](https://docs.robinhood.com/chain/connecting/) list
`wss://feed.mainnet.chain.robinhood.com` as the **Sequencer Feed** and
`https://sequencer.mainnet.chain.robinhood.com` as the sequencer submission endpoint.
The feed receives sequenced data. A low feed ping RTT does **not** demonstrate fast
transaction submission, acceptance or inclusion. Message arrival time after opening
is reported separately; it is not end-to-end network latency.

## Install and test

```sh
cd websocket-sequencer-probe
npm ci --ignore-scripts --no-fund
npm test
```

## Feed benchmark

```sh
node probe.mjs probe --label ohio-a --duration-seconds 600 --output ohio-a-feed.json
```

For simultaneous measurements across machines add the same future UTC time:

```sh
node probe.mjs probe --label ohio-a --duration-seconds 600 \
  --start-at 2026-09-16T06:00:00.250Z --output ohio-a-feed.json
```

Use the actual future time. An already elapsed start runs immediately. The timestamp
starts the connection attempt; the 600-second ping observation window begins after
the connection opens. With companion HTTP tests a +250 ms start phase spreads initial
requests, although handshake differences mean ping phases are not exact.

Defaults: 1 ping/second, 5-second timeout, first 5 pings excluded from percentiles.
`--interval-ms` accepts 100–60000; `--timeout-ms` 50–60000; `--warmup` 0–1000;
duration 1–3600 seconds. Only one outstanding ping is allowed. If it has not finished,
the next tick is counted as skipped. No catch-up bursts or automatic reconnects.

Use `--family 4` to force IPv4, `--family 6` for IPv6, or default `--family 0`
to let the OS/Node resolver choose. Compare runs using the same family setting.

Output JSON and stdout contain:

- Connection/open latency, peer IP/family, TLS protocol, upgrade HTTP status.
- Matched control-frame ping/pong RTT p50/p95/p99 (nearest rank), raw RTT samples,
  warmup flags, failures, timeouts, skipped ticks and unmatched pong counts.
- First message after open, message count and byte count, without storing feed contents.
- Completed/incomplete status, labels, host/Node/library versions, timestamps and clock drift.

Duration completion can still contain ping failures; inspect counts alongside percentiles.
`Ctrl+C`/`SIGTERM` writes an incomplete report and exits 2. A disconnect ends the run
and records it without reconnecting. Output is mode 0600, published atomically, and
an existing output file or symlink is refused. Use a fresh output name per run.

TLS certificate verification stays enabled. No redirects, per-message compression,
URL credentials, URL query strings, or raw response logging. Incoming messages are
limited to 8 MiB; protocol fragment counts are bounded. Plain WS is allowed only for
local tests on loopback. Node event-loop and proxy overhead are included in RTT;
the answering peer may be an edge service rather than the sequencer process.

## Submission endpoint WebSocket capability check

The WSS version of the submission endpoint is a **hypothesis**, not an official
documented submission endpoint. Check it once:

```sh
node probe.mjs capability --output sequencer-wss-capability.json
```

This attempts one upgrade to `wss://sequencer.mainnet.chain.robinhood.com`.
Only if it opens, it sends one unsigned `arb_checkPublisherHealth` request and waits
for the matching JSON-RPC ID. Rejected upgrades preserve their HTTP status; no retries.
A valid health response establishes that particular method works over that connection;
it does not prove transaction submission is supported. A completed capability run may
contain a JSON-RPC error, so inspect `capability.rpcSucceeded` as well.

Capability mode explicitly refuses the official feed hosts. Feed mode never sends
JSON-RPC messages. Exit 0 means the requested observation finished, exit 2 means a
network failure/interruption, exit 1 means bad arguments or inability to save output.

## Upload artifact

Distribute only `package.json`, `package-lock.json`, `probe.mjs`, `README.md` and `test/`;
run `npm ci --ignore-scripts` on the target before a measurement window. Do not bundle
`node_modules`, reports, environment files or wallet material. Build/install activity
should finish before comparing identical hosts under a common test window.
