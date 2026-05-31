/**
 * Aztec master-secret derivation (shared). See aztec_secret.h.
 */
#include "aztec_secret.h"

#include <string.h>

#include "os.h"
#include "cx.h"
#include "crypto_helpers.h"

#include "../crypto/grumpkin/fq.h"
#include "../crypto/poseidon2/fr.h"

/* "aztec-master-secret-v1" (22 chars) + trailing NUL in a [23] array = the
 * 23-byte DOMAIN the host mirrors (master-secret.ts). */
static const uint8_t MASTER_SECRET_DOMAIN[23] = "aztec-master-secret-v1";

/* M10 — domain for the Schnorr signing scalar. Device-only (the host never
 * derives this — it gets the pubkey via GET_SCHNORR_PUBKEY), so the exact byte
 * layout only needs to be internally consistent. Includes the trailing NUL,
 * matching the master-secret convention. */
static const uint8_t SCHNORR_SIGNING_DOMAIN[25] = "aztec-schnorr-signing-v1";

/* "aztec-schnorr-nonce-v1" (22) + NUL = 23. Device-only. */
static const uint8_t SCHNORR_NONCE_DOMAIN[23] = "aztec-schnorr-nonce-v1";

int az_derive_master_secret(const uint32_t *bip32_path, size_t bip32_path_len, uint8_t out_sk[32]) {
    cx_ecfp_256_private_key_t privkey;
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_init_privkey_256(CX_CURVE_256K1,
                                                 bip32_path,
                                                 bip32_path_len,
                                                 &privkey,
                                                 chain_code);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || privkey.d_len != 32) {
        explicit_bzero(&privkey, sizeof(privkey));
        return -1;
    }

    /* input = DOMAIN(23) || privkey_d(32) = 55 bytes. */
    uint8_t input[23 + 32];
    memcpy(input, MASTER_SECRET_DOMAIN, 23);
    memcpy(input + 23, privkey.d, 32);
    explicit_bzero(&privkey, sizeof(privkey));

    uint8_t digest[64];
    if (cx_hash_sha512(input, sizeof(input), digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input));

    fr_t reduced;
    fr_from_bytes_wide_be(&reduced, digest);
    explicit_bzero(digest, sizeof(digest));
    fr_to_bytes_be(out_sk, &reduced);
    explicit_bzero(&reduced, sizeof(reduced));
    return 0;
}

static int signing_scalar_once(const uint32_t *bip32_path, size_t bip32_path_len,
                               uint8_t out_priv_be[32]) {
    cx_ecfp_256_private_key_t privkey;
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_init_privkey_256(CX_CURVE_256K1, bip32_path, bip32_path_len, &privkey,
                                                 chain_code);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || privkey.d_len != 32) {
        explicit_bzero(&privkey, sizeof(privkey));
        return -1;
    }

    /* input = DOMAIN(25, incl NUL) || privkey_d(32) = 57 bytes. */
    uint8_t input[25 + 32];
    memcpy(input, SCHNORR_SIGNING_DOMAIN, 25);
    memcpy(input + 25, privkey.d, 32);
    explicit_bzero(&privkey, sizeof(privkey));

    uint8_t digest[64];
    if (cx_hash_sha512(input, sizeof(input), digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input));

    /* Reduce mod the GRUMPKIN scalar order (Fq) — the Schnorr key field, NOT Fr.
     * Rooting in the BIP-32 child priv (not the host-exportable master secret)
     * keeps spend authority off the reveal surface (codex CRITICAL). */
    gk_fq_t reduced;
    gk_fq_from_bytes_wide_be(&reduced, digest);
    explicit_bzero(digest, sizeof(digest));
    gk_fq_to_bytes_be(out_priv_be, &reduced);
    explicit_bzero(&reduced, sizeof(reduced));

    /* Reject the (astronomically unlikely) zero scalar — fail closed (codex). */
    uint8_t z = 0;
    for (int i = 0; i < 32; i++) z |= out_priv_be[i];
    if (z == 0) {
        explicit_bzero(out_priv_be, 32);
        return -1;
    }
    return 0;
}

