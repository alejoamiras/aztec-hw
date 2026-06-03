# Wave 1 — Agent B (opus): FW crypto + UI render-vs-sign + NVM/settings/blind-sign + reveal + path_canonical

Read-only red-team of the ~31 just-merged remediation commits in this scope. Every line cited was
read in the current tree. Dedup is against the 83 indexed AHW findings + the Round-4/5 folds.

Bottom line: the remediation is high quality. The four device guarantees I was asked to break all
HOLD (see "Confirmed clean"). I found a small number of NEW issues, the most material being a
render-vs-sign transparency gap on non-transfer verbs (call flags signed but not displayed).

---

### F-B-1: Call flags (STATIC / HIDE_MSG_SENDER) are signed but NOT rendered for MINT / DRIP / SPONSOR verbs
- Severity: MED — a flag the user authorizes is bound into the signed outer_hash but invisible on-screen for 3 of 4 verb families; clear-signing-completeness break (same class as AHW-040, narrower blast radius).
- Owned: OURS — our UI render layer + APPEND_CALL gate.
- Category: FW-UI
- Location: `ledger-app/src/ui/verified_calls_ui.c:252-323` (format_mode only called in the TRANSFER branch, line 261); `ledger-app/src/handler/append_call.c:110-139` (flags validated: mask + is_public only); `ledger-app/src/l4/parity.c:62-67` (all three flag bits bound into inner_hash for EVERY call).
- What: `append_call.c` validates only `slot->flags & ~L4_CALL_FLAG_MASK` (line 111) and `is_public` vs the verb (line 137-139). `L4_CALL_FLAG_STATIC` and `L4_CALL_FLAG_HIDE_MSG_SENDER` are left unconstrained for ALL verbs. `parity.c:65-67` emits is_public/hide_msg_sender/is_static as Fr(0/1) fields for every call, so they ARE part of the signed inner_hash → outer_hash. But `render_call_pairs` calls `format_mode` (the only code that surfaces STATIC/HIDE_SENDER) ONLY inside the TRANSFER_* switch arm (`:261`). For MINT_PUB/MINT_PRIV, DRIP_PUB, SPONSOR the flags are never rendered.
- Attack/impact: a malicious/patched host streams a MINT or DRIP call with `flags |= L4_CALL_FLAG_HIDE_MSG_SENDER` (or STATIC). The device binds the flag into the signature the user approves, but the review screen shows no indication. `hide_msg_sender=true` changes who the callee sees as caller (semantic change on a supply-creating mint). Blast radius is bounded: (a) `is_static=true` makes a state-changing mint/drip revert on-chain (self-defeating), and (b) the flag is still cryptographically bound (no signature-forgery) — so this is a transparency/clear-signing-completeness defect, not theft. But it violates the device's core "what is rendered == what is signed" invariant for 3/4 verbs.
- Evidence: read `verified_calls_ui.c` (format_mode at :139-159, called only at :261 in the TRANSFER arm; MINT arm :276-293, DRIP arm :302-320, SPONSOR arm :294-301 have NO format_mode call); `append_call.c:110-146` (no STATIC/HIDE_SENDER constraint); `parity.c:57-70` (emit_call_fields binds all 3 flags for every call).
- Fix sketch: render the flags for every verb that can carry them (move the format_mode pair emission out of the TRANSFER-only arm), OR reject non-zero STATIC/HIDE_SENDER on verbs whose UI doesn't display them (append_call), OR pin the expected flags per verb (e.g. mint/drip must be plain). Cheapest correct fix: always emit the Flags pair when `c->flags & (STATIC|HIDE_MSG_SENDER)`.
- Confidence: high (control-flow is unambiguous; flags reach the hash and skip the screen).
- Dedup-check: distinct from AHW-040 (DRIP value pairs unrendered — now fixed; this is the FLAG field, on mint/drip/sponsor). Distinct from AHW-055 (mint WARNING salience). Distinct from the "Confirmed clean" N-1 note (which verified flags are BOUND into inner_hash via parity.c — correct — but did NOT check the flags are DISPLAYED for every verb; N-1 only confirmed the no-display-vs-sign gap on `is_public`, which is shown in the action label). Novel render-vs-sign coverage gap.

