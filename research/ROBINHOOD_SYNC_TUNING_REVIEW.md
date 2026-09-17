# Code Review Report

## Findings

No blocking finding in the two cache settings. Synchronization throughput has
not yet been measured; increasing cache capacity must not be reported as a
measured speedup. Container replacement requires a stopped, never-started
container and must not interrupt an ongoing import.

## Summary

- Scope: resource measurements during archive assembly and two Nitro cache flags
  in the bootstrap's container creation command.
- Profiles: secure code and strict code review; Python infrastructure only.
- Risk: bounded additional memory use; actual workload and catch-up rate remain
  to be observed under the existing memory limits.
- Verification: 29 bootstrap tests pass; the installed, digest-pinned Nitro
  binary accepts the exact proposed flags in an isolated `--help` invocation.

## Domain Logic Assessment

At 04:02:41–04:02:51 UTC on 2026-09-17, archive assembly advanced from
240.384 GB to 250.408 GB, approximately 1000.8 MB/s. The RAID device read and
wrote approximately 1 GB/s each; Python used about 68% of one CPU. Aggregate
CPU idle was 76.75% and I/O wait 16.07%. Both NVMe devices were continuously
busy, although a busy percentage alone does not prove maximum SSD throughput.
With approximately nine minutes remaining, implementing and restarting a
parallel join would risk losing more elapsed work than it saved. The running
join is left intact, including its hash checks and final atomic publication.

Nitro v3.11.4 already enables next-block prefetch and defaults to eight possible
Pebble compactions on this host. Source review of `DigestMessage` confirms that
the next message can prefetch state in a goroutine, while committed execution
requires the previous state and is protected by a block-creation mutex. There
is no supported change here that turns committed block execution into eight
independent workers.

The cache profile changes only:

| Flag | Previous default | Selected value (MiB) |
| --- | ---: | ---: |
| `execution.caching.database-cache` | 2048 | 8192 |
| `execution.caching.trie-clean-cache` | 600 | 4096 |

The database cache is supplied separately to the execution and wasm databases:
budget up to 16 GiB combined, plus 4 GiB clean trie cache and the unchanged
1 GiB dirty-cache setting. Existing `GOMEMLIMIT=42GiB`, 52 GiB container limit,
and equal memory-swap limit remain unchanged on the 64 GiB machine. Cache sizes
are capacities; actual memory consumption and performance depend on workload.

## Rust Quality Assessment

Not applicable: the Rust minter is unchanged. No custom Nitro or Go build is
introduced. Built-in prefetch and compaction parallelism remain enabled.

## PostgreSQL Assessment

Not applicable: no SQL or migrations.

## Security Assessment

The user authorized acceleration and server configuration. No wallet material
is needed. Keep the pinned image, data/config/snapshot mounts, loopback ports,
memory limits, feed, and L1 endpoints identical. A replacement must be created
and inspected before swapping names. Cancel only the queued node start while
the snapshot service continues. Preserve the old created container for rollback;
never apply this transition if it has started importing. Requeue node startup
after success or restore the original container on failure.

## Smart Contract Assessment

Not applicable: no smart contract or transaction changes; node validation checks
remain enabled.

## Test Assessment

- `python3 ops/robinhood-node/test_bootstrap.py`: 29 tests passed.
- `git diff --check`: passed.
- Actual binary defaults: SSM `e740018a-73ac-4ab4-b3c1-2880ccf51892`.
- Exact flags accepted in isolated container: SSM
  `dab81f52-cdc6-4859-be01-d0d4841bd362`.
- Production synchronization and performance comparison: pending initial import.

## Recommendations

Apply only the reviewed cache settings. Preserve existing prefetch and Pebble
defaults; do not enable experimental writer settings or skip validation. Follow
local head advancement and the gap to an independent reference after import.

## Residual Risk

Cache benefits are not yet measured. L1 RPC/beacon rate limits, state access,
disk throughput, or ordered execution may dominate catch-up. A larger cache is
not a guarantee of shorter synchronization. The running archive join should not
be replaced merely to increase its nominal worker count.

## Primary sources

- [Nitro v3.11.4 execution engine](https://github.com/OffchainLabs/nitro/blob/v3.11.4/execution/gethexec/executionengine.go)
- [Nitro cache configuration](https://github.com/OffchainLabs/nitro/blob/v3.11.4/execution/gethexec/blockchain.go)
- [Nitro database configuration](https://github.com/OffchainLabs/nitro/blob/v3.11.4/cmd/conf/database.go)
- [Robinhood full-node guide](https://docs.robinhood.com/chain/run-a-full-node/)

Local source copies, image help, and host measurements are saved under
`.state/robinhood-node-20260916/`.
