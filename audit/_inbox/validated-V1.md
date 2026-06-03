<!-- Independent Validator V1 — cluster: FAULT-INJECTION / TOCTOU / SIGNING / STATE-MACHINE / FAIL-OPEN -->
<!-- Candidates: D-codex-deploy, G-codex-crypto-signing, K1-fault-injection, K3-apdu-statemachine, K9-failopen-taxonomy -->
<!-- READ-ONLY validation. Source-verified every cited file:line. Local refs V1-NN; orchestrator assigns global AHW-###. -->

## Verdict table

| Cand | Verdict | FinalSev | Owned | local-ref | note |
|------|---------|----------|-------|-----------|------|
| F-G-1 | ACCEPT (consolidation anchor) | HIGH | OURS | V1-01 | Blind-sign approval signs UNSNAPSHOTTED `G_context`. The ONE genuine post-review-mutable-state sink. Absorbs F-K1-2 + F-K3-1. |
| F-K1-2 | MERGE → V1-01 | (HIGH) | OURS | — | Identical sink/file:line as F-G-1 (sign_ui.c:94 + sign_outer_hash.c:126). Same finding, fault vector. |
| F-K3-1 | MERGE → V1-01 (as 2nd vector) | (HIGH) | OURS | — | Same sink; APDU-interleave (no-fault) vector. Severity contingent on NBGL-blocking (see reasoning) → does NOT add a separate HIGH. |
| F-D-1 | FOLD → already-filed F-D-1 MED | MED | OURS | — | Deploy display-identity TOCTOU. Already in `_state.md` as MED. Source shows sign consumes a FRESH local (outer_hash_local) + 4 re-derive/compares → weaker than stated. Sibling of V1-01 under systemic umbrella. Do NOT promote. |
| F-K1-1 | REJECT-INVALID (as HIGH) → V1-05 INFO | INFO | LEDGER-PLATFORM | V1-05 | "Every confirm callback is one `if(confirm)` branch" = the UNIVERSAL BOLOS/nbgl pattern. Single-glitch resistance on the SE confirm bit is platform. Emitting a HIGH here is exactly the over-count the mandate forbids. |
| F-K1-3 | DOWNGRADE HIGH→LOW | LOW | OURS | V1-02 | blind-sign NVM toggle checked pre-UI, not re-checked in approval callback. Fail-closed gate; single-glitch bypass of a POLICY TOGGLE (not key/hash); SE glitch-resistance is platform. Cheap defense-in-depth recheck. |
| F-K1-4 | DOWNGRADE HIGH→LOW; FI-bypass REJECTED | LOW | OURS | V1-03 | Claim "widens signer scope to arbitrary children" is FALSE: B3 re-runs at sign (finalize_and_sign.c:230) re-deriving account(path)==consumer → a non-canonical/foreign path fails closed. Residual = review shows no path fingerprint (display-scope, AHW-054-adjacent). |
| F-K1-5 | DOWNGRADE HIGH→LOW; reveal-leak REJECTED | LOW | MIXED | V1-04 | Claim is BACKWARDS: approval emits the FROZEN `s_secret` armed under the validated path (get_aztec_master_secret.c:176,188), NOT a re-derivation. Post-validation path glitch corrupts only the displayed `#N`, never the emitted secret. Folds toward AHW-094 + V1-01 display-TOCTOU. |
| F-K1-6 | DOWNGRADE → LOW; FOLD → AHW-025 family | LOW | OURS | V1-06 | "Duplicate-compute collapses to one pass if the lone mismatch branch is skipped" — valid defense-in-depth shape note. Same class as AHW-025 (glitch-sim untested) + orchestrator F-A-1. Keep as one LOW. |
| F-K9-1 | DOWNGRADE MED→LOW; MERGE w/ F-K9-2 | LOW | OURS | V1-07 | SW_HASH_MISMATCH conflates host-mismatch / malformed-Fr / internal-recompute-fault. VERIFIED in sw.h + finalize paths. Fail-CLOSED in every case → observability/triage only, not MED. |
| F-K9-2 | MERGE → V1-07 | (LOW) | OURS | — | SW_DUP_SIG_MISMATCH reused for reveal dual-derive mismatch (get_aztec_master_secret.c:152) + sig duplication. Same taxonomy class as K9-1. |
| F-K9-3 | ACCEPT | LOW | OURS | V1-08 | GET_PUBLIC_KEY forwards raw `cx_err_t` via io_send_sw (get_public_key.c:58). VERIFIED. Fail-closed; taxonomy escape hatch. Distinct from AHW-064. |
| F-K9-4 | ACCEPT (distinct from AHW-086) | LOW | OURS | V1-09 | verified_calls_ui render_call_pairs returns 0 on reg==NULL/verb==NULL (lines 236,239) + switch `default: break` (321) → label-only review, approval still signs. VERIFIED. Generic accept-on-unrenderable; AHW-086 is the specific flag omission. |

