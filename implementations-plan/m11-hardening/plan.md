# M11 — Tier-0/Tier-1 Hardening — CONSOLIDATED PLAN

Tier-A protocol. Consolidated from 3 independent drafts ([plan-main.md](plan-main.md), [plan-opus.md](plan-opus.md), codex session `019e7f52`) + [research-ledger-security.md](research-ledger-security.md). Provenance noted per decision. Status: **pending final codex review + approval.**

## Reframe (research-grounded)
Our crypto is already at/above the shipped+audited bar of the closest peer (Mina Ledger app, non-native Pallas + custom Schnorr). This is **targeted hardening, not a rewrite**:
- Scalar mul is already add-always + bitmask-cmov (> Mina's conditional-add). The only real CT leaks are **3 data-dependent branches** (two infinity short-circuits + `H==0`) in the shared point core — and that core is used by `[k]G` **AND Pedersen** (codex catch).
- **Dual-derive the nonce+scalar = the #1 win** (closes the only flagged fault gap; cheap; output-identical → parity-trivial). All 3 drafts rank it first.
- Wide-reduce bias ≈ **2⁻²⁵⁸** → T0.3 is a documented analysis + statistical test, **no code change**, **no rejection sampling** (all 3 agree).
- **Out of scope (all 3 agree):** `cx_math_*`/`cx_bn_*` field-arith migration — a separate milestone, not a hardening sweep.

## Decisions where drafts diverged (resolved)
1. **CT technique** — codex: complete/exception-free add/double; opus: offset-accumulator (high-bit seed so the accumulator is never `O` in-loop) + `*_ct` add; main: branch-removal, ladder only if needed. **Resolved:** harden ONE shared point core; primary = complete (RCB, exception-free; Grumpkin is `a=0` so it simplifies); fallback = offset-accumulator if complete formulas blow the flash/latency budget. Output must stay byte-identical (parity-locked). No Montgomery-ladder rewrite, no scalar blinding (preserves determinism, no RNG).
2. **T1.1 deployer** — opus + codex independently: do **not** put a raw `deployer` on the wire (host-controlled signing semantics, untethered from a reviewed profile). **Resolved:** wire carries `salt + profile_id`; `deployer` stays **profile-pinned + reviewed**. If custom deployer becomes real, evolve the *deploy* profile/codegen too + sign+show it (separate scope).
3. **Manifest versioning** — codex: split authwit vs deploy versions rather than one `L4_MANIFEST_VERSION`. **Adopted.**
4. **Dedup placement** — main wanted it first; codex/opus place it before T1.1 (its real value is shrinking T1.1's blast radius — the crypto changes are in different files). **Resolved:** dedup just before T1.1, paired with the fuzz harness.
5. **CT scope** — codex: must cover Pedersen. **Adopted** (shared core).
6. **New gate** — codex: nanos2 flash-size + sign-latency regression after CT. **Adopted.**
7. **Fuzz target** — codex: the device *handler seam* (state mutation), not just TS encoders. **Adopted** (`wire_host/` compiles the real L4 handlers).

## Common validation gates (reused every phase; codex-supplied)
- **Host parity:** `bun test packages/adapter-ledger/src/grumpkin-*.test.ts packages/adapter-ledger/src/pedersen-parity.test.ts packages/adapter-ledger/src/schnorr-*.test.ts packages/adapter-ledger/src/blake2s-parity.test.ts packages/adapter-ledger/src/poseidon2-parity.test.ts`
- **Nano S+ build:** `cd ledger-app && docker run --rm -v "$PWD:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1def30b4b8377120df663ebff91e9fd9b7548ee1fd8c0a3ff74df708a162 make BOLOS_SDK=/opt/nanosplus-secure-sdk`
- **Speculos:** docker `speculos@sha256:9b414c…` on `5001`/`9999`, mount `bin/app.elf`.
- **Browser e2e:** `cd apps/demo-browser && bunx playwright test <file>.e2e.ts` (the `schnorr-full-flow.e2e.ts` on-chain run is the decisive no-human proof for any signing change).
- NOT a gate: the legacy `ledger-app/tests/*.py` (L2/K1-weighted — codex).
- Self-validation loop: each phase ends with the gate above + (for the risky phases) a logged codex adversarial micro-review before the safe-tag.

---

## Phases

### P0 — Validation infra + baselines (test-only, no risk)
**Changes:** (a) dudect-style timing harness over the host-compiled shared point core (`grumpkin_host` sibling `grumpkin_dudect.c`): Welch t-test, runtime vs secret-scalar class; exits non-zero over threshold. Caveat documented: host proxy — catches *algorithmic* secret-dependent control flow (our branches), not device µarch. (b) A flash-size + sign-latency baseline capture (parse `app.elf` size; Speculos sign-cycle timing) → recorded budget for the P3 regression gate.
**Validate:** harnesses build + run; dudect on current code FAILS (documents the leak P3 fixes); baselines recorded in `lessons/`.
**Deps:** none. **Rollback:** test-only.

### P1 — Dual-derive scalar+nonce + memory-hygiene sweep (T0.2 + T0.4) ⭐
**Changes:** `aztec_secret.c` — `az_derive_schnorr_signing_scalar` + `az_derive_schnorr_nonce` get `*_once` cores wrapped by dual-derive: derive twice via independent buffers, ct-compare, mismatch → `reject(SW_FAULT_DETECTED)`. Switch all Schnorr scalar/nonce users (`get_schnorr_pubkey.c`, `begin_deploy_account.c`, `finalize_deploy_and_sign.c`, `finalize_and_sign.c`). Correct the M10-softened comments (gap now closed). Same phase: low-risk hygiene — `PIC()` on Flash-table derefs (`*.gen.c`, generators/params), `LEDGER_ASSERT(cx_… == CX_OK)` discipline sweep, `explicit_bzero` audit on all fault paths.
**Validate:** common gates; schnorr-sign + schnorr-partial parity UNCHANGED (output identical — only verified); `schnorr-full-flow.e2e.ts` on-chain green; `provider.m8.test.ts` (SPECULOS_URL). → **`safe-v9`.**
**Deps:** none (do first). **Rollback:** revert aztec_secret.c; ECDSA byte-stable (don't touch `sign_outer_hash.c`).
*(Provenance: ordering = all 3; hygiene-grouping = codex; fault-buffer-independence = opus/codex P6c idiom.)*

### P2 — Modular-bias analysis doc + statistical test (T0.3, doc/test-only)
**Changes:** write the 2⁻²⁵⁸ wide-reduce argument (doc under `implementations-plan/m11-hardening/`). Extend `grumpkin-fq-wide-parity.test.ts` with a bounded statistical sanity test + assert NO rejection-sampling path exists (guard against future drift).
**Validate:** `bun test …/grumpkin-fq-wide-parity.test.ts …/oracle/aztec-derivation.test.ts`.
**Deps:** independent (can land with P1). **Rollback:** docs/tests only.

### P3 — Constant-time shared point core (T0.1) ⚠ delicate
**Changes:** harden the add/double in `point.c` (and its callers `mul_generator.c` fixed+var-base, `pedersen.c` accumulator) to remove the 3 data-dependent branches — ONE hardened exception-free core shared by all three. Primary: complete RCB formulas (`a=0`); fallback: offset-accumulator + `*_ct` add if flash/latency over budget. Keep the OLD impl reachable behind a build flag until parity+timing+size all green (codex/opus safety).
**Validate:** common gates; grumpkin scalar-mul parity 7/7 + pedersen-parity + schnorr-sign vs barretenberg all **byte-identical**; **P0 dudect PASSES**; **flash-size + sign-latency within the P0 budget** (codex regression gate); `schnorr-full-flow.e2e.ts` green. → **`safe-v10`.**
**Deps:** P0 (gates), P1. **Rollback:** flip back to old core; safe-v9.

### P4 — Shared account-binding module + handler-seam fuzz (T1.2 + T1.4)
**Changes:** extract `derive_signing_pubkey_xy` (×3) + `deploy_derive_pubkey_xy`/`deploy_compute_partial` (×2) into `l4/account_binding.{c,h}` (semantic no-op). New `ledger-app/tests/wire_host/` compiles the REAL L4 handlers (`begin_authwit.c`, `append_call.c`, deploy-begin) with host shims; bounded libFuzzer/ASan corpus runner targeting **handler state mutation**, seeded from `provider.test.ts` negative cases + new targeted negatives (truncated/oversized/non-canonical-Fr/bad-(curve,profile)/wrong-version/trailing-bytes/state-violation).
**Validate:** common gates; `provider.test.ts`; `wire_host` corpus + bounded fuzz clean under ASan. → **`safe-v11`.**
**Deps:** independent of T0; do before P5 (shrinks its blast radius). **Rollback:** revert TU/harness (refactor is a no-op).

### P5 — Authwit v3 binding + metadata-driven profile (T1.1 + T1.3) ⚠ riskiest
**Changes:** introduce a **separate authwit manifest version** (not the shared `L4_MANIFEST_VERSION`); `BEGIN_AUTHWIT` carries `profile_id + salt` (NOT raw deployer). `begin_authwit.c` + `session.h` + host `l4-manifest.ts` + `auth-witness-provider.ts` updated. B3 in `finalize_and_sign.c` uses the carried `salt`/`profile_id` (+ deployer from the pinned profile) instead of hardcoded zero/profile-0. Host `aztec-ledger-session.ts` reads `profileId` from generated `deploy_profiles.generated.ts` by scheme (T1.3). **Clean break** — device rejects the old version (no limping). Keep the fail-closed assertion (opus: the break is *enabling* non-zero-salt accounts, not closing a hole).
**Validate:** `gen:clear-signing-v0:check`; common gates; new parity test — B3 address recompute with **non-zero salt** vs host `computeAddress`; `deploy-review.e2e.ts` + `schnorr-deploy-review.e2e.ts` + `schnorr-full-flow.e2e.ts`; a new **non-zero-salt authwit** e2e (verified `From` still correct). ECDSA + zero-salt regressions green. → **`safe-v13`.**
**Deps:** P4. **Rollback:** clean break — never run a safe-v11 host against a safe-v13 device; revert to safe-v11.
*(Provenance: split-versions + "deploy must evolve if custom deployer is real" = codex; deployer-stays-pinned = codex+opus; metadata profile = all 3.)*

### P6 — Schnorr transfer matrix + private-mode binding audit (T1.5)
**Changes:** parameterize a `schnorr-transfer-modes.e2e.ts` over all 4 modes (`pub→pub` proven; `priv→pub`, `pub→priv`, `priv→priv`) on one deployed Schnorr account. **Investigate opus's flag:** the B3 self-spend gate binds `from` via `consumer`==account-address; verify the **private** modes actually bind `from` the same way (private calls may not surface `from` to B3) — if not, that's a real finding to fix, not just an e2e.
**Validate:** common gates; the 4-mode e2e green on testnet. → **`safe-v14`.**
**Deps:** P1/P3 (hardened sign). **Rollback:** validation phase; code only if the audit finds a gap.

### P7 — Final codex post-impl review + fix loop
Consolidated diff + summary → codex (xhigh, adversarial ask) → triage → fix → close. Update `lessons/`, `index.md`, memory. → final tag.

---

## Security & Adversarial Considerations
- **Threat model:** (1) malicious/compromised host — mitigated: device reconstructs `outer_hash` (Poseidon2 over the manifest) + derives+verifies its own address; (2) **fault injection** on signing — P1 dual-derive closes the derivation gap (construction was already dual-run); pre-sign B3/Phase-6 recompute remains; (3) **side-channel** on physical silicon — P3 removes control-flow leaks in the shared point core (covers `[k]G` + Pedersen); (4) **scheme/account confusion** — existing `(curve_id, arg_schema)` fail-closed pairing + P5 generalization keeps deployer profile-pinned; (5) **malformed wire** — P4 fuzzes the handler seam (state mutation), not just encoders; (6) **supply chain** — host `@aztec` pinned + 7-day min-age; device deps = BOLOS SDK + builder/speculos pinned by digest.
- **What an attacker targets:** the signing key via repeated/biased nonce (P1 fault-closes; bias ≈2⁻²⁵⁸; deterministic nonce, no RNG); device side-channel (P3; residual µarch); tricking the device to sign for a wrong account (device-derived address + consumer cross-check, generalized in P5, deployer stays reviewed); parser state corruption (P4).
- **What we trust (unchanged):** BOLOS `cx_*`, the `@aztec` libs, the `noir-lang/schnorr` in-circuit verifier, Aztec domain constants.
- **Residuals (documented, NOT fixed in M11):** device µarch side-channels (host-dudect is an algorithmic proxy — no physical-device leakage testing); `cx_math` migration deferred; **no external audit** (owner-deferred); per codex, M11 closes obvious control-flow leaks but is not "side-channel complete" (`point.h` still documents data-dependent field arithmetic — that's the deferred `cx_math` milestone).

## Open questions (for the approval gate)
- **Q-A:** Is non-zero salt / custom deployer actually imminent? If the next demo stays zero-salt + universal deployer + 2 profiles, codex's smaller alternative ("make zero-salt explicit + fail-closed, skip the wire break") is cheaper. *Owner already chose the version-bump break (clarifying Q2) → proceeding, but P5 is the cut point if priorities shift.*
- **Q-B:** P3 complete-formulas vs offset-accumulator is decided by the P0 flash/latency budget — acceptable to defer that choice into the phase?
- **Q-C:** P6 may surface a private-mode `from`-binding finding that expands scope — fix in M11 or split out?

## Rejected / out of scope
- Rejection sampling on the wide-reduce (pointless, ~2⁻²⁵⁸ — research).
- `cx_math_*`/`cx_bn_*` field-arith migration (separate milestone — all 3).
- Montgomery-ladder rewrite + scalar blinding (unnecessary given cmov core + determinism — main/opus).
- Full matrix (Nano X/Stax/Flex) + external audit (owner-deferred).
