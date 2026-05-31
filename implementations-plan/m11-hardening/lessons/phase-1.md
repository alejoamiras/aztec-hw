# M11 P1 — dual-derive + hygiene (DONE → safe-v9)

## Dual-derive (commit 494ae35)
`aztec_secret.c`: `az_derive_schnorr_signing_scalar` + `az_derive_schnorr_nonce` now derive TWICE into independent buffers via `*_once` cores, gated by `dd_eq32_dir` called twice (forward + reverse, `volatile` accumulator) with two separate reject sites. Output byte-identical (deterministic) → parity unchanged.

**Validated on-chain (the decisive gate):** schnorr-full-flow e2e PASSED (5.7m) — Schnorr #4 re-derived its exact M10 address (`0x11ce2beb…`), deploy self-skipped, **drip err="" + transfer err="" (tx 0x036e14cf…)**, 0 console errors. Schnorr #0 also re-derived `0x27cb…`. So the dual-derived scalar (B3 path) + nonce (sign path) produce valid Schnorr authwits on testnet. ECDSA untouched (aztec_secret.c is Schnorr-only).

## codex audit (session in /tmp codex-…, prompt m11-codex-p1-audit.md)
- **Dual-derive verdict:** buys real protection in the single-transient / glitched-compare model; does NOT catch common-mode corruption of the shared input. That's acceptable because the sign paths have a downstream identity invariant — the pre-sign B3 / Phase-6 address recompute rejects a wrongly-derived key (`SW_AUTHWIT_CONSUMER_MISMATCH`). **Residual (documented):** `get_schnorr_pubkey.c` has no LOCAL downstream check, so a common-mode input fault there yields a wrong pubkey cleanly — but it's caught at sign time by B3 (the device re-derives + cross-checks), so it's a system-level non-issue.
- **Compare provability:** the nanos2 `app.asm` confirms two real compares + two branches today (not optimized away). Added `__attribute__((noinline))` to `dd_eq32_dir` (cheap future-proofing so the compiler can't merge them). text 45138→45650 (+512 B, ok).
- **Hygiene sweep = SKIP (codex-confirmed unnecessary).** The built code ALREADY uses PC-relative addressing for every candidate (`cs_deploy_profile_lookup`, `GRUMPKIN_G_*`, the `*.gen.c` tables — verified in app.asm), so `PIC()` is not needed and adding it on already-relocated pointers is noise-or-harmful. `cx_*` return checks are adequate (no unchecked call in src). `explicit_bzero`/`grumpkin_secure_wipe` already at/above bar. So P1's "hygiene" reduces to: audited, already good, + the one noinline.

## P3 recipe (codex — use this next)
Do NOT offset-accumulator or RCB. Exception-free **branch surgery** on the existing dbl-2009-l / madd-2007-bl in `point.c`:
- delete `point_double:79-85` early return (dbl-2009-l collapses to O for p=O; Y==0 unreachable for valid finite points).
- delete both `point_add_affine:142-147` (∞) and `:159-176` (H==0) early returns.
- always compute gen=madd(p,Q), dbl=2p, qj=(qx,qy,1), inf=O; then cmov-select: out=gen; cmov(out,inf, H==0 && r≠0); cmov(out,dbl, H==0 && r==0); cmov(out,qj, p.z==0).
- preserves affine output exactly (parity-locked), kills the leading-zero + H==0 leaks. Residual: `point_to_affine_be:226` still branches on final ∞, but signing rejects zero scalars/nonces so it's outside the secret path.

## Process lesson
Commit failures with `2>/dev/null` hid the REAL cause: commitlint rejected an invalid type `docs+test(...)` ("type may not be empty"). It was NEVER a signing/agent glitch. Use a valid conventional type (one of feat/fix/docs/test/refactor/…) and don't suppress hook stderr when debugging a failed commit.

safe-v9 = P0 (infra) + P1 (dual-derive) + P2 (bias) complete. Next: P3 (constant-time point core).