**Confirmed-clean (validator agrees — strong negatives, no finding):** authwit FINALIZE signs `recheck_outer` (a fresh local) + re-runs B3 at sign time (finalize_and_sign.c:207-287); deploy FINALIZE signs `outer_hash_local` memcpy'd from a fresh recompute + 4 re-derive/compares (finalize_deploy_and_sign.c:123-224); RFC6979 nonce (no app RNG); device-side low-S on every ECDSA path; raw r‖s (no DER/v); dispatcher resets L4 on every L2 boundary + every non-9000; ABORT/double-BEGIN/wrong-state all fail closed; reveal secret disarmed by l4_session_reset (AHW-059). I did NOT find a second-APDU mutation path in the normal (non-blind) flows — only the blind-sign union-clobber surface (V1-01).

---

## Ready-to-index blocks (ACCEPTED / CONSOLIDATED)

### V1-01 (anchor: F-G-1 ⊕ F-K1-2 ⊕ F-K3-1) — SYSTEMIC: blind-sign approval signs unsnapshotted mutable `G_context`
- Severity: HIGH — the blind-sign approval callback produces a valid secp256k1 signature over `(path, outer_hash)` re-read from mutable global state at approval time, with NO immutable reviewed snapshot and NO post-review compare. A change to `G_context` after the review is painted (RAM fault, or — contingent — a second APDU clobbering the union) yields a valid signature over bytes/key the user never saw. Reachable ONLY when blind-signing is explicitly enabled (default OFF, NVM-sticky, `0x6F13` reject pre-UI), which bounds the exposed population to users who opted into the degraded mode.
- Owned: OURS
- Category: FW-CRYPTO / FW-STATEMACHINE
- Location: `ledger-app/src/ui/sign_ui.c:94-121` (renders + wires approval from `G_context`); `ledger-app/src/handler/sign_outer_hash.c:126-177` (re-reads `G_context.sign_info.outer_hash` :130 + `G_context.bip32_path` :144-145,170-171 for BOTH ECDSA passes); union clobber surface: `types.h:80-83` (`pk_info`/`sign_info` share storage) + `get_public_key.c:26` / `get_schnorr_pubkey.c:24` (both `explicit_bzero(&G_context)` then write `pk_info`).
- Attack/impact: (Vector A — fault, high-confidence-real) physical glitch attacker perturbs `G_context.sign_info.outer_hash` and/or `G_context.bip32_path` between the user reviewing the screen and `sign_outer_hash_after_approval()` running; both RFC6979 passes sign the mutated values so the dup-sig check passes → valid signature for a different Aztec hash or child key. (Vector B — APDU interleave, contingent) host streams SIGN_OUTER_HASH, waits for the review, injects GET_PUBLIC_KEY (zeros G_context, repopulates the shared union), then the user approves the original screen. There is NO "review-pending" guard rejecting incoming APDUs (grep-confirmed: none exists).
- Evidence: contrast is decisive — authwit (`finalize_and_sign.c:280-287`) and deploy (`finalize_deploy_and_sign.c:214-224`) BOTH explicitly sign a fresh device-local recompute (`recheck_outer` / `outer_hash_local`) with comments naming the exact TOCTOU they defend; blind-sign is the ONLY signing sink that signs unsnapshotted `G_context`. It cannot recompute (raw hash by definition) — so it MUST snapshot. AHW-059 + the `get_aztec_master_secret.h:34` / `session.c:14` "blocking-IO loop" comments prove the authors already treat the deferred-approval boundary as a hazard elsewhere; blind-sign has no equivalent guard.
- Fix sketch: snapshot reviewed `(path, outer_hash)` into a dedicated immutable struct at `ui_display_blind_sign()`; sign ONLY that snapshot; on approval compare current `G_context` against it and reject on mismatch; add a live request-token any new APDU (incl. ABORT) clears.
- Confidence: high (sink + absence-of-snapshot verified at source). Vector-B exploitability is the open question — see cross-cluster note.
- Dedup-check: distinct from AHW-085 (authwit re-hashes cached args_hash — different mechanism, fail-closed via pass-3) and from filed-F-D-1 (deploy display-identity TOCTOU — signs a fresh local). This is the SYSTEMIC ROOT's one truly-live sink. Sibling MEDs under the same umbrella: filed-F-D-1, AHW-085.

