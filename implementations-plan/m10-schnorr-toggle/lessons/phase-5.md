# M10 P5 — device integration (in progress)

## P5a DONE (committed 851bd72) — GET_SCHNORR_PUBKEY + signing-scalar derivation
- `INS_GET_SCHNORR_PUBKEY = 0x13` (types.h) → `handler/get_schnorr_pubkey.c` → returns P=priv·G (64B X||Y).
- `l4/aztec_secret.c:az_derive_schnorr_signing_scalar` = `SHA-512("aztec-schnorr-signing-v1\0" || secp256k1_child_priv_d) mod n_grumpkin` (Fq reduce; NEVER the master secret — codex CRITICAL). Device-only (no host mirror — host gets P via APDU).
- Dispatcher wired. Builds + links on nanos2. pubkey math already P4-parity-locked.

## SchnorrAccount deploy constants (computed from @aztec/accounts/schnorr 4.2.1)
For the device `CS_DEPLOY_PROFILES[1]` + the Schnorr partial-address:
- **class_id** = `0x1e86cb5f3581f982b9c2c2b8a45fc4d0dfdb93cdab87e6deee55ec69d7f19703`
- **ctor_selector_u32** = `3449235631` (`0xcd9728af`)
- **ctor args** = `[signing_pub_key_x: Field, signing_pub_key_y: Field]` → 2 Frs (NOT 64 byte-Frs like ECDSA)
- **deployer** = Fr.ZERO (universal). **salt** = Fr.ZERO (demo default).

## P5b — REMAINING (next), in dependency order
1. **Schnorr partial-address** (`l4/deploy_address.c`): the ONLY diff from `az_deploy_compute_partial_address` is the args_hash — `computeVarArgsHash([P.x,P.y])` = `az_poseidon2_hash_with_separator([P.x,P.y], 2, L4_SEP_FUNCTION_ARGS)` (2 Frs), vs ECDSA's 64 byte-frs. Steps 2-4 (init/salted/partial) are IDENTICAL. Extract a `partial_from_args_hash()` helper (steps 2-4), reuse for both — and **parity-test BOTH ecdsa-partial + schnorr-partial vs host `computePartialAddress`** to de-risk touching the proven ECDSA path. Add `deploy_address.c` to the grumpkin_host Makefile SRCS + `ecdsa-partial`/`schnorr-partial` CLI modes.
2. **Nonce** (`l4/aztec_secret.c:az_derive_schnorr_nonce`) = reduce_Fq(SHA-512("aztec-schnorr-nonce-v1" ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg)). Device-only.
3. **finalize_and_sign.c**:
   - `b3_verify_consumer_is_this_account`: branch on `G_l4_session.curve_id`. Schnorr → derive scalar → `schnorr_grumpkin_pubkey` → `az_schnorr_compute_partial_address` (class_id/selector above, salt=0, deployer=0) → `az_account_derive_from_path(path, partial, pkh, addr)` → compare to consumer. (viewing-key half scheme-independent.) Fail-closed.
   - `finalize_after_approval` sign site: branch on curve_id. Schnorr → derive scalar + nonce → `schnorr_grumpkin_sign_with_nonce(sig, priv, k, recheck_outer)` (msg = the RAW 32-byte outer hash, NOT sha256). Return s‖e_raw.
   - NOTE: B3 runs BEFORE the UI; without the Schnorr branch a Schnorr authwit rejects at B3, so (1)+(3b3) must land together for the sign path to be reachable.
4. **Phase-6 deploy** (`finalize_deploy_and_sign.c`) per-scheme address verify (P6-adjacent).

## P5 DONE (commits 851bd72, 74d24fa, f342f00) + P6a (4d4278d)
Device Schnorr is COMPLETE for the AUTHWIT path + pubkey, builds on nanos2:
- `INS_GET_SCHNORR_PUBKEY` (0x13) + `provider.getSchnorrPublicKey` — **validated on Speculos**: on-curve Grumpkin point, deterministic per path, distinct per account index.
- `finalize_and_sign.c` branches `curve_id`: Schnorr B3 recompute (schnorr partial + class_id/selector from `schnorr_account.h`) + Schnorr sign over the raw outer_hash. ECDSA path byte-untouched.
- Nonce + signing-scalar derivations (`aztec_secret.c`), schnorr partial (`deploy_address.c`, parity-green 2/2).

