/**
 * INS_GET_AZTEC_ADDRESS (AHW-098, W4) — derive + attest the Aztec account address.
 *
 * Minimal request body (NO manifest_version — see the header): profile_id(u8),
 * curve_id(u8), path_scheme(u8), path_len(u8), path(path_len×u32 BE), salt(32 BE).
 * Validations mirror the deploy parse (profile allowlist, exact curve↔profile
 * pairing, canonical m/44'/AZTEC'/<acct>'/0/0 path, canonical salt) MINUS the
 * host-claimed pkh/expected_address — there is no host claim here, the device
 * AUTHORS the address. Two independent derivation passes + compare (a glitched
 * address would send funds to the wrong account), then an approval-gated review,
 * then return the 32-byte address FROM the out-of-band snapshot.
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"

#include "get_aztec_address.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/wire.h"
#include "../l4/account_derive.h"
#include "../l4/account_binding.h"
#include "../clear_signing_v0/deploy_profiles.gen.h"
#include "../review_snapshot.h"
#include "../ui/display.h"
#include "nbgl_use_case.h"

#define AZ_ADDR_LEN 32

/* Cached after derivation, returned after approval. Public values (address + its
 * account index + scheme); armed/single-use so a stale approval can't re-attest. */
static bool s_armed;
static uint8_t s_addr[AZ_ADDR_LEN];
static uint32_t s_account_index;
static uint8_t s_curve_id;

static void disarm(void) {
    s_armed = false;
    memset(s_addr, 0, sizeof(s_addr));
    s_account_index = 0;
    s_curve_id = 0;
}

const uint8_t *aztec_address_bytes(void) {
    return s_addr;
}
uint32_t aztec_address_account_index(void) {
    return s_account_index;
}
uint8_t aztec_address_curve_id(void) {
    return s_curve_id;
}

static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

/* Parse + validate the minimal request body. Returns SWO_SUCCESS or an error SW. */
static uint16_t parse_and_validate(buffer_t *cdata, uint32_t out_path[MAX_BIP32_PATH_LEN],
                                   uint8_t *out_path_len, uint8_t out_salt[32],
                                   uint8_t *out_curve_id, const cs_deploy_profile_t **out_profile) {
    uint8_t profile_id;
    if (!buffer_read_u8(cdata, &profile_id)) return SWO_WRONG_DATA_LENGTH;
    const cs_deploy_profile_t *profile = cs_deploy_profile_lookup(profile_id);
    if (profile == NULL) return SW_UNKNOWN_PROFILE_ID;

    uint8_t curve_id;
    if (!buffer_read_u8(cdata, &curve_id)) return SWO_WRONG_DATA_LENGTH;
    /* Enforce the EXACT (curve_id, profile) pairing — same fail-closed rule as deploy. */
    if (curve_id == L4_CURVE_ID_K1) {
        if (profile->arg_schema != CS_DEPLOY_ARG_SCHEMA_ECDSA_K_PUBKEY_XY) return SW_INVALID_CURVE_ID;
    } else if (curve_id == L4_CURVE_ID_GRUMPKIN) {
        if (profile->arg_schema != CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY) return SW_INVALID_CURVE_ID;
    } else {
        return SW_INVALID_CURVE_ID;
    }

    uint8_t path_scheme;
    if (!buffer_read_u8(cdata, &path_scheme)) return SWO_WRONG_DATA_LENGTH;
    if (path_scheme != L4_PATH_SCHEME_DEFAULT) return SW_INVALID_PATH_SCHEME;

    uint8_t path_len;
    if (!buffer_read_u8(cdata, &path_len)) return SWO_WRONG_DATA_LENGTH;
    if (path_len < L4_MIN_BIP32_PATH) return SW_INVALID_PATH_SCHEME;
    if (path_len > MAX_BIP32_PATH_LEN) return SW_BIP32_TOO_LONG;
    if (!buffer_read_bip32_path(cdata, out_path, path_len)) return SWO_WRONG_DATA_LENGTH;

    /* Canonical account/receive path m/44'/AZTEC'/<acct>'/0/0 — the same shape deploy
     * + the "Account #N" display assume; a non-canonical path could show a misleading #N. */
    if (out_path[0] != (0x80000000u | 44u)) return SW_INVALID_PATH_SCHEME;
    if (out_path[1] != AZTEC_COIN_TYPE_HARDENED) return SW_INVALID_PATH_SCHEME;
    if (path_len != 5u || (out_path[2] & 0x80000000u) == 0u || out_path[3] != 0u ||
        out_path[4] != 0u) {
        return SW_INVALID_PATH_SCHEME;
    }

    if (!buffer_read_bytes(cdata, out_salt, L4_FR_BYTES)) return SWO_WRONG_DATA_LENGTH;
    if (!l4_fr_is_canonical(out_salt)) return SW_HASH_MISMATCH;

    if (cdata->size != cdata->offset) return SWO_WRONG_DATA_LENGTH; /* no trailing bytes */

    *out_path_len = path_len;
    *out_curve_id = curve_id;
    *out_profile = profile;
    return SWO_SUCCESS;
}

