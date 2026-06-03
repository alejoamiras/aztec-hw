/**
 * INS_GET_AZTEC_MASTER_SECRET (M8 P4).
 *
 * Derives the 32-byte Aztec master secret (an Fr) from the BIP-32 secp256k1
 * child PRIVATE key (hashing the PRIVATE key, not the pubkey, is what keeps the
 * reveal gate meaningful — GET_PUBLIC_KEY would otherwise leak the input and
 * let a host bypass this screen; see aztec_secret.c + codex P4 review):
 *
 *   secret = SHA-512(DOMAIN || privkey_d(32)) mod Fr   (55-byte preimage)
 *   DOMAIN = "aztec-master-secret-v1" + one NUL byte (23 bytes total)
 *
 * Fr is the BN254 scalar field (poseidon2 fr_t / AZ_FR_P, 0x...f0000001) --
 * the field Aztec deriveKeys(secretKey: Fr) consumes. The reduction is the
 * wide reduction fr_from_bytes_wide_be (host-parity-tested).
 *
 * This INS discloses note-VIEWING capability (the host re-derives the four
 * viewing keys via deriveKeys), NOT spend authority. It is gated behind a
 * high-friction NBGL reveal screen.
 *
 * Flow mirrors finalize_deploy_and_sign: derive + arm the secret, show the
 * reveal UI, return 0 (deferred). The UI confirm/reject callback emits the
 * response via master_secret_reveal_approved / _rejected.
 *
 * Fault hardening: the derivation runs TWICE and the two results are compared
 * (constant-time) before arming -- a single-fault glitch that corrupts the
 * derivation is caught (mirrors the duplicate-sign discipline in the sign
 * handlers).
 */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"
#include "nbgl_use_case.h"

#include "get_aztec_master_secret.h"
#include "../constants.h"
#include "../globals.h"
#include "../sw.h"
#include "../review_snapshot.h"
#include "../ui/display.h"
#include "../l4/wire.h"
#include "../l4/aztec_secret.h"

static const uint8_t CHECKSUM_TAG[19] = "aztec-vk-confirm-v1"; /* 19 chars, no NUL needed */

/* Armed across the deferred UI confirm. Secret material -- wiped on emit. */
static uint8_t s_secret[32];
static char s_checksum[5]; /* 4 hex + NUL */
static bool s_armed;

static const char HEXC[] = "0123456789abcdef";

/* Constant-time 32-byte compare. Returns 0 on equal. */
static int ct_memcmp32(const uint8_t a[32], const uint8_t b[32]) {
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff;
}

static void disarm(void) {
    explicit_bzero(s_secret, sizeof(s_secret));
    /* Checksum is non-secret (a SHA-256 prefix the host also computes), but
     * it's derived from the secret -- wipe it too for a consistent discipline
     * (codex Phase-4 review MINOR). The UI already copied it into its own
     * buffer before display, so wiping here doesn't blank the shown value. */
    explicit_bzero(s_checksum, sizeof(s_checksum));
    s_armed = false;
}

/* AHW-059: public entry so l4_session_reset() (a different TU) can fold this
 * module's secret into the device-wide reset invariant. Disarming on a reset path
 * is fail-safe: if it ever raced a shown reveal, the approve would emit a wiped
 * (zero) secret rather than leak. */
void master_secret_disarm(void) {
    disarm();
}

/* AHW-016 (accepted residual, v0/PoC): the secret derivation (SHA-512 + Montgomery
 * reduce + [k]G) has NO NVM attempt-counter / cooldown / rate ceiling. The ROOT
 * issue is the non-constant-time portable C (AHW-029, PLATFORM — deferred to the
 * Donjon/cx_ hardening pass); a rate-limit would only be a side-channel-amplification
 * MITIGATION. We deliberately do not add one in v0:
 *   - the reveal INS is HUMAN-GATED (every reveal needs a physical approval), so it
 *     cannot be spammed for fast re-derivation in the first place;
 *   - a derivation-rate cap on the un-gated surfaces (GET_PUBLIC_KEY / FINALIZE)
 *     would throttle legitimate host setup + every signature for marginal gain.
 * PRODUCTION mitigation if the constant-time deficiency is not first closed:
 * NVM-backed throttle on the reveal INS + a global derivation-rate ceiling. Tracked
 * in audit/index.md. */
static int derive_master_secret(uint8_t out32[32]) {
    return az_derive_master_secret(G_context.bip32_path, G_context.bip32_path_len, out32);
}