### F-B-2: Reveal handler re-implements the canonical-path check inline instead of using the shared `az_bip32_path_is_canonical`
- Severity: LOW — a security gate (canonical path on the privacy-root reveal) is a 4th separately-written copy that can drift from the single-source predicate; defense-in-depth/maintainability, not a current hole.
- Owned: OURS.
- Category: MODULARITY (security-gate drift)
- Location: `ledger-app/src/handler/get_aztec_master_secret.c:108-135` vs the shared `ledger-app/src/path_canonical.c:5-8`.
- What: AHW-064/070 introduced `az_bip32_path_is_canonical()` as the single source of truth, and the blind-sign path + both pubkey getters now call it (`sign_outer_hash.c:93`, `get_public_key.c:47`, `get_schnorr_pubkey.c:43`). The reveal handler — arguably the most privacy-critical surface (exports the path-wide privacy ROOT, AHW-047) — does NOT call it. It inlines an equivalent check across four separate statements: `len < L4_MIN_BIP32_PATH` (:109), `path[0]==44'` (:122), `path[1]==coin'` (:125), then `len!=5 || path[2] unhardened || path[3]!=0 || path[4]!=0` (:132-134). Functionally equivalent TODAY, but if `az_bip32_path_is_canonical` is ever tightened (e.g. a coin-type change, or rejecting account index 0), the reveal path silently won't track it.
- Attack/impact: no live exploit (the inline check is currently correct and equivalent). The risk is future drift: a maintainer hardens the shared predicate, the reveal keeps the stale inline copy, and the privacy-root reveal accepts a path the rest of the app rejects. Maintainability + latent-divergence on a security gate.
- Evidence: read both files. `path_canonical.c:5-8` is the canonical predicate; `get_aztec_master_secret.c:108-135` re-derives the same constraints by hand and never calls it (it includes `../constants.h` for AZTEC_COIN_TYPE_HARDENED but not `path_canonical.h`).
- Fix sketch: replace the inline block (`:122-135`) with a single `if (!az_bip32_path_is_canonical(G_context.bip32_path, G_context.bip32_path_len)) return io_send_sw(SW_INVALID_PATH_SCHEME);` (the `len<L4_MIN` early check at :109 can stay or be folded).
- Confidence: high.
- Dedup-check: AHW-070 (LOW) flagged the canonical-path copy "across 3 C handlers + host mirror" but explicitly scoped it to the DEPLOY-handler copies, noting "the riskier blind-sign/pubkey surfaces already share via AHW-064." The reveal handler is a SEPARATE 4th copy not enumerated in AHW-070, and it post-dates AHW-064 (which converted blind-sign + pubkey getters but left this inline). Adjacent to AHW-070; arguably a fold (`AHW-070 += reveal copy`). Flagging as distinct so the deep-plan converts ALL copies, not just the 3 deploy ones.

### F-B-3: Master-secret reveal UI docstring is stale — claims it shows "Path: full BIP-32 path", code shows "Account #N"
- Severity: LOW — comment-truth defect on the privacy-root reveal screen; misleads an auditor about what the user actually sees when approving the highest-consequence export.
- Owned: OURS.
- Category: FW-UI (comment-truth)
- Location: `ledger-app/src/ui/master_secret_reveal_ui.c:10-14` (docstring) vs `:64-71` (actual render).
- What: the file header (`:11-13`) documents "Two pairs shown: - Path: full BIP-32 path (the user confirms WHICH account is exposed) - Confirm: 4-hex checksum". The actual `ui_display_master_secret_reveal` (`:64-71`) shows `Account = "#N"` (the masked human index from `reveal_account_index()`, :52-54) and `Confirm = checksum`. There is NO "Path" pair and the full BIP-32 path is never displayed. The M9 B2 change (shown in the `:65` comment) switched path→"#N" but the file's top docstring was not updated.
- Attack/impact: no runtime effect. It is a comment-truth defect on the single most sensitive screen in the app (privacy-root reveal). An auditor reading the header would believe the full path is on-screen for the user to confirm, when only the account index is — relevant because AHW-047 already found the reveal's scope is under-communicated, and the canonical-path enforcement (F-B-2) is what makes "#N" honest. Same auditor-confusion class the prior campaign repeatedly flagged (AHW-006/019/020/041).
- Evidence: read the file end-to-end. Header `:11-13` says Path/Confirm; body `:69-71` emits Account/Confirm; `reveal_account_index()` `:52-54` masks `path[2] & 0x7FFFFFFF`.
- Fix sketch: update the docstring to "Two pairs shown: Account #N (masked path[2]) + Confirm checksum"; note the full path is intentionally not shown post-M9 B2.
- Confidence: high.
- Dedup-check: distinct from AHW-022 (the reveal DISMISS status string — now "Privacy root revealed", fixed) and AHW-047 (the reveal SUBTITLE wording / scope). This is the file HEADER docstring describing the wrong pair set. Novel.

