# Dedicated Robinhood mainnet node

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