int handler_get_aztec_master_secret(buffer_t *cdata) {
    disarm();
    explicit_bzero(&G_context, sizeof(G_context));
    G_context.req_type = REQ_GET_PUBLIC_KEY; /* reuse the path-bearing context */

    if (!buffer_read_u8(cdata, &G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    /* Match the deploy/authwit path policy (codex Phase-4 review MINOR): require
     * the full canonical Aztec path length, not just the 2-element prefix. */
    if (G_context.bip32_path_len < L4_MIN_BIP32_PATH) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    if (G_context.bip32_path_len > MAX_BIP32_PATH_LEN) {
        return io_send_sw(SW_BIP32_TOO_LONG);
    }
    if (!buffer_read_bip32_path(cdata, G_context.bip32_path, G_context.bip32_path_len)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    if (cdata->size != cdata->offset) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    /* Canonical Aztec path prefix -- same gate as begin_deploy_account. */
    if (G_context.bip32_path[0] != (0x80000000u | 44u)) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    if (G_context.bip32_path[1] != AZTEC_COIN_TYPE_HARDENED) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }
    /* M9 (codex MAJOR): the reveal UI now shows "Account #N" by masking path[2],
     * so enforce the FULL canonical shape m/44'/AZTEC'/<acct>'/0/0 — otherwise a
     * host could pass a non-canonical path (e.g. unhardened account, or extra
     * components) and the device would show a misleading #N. */
    if (G_context.bip32_path_len != 5u || (G_context.bip32_path[2] & 0x80000000u) == 0u ||
        G_context.bip32_path[3] != 0u || G_context.bip32_path[4] != 0u) {
        return io_send_sw(SW_INVALID_PATH_SCHEME);
    }

    /* Derive twice + compare (fault hardening). */
    uint8_t pass1[32];
    uint8_t pass2[32];
    if (derive_master_secret(pass1) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        return io_send_sw(SWO_UNKNOWN);
    }
    if (derive_master_secret(pass2) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        explicit_bzero(pass2, sizeof(pass2));
        return io_send_sw(SWO_UNKNOWN);
    }
    if (ct_memcmp32(pass1, pass2) != 0) {
        explicit_bzero(pass1, sizeof(pass1));
        explicit_bzero(pass2, sizeof(pass2));
        return io_send_sw(SW_DUP_SIG_MISMATCH);
    }
    explicit_bzero(pass2, sizeof(pass2));

    /* Confirmation checksum: SHA-256(CHECKSUM_TAG || secret)[0..1] -> 4 hex. */
    uint8_t cinput[19 + 32];
    memcpy(cinput, CHECKSUM_TAG, 19);
    memcpy(cinput + 19, pass1, 32);
    uint8_t cdigest[32];
    if (cx_hash_sha256(cinput, sizeof(cinput), cdigest, sizeof(cdigest)) != 32) {
        explicit_bzero(cinput, sizeof(cinput));
        explicit_bzero(cdigest, sizeof(cdigest));
        explicit_bzero(pass1, sizeof(pass1));
        return io_send_sw(SWO_UNKNOWN);
    }
    explicit_bzero(cinput, sizeof(cinput));
    s_checksum[0] = HEXC[(cdigest[0] >> 4) & 0x0f];
    s_checksum[1] = HEXC[cdigest[0] & 0x0f];
    s_checksum[2] = HEXC[(cdigest[1] >> 4) & 0x0f];
    s_checksum[3] = HEXC[cdigest[1] & 0x0f];
    s_checksum[4] = '\0';
    /* cdigest is derived from the secret -- wipe (codex Phase-4 review MINOR). */
    explicit_bzero(cdigest, sizeof(cdigest));

    memcpy(s_secret, pass1, 32);
    explicit_bzero(pass1, sizeof(pass1));
    s_armed = true;

    return ui_display_master_secret_reveal();
}

int master_secret_reveal_approved(void) {
    if (!s_armed) {
        return io_send_sw(SWO_UNKNOWN);
    }
    /* AHW-112 (W1 sibling): verify the live account index matches what the reveal
     * screen showed before exporting the privacy root. A render→approval glitch to
     * bip32_path[2] becomes a clean reject, not a silent reveal of a DIFFERENT
     * account's root. (Reveal showed no address → NULL.) */
    uint32_t live_idx = (G_context.bip32_path_len > 2)
                            ? (G_context.bip32_path[2] & 0x7FFFFFFFu)
                            : 0;
    if (review_snapshot_verify_identity(live_idx, NULL) == NULL) {
        review_snapshot_disarm_identity();
        disarm();
        int mrc = io_send_sw(SW_REVIEW_STATE_MISMATCH);
        nbgl_useCaseStatus("Review state changed", false, ui_menu_main);
        return mrc;
    }
    review_snapshot_disarm_identity();
    uint8_t response[32];
    memcpy(response, s_secret, 32);
    disarm();
    int rc = io_send_response_pointer(response, sizeof(response), SWO_SUCCESS);
    explicit_bzero(response, sizeof(response));
    /* M6.11 regression guard -- dismiss the NBGL page after the reveal.
     * AHW-022: a reveal is NOT a transaction — use a custom status string via
     * nbgl_useCaseStatus instead of STATUS_TYPE_TRANSACTION_SIGNED, so the user
     * can't misremember a privacy-root export as a routine signed tx. */
    nbgl_useCaseStatus("Privacy root revealed", true, ui_menu_main);
    return rc;
}

int master_secret_reveal_rejected(void) {
    review_snapshot_disarm_identity();
    disarm();
    int rc = io_send_sw(SW_USER_REJECTED);
    nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_REJECTED, ui_menu_main);
    return rc;
}

const char *master_secret_checksum_str(void) {
    return s_checksum;
}
