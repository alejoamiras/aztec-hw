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
- [x] P0.1 — DONE (commit 7ef2e7c): deleted `apps/demo` + `packages/adapter-trezor` + the dead core Intent path; removed the re-exports from `core/index.ts` + the dead refs from `ci.yml`. `bun test packages/` green (117 pass/0 fail). Dissolves AHW-028/036/073/074/075/076/077/078.
- [—] P0.2 — DEFERRED (CI): `tsc -b` test-file errors / tsconfig split / blocking gate (AHW-030/031/032). **Owner deprioritized CI** — skipped; the pre-existing test-file `noUncheckedIndexedAccess` errors remain (don't affect `bun test`).
- [→] P0.3 — `internalDeps` (AHW-002) → folded into P1 (host security).
- [—] P0.4 — DEFERRED (CI): dep override + `bun audit` summary (AHW-033). Owner deprioritized CI.
- [→] P0.5 — comment-truth + dead-SW + dedup (AHW-006/013/014/041/058/070) → end-of-run sweep; CT-comment rewrites (019/020) gated on dudect re-verify.

## Stale doc-comments to sweep later (deletion residue, cosmetic)
`adapter-ledger/package.json:5`, `auth-witness-provider.ts:4`, `index.ts:8,10`, `provider.ts:9` still say "mirrors adapter-trezor" — clean up in the end-of-run comment sweep.

## Recon (verified before deleting)
- `adapter-ledger` has ZERO live (non-comment, non-test) refs to the core Intent path → safe to delete `computeOuterHashForIntent`/`IntentAuthWitnessProvider` from `core`.
- `adapter-trezor` consumed ONLY by the dead `apps/demo` (+ doc-comments in adapter-ledger).
- `apps/demo` referenced ONLY by `ci.yml:36` (the `tsc -b` line) + itself.

## Log
- (P0.1) …
