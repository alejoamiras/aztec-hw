# M11 — Tier-0/Tier-1 Hardening — CONSOLIDATED PLAN

Tier-A protocol. Consolidated from 3 independent drafts ([plan-main.md](plan-main.md), [plan-opus.md](plan-opus.md), codex session `019e7f52`) + [research-ledger-security.md](research-ledger-security.md). Provenance noted per decision. Status: **final codex review FOLDED (verdict changes-needed → all points addressed below); pending owner approval.**

## Final codex review (session `019e7f52`, folded)
Verdict **changes-needed** — all addressed:
- **Blocker (P5 stale fuzz):** the authwit v3 schema change makes P4's fuzz corpus stale → reopened parser bugs. **Folded:** P5 gate now re-runs + extends `wire_host` with v3 negatives (mixed-version, truncated-v3, extra-tail, bad-(curve,profile), wrong-salt).
- **Blocker (no ECDSA authwit gate):** the P1 hygiene sweep + P5 version break could regress the legacy `SIGN_OUTER_HASH`/ECDSA witness flow unnoticed. **Folded:** P1 + P5 gates add `provider.test.ts` ECDSA signing/authwit coverage.
- **Major (P3 thin vectors):** byte-identical on a thin set can hide exceptional-state breaks. **Folded:** P3 adds crafted/randomized edge vectors (`P=Q`, `P=−Q`, `Z=0`, scalar `0/1/msb`, long Pedersen chains) vs bb.js.
- **Major (timing gate semantics):** **Folded:** dudect = the *algorithmic* CT gate; Speculos size/latency = *perf* regression only (NOT leakage); on-device µarch leakage stays an explicit residual.
- **Major (dual-derive not fault-hard alone):** **Folded:** P1 hardens the compare itself — two independent compares (opposite order, `volatile` accumulators) + two reject sites before use.
- **Minor (private-binding audit too late):** **Folded:** the private-mode `from`-binding audit moves to a P4 spike (before `safe-v13`); the 4-mode matrix stays in P6; `safe-v13` is provisional pending the spike.
- **codex confirmed right:** deployer stays profile-pinned, split authwit/deploy versions, P3 covers the shared Pedersen point core, real nanos2 size/latency gate, fuzz the handler seam not TS encoders.

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
**Changes:** `aztec_secret.c` — `az_derive_schnorr_signing_scalar` + `az_derive_schnorr_nonce` get `*_once` cores wrapped by dual-derive: derive twice via independent buffers, then **two independent ct-compares** (opposite byte order + `volatile` accumulators) with **two separate reject sites before any use** — so a shared-input fault or a skipped-compare branch can't bypass it (codex Major); mismatch → `reject(SW_FAULT_DETECTED)`. Switch all Schnorr scalar/nonce users (`get_schnorr_pubkey.c`, `begin_deploy_account.c`, `finalize_deploy_and_sign.c`, `finalize_and_sign.c`). Correct the M10-softened comments (gap now closed). Same phase: low-risk hygiene — `PIC()` on Flash-table derefs (`*.gen.c`, generators/params), `LEDGER_ASSERT(cx_… == CX_OK)` discipline sweep, `explicit_bzero` audit on all fault paths.
**Validate:** common gates; schnorr-sign + schnorr-partial parity UNCHANGED (output identical — only verified); `schnorr-full-flow.e2e.ts` on-chain green; `provider.m8.test.ts` + **`provider.test.ts` ECDSA signing/authwit** (SPECULOS_URL) — the hygiene sweep must NOT regress the legacy `SIGN_OUTER_HASH`/ECDSA witness path (codex Blocker). → **`safe-v9`.**
**Deps:** none (do first). **Rollback:** revert aztec_secret.c; ECDSA byte-stable (don't touch `sign_outer_hash.c`).
*(Provenance: ordering = all 3; hygiene-grouping = codex; fault-buffer-independence = opus/codex P6c idiom.)*

### P2 — Modular-bias analysis doc + statistical test (T0.3, doc/test-only)
**Changes:** write the 2⁻²⁵⁸ wide-reduce argument (doc under `implementations-plan/m11-hardening/`). Extend `grumpkin-fq-wide-parity.test.ts` with a bounded statistical sanity test + assert NO rejection-sampling path exists (guard against future drift).
**Validate:** `bun test …/grumpkin-fq-wide-parity.test.ts …/oracle/aztec-derivation.test.ts`.
**Deps:** independent (can land with P1). **Rollback:** docs/tests only.

### P3 — Constant-time shared point core (T0.1) ⚠ delicate
**Changes:** harden the add/double in `point.c` (and its callers `mul_generator.c` fixed+var-base, `pedersen.c` accumulator) to remove the 3 data-dependent branches — ONE hardened exception-free core shared by all three. Primary: complete RCB formulas (`a=0`); fallback: offset-accumulator + `*_ct` add if flash/latency over budget. Keep the OLD impl reachable behind a build flag until parity+timing+size all green (codex/opus safety).
**Validate:** common gates; grumpkin scalar-mul parity 7/7 + pedersen-parity + schnorr-sign vs barretenberg all **byte-identical**, PLUS new crafted/randomized **edge vectors** for the exceptional states the CT rewrite touches — `P=Q`, `P=−Q`, `Z=0`/∞, scalar `0`/`1`/msb-set, long Pedersen chains — diffed vs bb.js (codex Major: a thin vector set can pass while rare paths break); **P0 dudect PASSES** = the *algorithmic* CT gate; **flash-size + sign-latency within the P0 budget** = a *perf* regression gate only, NOT a leakage gate (on-device µarch leakage stays an explicit residual — codex Major); `schnorr-full-flow.e2e.ts` green. → **`safe-v10`.**
**Deps:** P0 (gates), P1. **Rollback:** flip back to old core; safe-v9.

### P4 — Shared account-binding module + handler-seam fuzz (T1.2 + T1.4)
**Changes:** extract `derive_signing_pubkey_xy` (×3) + `deploy_derive_pubkey_xy`/`deploy_compute_partial` (×2) into `l4/account_binding.{c,h}` (semantic no-op). New `ledger-app/tests/wire_host/` compiles the REAL L4 handlers (`begin_authwit.c`, `append_call.c`, deploy-begin) with host shims; bounded libFuzzer/ASan corpus runner targeting **handler state mutation**, seeded from `provider.test.ts` negative cases + new targeted negatives (truncated/oversized/non-canonical-Fr/bad-(curve,profile)/wrong-version/trailing-bytes/state-violation). **Spike (codex Minor, pulled earlier):** audit whether the PRIVATE transfer modes actually bind `from` via the B3 self-spend gate (`append_call.c` / `finalize_and_sign.c` consumer cross-check) — if private calls don't surface `from` to B3, that's a real finding that GATES P5/P6 and must surface before `safe-v13`.
**Validate:** common gates; `provider.test.ts`; `wire_host` corpus + bounded fuzz clean under ASan; the private-binding spike's conclusion documented. → **`safe-v11`.**
**Deps:** independent of T0; do before P5 (shrinks its blast radius). **Rollback:** revert TU/harness (refactor is a no-op).

### P5 — Authwit v3 binding + metadata-driven profile (T1.1 + T1.3) ⚠ riskiest
**Changes:** introduce a **separate authwit manifest version** (not the shared `L4_MANIFEST_VERSION`); `BEGIN_AUTHWIT` carries `profile_id + salt` (NOT raw deployer). `begin_authwit.c` + `session.h` + host `l4-manifest.ts` + `auth-witness-provider.ts` updated. B3 in `finalize_and_sign.c` uses the carried `salt`/`profile_id` (+ deployer from the pinned profile) instead of hardcoded zero/profile-0. Host `aztec-ledger-session.ts` reads `profileId` from generated `deploy_profiles.generated.ts` by scheme (T1.3). **Clean break** — device rejects the old version (no limping). Keep the fail-closed assertion (opus: the break is *enabling* non-zero-salt accounts, not closing a hole).
**Validate:** `gen:clear-signing-v0:check`; common gates; **re-run + extend the P4 `wire_host` fuzz/negatives for the v3 schema** (mixed-version, truncated-v3, extra-tail, bad-(curve,profile), wrong-salt — codex Blocker: the schema change makes P4's corpus stale and reopens parser bugs); new parity test — B3 recompute with **non-zero salt** vs host `computeAddress`; **`provider.test.ts` ECDSA authwit** (the version break must NOT regress the ECDSA witness path — codex Blocker); `deploy-review.e2e.ts` + `schnorr-deploy-review.e2e.ts` + `schnorr-full-flow.e2e.ts`; a new **non-zero-salt authwit** e2e (verified `From` still correct). ECDSA + zero-salt regressions green. → **`safe-v13`** (provisional — pending the P4 private-binding spike's conclusion).
**Deps:** P4. **Rollback:** clean break — never run a safe-v11 host against a safe-v13 device; revert to safe-v11.
*(Provenance: split-versions + "deploy must evolve if custom deployer is real" = codex; deployer-stays-pinned = codex+opus; metadata profile = all 3.)*

### P6 — Schnorr transfer matrix + private-mode binding audit (T1.5)
**Changes:** parameterize a `schnorr-transfer-modes.e2e.ts` over all 4 modes (`pub→pub` proven; `priv→pub`, `pub→priv`, `priv→priv`) on one deployed Schnorr account. The private-mode `from`-binding was AUDITED in the P4 spike; here, run the 4-mode matrix on-chain and FIX any binding gap that surfaced (if the spike found private `from` unbound, the fix + re-tag land here — the B3 self-spend gate binds `from` via `consumer`==account-address, and private calls may not surface `from` to B3).
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