---

## Confirmed clean — invariants I tried hard to break and could not

**Guarantee 1 — blind_signing default-OFF / sticky / device-only / fresh-read:**
- `settings_set_blind_signing` (the ONLY mutator, settings.c:20) is called from EXACTLY ONE site: `menu_nbgl.c:43` (the on-device Settings switch). Grep-confirmed: no APDU handler writes it. `nvm_write` appears ONLY in settings.c. A malicious host CANNOT flip it.
- Default OFF: `const app_settings_t N_app_settings_real;` (settings.c:13) lives zero-initialized in NVRAM → `blind_signing == 0` on a fresh install/reinstall. Verified.
- Read FRESH each time: `settings_blind_signing_enabled()` dereferences the NVRAM via the PIC macro on every call — no RAM cache. `sign_outer_hash.c:111` reads it live BEFORE any UI and returns SW_BLIND_SIGN_DISABLED (0x6F13) + a status screen with NO signing path reachable. Verified.

**Guarantee 2 — what is RENDERED == what is SIGNED (the outer_hash chain):**
- The displayed `outer_hash` (verified_calls_ui.c:344, full 32 bytes) is `G_l4_session.outer_hash` = `computed_outer` from finalize parity passes 1+2 (finalize_and_sign.c:168-192). `finalize_after_approval` signs `recheck_outer` (pass 3) after asserting `recheck_outer == G_l4_session.outer_hash == claimed_outer_hash` (`:214-219`). Device signs ONLY its own recompute, never the host-claimed value. 3× fault-hardened.
- The rendered call args (amount/recipient/from) are `G_l4_session.calls[i].args`, the SAME bytes whose device-recomputed args_hash is bound into inner_hash (append_call.c:181 overwrites slot->args_hash with the device value; parity.c:58 consumes it). Amount, recipient, from are all on the signed path. No display-vs-sign substitution found for these fields. (The FLAG exception is F-B-1.)
- `cs_format_amount` (format.c) is faithful: high-16-bytes-nonzero reject (:31-33), decimals>30 reject (:34), correct u128→decimal divmod, correct trailing-zero trim leaving ≥1 frac digit, `need_room` overflow guard before writing (:67). No integer overflow / scaling that misstates a value. AHW-051's raw-alongside-scaled mitigation is live (`format_amount_with_raw`, :217-228 always emits "(raw <int>)").
- `g_call_amount[i]` buffer (`2*CS_FORMAT_MAX_LEN+32` = 128B) cannot overflow: `"%s %s (raw %s)"` with two ≤47-char amounts + a ≤7-char NUL-terminated symbol ≈ 111B max; snprintf truncates safely regardless.

**Guarantee 3 — canonical path enforcement, no bypass / off-by-one:**
- `az_bip32_path_is_canonical` (path_canonical.c:5-8) is exact: `len==5 && path[0]==44' && path[1]==coin' && path[2] hardened && path[3]==0 && path[4]==0`. No off-by-one in the length or hardened checks.
- It now gates ALL key-using surfaces: blind-sign (sign_outer_hash.c:93), GET_PUBLIC_KEY (:47), GET_SCHNORR_PUBKEY (:43), BEGIN_AUTHWIT (begin_authwit.c:62). The reveal inlines an equivalent (F-B-2). No signing/pubkey surface skips a canonical check.

