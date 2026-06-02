# Plan — audit remediation (CRIT + HIGH + MED + cheap miscs)

**Status:** MAIN draft (Tier A). Parallel plans: `plan-opus.md`, `plan-codex.md` (consolidation appended at bottom once both land). Findings register: `../../audit/index.md`.

## Context
Pre-external-audit hardening of the Aztec Ledger hardware-wallet. 83 findings catalogued; this plan remediates the **CRIT + 7 HIGH + ~24 MED + the cheap LOW/INFO miscs**. The **firmware is reopened** (rebuild + full Speculos re-validation) — the prior "firmware untouched" constraint is lifted for this work. The organizing spine is **clear-signing completeness** (the device must *show* and, where it can, *verify* exactly what it signs), plus the **firmware hardening** the owner chose to do in full.

## Locked decisions (owner)
1. **Recipient address:** rendered **8+8 of 32 bytes** on-device (was 4+4) + an optional "show full address" sub-screen. Residual ~2⁶⁴ prefix+suffix grind — accepted for PoC, documented (see Security §).
2. **Blind-signing:** a configurable NVM setting **`blind_signing`, default OFF** (Ledger Ethereum/Solana pattern). It gates the hash-only `signOuterHash` device path: **OFF → device rejects it** (the `sendTx` auto-created app-authwits fail-closed); **ON → device signs but shows a persistent + per-sign "⚠ Blind signing" warning.** Host-side defense-in-depth: AHW-002 (stop exposing raw bypasses) + AHW-003 (reject smuggled fields on the clear-sign tx path).
3. **Implement ALL production-hardening firmware items now:** NVM rate-limit (AHW-016), **generalize the B3 sender-binding to commit a salt (AHW-018 — WIRE CHANGE)**, reveal-key narrow-or-honest-word (AHW-047), cmov optimization-barrier (AHW-068).