### V1-02 (F-K1-3) — blind-sign NVM toggle not re-checked in the approval callback
- Severity: LOW — `settings_blind_signing_enabled()` gates pre-UI (sign_outer_hash.c:111) but `sign_outer_hash_after_approval()` never re-reads it. Single-glitch bypass of a POLICY toggle, not a key/hash; fail-closed by default.
- Owned: OURS
- Category: FW-STATEMACHINE
- Location: `ledger-app/src/handler/sign_outer_hash.c:111` (sole check), `:126` (approval path, no recheck)
- Attack/impact: with blind-signing OFF, a single instruction-skip at the pre-UI gate reaches the sign path. SE glitch-resistance on this is LEDGER-PLATFORM; the app-side recheck is cheap defense-in-depth.
- Fix sketch: re-read the NVM flag in `sign_outer_hash_after_approval()`, fail closed on OFF.
- Confidence: high
- Dedup-check: novel; the blind-sign-toggle remediation (P3) added the policy, not the FI-recheck.

### V1-03 (F-K1-4, downgraded) — authwit clear-sign review shows no path/account fingerprint
- Severity: LOW — the FI-bypass framing is rejected (B3 re-binds path→consumer at sign). Residual is display-scope only: a paranoid user cannot cross-check WHICH child key signed.
- Owned: OURS
- Category: FW-UI
- Location: `ledger-app/src/ui/verified_calls_ui.c:352` ("From (verified)" = consumer address, no path/#N shown)
- Attack/impact: none cryptographic (B3 at finalize_and_sign.c:230 fails closed on a foreign/non-canonical path). UX/transparency gap only.
- Fix sketch: add an "Account #N" pair to the authwit review (parity with deploy/reveal screens).
- Confidence: high
- Dedup-check: adjacent to AHW-054 (the "verified" halo scope); folds there if the orchestrator prefers.

### V1-04 (F-K1-5, downgraded) — reveal review `#N` can skew under a post-validation path glitch
- Severity: LOW — the privacy-root-leak framing is rejected (emitted secret is frozen at arm time under the validated path). Only the displayed `#N` can skew under a fault.
- Owned: MIXED (fault → SE/PLATFORM; display-binding → OURS)
- Category: FW-UI
- Location: `ledger-app/src/handler/get_aztec_master_secret.c:176` (arm), `:188` (emit frozen); `ui/master_secret_reveal_ui.c:53` (`#N` from live `G_context.bip32_path[2]`)
- Attack/impact: the secret emitted always matches the validated path; a glitch on `G_context.bip32_path` after validation changes only the human-facing `#N`. Display-integrity, fail-safe on the secret.
- Fix sketch: snapshot the account index alongside the armed secret; render from the snapshot.
- Confidence: high
- Dedup-check: largely folds to AHW-094 (reveal display comment-truth) + V1-01 systemic display-TOCTOU.

### V1-05 (F-K1-1, rejected-as-HIGH) — highest-value approve callbacks are not app-double-latched
- Severity: INFO — captured for completeness, NOT a HIGH.
- Owned: LEDGER-PLATFORM (the single nbgl confirm bit + SE glitch-resistance is the platform's job)
- Category: DESIGN
- Location: sign_ui.c:49, deploy_review_ui.c:90, verified_calls_ui.c:198, master_secret_reveal_ui.c:56
- What: every reviewed flow ends in one `if(confirm)` branch — the universal BOLOS/nbgl pattern.
- Attack/impact: a single glitch on the confirm bit; mitigation is the SE's responsibility. Apps add a 2nd app-owned latch only at the very highest-value sink — here that is V1-01 (snapshot-and-recompare blind-sign), which subsumes the only OURS-actionable slice.
- Fix sketch: none app-level beyond V1-01; document the platform reliance.
- Confidence: high
- Dedup-check: the OURS slice IS V1-01; this entry exists only to record the rejected HIGH.

### V1-06 (F-K1-6, downgraded/folded) — single-site mismatch branches on the duplicate-compute defenses
- Severity: LOW — defense-in-depth shape note; meaningful exploitation also needs a second perturbation of the computed value.
- Owned: OURS
- Category: DESIGN / TEST
- Location: get_aztec_master_secret.c:149, sign_outer_hash.c:189, finalize_deploy_and_sign.c:317, schnorr.c:85, begin_deploy_account.c:231
- What: duplicate-pass defenses use one mismatch-compare site; only `aztec_secret.c` uses the two-direction `dd_*` compare.
- Fix sketch: two independent compare sites/directions for the high-value checks; add the glitch-sim test (AHW-025).
- Confidence: high
- Dedup-check: same class as AHW-025 (glitch-sim untested) + orchestrator F-A-1; fold if preferred.

### V1-07 (F-K9-1 ⊕ F-K9-2, downgraded) — internal-fault vs host-mismatch SW conflation
- Severity: LOW — fail-CLOSED in every case; observability/triage/alerting weakness, not a bypass.
- Owned: OURS
- Category: DESIGN
- Location: `sw.h:11` (0x6F01), `sw.h:16` (0x6F06); 0x6F01 used for canonical-Fr reject (begin_authwit.c:79), host-hash disagreement, AND internal recompute fault (finalize_deploy_and_sign.c:159,186,211); 0x6F06 used for reveal dual-derive mismatch (get_aztec_master_secret.c:152) AND ECDSA dup-sig.
- Attack/impact: a glitch or helper regression on the device's own recompute is indistinguishable from hostile host data → weak alerting on the real signing path.
- Fix sketch: distinct internal-only SW/log bucket for device-side recompute faults; keep 0x6F01/0x6F06 user-facing.
- Confidence: high
- Dedup-check: distinct from AHW-017/059 (reset/disarm) — this is live SW taxonomy. The sw.h:33-39 comment shows the authors already accept the 0x6F12 conflation deliberately.

### V1-08 (F-K9-3) — GET_PUBLIC_KEY leaks raw `cx_err_t` outside the app SW taxonomy
- Severity: LOW — fail-closed; bypasses the documented SW set on a live handler.
- Owned: OURS
- Category: DESIGN
- Location: `ledger-app/src/handler/get_public_key.c:58` (`if (error != CX_OK) return io_send_sw(error);`)
- Attack/impact: host code assuming app-defined SWs sees undocumented platform codes; SDK changes silently alter failure handling/observability.
- Fix sketch: normalize all non-CX_OK pubkey-derive failures to one app SW; raw cx_err_t only in debug logs.
- Confidence: high
- Dedup-check: distinct from AHW-064 (path validation, fixed).

### V1-09 (F-K9-4) — verified-calls review fails open on an unrenderable call
- Severity: LOW — current verb/registry tables cover all live calls; the generic control flow accepts missing render coverage instead of rejecting.
- Owned: OURS
- Category: FW-UI / FW-STATEMACHINE
- Location: `ledger-app/src/ui/verified_calls_ui.c:236` (`if (reg==NULL) return 0;`), `:239` (`if (verb==NULL) return 0;`), `:321` (`default: break;`), `:363-365` (caller sums pairs, still proceeds to sign)
- Attack/impact: a future allowlist/codegen addition, or post-APPEND corruption, degrades clear-signing into label-only review while `on_review_choice`→`finalize_after_approval()` still signs. (APPEND_CALL enforces reg!=NULL at append time + FINALIZE re-runs B3, so the live exposure is narrow.)
- Fix sketch: make any unrenderable call fatal BEFORE the UI; turn the verb `default` into a fail-closed reject.
- Confidence: med-high
- Dedup-check: distinct from AHW-086 (specific flag omission in non-TRANSFER arms) — this is the GENERIC accept-on-unrenderable control flow. Same UI module; complementary.
