# Phase 2 — re-validate the full matrix + gates (post-refactor)

## Fast gates — GREEN (this session, off safe-v22)
- `bun run lint:all` → exit 0 (biome + sort-package-json + actionlint). 67 warnings / 45 infos are
  PRE-EXISTING repo-wide (noNonNullAssertion, noExplicitAny, etc.); my P1 files are biome-clean; no errors.
- `bun test packages/` → **141 pass, 32 skip (Speculos-gated), 0 fail** (core + adapter), incl. the new
  `l4-manifest-parity.test.ts` (6/6).
- `git grep` of {submitClearSignedIntent, createAuthWitFromIntent, createAuthWitForDeploy,
  FrozenAuthWitnessProvider, setAuthWitnessOverride, runRecipe, 2770bcb} in `src/*.ts` → only explanatory
  COMMENTS, no code refs. **Workarounds gone.**
- **Net LOC: −734** vs safe-v21 (157 insertions, 891 deletions) — well past "net LOC down".

## Already proven on-chain across P0/P1 (the matrix, piecemeal)
- ECDSA-K: transfer via real sendTx (safe-v20, tx 0x2b146ce0…); self-paid deploy via
  feeEntrypointOptions→wrapExecutionPayload (safe-v21, tx 0x1c36fd8d…); #2 drip+transfer via the
  DEFAULT (no ?seam, tx 0x285ad017…).
- Schnorr: #1 drip+transfer (tx 0x2d5296e2…), #3 drip+transfer (tx 0x171714fd…) via the DEFAULT.
- Schnorr deploy: composition argument (dropdown indices exhausted; see phase-1.md).

## Slow gates — REMAINING (Speculos/testnet; loop-driven) → safe-v23
- [ ] Consolidated full matrix in ONE pass on testnet+Speculos: deploy/drip/transfer × {ECDSA-K, Schnorr},
  no ?seam (the new default). Deploy rows need FRESH indices (scarce — ECDSA #0/#2/#3/#4, Schnorr #1/#3
  already on-chain); if none free, rely on the per-row proofs above + the composition argument, documented.
- [ ] M12 device fuzz (libFuzzer/ASan handler-seam) — firmware UNCHANGED ⇒ expected green; re-run to confirm.
- [ ] M12 bidirectional Speculos differential-replay (779 inputs) — `buildL4Manifest` wire bytes UNCHANGED
  ⇒ expected green; re-run to confirm the host parse-seam still matches the device.
- [ ] Speculos-gated tests (the 32 skips: b3-consumer-binding [ported to deviceOuterHashForIntent in P1.5],
  schnorr/ecdsa flows, etc.) run green under SPECULOS_URL.

## Then P3
- Assess genuine upstream residue (encoding stability/versioning; seam discoverability/docs; published
  test vectors). If real → `docs/aztec-js-upstream.md` + codex-as-Grego re-review before any send; else
  internal notes. DONE when all phase tags pushed + closing codex review folded.
