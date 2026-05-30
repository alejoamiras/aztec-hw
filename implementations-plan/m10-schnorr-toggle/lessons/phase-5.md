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

## P6+ host adapter, P7 frontend toggle, P8 testnet e2e, P9 review → safe-v8.
Fallback: safe-v7 (`c5be220`).