static int schnorr_nonce_once(const uint8_t priv_be[32], const uint8_t pubkey_x[32],
                              const uint8_t pubkey_y[32], uint8_t curve_id, const uint8_t msg[32],
                              uint8_t out_k_be[32]) {
    /* k = reduce_Fq(SHA-512(DOMAIN ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg)). Binding
     * curve_id + the pubkey prevents any cross-scheme / cross-account (k,msg)
     * repeat (opus). Deterministic ⇒ no RNG-failure nonce reuse; the FINALIZE
     * caller dual-derives + compares the signature (codex). */
    uint8_t input[23 + 1 + 32 + 32 + 32 + 32];
    size_t off = 0;
    memcpy(input + off, SCHNORR_NONCE_DOMAIN, 23);
    off += 23;
    input[off++] = curve_id;
    memcpy(input + off, pubkey_x, 32);
    off += 32;
    memcpy(input + off, pubkey_y, 32);
    off += 32;
    memcpy(input + off, priv_be, 32);
    off += 32;
    memcpy(input + off, msg, 32);
    off += 32;

    uint8_t digest[64];
    if (cx_hash_sha512(input, off, digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input)); /* contains priv */

    gk_fq_t reduced;
    gk_fq_from_bytes_wide_be(&reduced, digest);
    explicit_bzero(digest, sizeof(digest));
    gk_fq_to_bytes_be(out_k_be, &reduced);
    explicit_bzero(&reduced, sizeof(reduced));

    uint8_t z = 0;
    for (int i = 0; i < 32; i++) z |= out_k_be[i];
    if (z == 0) {
        explicit_bzero(out_k_be, 32);
        return -1;
    }
    return 0;
}

/* M11 P1 — fault-hard 32-byte equality for dual-derive. ONE direction with a
 * `volatile` accumulator; callers invoke it TWICE (forward + reverse) as two
 * independent compares with two separate reject sites, so a single glitch can't
 * both corrupt one derivation AND skip the check (codex Major). 0 iff equal. */
static int dd_eq32_dir(const uint8_t a[32], const uint8_t b[32], int forward) {
    volatile uint8_t diff = 0;
    if (forward) {
        for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    } else {
        for (int i = 31; i >= 0; i--) diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0 ? 0 : -1;
}

/* M11 P1 — dual-derive: compute the signing scalar TWICE into independent
 * buffers and gate on a fault-hard compare before exposing it. Output is
 * identical to the single derivation (parity unchanged); the second pass + the
 * compare close the single-pass fault gap the M10 comments flagged. */
int az_derive_schnorr_signing_scalar(const uint32_t *bip32_path, size_t bip32_path_len,
                                     uint8_t out_priv_be[32]) {
    uint8_t a[32], b[32];
    int r1 = signing_scalar_once(bip32_path, bip32_path_len, a);
    int r2 = signing_scalar_once(bip32_path, bip32_path_len, b);
    if (r1 != 0 || r2 != 0) {
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    if (dd_eq32_dir(a, b, 1) != 0) { /* reject site 1 (forward) */
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    if (dd_eq32_dir(a, b, 0) != 0) { /* reject site 2 (reverse) */
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    memcpy(out_priv_be, a, 32);
    explicit_bzero(a, 32);
    explicit_bzero(b, 32);
    return 0;
}

/* M11 P1 — dual-derive the nonce (same fault-hard pattern). */
int az_derive_schnorr_nonce(const uint8_t priv_be[32], const uint8_t pubkey_x[32],
                            const uint8_t pubkey_y[32], uint8_t curve_id, const uint8_t msg[32],
                            uint8_t out_k_be[32]) {
    uint8_t a[32], b[32];
    int r1 = schnorr_nonce_once(priv_be, pubkey_x, pubkey_y, curve_id, msg, a);
    int r2 = schnorr_nonce_once(priv_be, pubkey_x, pubkey_y, curve_id, msg, b);
    if (r1 != 0 || r2 != 0) {
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    if (dd_eq32_dir(a, b, 1) != 0) { /* reject site 1 (forward) */
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    if (dd_eq32_dir(a, b, 0) != 0) { /* reject site 2 (reverse) */
        explicit_bzero(a, 32);
        explicit_bzero(b, 32);
        return -1;
    }
    memcpy(out_k_be, a, 32);
    explicit_bzero(a, 32);
    explicit_bzero(b, 32);
    return 0;
}
