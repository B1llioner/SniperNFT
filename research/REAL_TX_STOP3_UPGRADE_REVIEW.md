# Stop-after-three upgrade: independent review addendum

## Findings and scope

**No blocking finding identified** in `rust-mint-benchmark/src/observer.rs` terminal-update changes or `.state/aws-ohio-20260916/real-tx-stop3/cloud-upgrade.py`, including its generated remote Python and launcher. Ready for installation subject to the limits below. Profiles: strict code review, Rust and secure code. No database or contract changes are assessed here; this is not an independent review of the monitor written by this reviewer.

Review date: 2026-09-16. The parent reports that the kit was uploaded; installation had not yet occurred when this addendum was prepared. This reviewer performed only local reads, syntax checks and archive comparisons, with **no AWS calls, credentials, signed transactions or installation actions**.

## Exact reviewed inputs

| Input | SHA-256 |
| --- | --- |
| `observer.rs` | `992effa076b35f51ced51644afc65b2f44683f6252eb5860061058d679e112ad` |
| `cloud-upgrade.py` | `541b0cf4b4ba741dc905a85dea8f94dbbed936fb7c8832819510d8bd2b9e921d` |
| Unchanged `build-and-package.py` | `d030e31f6b82964279c94046d1103609bc1717c8e9e3f20009cf1763fb1b4c99` |
| `source-v2.tgz` | `9fcf08bc389731afadf32c6ea23eff062639060bcf24242dac2a14a5f8690367` |
| `vinos-real-tx-stop3-kit-9fcf08bc389731af.tgz` | `623da58e764e53227eb889c0b416021d3fa271057bf8f675353a298eda98ddff` |
| `SOURCE_PACKAGE-v2.json` | `125dbd9a6128d62ee9696391fc8b3bd71544dee7f18b0455dbe682a403b64f4e` |

The builder is byte-identical to the version covered by [the original install review](REAL_TX_INSTALL_REVIEW.md).

## Assessment

- **Observer:** one terminal update per accepted hash, including receipt errors. Lifetime registrations and update capacity are both ten. Nonblocking publication cannot delay receipt polling; an impossible full channel becomes an explicit error. Closing the consumer preserves final results. Streaming order is completion order; final results remain in registration order. The sole update sender belongs to the worker and closes after watcher completion, allowing the monitor to drain and finish. Cancellation retains task ownership and aborts outstanding work.
- **Upgrade:** account, Ohio region and retained instance are fixed and checked. Approved source provenance is required before AWS requests. A durable exclusive intent precedes submission; automatic SDK retries are disabled. The remote program checks exact old-launcher bytes, old-install provenance, private state, pending markers and active benchmark executables. It does not read process arguments or environments.
- **Publication:** strict regular-file extraction into a fresh root-owned directory; artifact and binary digests checked; synchronized immutable destination; old installation and recovery metadata retained. The launcher replacement is atomic and synchronized. The only binary invocation is `--help`; installation never starts a benchmark or supplies a key.
- **Wallet exclusion:** the upgrade holds the persistent `4663-0x59Cd658EB1be492c52CcAA2575A90A236F77fAE2.lock` inode under `/var/lib/vinos-real-tx/locks` through the launcher switch and verifies that inode again. This exactly matches `Journal::create`: Alloy 1.6.0 `Address` display uses the uncompressed EIP-55 checksum, independently confirmed for this wallet using ethers. No pending marker is created or cleared by the upgrade.
- **Secrets and scope:** the artifact-only HTTPS presigned URL is limited to the fixed bucket/path, requested for 600 seconds, and suppressed from normal output. Errors do not print raw URL/SDK exception text. No IAM, security-group or instance-lifecycle changes are made.

## Verification and limits

Independent checks passed: Python and generated-Python parsing; generated launcher `bash -n`; exact old-wrapper SHA-256; all **20 source archive files** matched both `SOURCE_PACKAGE-v2.json` hashes and current local bytes. Names were unique normalized relative regular files. The kit digest matched, and its three files matched the verified source archive, unchanged builder and reviewed upgrade helper byte-for-byte. The observer author separately reported 11 passing tests covering streaming completion, capacity, poisoning and consumer closure.

The process scan is not atomic with an operator starting another CLI: keep the server quiescent during upgrade. The wallet lock prevents overlapping live work on that inode, but cannot prevent an old binary being manually started after a scan or coordinate another server. Trusted local user/root and controlled CloudShell/toolchain assumptions from the original review still apply. A presigned URL remains visible to authorized SSM parameter readers until expiration. After an ambiguous upgrade, inspect the durable intent, destination and launcher instead of blindly resubmitting. Installed provenance, Linux readiness and final preflight remain release checks; this review does not establish mainnet mint success.