**Guarantee 4 — reveal = privacy ROOT, human-gated, disarmed, honest:**
- The secret is armed (`s_armed`, get_aztec_master_secret.c:54) only after a full canonical-path check + double-derive + fault-compare, then `ui_display_master_secret_reveal` defers to a physical NBGL confirm. No path emits the secret without `s_armed` (master_secret_reveal_approved checks `if (!s_armed) return …UNKNOWN`, :184).
- Disarm-on-abort is now EXPLICIT: `l4_session_reset()` (session.c:15) calls `master_secret_disarm()` (AHW-059 fixed), and the dispatcher resets the session on EVERY non-9000 path + before INS_GET_AZTEC_MASTER_SECRET itself (dispatcher.c:172). `disarm()` explicit_bzero's both the secret and the checksum. Reject path disarms (:201). No "left armed" window found in the blocking-IO model.
- Wording is honest/blunt: subtitle "Lets this computer see ALL this account's notes, on every network. Not spending." + confirm "Reveal this account's privacy root?" + dismiss "Privacy root revealed". Matches AHW-047's corrected scope. (Stale HEADER docstring is F-B-3, cosmetic.)

**Crypto under -Oz — no NEW concrete OURS-fixable leak beyond the known AHW-029/068:**
- `grumpkin_point_cmov` (point.c:69-83) now has the `__asm__ volatile("" : "+r"(mask))` value barrier (AHW-068 fixed) — branchless select survives -Oz.
- `grumpkin_point_double` / `grumpkin_point_add_affine` (point.c) are the M11 branch-free cmov rewrite — NO data-dependent early returns. I verified the add_affine exceptional-case SELECT ORDER is correct (inf, then dbl, then qj LAST so p==O wins even though p==O also sets h_zero&r_zero=1 → the dbl cmov is overwritten by the qj cmov). Output is correct for O+Q, P+P, P+(−P).
- `fr.c`/`fq.c` fully reduce every add/sub/mul output to < p, so `fr_is_zero` (all-limbs-zero) is a CORRECT zero test (Montgomery form of 0 is all-zero). The point-arith exceptional-flag logic is therefore correct.
- The remaining timing residuals (operand-dependent fr_mul, the data-dependent fr_is_zero/gk_fq_eq used for exceptional flags, the leading-zero leak in double-and-add-always) are exactly AHW-029 (PLATFORM-deferred) / AHW-019 (stale comments). No NEW branch was INTRODUCED by remediation. `s_is_high` (sign_outer_hash.c:46, finalize:63) is the documented non-early-exit three-way compare and is correct.
- poseidon2 (constants pinned + generated), blake2s256 (RFC-7693, only ever 64-byte Schnorr-challenge input, correct counter/final handling), pedersen_hash3 (canonical-Fr-reject inputs, zero-scalar skip matches noble), schnorr dual-pass + ct_diff64 fault check, account_derive (NHK/IVSK/OVSK/TSK domain seps + address-from-ivpk match upstream) — all reviewed, no new defect.

**Other:**
- Codegen guards the device-side `%s` symbol read: `cSymbolLiteral` (gen-clear-signing-v0.ts:241-249) rejects `len >= CS_SYMBOL_LEN` (reserves NUL) + non-ASCII, so `reg->symbol` is always NUL-terminated within 8 bytes. No device-side over-read on the immutable const registry.
- `account_binding_deploy_pubkey_xy` fails closed on unknown curve_id (account_binding.c:52-54; post-impl codex LOW fixed). The (curve,profile) allowlist (wire.h:44-47) is re-checked at FINALIZE (finalize_and_sign.c:111) and keeps curve_id↔arg_schema consistent so the B3 pubkey/partial dispatch can't desync.
- `call_count` capped at L4_MAX_CALLS=5 (begin_authwit.c:103); worst-case 4 headers + 5×5 + 1 outer = 30 ≤ VC_PAIR_CAPACITY=32, so the render loop guard (`n_pairs+5<=32`, verified_calls_ui.c:363) NEVER trips → no signed call is silently dropped from the screen.
