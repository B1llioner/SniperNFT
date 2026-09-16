# Install-kit Code Review Report

## Findings

**No blocking finding identified in the frozen scripts below.** Ready to build and install the reviewed package on the retained EC2 instance. This disposition covers installation only; the installer does not start a paid benchmark.

## Summary

- **Scope:** `.state/aws-ohio-20260916/real-tx/build-and-package.py`, `cloud-install.py`, generated remote Python, generated Bash wrapper, final user-bootstrap change, source archive and its included documentation.
- **Profiles:** Strict review, secure code; Rust/contract behavior is covered separately by [the CLI review](REAL_TX_CODE_REVIEW.md). PostgreSQL is not applicable.
- **Reviewed source archive:** `2eaacf0ff7073f55bec8a77c8fd1a3a0c56e60a85162fc779211ac061c13065c`.
- **Build script SHA-256:** `d030e31f6b82964279c94046d1103609bc1717c8e9e3f20009cf1763fb1b4c99`.
- **Installer SHA-256:** `a60a0226d9bc5369bc9084da37653644b485535a3d67929c8eae1dc48e317837`.

## Security and Domain Assessment

- **AWS scope:** Account `543777713568`, region `us-east-2`, retained instance `i-0ef42c1e5475d7edb` are fixed and checked. The helper reads instance readiness and bucket public-access blocking, uploads only `real-tx/<artifact-sha256>.tgz` into the fixed bucket with expected-owner checking and SSE-S3, and submits one command to that explicit instance. It does not alter IAM, security groups, bucket policy, instance lifecycle or other servers.
- **Ambiguity:** A new private, synchronized local intent precedes upload/SSM submission. Reusing it is rejected. SDK retries are disabled; a lost SSM acknowledgement requires inspecting the intent/command state, rather than blindly issuing the install again. A root install lock and destination/launcher-existence checks protect the remote path. Incomplete installation can require manual reconciliation; there is no automatic destructive cleanup.
- **Source/build integrity:** The archive digest is checked before extraction. Its 19 members were independently compared with the reviewed source manifest and current documentation. The builder pins Rust 1.93.0, verifies the official rustup checksum, uses `cargo build --release --locked --jobs 1`, and records source and binary hashes. The built artifact must report the exact approved source digest above before installation.
- **Extraction:** Source and install archives accept exact allowlisted normalized relative paths, regular files only, no duplicate names, no links, and bounded member counts/sizes. Extraction writes each member explicitly to a fresh directory with `xb`; it never delegates path handling to `extractall`. Remote archive and binary digests and manifest equality are rechecked before publication.
- **Installation layout:** Versioned root-owned code under `/opt/vinos-real-tx/<artifact digest>`; root-owned launcher; private `/var/lib/vinos-real-tx` state/lock directories owned by `ssm-user`. The final bootstrap creates that account with `/usr/sbin/useradd --create-home --shell /bin/bash` only if absent, with a 30-second timeout. It does not grant sudo or change IAM. Existing `chronyc` is required.
- **Keys/commands:** Installer smoke test is only `--help`; no `--send`, private key, wallet file or raw transaction is supplied. The wrapper requires `ssm-user`, disables core dumps, sets umask 077, accepts only `preflight|https|wss|both`, fixes the expected public wallet and 0.019/0.001 ETH cap/reserve, and uses one absolute lock directory. A future live invocation obtains its key through the CLI's hidden terminal prompt. Fixed fresh output paths prevent an accidental repeated run of the same wrapper mode.
- **Presigned URL:** The object URL is HTTPS, short-lived (requested lifetime 600 seconds) and limited to the artifact. It is passed through the SSM input and never printed by normal helper output; exception text is reduced to types/codes and status output redacts URLs. It is still visible to principals authorized to inspect SSM command parameters until expiration. The artifact contains reviewed software/docs/public wallet metadata, not private keys or AWS credentials.

## Verification

Independent local checks passed without calling AWS, contacting endpoints or executing packaged binaries:

- Parsed both Python scripts and generated remote Python with `ast.parse`.
- Validated the generated launcher using `bash -n`.
- Verified the source archive SHA-256 and all 19 member contents against reviewed/current local files.
- Successfully extracted the valid source into a fresh temporary directory.
- Rejected archive fixtures containing parent traversal, absolute paths, symlinks and duplicate files.

The implementing agent separately reported mocked installer checks and syntax validation. The reviewer did not run a real install, download a signed URL, inspect credentials or change EC2 state.

## Rust / Smart Contract Assessment

No Rust or Solidity implementation is changed by these scripts. The builder embeds the source-reviewed contract artifact and produces the CLI reviewed in `REAL_TX_CODE_REVIEW.md`. Installer `--help` only establishes that the binary starts; Linux Chrony and actual endpoint/budget preflight remain necessary before a funded run.

## PostgreSQL Assessment

Not applicable: no database or migration operations.

## Residual Risk and Release Gates

- Compile/install operations trust the controlled CloudShell environment, downloaded locked dependencies/toolchain and root on the EC2 host. The build inherits that environment and reuses task-specific `/tmp` Cargo directories; this is not an adversarial build sandbox or a reproducible-build attestation. Cargo build scripts execute with the builder's permissions.
- The installer validates the package's internal manifest, while the operator must bind `sourceSha256` to the approved archive digest above. A self-consistent arbitrary artifact is not automatically approved code. Confirm the generated build status/manifest and package hash before invoking installation.
- The short-lived URL appears in SSM command input by design. Do not print the generated command or inspect full command parameters as routine progress output.
- The installed code is immutable to the benchmark user, but that user can edit its own reports/lock state. The wallet lock is cooperative and local to this server; the wallet must not be used concurrently elsewhere.
- Final installation success, exact installed binary hash, usable `ssm-user` terminal, Chrony readiness and read-only endpoint/budget preflight must be verified by the parent workflow. None of these checks implies a guarantee of mainnet mint success or first-block inclusion.
- If either script or build input changes, compare its diff and refresh the recorded hashes before using the revised kit.
