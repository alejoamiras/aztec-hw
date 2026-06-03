/**
 * Aztec/barretenberg Schnorr-over-Grumpkin construction (M10 P4). See schnorr.h.
 * Pure (no SHA-512): the nonce is provided by the caller.
 */
#include "schnorr.h"

#include <string.h>

#include "blake2s.h"
#include "grumpkin/fq.h"
#include "grumpkin/mul_generator.h"
#include "pedersen.h"

bool schnorr_grumpkin_pubkey(uint8_t out_px[32], uint8_t out_py[32], const uint8_t priv_be[32]) {
    /* Reject non-canonical priv (>= group order). */
    gk_fq_t tmp;
    if (!gk_fq_from_bytes_be(&tmp, priv_be)) return false;
    gk_fq_zero(&tmp);
    return grumpkin_scalar_mul_generator(out_px, out_py, priv_be); /* false if priv ≡ 0 */
}

/* Constant-time 64-byte compare. 0 == equal. */
static uint8_t ct_diff64(const uint8_t a[64], const uint8_t b[64]) {
    uint8_t d = 0;
    for (int i = 0; i < 64; i++) d |= (uint8_t)(a[i] ^ b[i]);
    return d;
}

/* One pass of the construction. Returns false on any reject condition. */
static bool sign_once(uint8_t out_sig[64], const uint8_t priv_be[32], const uint8_t k_be[32],
                      const uint8_t msg[32]) {
    gk_fq_t priv_fq, k_fq;
    if (!gk_fq_from_bytes_be(&priv_fq, priv_be)) return false; /* canonical priv */
    if (!gk_fq_from_bytes_be(&k_fq, k_be)) return false;       /* canonical k */

    uint8_t px[32], py[32], rx[32], ry[32];
    bool ok = false;
    if (!grumpkin_scalar_mul_generator(px, py, priv_be)) goto done; /* P = priv·G; false if 0 */
    if (!grumpkin_scalar_mul_generator(rx, ry, k_be)) goto done;    /* R = k·G; false if k≡0 (R=∞) */

    uint8_t compressed[32];
    if (!pedersen_hash3(compressed, rx, px, py)) goto done;

    uint8_t preimage[64];
    memcpy(preimage, compressed, 32);
    memcpy(preimage + 32, msg, 32);
    uint8_t e_raw[32];
    blake2s256(e_raw, preimage, sizeof(preimage));

    /* e = e_raw mod n_grumpkin (zero-extend to 64 → wide reduce). */
    uint8_t e_wide[64];
    memset(e_wide, 0, 32);
    memcpy(e_wide + 32, e_raw, 32);
    gk_fq_t e_fq;
    gk_fq_from_bytes_wide_be(&e_fq, e_wide);
    gk_fq_t zero;
    gk_fq_zero(&zero);
    if (gk_fq_eq(&e_fq, &zero)) goto done; /* e ≡ 0 */

    /* s = k − priv·e (mod n). */
    gk_fq_t pe, s_fq;
    gk_fq_mul(&pe, &priv_fq, &e_fq);
    gk_fq_sub(&s_fq, &k_fq, &pe);
    if (gk_fq_eq(&s_fq, &zero)) goto done; /* s ≡ 0 */

    gk_fq_to_bytes_be(out_sig, &s_fq);
    memcpy(out_sig + 32, e_raw, 32);
    ok = true;

done:
    /* Scrub ALL secret-derived field elements (AHW-100). `pe = priv·e` is the
     * dangerous one: with the public `e` (in the signature), leftover `pe`
     * recovers `priv = pe·e⁻¹`. gk_fq_zero is the cross-platform wipe (device +
     * the host parity oracle). gk_fq_secure_wipe does VOLATILE stores that survive
     * -Oz dead-store elimination — gk_fq_zero inlines to dead stores the compiler
     * drops — and needs no BOLOS os.h (host crypto build unaffected).
     * pe/s_fq may be indeterminate if we jumped here pre-assignment — writing
     * their storage is safe (no read of an uninit value). */
    gk_fq_secure_wipe(&priv_fq);
    gk_fq_secure_wipe(&k_fq);
    gk_fq_secure_wipe(&pe);
    gk_fq_secure_wipe(&s_fq);
    return ok;
}

bool schnorr_grumpkin_sign_with_nonce(uint8_t out_sig[64], const uint8_t priv_be[32],
                                      const uint8_t k_be[32], const uint8_t msg[32]) {
    uint8_t sig2[64];
    if (!sign_once(out_sig, priv_be, k_be, msg)) return false;
    if (!sign_once(sig2, priv_be, k_be, msg)) {
        memset(out_sig, 0, 64);
        return false;
    }
    /* Fault check: deterministic k ⇒ both passes identical (codex/opus). */
    if (ct_diff64(out_sig, sig2) != 0) {
        memset(out_sig, 0, 64);
        memset(sig2, 0, 64);
        return false;
    }
    memset(sig2, 0, 64);
    return true;
}
