# M11 — Tier-0/Tier-1 hardening — MAIN independent draft

(One of 3 parallel drafts: main [this] + codex + opus. Consolidated into `plan.md`.)

## Reframe (from `research-ledger-security.md`)
Our crypto is already at/above the Mina app's shipped+audited bar. So this is **targeted hardening, not a rewrite**:
- The scalar mul is already add-always + bitmask-cmov (> Mina's conditional-add). The ONLY real CT leak is the **infinity short-circuit + `H==0` branch** inside the mul → remove those.
- **Dual-derive the nonce+scalar = the single highest-leverage win** (closes the only flagged fault gap; cheap; output-identical so trivially parity-validated).
- The 512→254-bit wide-reduce bias is ≈2⁻²⁵⁸ → T0.3 is a **documented analysis + statistical test, NOT a code change** (rejection sampling is explicitly pointless).
- `cx_math_*` migration of `fq.c`/`fr.c` is a real win but a LARGE refactor of parity-locked code → **OUT of scope for M11** (note as a future milestone; our hand-rolled Montgomery is parity-locked + already CT-by-construction once branches go).

## Ordering principle
Front-load Tier-0 security; keep the demo green at every phase; gate everything on parity + build + Speculos, with the riskiest functional change (T1.1 wire bump) last and behind a fresh `safe-v*` tag. `safe-v8` is the pre-hardening fallback throughout.

## Phases

### P0 — Validation harness + baseline (infra-first)
- Build a **dudect-style timing-leak harness** over the host-compiled Grumpkin scalar mul (`grumpkin_host`): measure runtime vs. secret-scalar class (fixed vs random), Welch t-test; FAIL if |t|>threshold. Caveat: host proxy — catches *algorithmic* secret-dependent control flow (our infinity/`H==0` branches), not device µarch.
- Run on CURRENT code → expect a FAIL (documents the leak that P3 fixes) + record baseline.
- **Validate:** harness builds + runs; baseline recorded in lessons.
- **Risk:** none (test-only). **Independent.**

### P1 — Dedup derivation/dispatch helpers (T1.2)
- Extract `derive_signing_pubkey_xy` (3 copies: deploy-begin, deploy-finalize, authwit-finalize) and `deploy_derive_pubkey_xy`/`deploy_compute_partial` (2 copies) into a shared `l4/sign_scheme.{c,h}` (reads `G_l4_*session`). Pure refactor, zero behavior change.
- **Validate:** nanos2 build clean; ALL parity tests green; Speculos schnorr **deploy-review** e2e + ECDSA **deploy-fresh** regression e2e PASS (prove byte-identical behavior). **Rollback:** revert the TU.
- **Risk:** low (mechanical). Do early so P2/P3/T1.1 touch one site. **Depends on:** none.

### P2 — Dual-derive Schnorr scalar + nonce (T0.2) ⭐ highest-leverage
- In `aztec_secret.c`: make `az_derive_schnorr_signing_scalar` + `az_derive_schnorr_nonce` derive **twice via independent buffers/passes** and ct-compare; mismatch → abort (`SW_FAULT_DETECTED`). No shared intermediate between passes (codex P6c idiom). Update the comments I softened in M10 (the gap is now closed).
- **Validate:** schnorr-sign + schnorr-partial parity UNCHANGED (output identical — only verified); nanos2 build; Speculos schnorr deploy-review + a schnorr authwit sign succeed. **Rollback:** revert aztec_secret.c.
- **Risk:** low (output-identical). **Depends on:** P1 (touches the shared derive site).

### P3 — Constant-time scalar mul (T0.1)
- `mul_generator.c`/`point.c`: remove the **infinity short-circuit** + **`H==0` branch**; make the ladder fully uniform (add-always, cmov-select, constant iteration count over the full scalar bit-length; handle the identity via cmov, not branch). Keep Jacobian/affine math byte-identical. Decision: branch-removal FIRST; escalate to a Montgomery ladder ONLY if dudect still flags.
- **Validate:** (a) grumpkin scalar-mul parity 7/7 UNCHANGED (output byte-identical); (b) **P0 dudect now PASSES** (|t| below threshold); (c) nanos2 build; (d) Speculos schnorr sign works; (e) `schnorr-parity` (sign vs barretenberg) green. **Rollback:** revert; safe-v8.
- **Risk:** medium (touches proven EC math) — fully parity-gated (output must not change) + dudect-gated. **Depends on:** P0 (the gate).

### P4 — Memory hygiene + PIC + cx_ discipline (T0.4)
- Sweep every secret buffer (`priv`, `k`, `sk`, viewing scalars, nonces) for `explicit_bzero` on ALL exit/fault paths. Add `PIC()` on Flash-table pointer derefs (generators, params). Audit `cx_*` calls for `LEDGER_ASSERT(... == CX_OK)` / no-throw return checks.
- **Validate:** build + parity; host-compiled crypto under ASan/valgrind (no use-after-wipe/UB); a manual checklist in lessons.
- **Risk:** low. **Independent** (can interleave).

### P5 — Modular-bias analysis doc + statistical test (T0.3)
- Write the 2⁻²⁵⁸ analysis (no code change to the reduce). Add a statistical parity test: sample N derived scalars, assert distribution uniformity / match a host reference; assert NO rejection-sampling path exists (guard against accidental future change).
- **Validate:** test passes; doc reviewed.
- **Risk:** none. **Independent.**

→ **tag `safe-v9`** (Tier-0 hardening complete, demo green).

### P6 — Wire-parser negatives + fuzz (T1.4)
- Targeted negative tests: malformed/truncated/oversized APDUs, non-canonical Fr, bad `(curve_id, profile)` pairing, wrong manifest version, session-state violations, trailing bytes. Plus a **host-compiled libFuzzer harness** over the BEGIN_AUTHWIT/APPEND_CALL/BEGIN_DEPLOY parsers (they compile host-side). Run under ASan; fix any crash/UB; persist a small corpus.
- **Validate:** negatives reject with the right SW; fuzzer N-iterations clean under ASan.
- **Risk:** low-medium (may surface real parser bugs → fix them). **Independent.**

### P7 — Host deploy profile-id from generated metadata (T1.3)
- `aztec-ledger-session.ts`: derive `profileId` from the generated `deploy_profiles.generated.ts` keyed by scheme, not hardcoded 0/1.
- **Validate:** tsc; deploy-review + ECDSA deploy e2e. **Risk:** low. **Independent.**

### P8 — Generalize account-binding: BEGIN_AUTHWIT wire version bump (T1.1) ⚠ riskiest
- **Bump `L4_MANIFEST_VERSION`.** Add `salt`, `deployer`, `profile_id` to the BEGIN_AUTHWIT body (host `l4-manifest.ts` + device `begin_authwit.c` parse). The B3 recompute in `finalize_and_sign.c` uses the **carried** salt/deployer/profile instead of hardcoded zero/profile-0. Clean break (device rejects old version). Mirror the device deploy path (already carries salt/profile).
- **Validate:** new parity test — B3 address recompute with **non-zero salt + custom deployer** vs host `computeAddress`; nanos2 build; Speculos; a Playwright e2e onboarding a **non-zero-salt** account → authwit (verified From still correct). ECDSA + zero-salt Schnorr regressions green. **Rollback:** revert; `safe-v9`.
- **Risk:** HIGH (wire change + the proven B3 self-spend gate). Land host+device together; behind `safe-v9`. **Depends on:** P1, P7.

### P9 — All 4 transfer modes under Schnorr on-chain (T1.5)
- Parameterize the Schnorr full-flow e2e over the 4 modes (pub→pub proven; priv→pub, pub→priv, priv→priv). Same authwit Schnorr sign, different call payloads. Fix any mode-specific issue.
- **Validate:** 4 modes green on testnet (Playwright headless, correct success selectors from M10). **Risk:** low (validation; code only if a bug surfaces). **Depends on:** P2/P3 (hardened sign).

→ **tag `safe-v10`** (Tier-1 complete).

### P10 — Final codex post-impl review + fix loop
- Send the consolidated diff + summary to codex (xhigh, adversarial ask). Triage → fix → close loop. Update lessons + index + memory.

## Security & Adversarial Considerations
- **Threat model:** malicious/compromised host (already mitigated: device reconstructs outer_hash + derives+verifies its own address); **fault injection** on the signing path (P2 dual-derive + the existing construction dual-run + the pre-sign B3/Phase-6 recompute); **side-channel** on a physical device (P3 CT mul — though host-dudect is an algorithmic proxy, not device µarch; full DPA resistance needs hardware + is a documented residual); **scheme/account confusion** (P8 generalize + the existing `(curve_id, arg_schema)` fail-closed pairing); **malformed wire input** (P6 fuzz); **supply chain** (host `@aztec` pinned + 7-day min-age; device deps = BOLOS SDK pinned by digest).
- **What an attacker targets:** the signing key (via repeated/biased nonce → P2 closes the fault path; bias is ≈2⁻²⁵⁸; deterministic nonce avoids RNG); tricking the device into signing for an account it doesn't control (→ device-derived address + consumer cross-check, generalized in P8); the parser (→ P6).
- **What we trust (unchanged):** BOLOS `cx_*` (secp256k1, SHA, RNG), the `@aztec` libs, the `noir-lang/schnorr` in-circuit verifier, the Aztec address/hash domain constants.
- **Residuals (documented, not fixed in M11):** device µarch side-channels (no physical-device leakage testing); `cx_math_*` migration deferred; no external audit (explicitly deferred by owner).

## Opinionated calls
1. **CT = branch removal first, Montgomery ladder only if dudect still flags.** Our mul is already cmov-based; a full ladder rewrite risks the parity-locked output for likely no gain.
2. **T1.1 wire-break is worth it** (owner chose it) — but it's the riskiest; do it LAST, host+device together, behind safe-v9.
3. **Skip rejection sampling + `cx_math` migration** — research shows the former is pointless and the latter is disproportionate for a parity-locked, already-CT-after-P3 implementation.
4. **Validation is self-driving:** every phase has a parity/build/Speculos gate; output-identity (P2/P3) makes the security phases trivially regression-checkable; codex checkpoints at P3 (CT review), P8 (wire review), P10 (final).
