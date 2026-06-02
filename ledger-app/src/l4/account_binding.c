/**
 * M11 P4 / M12 P0 — shared account-identity primitives. See account_binding.h.
 */
#include "account_binding.h"

#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "crypto_helpers.h"

#include "aztec_secret.h"      /* az_derive_schnorr_signing_scalar */
#include "deploy_address.h"    /* az_{schnorr_,}deploy_compute_partial_address */
#include "wire.h"              /* L4_CURVE_ID_GRUMPKIN */
#include "../crypto/schnorr.h" /* schnorr_grumpkin_pubkey */

int account_binding_secp256k1_pubkey_xy(const uint32_t *bip32_path, size_t bip32_path_len,
                                        uint8_t out_x[32], uint8_t out_y[32]) {
    uint8_t raw[65]; /* 0x04 || X(32) || Y(32) */
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_get_pubkey_256(CX_CURVE_256K1, bip32_path, bip32_path_len, raw,
                                               chain_code, CX_SHA512);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || raw[0] != 0x04) {
        explicit_bzero(raw, sizeof(raw));
        return -1;
    }
    memcpy(out_x, &raw[1], 32);
    memcpy(out_y, &raw[33], 32);
    explicit_bzero(raw, sizeof(raw));
    return 0;
}

int account_binding_deploy_pubkey_xy(uint8_t curve_id, const uint32_t *bip32_path,
                                     size_t bip32_path_len, uint8_t out_x[32], uint8_t out_y[32]) {
    /* GRUMPKIN: Schnorr signing scalar (child priv mod Fq, never the master
     * secret) → its Grumpkin pubkey [priv]G. K1: the secp256k1 child pubkey. */
    if (curve_id == L4_CURVE_ID_GRUMPKIN) {
        uint8_t priv[32];
        if (az_derive_schnorr_signing_scalar(bip32_path, bip32_path_len, priv) != 0) {
            explicit_bzero(priv, 32);
            return -1;
        }
        bool ok = schnorr_grumpkin_pubkey(out_x, out_y, priv);
        explicit_bzero(priv, 32);
        return ok ? 0 : -1;
    }
    if (curve_id == L4_CURVE_ID_K1) {
        return account_binding_secp256k1_pubkey_xy(bip32_path, bip32_path_len, out_x, out_y);
    }
    /* post-impl codex LOW: fail-closed on any unknown curve in shared security code —
     * callers already validate curve_id, but don't silently default to K1 here. */
    return -1;
}

int account_binding_deploy_partial(const cs_deploy_profile_t *profile, const uint8_t pubkey_x[32],
                                   const uint8_t pubkey_y[32], const uint8_t salt[32],
                                   uint8_t out_args_hash[32], uint8_t out_init_hash[32],
                                   uint8_t out_partial_address[32]) {
    /* Both branches share the init/salted/partial chain (profile-pinned
     * selector/deployer/class_id + the caller-supplied salt); only the ctor
     * args_hash differs (Schnorr 2-Fr vs ECDSA-K 64-byte), per arg_schema. */
    if (profile->arg_schema == CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY) {
        return az_schnorr_compute_partial_address(pubkey_x, pubkey_y, profile->ctor_selector_u32,
                                                  salt, profile->deployer, profile->account_class_id,
                                                  out_args_hash, out_init_hash, out_partial_address);
    }
    return az_deploy_compute_partial_address(pubkey_x, pubkey_y, profile->ctor_selector_u32, salt,
                                             profile->deployer, profile->account_class_id,
                                             out_args_hash, out_init_hash, out_partial_address);
}
