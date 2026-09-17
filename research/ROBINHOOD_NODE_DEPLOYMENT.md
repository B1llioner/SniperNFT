# Dedicated Robinhood mainnet node

## Current status: cancelled and deleted on 2026-09-17

The user cancelled the own-node approach and explicitly requested deletion of
the node server. EC2 termination was completed and verified through direct AWS
CLI API calls:

- Node `i-07c02416ef9cc2e6c`: **terminated**, with no attached EBS volumes.
- Its root EBS volume `vol-0ed90a064bb441e7c`: no longer exists.
- No allocated Elastic IP was attached to this node before termination.
- Minter host `i-0ef42c1e5475d7edb`: **running**, original root volume retained.
- The shared security group and other infrastructure were retained.

The node's instance-store snapshot/database was discarded with termination.
No pacing proxy was deployed; its unfinished local implementation was archived
under `.state/robinhood-node-20260916/cancelled-proxy/`. The minter was never
migrated to this node. Continue using ready Robinhood readers and the official
Robinhood sequencer sender; do not recreate the own-node infrastructure unless
the user requests it again. The sections below are historical deployment notes.

Verification: `.state/robinhood-node-20260916/terminate-instance-result.json`,
`terminate-verification-instances.json`, `terminate-verification-volume.json`,
and `terminate-elastic-addresses.json` in the same directory.

## Host and scope

- Created: 2026-09-16 UTC, AWS Ohio `us-east-2c`.
- Instance: `i-07c02416ef9cc2e6c`, `i7ie.2xlarge`, private IP `10.73.2.223`.
- Hardware: 8 vCPU, 64 GiB RAM, two 2.5 TB local NVMe devices.
- Estimated recurring cost: $1.0481/hour, approximately $75.46 for 72 hours,
  including 32 GiB gp3 root disk and public IPv4, before taxes and additional
  metered traffic. This instance was explicitly authorized.
- Existing mint host: `i-0ef42c1e5475d7edb`; creating the node does not migrate
  the minter or change its endpoints.

The new machine's observed instance-store devices are `/dev/nvme0n1` and
`/dev/nvme2n1`. **Its EBS root device is `/dev/nvme1n1`.** Never copy disk numbers
from an example configuration. The installer checks model, serial, size,
partitions, existing signatures, and mount state before creating the array.

The database volume uses both instance-store devices as RAID0, mounted by
filesystem UUID at `/srv/robinhood`. Reboot assembly uses the saved array UUID;
recovery never automatically reformats storage. EC2 Stop/Start or termination
loses instance-store data; rebuilding requires another snapshot restore.

## Snapshot and runtime

The official snapshot catalog was checked on 2026-09-16:

- Latest completed Full-path snapshot: **2026-09-11**, 786,984,437,760 bytes,
  uncompressed multipart tar, Pebble database with path state scheme.
- Snapshot build: `v3.11.4-rc.3-7d5ac27`.
- Runtime: official stable `offchainlabs/nitro-node:v3.11.4-7d5ac27`, the same
  source commit as the snapshot build, released on September 16.
- Pinned manifest digest:
  `sha256:460918143cfdccc3aa984db8ca0c0d83b6054cec47ff10142bde4052054408ed`.

This snapshot's native Nitro manifest URL is missing, despite the two archive
parts and their official metadata being available. The reviewed fallback
downloads the two exact parts, verifies their sizes and SHA256 values from that
metadata, assembles the archive, and passes the local archive to Nitro. Local
`file:` import bypasses Nitro's remote checksum mechanism, so the download
stage must complete its own checks before Nitro starts. Both staging and the
extracted database reside on NVMe. An interrupted restore requires inspection
before deleting temporary files.

The downloader resumes partial files, stops after three unsuccessful transfer
attempts per part, and verifies each part again while assembling the archive.
Publication is atomic. The completed archive is mounted read-only into Nitro;
the downloaded parts are removed after publication. The snapshot service has
no automatic restart loop. The local archive is retained for recovery.

Reviewed bootstrap SHA256:
`abd0a36bfa10c06d2af36d6e7afc1b2d915a16b519fa7f977ad54b9126506979`.
Twenty local tests passed, including disk exclusion, interruption recovery,
checksum rejection, resume, and the three-attempt limit. The pulled official
image was also inspected on the new EC2 instance.

The 5 TB raw capacity provides substantial room beyond this snapshot, but an
exact three-day reserve must be checked against the restored size and measured
growth after catching up. Compare free space over time, excluding archive
cleanup and the initial catch-up period from steady-state growth estimates.

