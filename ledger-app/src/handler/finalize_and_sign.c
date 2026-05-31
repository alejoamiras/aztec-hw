/**
 * FINALIZE_AND_SIGN — parity gate + fault-hardened ECDSA over sha256(outer_hash).
 *
 * Three independent recomputations of outer_hash bound this handler:
 *   - Two BEFORE UI is shown (both must match claimed_outer_hash).
 *   - One INSIDE finalize_after_approval (must match the stored value).
 *
 * Any mismatch zeroes the session and returns SW_HASH_MISMATCH. The signing
 * step replicates the L2 K1 path (sha256 + RFC-6979 + low-S + duplicate
 * signature check from sign_outer_hash.c).
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"

#include "finalize_and_sign.h"
#include "sign_outer_hash.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../l4/parity.h"
#include "../l4/deploy_address.h"
#include "../l4/account_derive.h"
#include "../l4/aztec_secret.h"
#include "../l4/account_binding.h"
#include "../crypto/schnorr.h"
#include "../clear_signing_v0/deploy_profiles.gen.h"
#include "../clear_signing_v0/schnorr_account.h"
#include "../ui/display.h"
#include "nbgl_use_case.h"

/* sign_outer_hash.c exports n (the secp256k1 order) — reuse it. */
extern const uint8_t SECP256K1_N[32];

static const uint8_t SECP256K1_HALF_N_L4[32] = {
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d,
    0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
};

/* Bail-out helper: clear the session and return the given SW. */
static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

/* Constant-time-ish 32-byte compare. Returns 0 on equal. */
static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static bool s_is_high(const uint8_t *s) {
    int cmp = 0;
    for (size_t i = 0; i < 32; i++) {
        int diff = (int)s[i] - (int)SECP256K1_HALF_N_L4[i];
        int already = (cmp != 0) ? 1 : 0;
        cmp = already ? cmp : (diff > 0 ? 1 : (diff < 0 ? -1 : 0));
    }
    return cmp > 0;
}

