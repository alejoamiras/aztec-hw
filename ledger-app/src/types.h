#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "bip32.h"

#include "constants.h"

/**
 * Enumeration of APDU INS bytes per
 * implementations-plan/hw-wallet-poc-ledger/plan-final.md §2.
 */
typedef enum {
    INS_GET_VERSION = 0x01,
    INS_GET_CAPS = 0x02,
    INS_GET_PUBLIC_KEY = 0x03,
    INS_SIGN_OUTER_HASH = 0x04,
    INS_BEGIN_AUTHWIT = 0x05,
    INS_APPEND_CALL = 0x06,
    INS_FINALIZE_AND_SIGN = 0x07,
    INS_ABORT = 0x08,
    /* M7 P3 — clear-signed deploy. BEGIN_DEPLOY_ACCOUNT commits ALL deploy
     * semantics (profile_id, salt, public_keys_hash, expected_address);
     * FINALIZE_DEPLOY_AND_SIGN adds only the claimed_outer_hash (codex
     * audit MAJOR #1 — eliminates the "host changes its mind between
     * BEGIN and FINALIZE" desync class). */
    INS_BEGIN_DEPLOY_ACCOUNT = 0x10,
    INS_FINALIZE_DEPLOY_AND_SIGN = 0x11,
    /* M8 P4 — reveal the 32-byte Aztec master secret (Fr) for a path after a
     * high-friction on-device confirmation. Single-shot (no streaming). The
     * host runs the result through Aztec deriveKeys() to reconstruct viewing
     * keys. Discloses note-VIEWING capability, never spend authority. */
    INS_GET_AZTEC_MASTER_SECRET = 0x12,
    /* M10 — Grumpkin signing public key P = priv·G for the SchnorrAccount. The
     * host drops (P.x, P.y) into the SchnorrAccount constructor args. Like
     * GET_PUBLIC_KEY (K1), this is non-sensitive (public key, no confirmation).
     * The Schnorr signing scalar is derived device-side from the BIP-32 child
     * priv (distinct domain, reduced mod the Grumpkin order) — never exported. */
    INS_GET_SCHNORR_PUBKEY = 0x13,
#ifdef CX_MATH_SPIKE
    /* M12 P3 — THROWAWAY cx_math prototype-spike INS (flag-gated; never in the
     * shipped build). cx_bn_mod_mul vs native fr_mul/gk_fq_mul for both moduli. */
    INS_CXMATH_SPIKE = 0x70,
#endif
} command_e;

/**
 * Feature bitmask returned by GET_CAPS.
 */
typedef enum {
    CAPS_K1 = 1u << 0,
    CAPS_R1 = 1u << 1,
    CAPS_CLEAR_SIGN = 1u << 2,
    CAPS_GRUMPKIN = 1u << 3,
} caps_e;

typedef enum {
    REQ_NONE = 0,
    REQ_GET_PUBLIC_KEY,
    REQ_SIGN_OUTER_HASH,
} request_type_e;

typedef struct {
    uint8_t raw_public_key[65];  // 0x04 || X(32) || Y(32) — secp256k1
    uint8_t chain_code[32];
} pubkey_ctx_t;

typedef struct {
    uint8_t outer_hash[AZTEC_OUTER_HASH_LEN];
    uint8_t r[32];
    uint8_t s[32];
} sign_ctx_t;

typedef struct {
    request_type_e req_type;
    uint32_t bip32_path[MAX_BIP32_PATH_LEN];
    uint8_t bip32_path_len;
    union {
        pubkey_ctx_t pk_info;
        sign_ctx_t sign_info;
    };
} global_ctx_t;
