# Verified stop-after-three installation

Installed on 2026-09-16 on retained EC2 `i-0ef42c1e5475d7edb`, `us-east-2c`. The other Ohio instances remain stopped. Source commit: `df796d0`, branch `test/rust-timed-mint`.

## Evidence

- Approved source SHA-256: `9fcf08bc389731afadf32c6ea23eff062639060bcf24242dac2a14a5f8690367`.
- Linux artifact SHA-256: `306ad82efa47f153e49d0d30a99630e9acdad7d4f4303dfa0b6561c0ec74329b`.
- Installed binary SHA-256: `7ceadea6659e63c90656a83edb51df283c2d09cc97c1aec494f5605098d6ac8e`.
- Launcher SHA-256: `094d1acacfa2c7c3400c1cc9030ba06b32e03ba36978fec2e29f9ac6c845adc0`.
- Upgrade SSM command `259faf8b-981e-4e26-b47c-4add4f00c812`: Success. Previous version retained; launcher atomically replaced.
- Read-only verification `72289a1e-95cf-4ace-87b6-9890b97a76c3`: Success. Binary hash matched the build manifest, both routes simulated 10 NFT, batch estimate 1,560,422 gas. Balance 0.02 ETH, maximum reserved cost 0.0137643624 ETH, configured cap 0.019 ETH and reserve 0.001 ETH. These fee values are a snapshot; live preflight recalculates them.
- Chrony conservative error estimate: 0.1321565 ms, normal leap status, stratum 2.
- Plan confirmed `failurePolicy: first-block`, `consecutiveFailureLimit: 3`.

Downloaded evidence archive SHA-256: `deb81115da94d0c9099bec3ac2e4ecfa51f58c8d55d41b4447a26ecad484746e`; all nine bounded JSON members verified and saved under `.state/aws-ohio-20260916/real-tx-stop3/`. No private key was read and no funded transaction was sent during installation or preflight.

## Interactive launch

In AWS CloudShell:

```bash
aws ssm start-session --region us-east-2 --target i-0ef42c1e5475d7edb
```

Inside EC2, as `ssm-user`:

```bash
vinos-real-tx both
```

Enter the expected wallet key only at `Private key (hidden, not saved):`. After entry, fresh checks precede paid deployment and minting. Keep the session open. New sends stop after three consecutive incomplete batches or misses of the first L2 block; success resets the count. Unknown send outcomes stop immediately, and receipt feedback lag has its own conservative stop. Already submitted transactions may still execute.

Reports are under `/var/lib/vinos-real-tx/run-both-001/`. After a stop, inspect `diagnostics.json`, `diagnostics-preliminary.json` and `journal.jsonl`; the pending marker blocks an unreviewed restart. There is no automatic retry or second-route start after the guard trips. HTTPS uses the official sequencer; WSS uses PublicNode JSON-RPC, a separate network route.
