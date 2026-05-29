# M9 Phase B/C/D — device reviews, demo polish, honesty folds

## Done + committed (branch `m9-real-wallet-ux`, all UNSIGNED — AFK, 1Password agent locked)
- **B1/B2** (b7bec00): `deploy_review_ui.c` + `master_secret_reveal_ui.c` show `Account #N` (= `bip32_path[2] & 0x7FFFFFFF`) instead of the raw BIP-32 path. Deploy keeps the verified Address; reveal keeps the checksum. Clean nanos2 build; onboard.e2e green (13.2s, reveal approver still lands).
- **C/D copy** (0d69130): ConnectPanel Forget copy honest ("kept in this browser tab for the session" + recovery framing, drops "nothing on disk" — codex MAJOR3); deploy comment clarified (only the inner auth hash is pinned — codex MINOR). reconnect.e2e green (26.9s).
- **`safe-v5` tagged** at 0d69130 (pre-B3 checkpoint, demo-ready: full frontend + device reviews validated).

## Validation done
- onboard.e2e.ts 13.2s green; reconnect.e2e.ts (wipe→reconnect→same `0x0aa630`) 26.9s green. Frontend implemented + working.
- B1/B2/C/D do NOT touch the transfer/drip authwit path, so no tx regression risk from them.

## B3 — TURNKEY SPEC (device-verified `From` on transfers)
Goal: the authwit/transfer review leads with the device-VERIFIED account address as `From`, cross-checked against the signed `consumer`. NO wire change (codex BLOCKER fix — `consumer` is already in BEGIN_AUTHWIT + is the account address; opus traced `consumer == account` for all 4 transfer modes + drip because every demo verb is self-spend).

