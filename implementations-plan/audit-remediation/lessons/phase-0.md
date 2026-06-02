# Audit-remediation — implementation status

> Branch `audit-remediation`. **Commits UNSIGNED** this run — 1Password SSH agent failing
> (`failed to fill whole buffer`); per the owner's convention, committing via
> `git -c commit.gpgsign=false` and backfilling signatures later
> (`git rebase --exec 'git commit --amend --no-edit -S' main`). Phase `safe-vN` tags
> deferred to the backfill pass (tag signing uses the same agent).

## Phase checklist
```
[▶] P0 — surface reduction + green CI (host/build; no firmware)
[ ] P1 — host clear-signing policy (TS)
[ ] P2 — firmware policy/hardening (blind_signing toggle, path-canon, rate-limit, cmov, session-reset)
[ ] P3 — device UI/review (DRIP render, 8+8 recipient+sender, raw amount, honesty nits)
[ ] P4 — B3 wire v3 (salt+profile_id, derive-don't-trust) — ISOLATED, firmware-first
[ ] P5 — privacy/metadata + build/manifest provenance
[ ] P6 — validation (Speculos+testnet matrix, fuzz/differential-replay) + post-impl codex review
```

## P0 sub-steps
- [▶] P0.1 — delete `apps/demo` + `packages/adapter-trezor` + the dead core Intent path (`computeOuterHashForIntent`, `IntentAuthWitnessProvider`); update `ci.yml`, workspaces, the "mirrors adapter-trezor" comments. Dissolves AHW-028/036/073/074/075/076/077/078.
- [ ] P0.2 — fix the remaining `tsc -b` errors (AHW-030); split `apps/demo-browser` app/test tsconfigs (AHW-031/032); make typecheck a blocking CI gate.
- [ ] P0.3 — `internalDeps` stops exposing `session`/`ledgerProvider`; cache the clear-signing account (AHW-002).
- [ ] P0.4 — `bun.lock` override `systeminformation ^5.31.6`; surface `bun audit` in CI summary (AHW-033).
- [ ] P0.5 — comment-truth + dead-SW + dedup path-check (AHW-006/013/014/019*/020*/041/058/070). *019/020 gated on re-confirming dudect/aztec_secret.c before rewriting (don't overstate CT resistance).

## Recon (verified before deleting)
- `adapter-ledger` has ZERO live (non-comment, non-test) refs to the core Intent path → safe to delete `computeOuterHashForIntent`/`IntentAuthWitnessProvider` from `core`.
- `adapter-trezor` consumed ONLY by the dead `apps/demo` (+ doc-comments in adapter-ledger).
- `apps/demo` referenced ONLY by `ci.yml:36` (the `tsc -b` line) + itself.

## Log
- (P0.1) …
