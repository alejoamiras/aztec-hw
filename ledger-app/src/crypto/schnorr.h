#pragma once

/**
 * Aztec/barretenberg Schnorr-over-Grumpkin (M10 P4) — the construction the
 * canonical `SchnorrAccount` verifies (barretenberg crypto/schnorr/schnorr.tcc;
 * the @aztec/foundation `Schnorr` WASM == on-chain):
 *
 *   R = k·G
 *   e_raw = Blake2s( pedersen([R.x, P.x, P.y]) || msg )   (64-byte preimage)
 *   e     = e_raw mod n_grumpkin
 *   s     = k − priv·e  (mod n_grumpkin)
 *   sig   = s(32 BE) || e_raw(32)
 *
 * The signing key `priv` and pubkey `P = priv·G` are Grumpkin scalars/points
 * (scalar field Fq = BN254 base field). `msg` is the 32-byte authwit outer_hash.
 *
 * NOTE: the nonce `k` is CALLER-PROVIDED here so this stays pure (no SHA-512 /
 * BOLOS dependency) and host-parity-testable. The device handler derives `k`
 * deterministically (= reduce_Fq(SHA-512(domain ‖ curve ‖ P ‖ priv ‖ msg)))
 * and passes it in — barretenberg's verifier accepts any valid (s, e_raw)
 * regardless of how k was produced.
 */
#include <stdbool.h>
#include <stdint.h>

/** P = priv·G (Grumpkin), BE coords. False if priv ≡ 0 / non-canonical. */
bool schnorr_grumpkin_pubkey(uint8_t out_px[32], uint8_t out_py[32], const uint8_t priv_be[32]);

/**
 * Aztec Schnorr signature with a caller-provided nonce. sig = s(32) || e_raw(32).
 * Fault-hardened (computed twice + compared). Returns false on any of:
 * non-canonical priv/k, k≡0 (R=∞), e≡0, s≡0, or an internal recompute mismatch.
 */
bool schnorr_grumpkin_sign_with_nonce(uint8_t out_sig[64], const uint8_t priv_be[32],
                                      const uint8_t k_be[32], const uint8_t msg[32]);
