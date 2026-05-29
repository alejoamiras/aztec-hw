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

## Pending audits
- B3 needs its own codex post-impl audit after implementation.
