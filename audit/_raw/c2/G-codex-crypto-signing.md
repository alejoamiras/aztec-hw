<!-- Harvested from codex session FGUBwNMi (crypto/signing security), read-only xhigh. -->

### F-G-1: Blind-sign approval is not bound to the post-review `(path, outer_hash)`
- Severity: HIGH — one post-approval fault can turn an approved blind-sign into a valid signature over a different path and/or hash than the user reviewed
- Owned: OURS
- Category: FW-CRYPTO
- Location: ledger-app/src/ui/sign_ui.c:94-121; ledger-app/src/handler/sign_outer_hash.c:126-177
- What: the blind-sign UI renders `Path` and `outer_hash` from `G_context`, then the approval callback signs by re-reading the same mutable global fields. There is no reviewed-state snapshot, no post-UI compare, and no local immutable copy for signing.
- Attack/impact: a physical fault attacker who glitches RAM after the user reviews the screen but before `sign_outer_hash_after_approval()` runs can change `G_context.sign_info.outer_hash` and/or `G_context.bip32_path`. Both RFC6979 ECDSA passes then sign the mutated values, so the duplicate-sign check still passes. Result: the host receives a valid secp256k1 signature for a different raw Aztec hash or different Aztec account than was shown on-screen. Because this is the raw blind-sign path, that is a direct authorization-integrity break if blind signing has been enabled.
- Evidence: `ui_display_blind_sign()` formats and displays `G_context.bip32_path` / `G_context.sign_info.outer_hash` (`sign_ui.c:97-106`) and wires approval to `sign_outer_hash_after_approval()` (`:114-121`). The signer then hashes `G_context.sign_info.outer_hash` (`sign_outer_hash.c:130`) and calls `bip32_derive_ecdsa_sign_rs_hash_256(... G_context.bip32_path, G_context.bip32_path_len, ...)` twice (`:143-151`, `:169-177`).
- Fix sketch: store a reviewed snapshot of `path` and `outer_hash`, compare current state against it on approval, and sign only a local immutable copy; reject on any post-review mismatch.
- Confidence: high
- Dedup-check: nearest AHW-001 / AHW-064, but distinct — those are host/API misuse and path-admission issues; this is a device-side post-review fault-binding hole in the actual sign step. Novel.

### F-G-2: Schnorr signing leaves private-key-equivalent intermediates on the stack
- Severity: MED — no direct read primitive is present here, but the app fails the “zeroize after sign” invariant and leaves spend-authority-grade residue for any later memory disclosure to recover
- Owned: OURS
- Category: FW-CRYPTO
- Location: ledger-app/src/crypto/schnorr.c:30-74; ledger-app/src/crypto/grumpkin/fq.c:223-237,261-273; ledger-app/src/l4/aztec_secret.c:93-97,138-142
- What: the Schnorr path scrubs the obvious buffers (`priv_fq`, `k_fq`, caller `sch_priv`, caller `sch_k`), but not all secret-equivalent temporaries. In `sign_once()`, `pe = priv * e` is left live on the stack. In the helper field routines used to derive and serialize the secret scalar/nonce, `gk_fq_from_bytes_wide_be()` leaves `acc`/`term`, and `gk_fq_to_bytes_be()` leaves `normal`, unsanitized.
- Attack/impact: after one Schnorr signature, any later stack disclosure / crash dump / unrelated memory leak can recover the Schnorr signing key or deterministic nonce from residue the app meant to have erased. `pe` is especially bad: `e_raw` is returned in the signature, `e = e_raw mod n` is nonzero by construction, and leaked `pe` gives `priv = pe * e^{-1} mod n`. This is not just “extra arithmetic state”; it is private-key-equivalent residue.
- Evidence: `schnorr.c` computes `gk_fq_t pe, s_fq; gk_fq_mul(&pe, &priv_fq, &e_fq); gk_fq_sub(&s_fq, &k_fq, &pe);` (`:60-63`) but on exit zeroes only `priv_fq` and `k_fq` (`:70-74`). The derivation helpers similarly keep secret values in locals without scrubbing: `gk_fq_t acc, c256, term; ... gk_fq_set(out, &acc);` in `fq.c:223-237`, and `gk_fq_t normal; gk_fq_mul(&normal, a, &one_normal);` in `fq.c:261-273`. Those helpers are invoked on the secret Schnorr scalar and nonce in `aztec_secret.c:93-97` and `:138-142`. I also read the generated `debug/app.asm`: `sign_once` allocates a 516-byte frame and only zeroes the two field-element slots corresponding to `priv_fq` and `k_fq` before returning.
- Fix sketch: scrub all secret-equivalent locals on every exit path (`pe`, secret reductions/serializations, wide-reduction temporaries), ideally via dedicated helper-level cleanup so caller-level `explicit_bzero` is not the only line of defense.
- Confidence: high
- Dedup-check: nearest AHW-061 / AHW-029, but distinct — AHW-061 was a misleading scrub-looking pattern in `schnorr_grumpkin_pubkey`, and AHW-029 is constant-time posture; this is a real key-lifetime/zeroization defect. Novel.

**Confirmed clean**
- ECDSA low-S is enforced device-side on every ECDSA signing path before serialization: `sign_outer_hash.c:159-162`, `finalize_and_sign.c:308-309,329`, `finalize_deploy_and_sign.c:295-296,315`.
- ECDSA output is raw 64-byte `r || s`, not DER and not `v`-extended: `sign_outer_hash.c:199-202`, `finalize_and_sign.c:338-340`, `finalize_deploy_and_sign.c:326-328`.
- The duplicate-sign reject path is real and returns `SW_DUP_SIG_MISMATCH` in all ECDSA emitters: `sign_outer_hash.c:189-196`, `finalize_and_sign.c:330-335`, `finalize_deploy_and_sign.c:317-323`. I verified the code paths; I did not find a dedicated test asserting them.
- I found no app-side RNG-based ECDSA nonce path. All ECDSA sign sites use `CX_RND_RFC6979`: `sign_outer_hash.c:143-151,169-177`, `finalize_and_sign.c:294-302,313-321`, `finalize_deploy_and_sign.c:281-288,299-306`.
- The device hashes exactly one SHA-256 over the 32-byte outer hash before ECDSA signing on the K1 path: `sign_outer_hash.c:127-151`. The clear-sign authwit/deploy paths sign the device-local recomputations (`recheck_outer` / `outer_hash_local`), not the host `claimed_outer_hash`: `finalize_and_sign.c:207-219,280-302`; `finalize_deploy_and_sign.c:191-224,272-288`.
- Clear-sign authwit re-runs B3 immediately before signing, so the signer path is rebound to the verified consumer at sign time: `finalize_and_sign.c:221-233`.
- Clear-sign deploy re-derives the deploy pubkey/partial/public-keys-hash/address and recomputes the deploy outer hash locally before signing: `finalize_deploy_and_sign.c:123-224`.
- Schnorr nonce generation is deterministic, domain-separated, and bound to `curve_id || P.x || P.y || priv || msg`, with dual derivation and two-direction compare: `aztec_secret.c:109-150,153-223`.
- Schnorr serialization is canonical `s(32) || e_raw(32)` and rejects `priv=0`, `k=0`, `e=0`, `s=0`: `schnorr.c:33-67,77-92`.
- On the ECDSA side, the BOLOS wrapper used by the app does scrub its temporary private-key frame after signing; I verified that in `ledger-app/debug/app.asm:14156-14178`.