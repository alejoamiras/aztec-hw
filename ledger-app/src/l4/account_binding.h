#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * M11 P4 — single source for account-binding key derivation.
 *
 * Was 3 near-identical copies (`finalize_and_sign.c`'s authwit B3 + the two
 * deploy handlers), which codex flagged as security-relevant drift surface (they
 * had already diverged cosmetically: one combined the `err`/`0x04` checks, the
 * others split them). Centralizing removes the drift.
 *
 * Derives the uncompressed (X, Y) of the secp256k1 child pubkey for a BIP-32
 * path. Returns 0 on success, -1 on derivation failure or a non-0x04 prefix.
 * Scrubs the chain code + the raw 65-byte buffer on every path.
 */
int account_binding_secp256k1_pubkey_xy(const uint32_t *bip32_path, size_t bip32_path_len,
                                        uint8_t out_x[32], uint8_t out_y[32]);
