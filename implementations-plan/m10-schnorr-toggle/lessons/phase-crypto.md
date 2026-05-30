# M10 P1–P4 — on-device crypto core (DONE, parity-green, arm-compiling)

All committed on branch `m9-real-wallet-ux` (unsigned, AFK). Each phase gated by a bun host-parity test that compiles the SAME device `.c` (via `ledger-app/tests/grumpkin_host` + `blake2s_host`) and diffs against bb.js / node:crypto.

- **P1 blake2s** (`bb489ec`): `src/crypto/blake2s.{c,h}` RFC-7693 (BOLOS has only blake2b). 3/3 vs `node:crypto` blake2s256. Vector #1 = 64-byte input (the schnorr preimage shape).
- **P2 var-base [k]·P** (`49bc1ce`): refactored `mul_generator.c` to share a double-and-add core; added `grumpkin_scalar_mul_affine`. 7/7 vs bb.js (+ fixed-base no-regression).
- **P3 pedersen-3** (`80ca316`): `src/crypto/pedersen.{c,h}`. `([3]·g_len + Σ v_i·g_i).x`. 3/3 vs `@aztec/foundation` pedersenHash. Vector #1 `[0,0,0]`=x(3·g_len).
- **P4 schnorr** (`a7e8cde`): `src/crypto/schnorr.{c,h}`. 3/3 — byte-exact vs JS replication + 64 random verify under barretenberg. arm build links blake2s.o/pedersen.o/schnorr.o.

## Decisions that proved right (verified, not guessed)
- **Pedersen generators are PLAIN affine, NOT Montgomery** — confirmed via `@aztec/foundation` `pedersen.noble.ts` (`new ProjectivePoint(x,y,1n)`), byte-identical to barretenberg `precomputed_generators_grumpkin_impl.hpp`. Lifted G0–2 (`DEFAULT_DOMAIN_SEPARATOR`) + g_len (`pedersen_hash_length`) as hex into `pedersen.c`. Integrity gate = the parity test.
- **No input scalar reduction**: noble does `input mod Fp`; Aztec Fr (`…f0000001`) < Grumpkin order (`…d87cfd47`), so canonical Fr inputs pass through. Device enforces canonical-Fr inputs (codex invariant). Zero inputs are SKIPPED (noble `ie ? add : skip`).
- **Blake2s only for the challenge** (not pedersen) — pedersen needs Blake3 only if deriving generators on-device, which we avoid by hardcoding.
- **schnorr.c is PURE** (caller-provided nonce) so it links on the host (no `cx_hash_sha512`). The deterministic-k + signing-scalar derivation (sha512, BOLOS) is P5 device-only glue.

## P5–P9 remaining (integration) — entry points identified
- **Signing scalar** = mirror `l4/aztec_secret.c:az_derive_master_secret` but reduce mod **Fq** (`gk_fq_from_bytes_wide_be`) + domain `"aztec-schnorr-signing-v1"`. Device-only (host gets P via APDU) → no host mirror needed.
- **Nonce** k = reduce_Fq(SHA-512("aztec-schnorr-nonce-v1" ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg)). Device-only.
- **P5**: new `INS_GET_SCHNORR_PUBKEY` (mirror `handler/get_public_key.c`; wire in `apdu/dispatcher.c` + the INS constant) → `schnorr_grumpkin_pubkey`. Branch `handler/finalize_and_sign.c` (the `finalize_after_approval` ECDSA sign site) on `curve_id == L4_CURVE_ID_GRUMPKIN (3)` → derive scalar+nonce → `schnorr_grumpkin_sign_with_nonce`. Extend B3 consumer-recompute + Phase-6 deploy-address per-scheme. Speculos APDU test.
- **P6** host adapter: subclass `@aztec/accounts/schnorr` `SchnorrBaseAccountContract`; device-backed authwit provider (curve_id=Schnorr); `CS_DEPLOY_PROFILES[1]` = SchnorrAccount + codegen; thread `scheme` through `connect()`, cache key includes scheme.
- **P7** frontend ECDSA/Schnorr toggle. **P8** testnet e2e (Playwright) Schnorr onboard→deploy(fresh idx)→drip→transfer + ECDSA regression. **P9** codex post-impl review → `safe-v8`.
- Fallback: `safe-v7` (`c5be220`).
