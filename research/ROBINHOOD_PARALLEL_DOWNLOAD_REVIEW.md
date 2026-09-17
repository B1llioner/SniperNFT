# Code Review Report

## Findings

No blocking findings remain in the reviewed Python change. Production transfer
rate and the server deployment are separate verification steps; see the deployment
runbook for observed results.

## Summary

- Scope: snapshot range downloader and its integration with the existing archive
  verification pipeline in `ops/robinhood-node/bootstrap.py`.
- Profiles: secure code and strict code review. Only Python infrastructure code
  changes; the Rust minter, contracts, and database interfaces are unchanged.
- Risk: bounded transfer failures can stop preparation; corrupted data cannot
  authorize import without passing the pinned full-part SHA-256 checks.
- Verification: 29 local tests pass, including nine parallel-download tests.

## Domain Logic Assessment

The existing part file is a contiguous prefix. Eight workers each fetch at most
256 MiB into separate scratch files. Only an exact HTTP 206 response with the
requested Content-Range, exact length, successful curl exit, and no non-identity
content encoding becomes a `.ready` file. Scratch writes are synchronized before
atomic publication. Ready ranges are appended in order and the part file is
synchronized before removing its source range.

An interruption midway through append leaves the ready source available. On the
next run, the downloader copies only the suffix beyond the saved part length.
Successful out-of-order ranges survive failures. Unpublished pending ranges may
be downloaded again; they never authorize advancement of the contiguous prefix.
Three successive waves containing failed requests stop the downloader, preserving
the prefix and successful ranges. A clean wave resets the failure count.

Each completed part still passes its original pinned SHA-256 check. Archive
assembly rechecks part hashes and publishes the archive and completion marker
through the existing recovery path. The exclusive download lock covers the whole
snapshot preparation stage. The server switch must hold that same lock while
checking stopped services and replacing the helper.

## Rust Quality Assessment

Not applicable: no Rust changes. Python uses a bounded executor (default eight,
allowed one through sixteen workers), bounded range bodies, HTTPS-only curl
requests, per-request timeouts, and bounded failed waves. Worker exceptions stop
the stage; the executor waits for in-flight bounded requests. systemd owns the
process group and service termination also stops curl children.

## PostgreSQL Assessment

Not applicable: no SQL, migrations, or database client changes.

## Security Assessment

- Authorization: user explicitly requested the server upgrade and atomic switch.
- Input: snapshot host, path, sizes, and SHA-256 values remain pinned constants.
- Files: root-owned production directories, single-link regular files, no writable
  group/other permissions, exclusive creation, overlap rejection, bounded names,
  and atomic ready-file publication. Root is the trusted filesystem administrator.
- Processes/network: argument arrays, no shell interpolation, no proxy or
  redirects, HTTPS, explicit HTTP/1.1, and disabled implicit curl configuration.
- Secrets: no wallet, credentials, or private key is read by the downloader.
- Dependencies: Python standard library and the already installed curl.

## Smart Contract Assessment

Not applicable: no contract, deployment, signature, or minting behavior changes.

## Test Assessment

`python3 ops/robinhood-node/test_bootstrap.py` passes 29 tests. New coverage checks
actual concurrent scheduling with a barrier; prefix and inode preservation;
out-of-order reuse; recovery after an injected partial append; exactly three
failed waves; HTTP status, range, duplicate header, length, encoding, timeout,
and curl failure rejection; final checksum rejection; unsafe paths and overlaps;
verified archive publication and marker reuse; and invalid worker bounds.

`git diff --check` passes. Local network behavior is mocked; a bounded real HTTPS
range canary on the EC2 host is required before installing the candidate.

## Recommendations

No outstanding code changes are required before the guarded deployment. Keep
the final checksum and archive publication checks enabled. Report actual useful
file growth after switching, rather than the throughput of discarded probes.

## Residual Risk

- The CDN may interrupt or reject even short range requests; three failed waves
  still require diagnosis, not unlimited automatic restarts.
- Short parallel probes proved increased aggregate throughput, not a sustained
  production rate. Appending and synchronizing data adds disk work.
- Power loss can require redownloading unpublished scratch ranges. Full-part
  hashes detect corruption but do not automatically repair a corrupt prefix.
- This does not make an instance-store disk persistent across EC2 Stop/Start.
- Full node synchronization and minter placement remain separate checks.
