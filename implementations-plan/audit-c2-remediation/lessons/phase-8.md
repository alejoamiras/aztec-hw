# Phase 8 (P8) — register finalize + post-impl codex review — DONE

## Register (audit/index.md)
**12 FIXED:** AHW-087, 095, 096, 097, 098, 099, 100, 103, 106, 108, 109, 112.
**RESIDUAL:** 104 (defanged by 097), 105 (subsumed by 098).
**DEFERRED:** 101/102 (CI build-gate / reproducible build), 107 (frontend recovery-index limit).
Inline residual notes on AHW-096 (hand-edited `*.gen.c` → AHW-102) and AHW-109 (`0x6F06` dup-sig
reject branch = glitch-only, untestable via emulator).

## Post-impl codex review — see `audit-codex-postimpl.md`
Verdict fix-first. Folded **1 HIGH** (W4 was opt-in → `connect()` now attests by default),
**1 MED** (centralized review-snapshot disarm on reset/reject), **1 LOW** (narrowed
`getLedgerProvider` → `getCaps`/`attestReceiveAddress`). **1 LOW accepted** (marker migration
scoped to deploy/reveal/address walkers — blind-sign page count is stable). No CRITICAL. Commit
`c5b8b54`. Codex independently confirmed W4 device parsing, snapshot-return, host fail-close, and
W2 single-sourcing as sound.

## Final validation (the DONE gate)
- `bun run lint:all` exit 0 · `bun test packages/` 135 pass / 0 fail · adapter `tsc` clean (3
  pre-existing unrelated test-file errors only).
- Firmware-native `review_snapshot_test` exit 0.
- Speculos matrix (rebuilt elf, app version 0.1.0), ECDSA + Schnorr:
  - `provider.test` 9 — blind-sign (+ disarm-on-reject) + low-S/secp.verify + GET_VERSION 0.1.0 + GET_CAPS 0x1D.
  - `provider.m8` 10 — reveal, deploy (+ AHW-096 sponsor render), **GET_AZTEC_ADDRESS round-trip device==host for BOTH ECDSA (profile 0) and Schnorr (profile 1)**, 0x6F0D/0x6F04 rejects.
  - `wire-reject-arms` 4 — exact-SW per APPEND_CALL arm (0x6F09/0A/0B/0C).
  - `verified-calls-content` 2 — clear-sign verbs unchanged.

## Open on return (NOT code — process)
- **Commits UNSIGNED** — 1Password agent died mid-session; backfill `git rebase --exec 'git commit --amend --no-edit -S' main`.
- **NOT merged** to main, no PR.
- **Demo e2e** (`smoke.e2e`/`OnboardPanel`, frontend — OUT of the firmware+wire audit scope): with
  `connect()` now attesting by default, the demo onboarding will prompt an on-device address
  confirmation. A real Ledger user just taps; the Speculos-driven e2e needs an attestation autoConfirm
  step (or `attestReceiveAddress:false` if a test deliberately wants the legacy path). Frontend follow-up.
