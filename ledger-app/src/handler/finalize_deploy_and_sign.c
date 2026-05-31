/**
 * M7 P3 — INS_FINALIZE_DEPLOY_AND_SIGN.
 *
 * Mirrors finalize_and_sign.c's parity-pass-3 + duplicate-ECDSA-signature
 * discipline. The only semantic input from the host at this stage is
 * `claimed_outer_hash` (codex audit MAJOR #1: BEGIN already committed
 * everything else).
 *
 * Codex 019e6ad4 / M6.11 — explicit NBGL dismissal after success / reject.
 * Required from commit zero on the new verb so we don't regress.
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"

#include "finalize_deploy_and_sign.h"
#include "sign_outer_hash.h" /* SECP256K1_N is exported from there */
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../l4/deploy_address.h"
#include "../l4/account_derive.h"
#include "../l4/aztec_secret.h"
#include "../l4/account_binding.h"
#include "../crypto/schnorr.h"
#include "../l4/deploy_outer_hash.h"
#include "../clear_signing_v0/deploy_profiles.gen.h"
#include "../ui/display.h"
#include "nbgl_use_case.h"

extern const uint8_t SECP256K1_N[32];

static const uint8_t SECP256K1_HALF_N_DEPLOY[32] = {
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d,
    0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
};