Sources: [Robinhood node guide](https://docs.robinhood.com/chain/run-a-full-node/),
[official snapshot catalog](https://snapshot-explorer.arbitrum.io/?chain=Robinhood+Chain),
[Nitro 3.11.4 release](https://github.com/OffchainLabs/nitro/releases/tag/v3.11.4).

## Network roles

- Node reads Ethereum execution and beacon data through PublicNode endpoints.
- Node receives the official Robinhood feed over
  `wss://feed.mainnet.chain.robinhood.com`.
- Node HTTP and WS ports are published only on host loopback:
  `127.0.0.1:8547` and `127.0.0.1:8548`.
- Transaction forwarding on the node is disabled. The minter's sender remains
  `https://sequencer.mainnet.chain.robinhood.com`.

The node does not require the wallet private key. Public L1 provider throttling
or missing historical blobs can slow or stop catch-up and must be diagnosed
from actual logs. No API key or private key belongs in this document.

## Operator access and readiness

From AWS CloudShell, open the **new node**:

```bash
aws ssm start-session --region us-east-2 --target i-07c02416ef9cc2e6c
```

After the bootstrap and status helper have been installed:

```bash
sudo /usr/local/bin/vinos-robinhood-node-status
sudo journalctl -u vinos-robinhood-snapshot.service -n 30 --no-pager
sudo journalctl -u vinos-robinhood-node.service -n 30 --no-pager
```

The status helper is read-only. It reports service state, capacity, `eth_syncing`,
chain ID, local head age, and the difference from an independent public head.
Its reference request sets a User-Agent accepted by the public endpoint; the
default Python urllib User-Agent received an HTTP error from this host, while
the explicit header was verified against both official RPC and PublicNode.
One observation does not establish readiness. Before switching a minter, verify
several fresh heads, chain ID 4663, completed syncing, the expected NFT runtime
and state, and successful representative simulations. Keep the existing reader
available until the replacement has passed these checks.

Measure the Rust minter on the node host and compare against the existing
arrangement under node load before selecting the final placement. Compare full
preparation and simulation time, submission acknowledgment, and latency spikes;
an HTTP acknowledgment alone does not measure inclusion time. Upgrade hardware
if measurements show CPU or memory contention limiting the result.

## Deployment status

The EC2 instance is running and SSM is online. Installation completed successfully
through SSM command `0f014648-c318-4c0c-a5af-f1633faf9251`: the NVMe array is
mounted, the pinned Nitro container and services exist, and the snapshot
download is running. The status helper is installed at
`/usr/local/bin/vinos-robinhood-node-status`. Nitro starts after the local
archive passes verification; sync completion and a minter migration are not
yet verified.

Actual observations on 2026-09-16 UTC:

| Observation | First part bytes written |
| --- | ---: |
| 21:33:02 | 8,149,508,096 |
| 21:33:22 | 10,633,605,120 |

The 20.098-second interval averaged approximately **123.6 MB/s** (decimal).
At that rate, the remaining download alone would take approximately 105 minutes;
checksum verification, assembly, extraction, and chain catch-up are additional.
This short sample is not a sustained-throughput guarantee. The mounted
filesystem reports 4,997,590,810,624 bytes total and, at the second observation,
4,949,826,854,912 bytes available. Nitro was waiting for its snapshot dependency
with zero restarts; unavailable local RPC during this stage is expected.

At **21:47:24 UTC**, 108,148,944,896 bytes had been downloaded (13.74%), with
4,849,598,611,456 bytes available. The official reference RPC check passed.
Ethereum execution RPC returned chain ID 1 and the beacon endpoint reported
`is_syncing=false` with the actual Go client User-Agent. Both host clocks
reported chrony `Leap status: Normal`; reported clock offsets are not a
guarantee of absolute UTC accuracy.

All 21 configured Nitro CLI arguments were accepted by the pinned image in a
disposable container with `--network none --read-only` and an appended `--help`.
That validation exited 0 without attaching or writing the snapshot/database.
It checks argument compatibility; database restore and completed sync are still
pending. The existing minter host has separately received the parallel-read
upgrade and passed read-only preflight; see `GENESIS_PARALLEL_PREFLIGHT_REVIEW.md`.

The reviewed bootstrap, status helper, placeholder spec, and regression tests are versioned
under `ops/robinhood-node/`. The default bootstrap mode is read-only planning;
the actual spec must name the intended instance and its observed blank disks.
Local operational evidence and instance-specific files are retained under
`.state/robinhood-node-20260916/`. The separate parallel-preflight change and
controlled benchmark are documented in `GENESIS_PARALLEL_PREFLIGHT_REVIEW.md`.

### Download recovery: 2026-09-16 23:56 UTC

The download stopped at 21:59:17 UTC after three failed attempts. Curl reported
error 92: the snapshot server reset an HTTP/2 stream with `INTERNAL_ERROR`.
The partial first part was preserved at 170,310,893,568 bytes; Nitro did not
start because its snapshot dependency failed.

A bounded HTTP/1.1 range probe returned HTTP 206 and the exact requested 1 MiB
at the saved offset. The bootstrap now explicitly uses `curl --http1.1` while
retaining resume, checksum verification, and the three-attempt limit. All 20
bootstrap tests passed, including interrupted-download resume and preservation
after three failures. The installed helper was atomically patched after checking
its old hash and the saved partial file; provisioning and disk formatting were
not rerun. New helper SHA-256:
`7d6ce288425db709cb65490e875dbd717d11d052cac83c3b705bfdf66038d5d3`.

Recovery SSM command `40f3bda7-5530-40cb-a101-acf9f052ea11` reset the failed
units and queued the node start with its snapshot dependency. The download log
confirmed `resumeBytes=170310893568`, with the same partial inode. Between
23:56:09.804 and 23:56:29.906 UTC, the file grew to 172,317,605,888 bytes:
21.90% of the complete snapshot, approximately 99.8 MB/s over this short sample.
Free space was approximately 4.784 TB. This confirms resumed transfer, not
sustained reliability or completed node sync. Evidence is saved in
`.state/robinhood-node-20260916/http1-resume-result.json`.

### Parallel range downloader: 2026-09-17

The subsequent HTTP/1.1 transfer also exhausted its three attempts: curl error
18 indicated a truncated response. It stopped at 00:33:48 UTC. A fresh check at
03:15:56 UTC confirmed the preserved first part at 388,536,532,992 bytes (49.37%
of the full snapshot), with Nitro inactive and no import started. The file inode
was 1073741954; approximately 4.574 TB remained available. Evidence:
`.state/robinhood-node-20260916/progress-20260917T0315.json`.

The new bootstrap uses eight concurrent requests, each at most 256 MiB. This
limits dependence on one uninterrupted multi-hour response. Exact HTTP range
responses are staged separately, synchronized, and appended to the existing
contiguous prefix. Successfully downloaded ranges survive retries. Three
successive failed waves stop the stage. The pinned whole-part hashes and final
archive checks remain required. `download_part` is retained for compatibility;
the production `prepare_snapshot` default is `download_part_parallel`.

Earlier bounded probes on the same EC2 measured approximately 100 MB/s with one
connection versus 458 MB/s combined with five connections. Those probes discarded
test bytes and lasted only a few seconds. They justify testing parallelism but
do not establish the sustained useful download rate.

Candidate helper SHA-256:
`9676ca928ee1114ec2122aca127cbb0414cf6b7b715e2a2dc2e155a9a3931b3b`.
All 29 local tests passed. The review and recovery invariants are documented in
`ROBINHOOD_PARALLEL_DOWNLOAD_REVIEW.md`. Before switching the installed helper,
the deployment must pass a real bounded range canary, acquire `download.lock`,
check the stopped services and old helper hash, preserve the partial file, and
atomically replace the helper. Provisioning and disk formatting must not rerun.

The guarded switch completed successfully through SSM command
`6c0141de-e7cd-4ba5-bec1-a1680199df97`. Before switching, all 29 tests passed on
the EC2 host and the candidate fetched an exact real 1 MiB range successfully
(SSM `5eb7ed41-0ef0-4938-a353-35591e640917`). The initial staging package omitted
the public example-spec fixture required by one negative test; adding that
fixture fixed the packaging check without changing the reviewed source.

The installed helper matches the candidate hash above. The existing part retained
inode 1073741954 and its initial/final 1 MiB sample hashes across replacement.
Its recorded resume offset was exactly 388,536,532,992 bytes. No provisioning,
formatting, or minter changes occurred.

| Observation (2026-09-17 UTC) | Contiguous part bytes |
| --- | ---: |
| 03:27:21.736 | 388,536,532,992 |
| 03:27:41.852 | 394,978,983,936 |
| 03:28:01.952 | 401,421,434,880 |

Useful part-file growth averaged **320.40 MB/s** over 40.215 seconds, approximately
3.2 times the prior 99.6 MB/s baseline. This includes appending and syncing the
downloaded ranges, rather than counting discarded probe bytes. Eight curl
processes were observed; all first six waves reported zero consecutive failed
waves. At the last observation the snapshot was 51.01% downloaded and 4.559 TB
remained free. systemd queued Nitro job 35926 behind running snapshot job 35927.
The snapshot is still incomplete; these observations do not establish long-term
stability or completed node synchronization. Full proof:
`.state/robinhood-node-20260916/parallel-upgrade-result.json`.

### Archive completion and Nitro cache profile

At 04:02:41–04:02:51 UTC on 2026-09-17, joining advanced from 240.384 GB to
250.408 GB at approximately 1000.8 MB/s. The RAID simultaneously read and wrote
about 1 GB/s; Python used about 68% of one CPU, while aggregate CPU idle was
76.75% and I/O wait 16.07%. Restarting the almost-completed join to introduce a
new algorithm was not justified. The existing verified join continued intact.
See `.state/robinhood-node-20260916/assembly-profile-summary.json`.

The actual pinned Nitro binary confirmed that next-block prefetch was already
enabled and the Pebble compaction concurrency limit was already eight. No
experimental parallel execution or validation-skipping flags were added.

The cache profile was verified against the installed binary with isolated
`--help`, then applied through SSM command
`9a49eda4-12ef-448b-8588-f62a44272f9a` at 04:13:55 UTC:

- `--execution.caching.database-cache=8192` (previous default 2048 MiB).
- `--execution.caching.trie-clean-cache=4096` (previous default 600 MiB).

Database cache capacity applies separately to execution and wasm databases.
The existing 42 GiB Go soft memory limit and 52 GiB container memory/swap limits
were retained. The complete container config, host config, mounts, and network
names passed parity checks, allowing only the two new flags and generated
hostname to differ. The old, never-started container was preserved as
`vinos-robinhood-node-before-cache-20260917`; the new container keeps the canonical
`vinos-robinhood-node` name. The download helper was not replaced during joining.
The versioned bootstrap now includes these cache settings for future installs.

Only the queued node start was briefly held during replacement. The snapshot
process continued with the same PID and completed successfully. At the recorded
replacement result, snapshot service was `active/exited`, `Result=success`, and
node start job 42640 was running. Import and completed sync require subsequent
runtime verification. No synchronization speedup has yet been measured.
Review: `ROBINHOOD_SYNC_TUNING_REVIEW.md`.

Runtime startup was verified at 04:14:57 UTC (SSM
`987e3d34-0c1b-4e57-8699-c5202d27ead1`): node service `active/running`, zero
restarts, Docker running, and `OOMKilled=false`. Logs showed
`extracting downloaded init archive` from 04:13:56 UTC, Nitro v3.11.4,
GOMAXPROCS 8, and an L1 connection with chain ID 1. The complete 786,984,437,760
byte archive and completion marker exist; source parts were removed normally.
Approximately 4.105 TB remained available. RPC was not ready during extraction,
which does not establish catch-up or a fully synced node. Evidence:
`.state/robinhood-node-20260916/cache-startup-result.json`.

### Historical L1 access after extraction

AWS operations for this repair now use a verified AWS CLI v2.36.47 temporary
sign-in session, authenticated by STS against the intended account. No permanent
IAM access key was created. The task-local `.state/aws-direct.py` wrapper uses
an isolated CLI-managed login cache and the official Ohio SSM endpoint
`https://ssm.us-east-2.api.aws`; the legacy SSM hostname was intermittently
unreachable from the workstation. Browser/CloudShell availability is no longer
required for command submission. Authentication still expires with the AWS
session; instance services run independently of that session. Authentication
files and cache contents are intentionally excluded from this repository.

At 05:04:18–05:04:28 UTC on 2026-09-17, extraction was complete and the local
RPC answered with chain ID 4663, but the head stayed at block 60,277,774.
The reference gap increased from 4,824,372 to 4,824,473 blocks. The Ethereum
execution endpoint `https://ethereum-rpc.publicnode.com` returned HTTP 403 on
the historical `eth_getLogs` needed by Nitro, requiring a personal token.
This blocked L1 inbox reading; it was not a missing Robinhood snapshot or an
out-of-memory failure. Approximately 3.389 TB remained free. Evidence:
`.state/robinhood-node-20260916/progress-20260917T050418.json`.

A keyless replacement, `https://rpc.mevblocker.io`, passed a bounded read-only
preflight from the node EC2 at 05:29:47 UTC. SSM command:
`f6018035-de23-4572-985b-4d2a7d7c6a13`.

| Historical request | Result |
| --- | --- |
| Ethereum chain ID | 1 |
| Original failing two-block log query | 2 events, 293 ms |
| 1,000-block log query | 1,131 events, 2.873 s |
| Full historical block | Expected block hash and batch transaction, 440 ms |
| Batch transaction receipt | Expected transaction/block and successful status, 340 ms |
| Beacon blobs for that batch | 3 blobs of 131,072 bytes, 131 ms |

The Beacon endpoint remains `https://ethereum-beacon-api.publicnode.com`.
The pinned Nitro source uses `/eth/v1/beacon/blobs/{slot}` with repeated
`versioned_hashes` query parameters. The preflight checked response structure,
count and lengths; Nitro itself recomputes KZG commitments and checks the hashes
when ingesting blobs. It does not rely on the legacy `blob_sidecars` endpoint.
Proof: `.state/robinhood-node-20260916/mev-extended-result.json`.

The installed node was switched to MEV Blocker for **L1 reads only**. These are
point-in-time availability measurements, not a provider uptime or throughput
guarantee. The proposed unthrottled MEV Blocker bootstrap default was withdrawn
after the runtime rate-limit failure below. The existing bootstrap's PublicNode
default is also unsuitable for this snapshot without historical-access repair;
do not treat a fresh bootstrap as sync-ready. Repeat sustained historical L1 and
Beacon checks before future deployments. The minter's transaction sender remains
the official Robinhood sequencer.

The first switch attempt stopped at its **pre-shutdown parity check** at
05:33:13 UTC, with `HOST_CONFIG_PARITY_FAILED` (SSM
`f8aea416-0fec-4650-907b-0ab332a5b9c8`). The running node had not been stopped
or replaced. A read-only comparison at 05:50:59 UTC found exactly one difference:
`HostConfig.OomKillDisable` was `null` in the old container and `false` in the
created candidate (SSM `5ad785af-794a-4ce7-96ef-b3420cc72503`). Evidence:
`.state/robinhood-node-20260916/l1-switch-result.json` and
`.state/robinhood-node-20260916/l1-hostconfig-diff.json`.

The revised comparison normalizes only that `null`/`false` representation on
copied host configs; all other fields still require equality. `true` and other
types are rejected, including when both containers specify `true`. This retains
OOM protection: [Docker's implementation defaults an unset value to `false`](https://github.com/moby/moby/blob/v28.2.2/daemon/daemon_unix.go).
The candidate is reused without starting a second database writer.

The revised one-time switch script passed syntax validation and **13 local mock
tests**, including both normalization directions, rejection of OOM-disable and
other config drift, dirty/timeout shutdown, rollback after startup or rename
failure, and prevention of two concurrent database writers. Its SHA-256 is
`86b9600d15f9aa3701d4581cb8dd40f60134c9495684ca02bfebb59dd8f1477b`.

The guarded switch then succeeded at **06:03:03 UTC** through SSM command
`d13536bd-1ff0-403c-86f9-411796d2659e`: `switched_running`,
`parityPassed=true`, and `oldStoppedCleanly=true`. The old container
`3a33dd8d3241…` is preserved as
`vinos-robinhood-node-before-l1-mevblocker-20260917`; the reused candidate
`a37c04fd3dff…` now has the canonical `vinos-robinhood-node` name. Only
`parent-chain.connection.url` changed. Data, snapshot, pinned image, mounts,
memory/cache limits, Beacon endpoint, and transaction forwarding settings were
retained; the installed bootstrap helper was not replaced by this operation.
Evidence: `.state/robinhood-node-20260916/l1-switch-direct-result.json`.

This result confirms a running replacement container, **not completed
synchronization** (`syncCompletionVerified=false`).

A subsequent two-sample check at **06:09:52–06:10:22 UTC** (SSM
`69497dd7-8575-4b14-bc62-3078aec01525`) found the local head still fixed at
60,277,774; the reference gap increased from 4,863,447 to 4,863,744 blocks.
Nitro remained running with zero restarts and `OOMKilled=false`, but MEV Blocker
returned HTTP 429 / Cloudflare error 1015 on latest/finalized header reads and
inbox processing. The response requested at least 30 seconds before retrying.
The initial successful requests therefore did **not** establish that the public
endpoint could sustain Nitro's request pattern. Sync remained blocked by
throttling; the RPC switch itself succeeded, but the recovery was not complete.
Evidence: `.state/robinhood-node-20260916/l1-progress-direct-result.json`.

Before treating this endpoint as a working deployment default, adjust the
request/retry pattern or select an upstream that supports it, then verify actual
head movement and convergence. Do not point the minter at this node while it
remains behind the network.