**Recompute the account address at authwit (reuse the deploy pattern):**
1. Signing pubkey: `derive_signing_pubkey_xy` in `begin_deploy_account.c:58` is `static` + derives from a path via `bip32_derive_get_pubkey_256`. Extract/parameterize it (take the path) into a shared helper, OR add an authwit variant using `G_l4_session.bip32_path`.
2. Partial: `az_deploy_compute_partial_address(pk_x, pk_y, profile->ctor_selector_u32, salt, profile->deployer, profile->account_class_id, …)` with `profile = &CS_DEPLOY_PROFILES[0]` and `salt = 32 zero bytes` (DEFAULT_ACCOUNT_SALT = Fr.ZERO).
3. Address: `az_account_derive_from_path(G_l4_session.bip32_path, len, partial, out_pkh, out_addr)` (derives sk→viewing keys→pkh + `az_account_address` with ivpk).
4. **Cross-check** `out_addr == G_l4_session.consumer` (session.h:59) → reject on mismatch (a `SW_*_MISMATCH`, like deploy's `0x6F0E`). Place in `handler_finalize_and_sign` (finalize_and_sign.c:80) BEFORE `ui_display_verified_calls()` (line 124).
5. **`verified_calls_ui.c`**: lead with `From` = `address_8_6(out_addr)`; DROP the `Path`/`Chain` header pairs. Stash the computed address for the UI.
6. **Scrub**: reuse `grumpkin_secure_wipe` / `explicit_bzero` on sk + viewing scalars + pubkey on the authwit path (copy the deploy hygiene — opus item 5; new per-tx secret-residue surface).

**Invariant to record in code** (opus item 1): this binds the ENTRYPOINT authwit and presumes self-spend (`from == account`, no token inner-authwit). Link the `From` display to the `SW_DELEGATED_SPEND_UNSUPPORTED` allowlist so it's not read as "device vets arbitrary senders." Delegated spend is out of scope.

**Validation (REQUIRED before committing B3):** clean nanos2 build; Speculos **drip** must still succeed (proves the recompute == consumer for self-spend; a wrong recompute would reject) + ideally one transfer mode. The recompute adds ~10-15 Grumpkin mults per tx (perf note for the real-HW pass).

**Fallback:** safe-v5 (0d69130) is the clean pre-B3 checkpoint. If B3 breaks the proven authwit flow and can't be quickly fixed, revert to safe-v5.

## codex post-impl audit of A+B1/B2+C/D — FOLDED (verdict CHANGES-NEEDED)
All 3 findings folded + validated:
- **MAJOR** (canonical-path faithfulness): the reveal/deploy UIs now show `Account #N` by masking `bip32_path[2]`, but both handlers only enforced the `m/44'/AZTEC'` *prefix* — a host could pass `m/44'/AZTEC'/0/1/999` or an unhardened account and the device would still show `#0`. FIX: enforce the FULL canonical shape `m/44'/AZTEC'/<acct>'/0/0` (`len==5`, `path[2]` hardened, `path[3]==0`, `path[4]==0`, reject `SW_INVALID_PATH_SCHEME`) in `get_aztec_master_secret.c:115` AND `begin_deploy_account.c:127`. (B3's authwit recompute will inherit the same guard via `G_l4_session.bip32_path`.)
- **MINOR** (`isDeployed` could hang onboarding): wrapped the RPC in `Promise.race` w/ an 8s timeout → falls back to "not detected" (shows Deploy, harmless). `OnboardPanel.tsx:108`.
- **NIT** (caller-owned `bip32Path` array stored by ref): copy on entry — `const bip32Path = [...(opts.bip32Path ?? defaultAztecPath())]` in `aztec-ledger-session.ts` connect.

Validation: clean nanos2 build (only the 2 handlers recompiled); **onboard.e2e green 13.3s, same `0x0aa630…`** — the canonical gate ACCEPTS the legit `defaultAztecPath(0)` (= `[44',AZTEC',0',0,0]`); a non-canonical path now rejects by construction. tsc + biome clean on the 2 host files. codex "looks sound" on A1 cache-by-pubkey, no `default`-cache reuse, A3 gate semantics.

## B3 — IMPLEMENTED (device-verified `From`)
The device now recomputes its OWN account address at FINALIZE and cross-checks it against the signed `consumer`; the review leads with that verified address. NO wire change.
- **finalize_and_sign.c**: `b3_verify_consumer_is_this_account()` = derive secp256k1 signing pubkey from `G_l4_session.bip32_path` → `az_deploy_compute_partial_address(…, salt=Fr.ZERO, CS_DEPLOY_PROFILES[0])` → `az_account_derive_from_path(path, partial, pkh, addr)` → `ct_memcmp32(addr, consumer)`; reject `SW_AUTHWIT_CONSUMER_MISMATCH (0x6F12)`. Mirrors the proven deploy Phase-6. All intermediates `explicit_bzero`'d.
- **begin_authwit.c**: enforce canonical `m/44'/AZTEC'/<acct>'/0/0` (matches the other handlers).
- **verified_calls_ui.c**: header leads with `From (verified)` = full 0x+64-hex of `consumer`; dropped raw `Path`.
- **Security value**: for **drip** (not a 4-arg transfer), `from==consumer` is NOT checked at APPEND_CALL, so B3's `consumer==account` is the ONLY device gate proving self-spend. For transfers it's defense-in-depth.

## codex post-impl audit of B3 — FOLDED (verdict CHANGES-NEEDED; session 019e75ea)
- **MAJOR** (signer-path not rebound before signing): the pre-UI check proved `account(path)==consumer`, but signing re-reads `G_l4_session.bip32_path`; pass-3 rebinds only `consumer`. FIX: re-run `b3_verify_consumer_is_this_account()` in `finalize_after_approval()` just before the ECDSA (mirrors deploy's pre-sign Phase-6 recheck) → binds the SIGNER PATH to the verified account + forces an instruction-skip attack to bypass two sites.
- **MEDIUM** (dropped `Chain` = UX-security regression): restored a compact `Chain` pair (kept `Path` dropped — that's the M9-B win). Replay/domain still cryptographically bound via chain_id/version inside outer_hash.
- **MEDIUM** (profile0/zero-salt footgun): documented hard in `sw.h` — `0x6F12` means EITHER wrong consumer OR an unsupported template/salt; the device can't distinguish. All demo accounts are profile-0/zero-salt so it only fires on genuine mismatch.
- **LOW** (host/device path drift): host encoder allowed 5..10 components; device requires exactly 5. Added `assertCanonicalAztecPath()` in `apdu.ts`, used in `encodeBeginAuthwitBody` + `encodeBeginDeployAccountBody` → host fails fast instead of opaque 0x6F03.
- codex "looks fine": no host-TOCTOU on signed `consumer` (pass-3 signs the rechecked outer); wipe discipline OK; full-64-hex `From` is the right display.

## smoke.e2e fix (M9 A staleness)
M9 A's deployed-detection correctly HIDES the Deploy button for an on-chain account, but smoke.e2e blocked 15min on `deployBtn.click()`. FIX: skip Deploy when `count()===0` → proceed to Drip (still exercises FINALIZE → B3). Drip is the cleanest B3 test (consumer check is the sole gate).

## Validation — COMPLETE (committed f8811be, tagged safe-v6)
- Device builds clean (nanos2, -Werror); host tsc + biome clean; adapter unit tests 85 pass / 0 fail (canonical-path tightening broke nothing).
- Full e2e matrix GREEN on the final B3 elf (f8811be):
  - **smoke.e2e**: CONNECT OK → DERIVE OK → DEPLOY SKIPPED (M9 A) → **DRIP OK**, no 0x6F12, 0 console/page errors. Drip went through FINALIZE → B3 cross-check ×2 (pre-UI + pre-sign) → device signed → tx included. Proves the recompute is byte-correct AND consumer == account (self-spend).
  - **onboard.e2e**: 13.5s, `0x0aa630…773b`.
  - **reconnect.e2e**: 26.6s, addrA == addrB (wipe→reconnect reproduces the same account — recovery intact).
- NOTE: B3's REJECTION path (0x6F12 on a deliberately mismatched consumer) is not yet e2e-covered — happy path only. Deferred follow-up (would need a crafted-consumer authwit against Speculos).