## ⚠ GAP discovered: DEPLOY path is still ECDSA-only
A full Schnorr demo (deploy→drip→transfer) ALSO needs the DEPLOY wired for Schnorr — symmetric to the authwit work, NOT yet done:
- `begin_deploy_account.c`: compute the partial/address via `az_schnorr_compute_partial_address` (not the ECDSA `az_deploy_compute_partial_address`) when the profile is Schnorr; Phase-6 address verify per-scheme.
- `finalize_deploy_and_sign.c`: sign the deploy authwit with Schnorr (curve_id branch, like finalize_and_sign) + the deploy-outer-hash recompute uses the schnorr account address.
- Needs `CS_DEPLOY_PROFILES[1]` (SchnorrAccount) — P6 codegen, OR reuse `schnorr_account.h` consts.

## P6 host adapter (next)
- `schnorr-account.ts`: subclass `@aztec/accounts/schnorr` `SchnorrBaseAccountContract`; `getInitializationFunctionAndArgs` → device `getSchnorrPublicKey`; `getAuthWitnessProvider` → device-backed provider that streams BEGIN_AUTHWIT with **curve_id=GRUMPKIN (3)** + FINALIZE returns the schnorr sig (64B s‖e).
- The L4 manifest/`encodeBeginAuthwitBody` must send curve_id=Schnorr; the FINALIZE sig is wrapped into an AuthWitness (64B, same shape).
- Thread `scheme: 'ecdsa'|'schnorr'` through `AztecLedgerSession.connect`: picks account contract + curve_id + deploy profile; cache key includes scheme (distinct per-scheme accounts).
- Host deploy builder: a Schnorr deploy (profile 1) — pairs with the deploy-Schnorr device path above.

## P6b + P7 DONE; codex review (round 1) FOLDED
- P6b (86eecac): scheme-aware host authwit (buildL4Manifest+provider curveId; LedgerSchnorrAccountContract; connect({scheme})). P7 (c722fa7): OnboardPanel #scheme toggle.
- **codex post-impl review (session /tmp/claude-501/codex-Xerqwmtq)** — verdict changes-needed; core construction + derivations CONFIRMED correct. Folded (051cad4):
  - **BLOCKER**: begin_authwit rejected curve_id!=K1 → Schnorr authwit was unreachable. FIXED (accept K1|GRUMPKIN) + GET_CAPS advertises CAPS_GRUMPKIN.
  - **MAJOR (fault check)**: comment overstated — sign helper dual-runs the CONSTRUCTION but the scalar/nonce derivation is single-pass. Corrected the comment (glitch is fail-safe on-chain-invalid + cross-checked by pre-UI B3). Full dual-derive = documented follow-up.
  - **MAJOR (B3 constraint)**: B3 hardcodes zero salt/deployer/one profile — safe today (fail-closed), breaks for nonzero salt/multi-profile unless BEGIN_AUTHWIT carries account-shape metadata. Demo config = zero-salt/profile-1, so OK; documented.
  - LOW: var-base side-channel — documented PoC limitation.

## DEPLOY-SCHNORR roadmap (codex-recommended, NEXT — the gating piece for P8)
1. Scheme on `curve_id`, deploy template on `profile_id`; enforce EXACT pairs: (K1,profile 0)=ECDSA, (GRUMPKIN,profile 1)=Schnorr. NOT profile_id-as-scheme.
2. Add `CS_DEPLOY_PROFILES[1]` (SchnorrAccount: class_id 0x1e86cb…, ctor_selector 0xcd9728af, arg_schema=2-Fr, deployer/sponsor as profile 0) via the codegen (gen-clear-signing-v0.ts) — or hand-extend the gen'd file.
3. `deploy-context.ts`: add `curveId` (default K1 — keeps ECDSA byte-stable) + send it in encodeBeginDeployAccountBody.
4. Device `begin_deploy_account.c` + `finalize_deploy_and_sign.c`: branch ONLY at the 2 scheme seams — (a) signing pubkey: K1 vs derived Schnorr Grumpkin pubkey; (b) sign primitive: sha256(outer)+ECDSA vs raw outer+Schnorr. Generalize the partial-address recompute to emit args_hash/init_hash/partial for both schemas (deploy_address.c already has both via the shared `partial_from_args_hash`). Phase-6 outer-hash verify is scheme-independent (shared).
5. Host `deployAccount`: profileId + curveId by scheme; drop the scheme=schnorr guard once wired.

