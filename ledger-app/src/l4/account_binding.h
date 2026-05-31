#pragma once

#include <stddef.h>
#include <stdint.h>

#include "../clear_signing_v0/deploy_profiles.gen.h" /* cs_deploy_profile_t */

/**
 * M11 P4 / M12 P0 — single source for account-IDENTITY derivation primitives.
 *
 * M11 P4 centralized the secp256k1-pubkey derivation that the authwit B3 path +
 * the two deploy handlers each copied. M12 P0 also absorbs the scheme-dispatched
 * DEPLOY pubkey + partial-address helpers that `begin_deploy_account.c` and
 * `finalize_deploy_and_sign.c` held byte-identically. codex flagged the copies as
 * a security-relevant drift surface (they had already diverged cosmetically);
 * centralizing removes the place where a fix lands in one copy and not the other.
 *
 * SCOPE (broadened in M12 P0): account-identity primitives — derive this device's
 * signing pubkey from a path, and (for a deploy) recompute the partial account
 * address from pubkey + profile + salt. NOT "narrow secp256k1 key-derivation"
 * anymore. Every helper is a PURE function of its explicit params — it reads NO
 * session globals — so each is unit-testable in isolation and carries no hidden
 * coupling to drift against. The binding *checks* (authwit B3 + deploy P6 address
 * compares) deliberately stay in the handlers; this module only derives, it never
 * decides.
 */

/* Uncompressed (X, Y) of the secp256k1 child pubkey for a BIP-32 path. Returns 0
 * on success, -1 on derivation failure or a non-0x04 prefix. Scrubs the chain
 * code + the raw 65-byte buffer on every path. */
int account_binding_secp256k1_pubkey_xy(const uint32_t *bip32_path, size_t bip32_path_len,
                                        uint8_t out_x[32], uint8_t out_y[32]);

/* Scheme-dispatched signing pubkey (X, Y) for a deploy. GRUMPKIN derives the
 * Schnorr signing scalar from the path (child priv mod Fq, NEVER the master
 * secret) → its Grumpkin pubkey [priv]G; K1 → the secp256k1 child pubkey. Returns
 * 0 on success, -1 on failure. Scrubs the transient scalar on the GRUMPKIN path. */
int account_binding_deploy_pubkey_xy(uint8_t curve_id, const uint32_t *bip32_path,
                                     size_t bip32_path_len, uint8_t out_x[32], uint8_t out_y[32]);

/* Scheme-dispatched (args_hash, init_hash, partial_address) for a deploy. Shares
 * the init/salted/partial chain (profile-pinned selector/deployer/class_id +
 * caller-supplied salt); only the ctor args_hash differs (Schnorr 2-Fr vs ECDSA-K
 * 64-byte), selected by `profile->arg_schema`. Returns 0 on success. */
int account_binding_deploy_partial(const cs_deploy_profile_t *profile, const uint8_t pubkey_x[32],
                                   const uint8_t pubkey_y[32], const uint8_t salt[32],
                                   uint8_t out_args_hash[32], uint8_t out_init_hash[32],
                                   uint8_t out_partial_address[32]);