static void low_s_normalize(uint8_t *s) {
    uint16_t borrow = 0;
    for (int i = 31; i >= 0; i--) {
        int32_t v = (int32_t)SECP256K1_N[i] - (int32_t)s[i] - (int32_t)borrow;
        if (v < 0) {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        s[i] = (uint8_t)v;
    }
}

/* M9 B3: secp256k1 signing pubkey (X,Y) from the AUTHWIT session path. Mirror
 * of begin_deploy_account.c's derive_signing_pubkey_xy, but reads
 * G_l4_session.bip32_path. (This is the 3rd copy of the same 6-line derivation;
 * a follow-up should unify deploy + authwit into one shared l4 helper. Kept
 * local here to avoid destabilizing the proven deploy path in the B3 change.) */
static int derive_signing_pubkey_xy_session(uint8_t out_x[32], uint8_t out_y[32]) {
    /* M11 P4: delegate to the shared single source (was a local copy). */
    return account_binding_secp256k1_pubkey_xy(G_l4_session.bip32_path, G_l4_session.bip32_path_len,
                                               out_x, out_y);
}

/* M9 B3: recompute THIS account's address from the signing path (partial) +
 * viewing keys (pkh) and cross-check it against the signed `consumer`. Returns
 * the SW to reject with, or 0 on a verified match. `consumer` is the first
 * field of outer_hash (parity.c) and is re-verified before signing (pass 3), so
 * it cannot drift after this check — proving the account we authorize for is
 * the one this key controls. This is the ONLY consumer gate for non-transfer
 * verbs (drip); for transfers APPEND_CALL already pins from == consumer, so
 * together they give from == consumer == account (self-spend only; delegated
 * spend is rejected at APPEND_CALL with SW_DELEGATED_SPEND_UNSUPPORTED).
 *
 * salt = Fr.ZERO (the demo's deterministic DEFAULT_ACCOUNT_SALT), profile 0
 * (the sole EcdsaKAccount template). An account deployed with a different
 * salt/profile recomputes to a different address and fails closed; a glitched
 * recompute also fails closed (reject, never a false accept). */
static int b3_verify_consumer_is_this_account(void) {
    static const uint8_t B3_ZERO[32] = {0}; /* salt + deployer (universal, Fr.ZERO) */
    uint8_t partial[32];

    if (G_l4_session.curve_id == L4_CURVE_ID_GRUMPKIN) {
        /* Schnorr account: partial from the Grumpkin pubkey (2-Fr ctor) + the
         * SchnorrAccount class_id/selector. Viewing-key half (below) is
         * scheme-independent. */
        uint8_t priv[32];
        if (az_derive_schnorr_signing_scalar(G_l4_session.bip32_path, G_l4_session.bip32_path_len,
                                             priv) != 0) {
            explicit_bzero(priv, 32);
            return SWO_UNKNOWN;
        }
        uint8_t pk_x[32], pk_y[32];
        bool pk_ok = schnorr_grumpkin_pubkey(pk_x, pk_y, priv);
        explicit_bzero(priv, 32);
        if (!pk_ok) {
            explicit_bzero(pk_x, 32);
            explicit_bzero(pk_y, 32);
            return SWO_UNKNOWN;
        }
        uint8_t s_args_hash[32], s_init_hash[32];
        int prc = az_schnorr_compute_partial_address(pk_x, pk_y, SCHNORR_ACCOUNT_CTOR_SELECTOR_U32,
                                                     B3_ZERO, B3_ZERO, SCHNORR_ACCOUNT_CLASS_ID_BE,
                                                     s_args_hash, s_init_hash, partial);
        explicit_bzero(pk_x, 32);
        explicit_bzero(pk_y, 32);
        explicit_bzero(s_args_hash, 32);
        explicit_bzero(s_init_hash, 32);
        if (prc != 0) {
            explicit_bzero(partial, 32);
            return SWO_UNKNOWN;
        }
    } else {
        /* ECDSA-K account (profile 0). */
        const cs_deploy_profile_t *profile = cs_deploy_profile_lookup(0);
        if (profile == NULL) return SW_UNKNOWN_PROFILE_ID;
        uint8_t pk_x[32], pk_y[32];
        if (derive_signing_pubkey_xy_session(pk_x, pk_y) != 0) {
            explicit_bzero(pk_x, 32);
            explicit_bzero(pk_y, 32);
            return SWO_UNKNOWN;
        }
        uint8_t args_hash[32], init_hash[32];
        int prc = az_deploy_compute_partial_address(pk_x, pk_y, profile->ctor_selector_u32, B3_ZERO,
                                                    profile->deployer, profile->account_class_id,
                                                    args_hash, init_hash, partial);
        explicit_bzero(pk_x, 32);
        explicit_bzero(pk_y, 32);
        explicit_bzero(args_hash, 32);
        explicit_bzero(init_hash, 32);
        if (prc != 0) {
            explicit_bzero(partial, 32);
            return SWO_UNKNOWN;
        }
    }

    uint8_t pkh[32], addr[32];
    int rc = az_account_derive_from_path(G_l4_session.bip32_path, G_l4_session.bip32_path_len,
                                         partial, pkh, addr);
    explicit_bzero(partial, 32);
    explicit_bzero(pkh, 32);
    if (rc != 0) {
        explicit_bzero(addr, 32);
        return SWO_UNKNOWN;
    }

    int mismatch = ct_memcmp32(addr, G_l4_session.consumer);
    explicit_bzero(addr, 32);
    return (mismatch != 0) ? SW_AUTHWIT_CONSUMER_MISMATCH : 0;
}

int handler_finalize_and_sign(buffer_t *cdata) {
    if (G_l4_session.state != L4_CALLS_COMPLETE) return reject(SWO_INVALID_INS);

    if (!buffer_read_bytes(cdata, G_l4_session.claimed_outer_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);
    /* codex L4 MINOR — `claimed_outer_hash` must be a canonical Fr too;
     * length-only check was spec drift. */
    if (!l4_fr_is_canonical(G_l4_session.claimed_outer_hash)) {
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Parity pass 1 ------------------------------------------------- */
    uint8_t computed_outer[L4_FR_BYTES];
    uint8_t computed_inner[L4_FR_BYTES];
    if (!l4_compute_outer_hash(computed_outer, computed_inner)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Parity pass 2 (fault detection, deep plan §5) ----------------- */
    uint8_t computed_outer_2[L4_FR_BYTES];
    uint8_t computed_inner_2[L4_FR_BYTES];
    if (!l4_compute_outer_hash(computed_outer_2, computed_inner_2)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer_2, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_outer, computed_outer_2) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(computed_inner, computed_inner_2) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* Stash the device-recomputed values for UI + signing step. */
    memcpy(G_l4_session.outer_hash, computed_outer, L4_FR_BYTES);
    memcpy(G_l4_session.inner_hash, computed_inner, L4_FR_BYTES);

    /* M9 B3: device-VERIFIED `From`. Recompute this account's address and
     * cross-check it against `consumer` BEFORE showing the review, so the
     * address the UI presents as `From` is device-proven, not host-asserted. */
    int b3_sw = b3_verify_consumer_is_this_account();
    if (b3_sw != 0) {
        return reject((uint16_t)b3_sw);
    }

    /* UI calls finalize_after_approval / finalize_rejected on user choice. */
    return ui_display_verified_calls();
}

int finalize_after_approval(void) {
    /* --- Parity pass 3 (just before signing) --------------------------- */
    uint8_t recheck_outer[L4_FR_BYTES];
    uint8_t recheck_inner[L4_FR_BYTES];
    if (!l4_compute_outer_hash(recheck_outer, recheck_inner)) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(recheck_outer, G_l4_session.outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }
    if (ct_memcmp32(recheck_outer, G_l4_session.claimed_outer_hash) != 0) {
        return reject(SW_HASH_MISMATCH);
    }

    /* M9 B3 (codex post-impl MAJOR): re-run the consumer cross-check HERE, just
     * before signing, not only before the UI. Pass 3 above rebinds `consumer`
     * to outer_hash, but the signature below derives from G_l4_session.bip32_path
     * — so without this, a fault that mutates the signer path between the
     * pre-UI check and the signature would sign with a key we never verified
     * against `consumer`. Re-deriving account(path) == consumer here binds the
     * SIGNER PATH to the verified account, mirroring the deploy's pre-sign
     * Phase-6 recheck (finalize_deploy_and_sign.c). Also forces an
     * instruction-skip attack to bypass the gate at two distinct sites. */
    int b3_sw = b3_verify_consumer_is_this_account();
    if (b3_sw != 0) {
        return reject((uint16_t)b3_sw);
    }

    /* M10: Schnorr-over-Grumpkin path. Signs the RAW outer_hash (no sha256 —
     * unlike ECDSA-K). Deterministic nonce bound to curve_id+pubkey+priv+msg.
     * Fault model (codex post-impl MAJOR — precise): schnorr_grumpkin_sign_with_
     * nonce recomputes the (R, pedersen, blake2s, e, s) CONSTRUCTION twice +
     * byte-compares, catching construction-stage glitches. The scalar/nonce
     * derivation here is single-pass — but a glitch there yields a sig for a
     * different key, which is (a) fail-safe (on-chain-invalid, never a spend
     * break) and (b) independently cross-checked: the pre-UI B3 derived the same
     * scalar→address and proved it == consumer. Full dual-derive of the scalar
     * is a documented hardening follow-up. Returns s(32)||e_raw(32). The ECDSA-K
     * block below is untouched (curve_id != GRUMPKIN). */
    if (G_l4_session.curve_id == L4_CURVE_ID_GRUMPKIN) {
        uint8_t sch_priv[32], sch_px[32], sch_py[32], sch_k[32];
        if (az_derive_schnorr_signing_scalar(G_l4_session.bip32_path,
                                             G_l4_session.bip32_path_len, sch_priv) != 0) {
            explicit_bzero(sch_priv, 32);
            return reject(SWO_UNKNOWN);
        }
        if (!schnorr_grumpkin_pubkey(sch_px, sch_py, sch_priv)) {
            explicit_bzero(sch_priv, 32);
            return reject(SWO_UNKNOWN);
        }
        if (az_derive_schnorr_nonce(sch_priv, sch_px, sch_py, L4_CURVE_ID_GRUMPKIN,
                                    recheck_outer, sch_k) != 0) {
            explicit_bzero(sch_priv, 32);
            explicit_bzero(sch_k, 32);
            return reject(SWO_UNKNOWN);
        }
        uint8_t sch_sig[64];
        bool sok = schnorr_grumpkin_sign_with_nonce(sch_sig, sch_priv, sch_k, recheck_outer);
        explicit_bzero(sch_priv, 32);
        explicit_bzero(sch_k, 32);
        if (!sok) {
            explicit_bzero(sch_sig, sizeof(sch_sig));
            return reject(SWO_UNKNOWN);
        }
        int sch_rc = io_send_response_pointer(sch_sig, sizeof(sch_sig), SWO_SUCCESS);
        explicit_bzero(sch_sig, sizeof(sch_sig));
        l4_session_reset();
        nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main);
        return sch_rc;
    }

    /* Sign sha256(recheck_outer) — sign the JUST-VALIDATED local value, NOT
     * the mutable G_l4_session.outer_hash. Defeats a TOCTOU glitch between
     * the compares above and the sha256/sign calls below: the dup-sig check
     * cannot catch corruption that happens BEFORE the digest computes, since
     * both sign calls would consume the same already-corrupted digest.
     * (codex L4 final-review BLOCKER #1.) */
    uint8_t digest[32];
    size_t digest_len = cx_hash_sha256(recheck_outer, L4_FR_BYTES, digest, sizeof(digest));
    if (digest_len != 32) {
        return reject(SWO_UNKNOWN);
    }

    uint8_t r[32], s[32];
    uint32_t info = 0;
    cx_err_t err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                                       G_l4_session.bip32_path,
                                                       G_l4_session.bip32_path_len,
                                                       CX_RND_RFC6979,
                                                       CX_SHA256,
                                                       digest, sizeof(digest),
                                                       r,
                                                       s,
                                                       &info);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s)) low_s_normalize(s);

    /* Duplicate signature check — fault defense (sign_outer_hash.c parity). */
    uint8_t r2[32], s2[32];
    uint32_t info2 = 0;
    err = bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1,
                                              G_l4_session.bip32_path,
                                              G_l4_session.bip32_path_len,
                                              CX_RND_RFC6979,
                                              CX_SHA256,
                                              digest, sizeof(digest),
                                              r2,
                                              s2,
                                              &info2);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s2)) low_s_normalize(s2);
    if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        return reject(SW_DUP_SIG_MISMATCH);
    }

    uint8_t response[ECDSA_K1_SIG_LEN];
    memcpy(response, r, 32);
    memcpy(response + 32, s, 32);

    explicit_bzero(r, sizeof(r));
    explicit_bzero(s, sizeof(s));
    explicit_bzero(r2, sizeof(r2));
    explicit_bzero(s2, sizeof(s2));

    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    l4_session_reset();
    /* Codex 019e6ad4 fix: NBGL review screen stays painted after the
     * APDU success reply unless we explicitly transition the device
     * back to home. nbgl_useCaseReviewStatus shows a brief "Tx signed"
     * confirmation page, then calls ui_menu_main() to return to idle. */
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main);
    return rc;
}

int finalize_rejected(void) {
    l4_session_reset();
    int rc = io_send_sw(SW_USER_REJECTED);
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    return rc;
}