/* Derive the account address: pubkey → partial → (pkh, address). 0 on success.
 * Mirrors the deploy chain (account_binding_* + az_account_derive_from_path). */
static int derive_address(uint8_t curve_id, const cs_deploy_profile_t *profile,
                          const uint32_t *path, uint8_t path_len, const uint8_t salt[32],
                          uint8_t out_addr[32]) {
    uint8_t px[32], py[32];
    if (account_binding_deploy_pubkey_xy(curve_id, path, path_len, px, py) != 0) {
        explicit_bzero(px, 32);
        explicit_bzero(py, 32);
        return -1;
    }
    uint8_t args_hash[32], init_hash[32], partial[32];
    int prc = account_binding_deploy_partial(profile, px, py, salt, args_hash, init_hash, partial);
    explicit_bzero(px, 32);
    explicit_bzero(py, 32);
    explicit_bzero(args_hash, 32);
    explicit_bzero(init_hash, 32);
    if (prc != 0) {
        explicit_bzero(partial, 32);
        return -1;
    }
    uint8_t pkh[32];
    int arc = az_account_derive_from_path(path, path_len, partial, pkh, out_addr);
    explicit_bzero(partial, 32);
    explicit_bzero(pkh, 32);
    return (arc != 0) ? -1 : 0;
}

int handler_get_aztec_address(buffer_t *cdata) {
    disarm();

    uint32_t path[MAX_BIP32_PATH_LEN];
    uint8_t path_len = 0;
    uint8_t salt[32];
    uint8_t curve_id = 0;
    const cs_deploy_profile_t *profile = NULL;
    uint16_t prc = parse_and_validate(cdata, path, &path_len, salt, &curve_id, &profile);
    if (prc != SWO_SUCCESS) {
        explicit_bzero(salt, sizeof(salt));
        return io_send_sw(prc);
    }

    /* Two FULLY-INDEPENDENT derivation passes + compare (fault hardening): a glitched
     * address shown to the user sends funds to the wrong account, so hold the deploy's
     * bar (az_account_derive_from_path re-derives sk each pass). */
    uint8_t addr1[32], addr2[32];
    if (derive_address(curve_id, profile, path, path_len, salt, addr1) != 0 ||
        derive_address(curve_id, profile, path, path_len, salt, addr2) != 0) {
        explicit_bzero(salt, sizeof(salt));
        explicit_bzero(addr1, 32);
        explicit_bzero(addr2, 32);
        return io_send_sw(SWO_UNKNOWN);
    }
    explicit_bzero(salt, sizeof(salt));
    if (ct_memcmp32(addr1, addr2) != 0) {
        explicit_bzero(addr1, 32);
        explicit_bzero(addr2, 32);
        return io_send_sw(SW_HASH_MISMATCH); /* internal fault, not a host disagreement */
    }

    memcpy(s_addr, addr1, AZ_ADDR_LEN);
    explicit_bzero(addr1, 32);
    explicit_bzero(addr2, 32);
    s_account_index = path[2] & 0x7FFFFFFFu;
    s_curve_id = curve_id;
    s_armed = true;

    return ui_display_aztec_address_review();
}

int aztec_address_review_approved(void) {
    if (!s_armed) {
        return io_send_sw(SWO_UNKNOWN);
    }
    /* Return the address FROM the out-of-band snapshot captured at review-draw time:
     * bind the attested address to exactly what was SHOWN. A render→approval glitch to
     * the displayed #N/address is a clean reject, never a silent attest of a different
     * address (a fresh AHW-095-class sink otherwise). */
    const review_identity_snapshot_t *snap = review_snapshot_verify_identity(s_account_index, s_addr);
    if (snap == NULL) {
        review_snapshot_disarm_identity();
        disarm();
        int mrc = io_send_sw(SW_REVIEW_STATE_MISMATCH);
        nbgl_useCaseStatus("Review state changed", false, ui_menu_main);
        return mrc;
    }
    uint8_t response[AZ_ADDR_LEN];
    memcpy(response, snap->address, AZ_ADDR_LEN);
    review_snapshot_disarm_identity();
    disarm();
    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    /* An address attestation is NOT a transaction (AHW-022-style) — custom status so
     * the user can't misremember it as a signed tx. */
    nbgl_useCaseStatus("Address confirmed", true, ui_menu_main);
    return rc;
}

int aztec_address_review_rejected(void) {
    review_snapshot_disarm_identity();
    disarm();
    int rc = io_send_sw(SW_USER_REJECTED);
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    return rc;
}