## DEPLOY-SCHNORR DONE (device + host + codegen) — commits 2a5e324 (device) + host
Executed the codex roadmap exactly:
- **deploy_address.c**: `az_schnorr_compute_partial_address` generalized to 3-out (args/init/partial) — schnorr-partial parity 2/2, byte-stable.
- **Codegen**: `schnorr_pubkey_xy` arg schema + `CS_DEPLOY_PROFILES[1]` (SchnorrAccount). class_id 0x1e86cb… + ctor_selector 0xcd9728af **fail-closed-verified against SchnorrAccountContractArtifact at gen time** (passed → they match the SDK). `crossCheckDeployProfile` generalized to a per-id artifact map.
- **begin_deploy_account.c**: accept K1|GRUMPKIN with EXACT (curve_id, profile arg_schema) pairing; `deploy_derive_pubkey_xy` + `deploy_compute_partial` dispatch the pubkey (secp256k1 vs Grumpkin) + partial. 3-pass fault check intact.
- **finalize_deploy_and_sign.c**: same dispatch in Phase-6 recompute + a raw-outer Schnorr sign branch (mirrors the authwit one). KEY: `az_deploy_compute_outer_hash` is the sponsor app_payload — scheme-INDEPENDENT; only `consumer` (device-derived Schnorr address) differs. ctor args never enter the signed hash.
- **Host**: deploy-context curveId (default K1); deployAccount drops the schnorr guard + picks profile/curve by scheme. Sign packing UNCHANGED — finalize{Deploy,}AndSign both split 64B as {r,s}; packEcdsaSignature concats → Schnorr s‖e round-trips like the wired authwit path.
- Helpers DUPLICATED across both deploy handlers (matches the file's existing derive_signing_pubkey_xy dup) — flagged to codex as a possible refactor (drift risk on security-relevant dispatch).

## P8 e2e RESULTS (Playwright headless + real Speculos, new elf)
- **schnorr-deploy-review.e2e.ts: PASS (18.6s)** — onboard Schnorr #0 = 0x27cb2244… → Deploy → device shows "Deploy Aztec account". Proves BEGIN_DEPLOY(GRUMPKIN,profile1) end-to-end (pairing + Grumpkin pubkey + 2-Fr partial + P6 address). Repeatable.
- **deploy-fresh-account.e2e.ts (ECDSA regression): PASS (16.5s)** on #2 — un-regressed. (Bumped #1→#2: #1 got deployed for real in M9 bring-up; page correctly showed it ✓on-chain — confirms ECDSA onboard+detection still work.)
- **schnorr-full-flow.e2e.ts (deploy+drip+transfer SUBMIT on testnet, idx #5): RUNNING** (bg bhylbubp7). The on-chain deploy is the keystone — a landed Schnorr deploy proves finalize_deploy Schnorr sign is accepted by the canonical noir-lang/schnorr verifier.
- **codex P9 review: RUNNING** (bg bejntein9, /tmp prompt m10-codex-p9-deploy-schnorr.md).

## codex P9 review (session 019e7b12) FOLDED — verdict was `blocker`
Both blockers folded + built clean (commit "fix(m10): fold codex P9 blockers", 24 total):
- **BLOCKER 1 — deploy TOCTOU** (finalize_deploy_and_sign.c): I signed `outer_hash_local` copied from the MUTABLE session `claimed_outer_hash` AFTER the recomputed_outer compare → reintroduced the exact bug finalize_and_sign.c guards. A glitch on the host-controlled field between compare+copy changes the signed msg; dup-sign/dual-run can't catch it. FIX: sign `recomputed_outer` (device value) directly.
- **BLOCKER 2 — empty deploy-review address** (deploy_review_ui.c, PRE-EXISTING): `g_addr_str[32]` < the 34 `address_8_6` needs → length guard wrote "" → deploy review showed NO address (clear-signing defeated). FIX: buffer→40. Confirmed verified_calls_ui.c uses its own 24-byte `short_hex_field` (unaffected).
- **MAJOR (won't-fix for PoC)**: single-pass nonce/scalar derivation → repeated-k leak under fault injection. Documented authwit residual; full dual-derive is the hardening follow-up.
- **MINORS (follow-ups)**: dedup deploy_derive_pubkey_xy/deploy_compute_partial into a shared TU; host should read profile-id from generated metadata not hardcode.
- codex **confirmed correct**: outer_hash scheme-independence (fact #1), (curve_id,arg_schema) anti-confusion boundary, codegen fail-closed on class-id/selector drift.

## REMAINING: confirm full-flow landed on-chain → reload new elf + re-verify deploy-review (address now shows + TOCTOU benign-safe) → tag safe-v8.
NOTE: the running full-flow (bhylbubp7) uses the elf BEFORE the P9 fixes — still valid for proving Schnorr SIGN correctness on-chain (the fixes are fault-resistance + display, not benign-path). Post-fix re-verify needed.
Fallback: safe-v7 (`c5be220`). 24 M10 commits on branch `m9-real-wallet-ux`.