## Invariants that MUST NOT regress
- Device independent `outer_hash` recompute + reject-on-mismatch (`l4/parity.c`, `finalize_and_sign.c`, `finalize_deploy_and_sign.c`).
- **B3 consumer/address binding** — the salt-generalization must *strengthen* it, never weaken it; it stays fail-closed on a wrong account.
- M8-P6 self-derived pkh/address sovereignty (device rejects an address it didn't derive).
- "Device signs only what it recomputed."
- **Zero math/memory regressions** — the field/EC/hash/sig layer is verified-clean (6/6 primitives); touch nothing there except the AHW-068 cmov barrier.

---

## Phases

### Phase 0 — Surface reduction + green CI (host + build; no firmware; lowest risk first)
*Goal: shrink the audit blast radius and make CI trustworthy before any firmware work, so every later phase is validated against a green baseline.*
- **AHW-030** — fix the `tsc -b` errors red on `main`; make the typecheck a **blocking** CI gate (the live test-file errors + `cxmath_spike/measure.ts` + `gen-poseidon2-constants.ts`).
- **AHW-028 + AHW-078** — delete the dead `apps/demo` and the `adapter-trezor` package. **Dissolves AHW-073/074/075/076/077** (the broken-hash code goes with it). *Pre-check: confirm nothing in `demo-browser`/CI/workspaces still imports them (the validators say only the dead `apps/demo` consumes trezor).* This also removes AHW-031's "dead app gated" half.
- **AHW-033** — add `bun.lock` root `overrides: { systeminformation: "^5.31.6" }`; surface `bun audit` findings in `$GITHUB_STEP_SUMMARY` (the 2 undici HIGHs are code-dead, the 4 systeminformation are node-only — record that verdict).
- **AHW-002** — stop `internalDeps` exposing `session`/`ledgerProvider`; cache the clear-signing `BaseAccount` from connect so no caller falls back to the blind default account.
- **Comment/contract truth (AHW-006/019/020/041/058/013/014):** correct the lying comment (AHW-041 — either implement the device-side DRIP token-kind check or delete the false claim), the stale-understated crypto comments (AHW-019/020), the "reserved: M8" SW comments (AHW-006), the dead SW words (AHW-058), the stale wire/header comments (AHW-013/014).
- **AHW-070** — extract one `assert_canonical_aztec_path()` used by all C handlers (sets up Phase 3's AHW-064 fix cleanly).
- **Files:** `apps/demo*`, `packages/adapter-trezor`, `bun.lock`, `.github/workflows/*`, `aztec-ledger-session.ts`, `apdu.ts`/`sw.h` (comments), `ledger-app/src/handler/*` (comments + the shared path helper).
- **Tests:** CI goes green + blocking; `git grep` confirms trezor/demo gone; no remaining refs.
- **Risk:** low (dead code + config + host hygiene). Rollback trivial.

### Phase 1 — Host-side clear-signing enforcement (TS; the blind-sign + unsigned-fields net)
*Goal: the host refuses to feed the device anything outside the reviewed intent, independent of the device's own toggle (defense-in-depth).*
- **AHW-001 (host half)** — make `LedgerEcdsaKAuthWitnessProvider.createAuthWit` (the hash-only blind path) **fail-closed by default**: it must not silently produce blind witnesses. The `sendTx` auto-created app-authwits then fail-closed (the device toggle in Phase 3 is the user-sovereign override).
- **AHW-003** — on the clear-sign tx path (`clear-signing-entrypoint.ts`), **reject** non-empty `exec.authWitnesses` / `capsules` / `extraHashedArgs` and non-`EXTERNAL` fee mode (mirror the deploy guards) with clear errors.
- **AHW-062** — reject host-supplied `maxPriorityFeesPerGas` / manual gas overrides on the clear-sign path; derive gas internally (already done) + assert it; document the fee envelope. (Pairs with AHW-003; the fee-ceiling clear-sign is a Phase 2/3 device concern.)
- **AHW-005** — type the `ledgerDeployContext` sideband end-to-end (shared `LedgerFeeEntrypointOptions`) so a rename is a compile error.
- **AHW-008** — extract `#canonicalOuterHash` (kills the tx/deploy hash-block drift risk).
- **AHW-004 + AHW-046** — write `clear-signing-entrypoint.test.ts` (the 4 fail-closed guards + `#consume` stream-A-claim-B happy/reject) + per-verb review-screen content tests (host-driven assertion of what each verb renders).
- **AHW-007/010/011/012** — `internalDeps` no-secret test; tidy the `as` casts / shape-guard the Speculos JSON; rename `LedgerEcdsaKAuthWitnessProvider` → `LedgerAuthWitnessProvider` (public-API, version-note).
- **Files:** `auth-witness-provider.ts`, `clear-signing-entrypoint.ts`, `aztec-ledger-session.ts`, `*.test.ts`, `deploy-context.ts`, `index.ts`.
- **Tests:** the new test files; `bun test packages/` green.
- **Risk:** medium — `createAuthWit` fail-closing changes a code path. Verified free (no live caller), but re-run the full matrix. Rollback: re-enable behind the (Phase-3) device toggle only.

### Phase 2 — Device clear-signing UI (firmware C; UX-sensitive)
*Goal: the device shows what it signs — completely and honestly — without overwhelming the screen.*
- **AHW-040** — add the **DRIP render case** to `verified_calls_ui.c` (`format_action` + `render_call_pairs`): show the drip amount/token/recipient like any transfer. (No more "Call DRIP" with zero value pairs.)
- **AHW-050** — recipient rendered **8+8** via a new `address_8_6`-style helper (reuse the deploy path's wider renderer); add an optional **"Show full address"** sub-screen. Keep the sender's existing strong render.
- **AHW-051** — show the **raw integer amount** compactly alongside the human-scaled one (so a skewed host `decimals` can't hide magnitude); display `decimals` provenance.
- **UI honesty nits:** AHW-052 (ASCII `..` ellipsis, not U+2026), AHW-053 (show full `outer_hash` on the paranoia screen), AHW-054 (scope "(verified)" to the From line; label host-provided fields), AHW-055 (mint `WARNING` as a salient banner), AHW-056 (sponsor fee terms if any), AHW-022 (reveal dismiss → "Viewing key revealed"), AHW-045 (cached re-onboard shows the real checksum), AHW-023 (comment the authwit "claim-present" guard).
- **Files:** `ledger-app/src/ui/verified_calls_ui.c`, `deploy_review_ui.c`, `sign_ui.c`, `master_secret_reveal_ui.c`, `clear_signing_v0/format.c`.
- **Tests:** **ragger screen-content tests per verb** (AHW-046's device half) — assert the exact rendered fields for transfer (4 modes) / drip / deploy / reveal; a vector for the 8+8 recipient + the raw-amount line.
- **UX:** this is the screen the user sees — keep it tight (8+8 fits one screen; raw amount is one extra compact line; full-address is opt-in). Speculos snapshot review.
- **Risk:** medium — pure rendering, no signing-path change, but Speculos snapshots churn. Rollback: revert UI files.

### Phase 3 — Device security hardening (firmware C; the heaviest — incl. the wire change)
*Goal: the device-side enforcement + the production hardening. Sequenced last among firmware so the wire change lands on an already-validated UI.*
- **AHW-001 (device half) — the `blind_signing` toggle.** Add an NVM `blind_signing` flag (default OFF) + a Settings menu screen to toggle it + a persistent "Blind signing ON" indicator. Gate `sign_outer_hash.c`: **OFF → reject** (new SW, e.g. `SW_BLIND_SIGNING_DISABLED`); **ON → proceed but render a "⚠ Blind signing — you are signing a hash you cannot read" warning** before signing. (This is the device backstop to Phase 1's host fail-close.)
- **AHW-064** — enforce the canonical path (the Phase-0 shared helper) on `sign_outer_hash.c` + `get_public_key.c` + `get_schnorr_pubkey.c` (not just `1≤len≤10`).
- **AHW-016** — **NVM rate-limit** on the reveal/derive surface: a monotonic counter / cooldown on `GET_AZTEC_MASTER_SECRET` (the only INS that exports secret-derived bytes) + a global derivation ceiling. *Design for NVM write-endurance (counter in RAM during a session, persist only the reveal count; cap, don't brick — see Security §).*
- **AHW-018 — B3 salt generalization (WIRE CHANGE).** Today the binding hard-codes `salt=Fr.ZERO`/profile-0. Carry the account's `salt` (+ profile) on the `begin_authwit` wire **as a committed field the device feeds into its own address re-derivation** — the device must DERIVE the expected account from `(device pubkey, salt, profile, class_id)` and bind the consumer to *that*, never trust a host-asserted address. Update the host encoder + the differential-replay vectors + the fuzz corpus. **Fail-closed:** a salt that doesn't reproduce the signer's account → reject (`0x6F12`).
- **AHW-047 — reveal narrowing or honest wording.** *Investigate first:* Aztec derives all 4 master keys (NHK/IVSK/OVSK/TSK) from one secret — purpose-scoped export may be protocol-impossible. If impossible → **honest wording** on-device + host ("exports your account's privacy root for this path, across all networks") + AHW-048 (don't persist it; scheme-aware cache) + AHW-079 (don't use approval-free pubkeys as a persistent ID). If a narrower export IS possible → derive + export only the note-reading capability.
- **AHW-068** — add a compiler optimization barrier to the `point.c` cmov (verify emitted asm stays branch-free under `-Oz`).
- **AHW-017 + AHW-059** — reset `G_l4_session` on BOTH `app_main` bail-outs; `master_secret_disarm()` from `l4_session_reset()`.
- **Files:** `ledger-app/src/handler/sign_outer_hash.c`, `get_aztec_master_secret.c`, `get_public_key.c`, `get_schnorr_pubkey.c`, `finalize_and_sign.c` (B3), `l4/account_binding.c`, `l4/session.c`, `app_main.c`, `crypto/grumpkin/point.c`, new Settings UI, `sw.h`; host: `l4-manifest.ts`/`apdu.ts`/`deploy-context.ts` (wire), `provider.ts`.
- **Tests:** **the B3-salt change is the high-risk item** — add: a non-zero-salt account binds correctly (positive), a wrong salt → `0x6F12` (negative, AHW-026), the device re-derives (never trusts host address); blind-signing OFF→reject / ON→warn tests; rate-limit hit→reject test (AHW-025-style); re-run the M12 fuzz + bidirectional differential-replay against the NEW wire.
- **Risk:** HIGH — wire change + the security-critical binding + NVM. **Codex consult before implementing AHW-018.** Sequenced last; each sub-item independently revertable.

### Phase 4 — Privacy/metadata + build/manifest cleanup (host + frontend + build; low-risk)
- **Privacy:** AHW-048 (don't persist the revealed secret; scheme-aware cache key), AHW-079 (per-tab random handle, not the raw pubkey, as cache ID), AHW-080 (disclose Connect reveals Ledger+app presence; prefer `request()`), AHW-081 (pass a silent/warn-only logger), AHW-082 (surface the real RPC operator URL + default blank/self-host; document what the node sees), AHW-083 (sanitize browser error logging; no addr/tx-hash in test logs).
- **Build/manifest:** AHW-065 (drop/justify the unused `"13'"` path grant), AHW-066 (register the real Aztec coin type or gate the placeholder behind a non-default flag — never ship `1666`), AHW-067 (`ENABLE_SDK_WERROR=1` + fix warnings), AHW-069 (pin + assert clang), AHW-071 (remove/populate the empty root toml), AHW-072 (align icon set), AHW-034 (firmware provenance: make `ledger-app` a real submodule pinned to a commit, or commit + hash-pin + record the `app.elf` hash), AHW-035/042 (codegen: assert the artifact version/content-hash; cross-check registry `address`/`decimals`/`symbol`).
- **AHW-021** — `#error` guard so a release build can't define `CX_MATH_SPIKE`; delete the spike if done.
- **AHW-063** — deploy waits CHECKPOINTED (or labels PROPOSED provisional).
- **AHW-027/060/061** — `cs_format_amount` adversarial vectors; rename the misleading poseidon2 vector label; comment the schnorr secret-scrub.
- **Risk:** low (mostly config/docs/frontend). AHW-066 + AHW-034 are the meatier ones.

### Phase 5 — Validation + post-impl review
- Full matrix on **Speculos + testnet**: deploy / drip / transfer × {ECDSA-K, Schnorr}, with the new UI + the toggle OFF (default) and ON; the 8+8 recipient; the raw-amount line.
- **M12 fuzz + bidirectional differential-replay re-run against the NEW wire** (B3-salt change) — must be green; regenerate the corpus/vectors.
- `bun run lint:all` + `bun test packages/` green; `git grep` confirms the deleted workarounds/dead-code gone.
- **Post-impl codex review** (diff + summary, adversarial ask) → fix loop.
- Update `audit/index.md` (mark fixed findings), `docs/`, lessons.

---

## Security & Adversarial Considerations
*(FIX planning → the question is "could a fix make it worse?")*
- **B3-salt wire change (highest risk).** The salt must be a field the device feeds into its OWN address re-derivation and then binds the consumer to the derived account — it must NEVER let a host-asserted salt+address substitute for the device's self-derivation (that would convert the M8-P6 sovereignty guarantee into a host-trusted one). Failure mode to prevent: host supplies a salt that makes the device bind to an attacker-chosen account. Mitigation: derive, don't trust; fail-closed on mismatch; the differential-replay + a wrong-salt negative test gate it. **Codex consult before coding.**
- **`blind_signing` toggle footgun.** A malicious host must NOT be able to flip it (it's NVM, set only via the on-device Settings menu — no APDU writes it). Enabling it should show a strong warning; consider resetting to OFF on app-close or keeping it sticky with a persistent on-screen indicator (decide in consult). Social-engineering ("enable blind signing to continue") is the residual — the warning copy must be blunt.
- **8+8 address.** Residual ~2⁶⁴ to craft a matching 16-byte prefix+suffix (expensive but not impossible for a funded attacker); the optional show-full sub-screen is the escape valve for high-value transfers. Documented as a PoC-accepted residual.
- **NVM rate-limit.** Must not brick a legitimate user (cap → cooldown/reset, not permanent lock) and must not wear out NVM (don't write per-derive; persist only the reveal-INS count, or use a session-RAM counter + a conservative NVM-backed reveal ceiling). Power-cycle bypass: the reveal counter must be NVM-backed (survives reset); the per-session derive ceiling is RAM (resets, acceptable — the reveal export is the sensitive one).
- **Reveal narrowing may be protocol-impossible.** If Aztec's one-secret→4-keys derivation can't be narrowed, do NOT fake it — ship honest wording + non-persistence; record the limitation for the auditor.
- **Don't weaken while fixing:** Phase 1's `createAuthWit` fail-close + Phase 3's toggle must compose so there's no window where blind-signing is silently allowed; the host guard (AHW-003) and the device gate are independent layers.
- **Least privilege / supply chain:** AHW-066 (no placeholder coin type), AHW-034 (firmware provenance), AHW-033 (dep override) all reduce the trust surface.

## Validation gate (DONE)
Speculos+testnet matrix green (both toggle states) · M12 fuzz + differential-replay green on the NEW wire · `bun run lint:all` + `bun test packages/` exit 0 · `git grep` clean (dead code + workarounds gone) · all preserved-invariant tests pass (recompute, B3 fail-closed incl. non-zero-salt, M8-P6 sovereignty) · post-impl codex review folded · `audit/index.md` updated.

## Open consult items (codex, during impl)
1. B3-salt wire format + the derive-don't-trust binding (before Phase 3 coding).
2. `blind_signing` sticky-vs-per-session + the warning copy.
3. Whether reveal-narrowing is protocol-possible (AHW-047).

---

## Consolidation (Tier A: main + `plan-opus.md` + `plan-codex.md`)

All three converged on the spine: delete dead surface → host fail-close + clear-sign policy → firmware policy/UI → **the B3 wire bump isolated + firmware-first** → CI/provenance. Refinements adopted, by source:

**Adopted from codex:**
- **B3 wire v3 carries `salt` AND `profile_id`** (not salt alone) — salt-only still bakes in the profile-0 assumption. The device routes B3 through the **same `account_binding_deploy_partial()` logic the deploy path already uses** (reuse, don't fork). [extends the owner's "carry a salt" decision → flag at gate]
- **`cancellable=true` for non-deploy clear-signed txs** closes the AHW-049 public-tx sponsor-replay (emits the nonce nullifier); deploy stays `cancellable=false`. This **resolves the fork opus raised** (the guard becomes "assert the fixed per-path policy", not "reject cancellable"). One host-side `assertClearSignPolicy(exec, options)`: reject `authWitnesses`/`capsules`/`extraHashedArgs`, pin fee mode, set the per-path cancellable. [behavior change → flag at gate]
- **CI-red fix = split `apps/demo-browser` into app/test tsconfigs** so `bun:test` types don't poison the app build; gate the live app in CI; testnet Playwright → nightly/manual lane (also fixes AHW-031 inverted coverage).
- **Rate-limit ONLY the export/pre-approval derivation surfaces**, never the normal approved-signing path (avoid breaking legit flows); write NVM only on threshold transitions (endurance).
- **`blind_signing` STICKY in NVM, device-only, no APDU flips it** — codex + opus agree; per-session reset breeds habituation. (Resolves my consult item #2.) Don't show raw salt on-device — the user anchor stays the device-verified sender address.

**Adopted from opus:**
- **8+8 is a memory touch** — `g_call_to[24]` is too small for 8+8 (needs ≥34); audit every `g_call_*` buffer + add to the memory-regression net.
- **B3 wire bump = its own isolated, dead-last firmware PR**, independently revertible; byte-stable for the `Fr.ZERO` demo path.
- **Comment-truth sweep gated on re-verifying `dudect`/`aztec_secret.c`** — never rewrite a CT comment to claim more resistance than verified (a trap for the auditor).
- Show-full address = **one prominent tap**, not a deep drill-down (the unverified field gets the easiest path to full verification).

**Resolved (all three agree):**
- **Reveal-narrowing is NOT protocol-possible** (Aztec derives all 4 master keys from one secret Fr) → honest "privacy root" wording + remove `sessionStorage` persistence + scheme-aware/non-pubkey cache key. No fake narrowing. (Resolves consult item #3.)
- B3-salt **derive-don't-trust**: the device derives the expected account from `(path, curve, profile_id, salt)` and binds `consumer` to *that*; a hostile salt → different derived address → reject `0x6F12`. Fail-closed + fail-safe (a lie yields an on-chain-useless authwit). Firmware-first, **no v2 fallback** (host gates on fw version, "update app").

**Divergences — RESOLVED at the approval gate (owner):**
1. `blind_signing` ON-path → **KEEP the configurable toggle** (sticky, default-OFF, device-only). Opus's "delete `signOuterHash` entirely" recorded but **rejected** — owner wants the future-proof, Ledger-standard toggle; codex concurs.
2. B3 generalization → **GENERALIZE (salt + profile_id)**. Owner accepts the **documented sibling-rebind residual** (codex must-fix #1): v3 proves "From is a seed-controlled, device-derived, rendered account" — NOT "the cryptographically-pinned connected account"; the residual is mitigated by the **8+8 From render landing before P4** + reusing deploy's curve/profile validation, and the full cryptographic pin (on-device account selection) is a **documented follow-up**, not this PR. P4 stays in, isolated + firmware-first + no v2 fallback.
3. `cancellable=true` for txs → **YES** (closes AHW-049; a fixed host policy the device does NOT display and the user does NOT review; deploy stays `cancellable=false`).

**✅ PLAN APPROVED** (owner, after the codex GO-with-edits final review + all four gate deliverables). Ready to implement P0→P6 per the consolidated phase order. Implementation seeds in `goal-loop-seeds.md`.

**Consolidated phase order** (merge of all three — CI-red early for a green baseline, firmware policy → UI → **wire bump isolated dead-last**, provenance after):
P0 dead-surface + CI-red + raw-bypass + cheap comments → P1 host clear-sign policy + fail-close + seam tests → P2 firmware policy/hardening (toggle, path-canon, scoped rate-limit, cmov, session-reset) → P3 device UI/review (DRIP, 8+8+buffers, raw-amount, reveal wording, content tests) → **P4 B3 wire v3 (salt+profile_id) — isolated, firmware-first, no fallback** → P5 privacy/build/provenance → P6 validation + post-impl codex review.

**Rejected/none:** no plan proposed faking reveal-narrowing, a v2 wire fallback, or touching the verified-clean crypto math (only the AHW-068 cmov barrier). Phases above supersede the 6-phase draft sections (which remain as the detailed design reference).

## Final codex review (consolidated plan) — GO-with-edits, folded
Codex (session `019e85aa`) final pass: **GO-with-edits.** Edits folded:

**MUST-FIX 1 — B3 wire-v3 is NOT a pure strengthening (the key catch).** Carrying host-supplied `(salt, profile_id)` keeps "derive-don't-trust-the-address" but loses "THIS connected account": a hostile host that knows a real `(salt, profile_id)` for a SIBLING account under the same seed can rebind the authwit to that sibling (you'd sign FROM a different account of your own). The current `salt=0` hardcode implicitly PINS the account; generalizing trades that pin for flexibility. Folds:
- **Honest guarantee downgrade:** v3 proves "From is a seed-controlled account, device-derived (not host-asserted), and rendered to you" — NOT "From is the cryptographically-pinned connected account." Residual = a sibling-rebind; the full fix is on-device account selection / a connect-time account pin (bigger feature → documented as the next step, NOT this PR).
- **The device-verified `From`/sender render MUST be widened to 8+8 BEFORE P4 lands** (today authwit shows the sender 4+4 — a sibling-swap would be invisible). So P3 widens BOTH the recipient (AHW-050) AND the sender/From render (`verified_calls_ui.c:155`, `finalize_and_sign.c`); P4 is gated on it.
- **Reuse deploy's curve/profile validation** (`begin_deploy_account.c:73`), not just the partial-address path.
- → **FLAG to owner:** AHW-018's fix is a flexibility+honesty improvement with a *documented residual*, not a clean strengthening. Acceptable for PoC with the 8+8 From render; the cryptographic pin is a follow-up.

**MUST-FIX 2 — 8+8 buffer math corrected.** `g_call_to` needs **≥37** (ASCII `..`) not 34; the optional full-address buffer needs **67**; and DRIP + raw-amount + full-address pages add pairs, so `VC_PAIR_CAPACITY=32` and the `n_pairs + 5` bound (`verified_calls_ui.c:61,282`) must be recomputed/bumped or they undercount. Folded into P3.

**Secondary (folded):** `cancellable=true` for txs is a **fixed host policy** the device does NOT display and you do NOT review (not "user-reviewed") — replay-nullifier reasoning confirmed correct. Rate-limit RAM pre-threshold counters are **reboot-evadable** (soft throttle, not hard anti-amplification — the cx_/Donjon path stays the real fix, AHW-029). Firmware-first gate on an **explicit capability/manifest version**, not just semver.

**Codex confirmed solid:** the phase order; reusing the deploy partial-address path *if* curve/profile validation is reused; deploy `cancellable=false`; recompute preserved; math untouched.
