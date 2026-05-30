/**
 * Aztec master-secret derivation (shared, device-only).
 *
 *   sk = SHA-512("aztec-master-secret-v1\0" || privkey_d(32)) mod Fr
 *
 * where privkey_d is the BIP-32 secp256k1 child PRIVATE scalar at `path`, and
 * Fr is the BN254 scalar field. Extracted so both INS_GET_AZTEC_MASTER_SECRET
 * (the reveal) and the deploy verification (Phase 6) derive `sk` identically.
 *
 * Codex Phase-4 BLOCKER: hashes the PRIVATE key, never the public key (the
 * public key is host-readable with no confirmation). SHA-512 one-way ⇒ no
 * signing-key leak.
 *
 * `out_sk` is SECRET-EQUIVALENT (it reconstructs all viewing keys). The caller
 * MUST `explicit_bzero` it after use. This function wipes every intermediate
 * (privkey struct, chain code, hash input, digest) before returning.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/** @return 0 on success, -1 on derivation failure. */
int az_derive_master_secret(const uint32_t *bip32_path, size_t bip32_path_len, uint8_t out_sk[32]);

/**
 * M10 — derive the Grumpkin Schnorr SIGNING scalar (device-only):
 *
 *   priv = SHA-512("aztec-schnorr-signing-v1\0" || privkey_d(32)) mod n_grumpkin
 *
 * Rooted in the BIP-32 secp256k1 child priv (same lineage as the K1 key, so
 * reconnect == recovery), reduced mod the Grumpkin scalar order (Fq) — the
 * Schnorr key field. Distinct domain + NEVER the host-exportable master secret
 * (codex CRITICAL: would turn the viewing-key reveal into spend-key exfil).
 * `out_priv_be` is SECRET; caller must wipe. @return 0 ok, -1 on failure / zero.
 */
int az_derive_schnorr_signing_scalar(const uint32_t *bip32_path, size_t bip32_path_len,
                                     uint8_t out_priv_be[32]);