static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static bool s_is_high(const uint8_t *s) {
    int cmp = 0;
    for (size_t i = 0; i < 32; i++) {
        int diff = (int)s[i] - (int)SECP256K1_HALF_N_DEPLOY[i];
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

/* M12 P0: the deploy pubkey + partial-address helpers (+ the K1-only
 * derive_signing_pubkey_xy wrapper) moved verbatim into l4/account_binding.c as
 * PURE param-driven helpers — see account_binding.h. The Phase-6 recompute below
 * passes the session's curve_id / path / salt explicitly (no module reads of the
 * session global). Byte-identical behavior. */

int handler_finalize_deploy_and_sign(buffer_t *cdata) {
    if (G_l4_session.state != L4_DEPLOY_CONTEXT) {
        return reject(SW_DEPLOY_CONTEXT_WRONG_STATE);
    }

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.claimed_outer_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);
    if (!l4_fr_is_canonical(G_l4_deploy_session.claimed_outer_hash)) {
        return reject(SW_HASH_MISMATCH);
    }
    G_l4_deploy_session.claimed_outer_hash_received = true;

    /* The actual sign step waits for user approval; the UI flow was
     * already entered from BEGIN_DEPLOY_ACCOUNT (review screen visible).
     * Here we just stash the outer-hash claim and signal the UI to
     * proceed. In practice this APDU lands AFTER the user has confirmed,
     * because the host streams BEGIN → user-approve → FINALIZE → sign-reply
     * in that order. So the actual signing happens here, in
     * finalize_deploy_after_approval, invoked from the UI's confirm
     * callback. */
    return ui_display_deploy_review();
}

int finalize_deploy_after_approval(void) {
    /* Without an outer_hash claim we have nothing to sign. The host MUST stream
     * FINALIZE before user-approve so the slot is populated; otherwise reject.
     * Use the explicit state bit, not a zero-scan: Fr(0) is a valid canonical
     * hash and must not be conflated with "not received" (codex P6d review). */
    if (!G_l4_deploy_session.claimed_outer_hash_received) {
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Parity pass 3 ----------------------------------------------- */
    const cs_deploy_profile_t *profile = cs_deploy_profile_lookup(G_l4_deploy_session.profile_id);
    if (profile == NULL) return reject(SW_UNKNOWN_PROFILE_ID);

    uint8_t signing_pubkey_x[32];
    uint8_t signing_pubkey_y[32];
    if (account_binding_deploy_pubkey_xy(G_l4_deploy_session.curve_id, G_l4_deploy_session.bip32_path,
                                         G_l4_deploy_session.bip32_path_len, signing_pubkey_x,
                                         signing_pubkey_y) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        return reject(SWO_UNKNOWN);
    }

    uint8_t recheck_args[32];
    uint8_t recheck_init[32];
    uint8_t recheck_partial[32];
    if (account_binding_deploy_partial(profile, signing_pubkey_x, signing_pubkey_y,
                                       G_l4_deploy_session.salt, recheck_args, recheck_init,
                                       recheck_partial) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        explicit_bzero(recheck_args, 32);
        explicit_bzero(recheck_init, 32);
        explicit_bzero(recheck_partial, 32);
        return reject(SWO_UNKNOWN);
    }
    explicit_bzero(signing_pubkey_x, 32);
    explicit_bzero(signing_pubkey_y, 32);

    if (ct_memcmp32(recheck_args, G_l4_deploy_session.args_hash_local) != 0 ||
        ct_memcmp32(recheck_init, G_l4_deploy_session.init_hash_local) != 0 ||
        ct_memcmp32(recheck_partial, G_l4_deploy_session.partial_address_local) != 0) {
        explicit_bzero(recheck_args, 32);
        explicit_bzero(recheck_init, 32);
        explicit_bzero(recheck_partial, 32);
        return reject(SW_HASH_MISMATCH);
    }
    explicit_bzero(recheck_args, 32);
    explicit_bzero(recheck_init, 32);
    explicit_bzero(recheck_partial, 32);

    /* --- M8 P6: third-pass re-derivation of publicKeysHash + address --------
     * BEGIN verified the device-derived account identity against the host and
     * cached the public values. Re-derive once more here (just before signing)
     * and compare against the cached locals -- a glitch between BEGIN and the
     * signature must not let us sign a deploy whose on-chain viewing keys /
     * address differ from what was verified + displayed. A full independent
     * path->sk->{pkh,addr} pass (codex Phase-6c review MAJOR). Internal mismatch
     * is a fault, not a host disagreement -> generic SW_HASH_MISMATCH. */
    uint8_t p6_pkh[32], p6_addr[32];
    if (az_account_derive_from_path(G_l4_deploy_session.bip32_path,
                                    G_l4_deploy_session.bip32_path_len,
                                    G_l4_deploy_session.partial_address_local,
                                    p6_pkh, p6_addr) != 0) {
        explicit_bzero(p6_pkh, 32);
        explicit_bzero(p6_addr, 32);
        return reject(SWO_UNKNOWN);
    }
    if (ct_memcmp32(p6_pkh, G_l4_deploy_session.public_keys_hash_local) != 0 ||
        ct_memcmp32(p6_addr, G_l4_deploy_session.address_local) != 0) {
        explicit_bzero(p6_pkh, 32);
        explicit_bzero(p6_addr, 32);
        return reject(SW_HASH_MISMATCH);
    }
    explicit_bzero(p6_pkh, 32);
    explicit_bzero(p6_addr, 32);

    /* --- M8 P6d: recompute the deploy authwit outer_hash from device-authored
     * values and verify it against the host claim BEFORE signing. The deploy
     * authwit is the account entrypoint wrapping one sponsor_unconditionally()
     * call; the device reconstructs it from the device-verified address
     * (consumer = address_local), the manifest-pinned sponsor FPC + selector,
     * and the session chain/version/tx_nonce. This closes the last blind-sign:
     * the device now signs a hash it authored, not one the host asserted. */
    uint8_t recomputed_outer[L4_FR_BYTES];
    if (az_deploy_compute_outer_hash(G_l4_deploy_session.address_local,
                                     G_l4_deploy_session.chain_id,
                                     G_l4_deploy_session.protocol_version,
                                     G_l4_deploy_session.tx_nonce,
                                     profile->sponsor_fpc_address,
                                     profile->sponsor_selector_u32,
                                     recomputed_outer) != 0) {
        explicit_bzero(recomputed_outer, sizeof(recomputed_outer));
        return reject(SWO_UNKNOWN);
    }
    if (ct_memcmp32(recomputed_outer, G_l4_deploy_session.claimed_outer_hash) != 0) {
        explicit_bzero(recomputed_outer, sizeof(recomputed_outer));
        return reject(SW_HASH_MISMATCH);
    }

    /* --- Sign the DEVICE-recomputed outer_hash DIRECTLY ----------------
     * Sign recomputed_outer (just proven == claimed), NOT a re-read of the mutable
     * session claimed_outer_hash. A glitch on the host-controlled session field
     * between the compare above and the sign below cannot change what we sign,
     * because the sign (and the duplicate ECDSA / dual-run Schnorr construction)
     * consume THIS local. Re-reading the session field here would reintroduce the
     * exact TOCTOU finalize_and_sign.c defends against (it signs recheck_outer).
     * (codex P9 BLOCKER.) */
    uint8_t outer_hash_local[L4_FR_BYTES];
    memcpy(outer_hash_local, recomputed_outer, L4_FR_BYTES);
    explicit_bzero(recomputed_outer, sizeof(recomputed_outer));

    /* --- M10 Schnorr deploy authwit: sign the RAW outer_hash (no sha256),
     * Schnorr-over-Grumpkin. Mirrors finalize_and_sign.c's authwit Schnorr branch.
     * Signs the just-built local (== recomputed_outer, proven equal at the outer-
     * hash compare above). The ECDSA-K sha256+ECDSA block below is byte-untouched
     * (curve_id != GRUMPKIN). Fault model is the authwit one: the sign helper dual-
     * runs the construction; the scalar/nonce derivation is single-pass but fail-
     * safe (a glitch yields an on-chain-invalid sig, never a spend break) and
     * cross-checked by the pre-sign Phase-6 recompute (this scalar→address ==
     * the reviewed address_local). */
    if (G_l4_deploy_session.curve_id == L4_CURVE_ID_GRUMPKIN) {
        uint8_t sch_priv[32], sch_px[32], sch_py[32], sch_k[32];
        if (az_derive_schnorr_signing_scalar(G_l4_deploy_session.bip32_path,
                                             G_l4_deploy_session.bip32_path_len, sch_priv) != 0) {
            explicit_bzero(sch_priv, 32);
            explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
            return reject(SWO_UNKNOWN);
        }
        if (!schnorr_grumpkin_pubkey(sch_px, sch_py, sch_priv)) {
            explicit_bzero(sch_priv, 32);
            explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
            return reject(SWO_UNKNOWN);
        }
        if (az_derive_schnorr_nonce(sch_priv, sch_px, sch_py, L4_CURVE_ID_GRUMPKIN, outer_hash_local,
                                    sch_k) != 0) {
            explicit_bzero(sch_priv, 32);
            explicit_bzero(sch_k, 32);
            explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
            return reject(SWO_UNKNOWN);
        }
        uint8_t sch_sig[64];
        bool sok = schnorr_grumpkin_sign_with_nonce(sch_sig, sch_priv, sch_k, outer_hash_local);
        explicit_bzero(sch_priv, 32);
        explicit_bzero(sch_k, 32);
        explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
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

    uint8_t digest[32];
    size_t digest_len = cx_hash_sha256(outer_hash_local, L4_FR_BYTES, digest, sizeof(digest));
    if (digest_len != 32) {
        explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
        return reject(SWO_UNKNOWN);
    }

    uint8_t r[32], s[32];
    uint32_t info = 0;
    cx_err_t err = bip32_derive_ecdsa_sign_rs_hash_256(
        CX_CURVE_256K1,
        G_l4_deploy_session.bip32_path,
        G_l4_deploy_session.bip32_path_len,
        CX_RND_RFC6979,
        CX_SHA256,
        digest, sizeof(digest),
        r, s, &info);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s)) low_s_normalize(s);

    uint8_t r2[32], s2[32];
    uint32_t info2 = 0;
    err = bip32_derive_ecdsa_sign_rs_hash_256(
        CX_CURVE_256K1,
        G_l4_deploy_session.bip32_path,
        G_l4_deploy_session.bip32_path_len,
        CX_RND_RFC6979,
        CX_SHA256,
        digest, sizeof(digest),
        r2, s2, &info2);
    if (err != CX_OK) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
        return reject(SWO_UNKNOWN);
    }
    if (s_is_high(s2)) low_s_normalize(s2);

    if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) {
        explicit_bzero(r, sizeof(r));
        explicit_bzero(s, sizeof(s));
        explicit_bzero(r2, sizeof(r2));
        explicit_bzero(s2, sizeof(s2));
        explicit_bzero(outer_hash_local, sizeof(outer_hash_local));
        return reject(SW_DUP_SIG_MISMATCH);
    }

    uint8_t response[ECDSA_K1_SIG_LEN];
    memcpy(response, r, 32);
    memcpy(response + 32, s, 32);

    explicit_bzero(r, sizeof(r));
    explicit_bzero(s, sizeof(s));
    explicit_bzero(r2, sizeof(r2));
    explicit_bzero(s2, sizeof(s2));
    explicit_bzero(outer_hash_local, sizeof(outer_hash_local));

    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    l4_session_reset();
    /* M6.11 regression guard — ship the dismissal from commit zero. */
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main);
    return rc;
}

int finalize_deploy_rejected(void) {
    l4_session_reset();
    int rc = io_send_sw(SW_USER_REJECTED);
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    return rc;
}
