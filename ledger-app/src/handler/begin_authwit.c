/**
 * BEGIN_AUTHWIT — parse and validate the manifest header, start a new session.
 *
 * Validation order matters: cheap rejects first, then path canonicality, then
 * Fr canonicality. Any rejection zeroes G_l4_session (deep plan §2 recovery).
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"

#include "begin_authwit.h"
#include "../constants.h"
#include "../path_canonical.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"

/* Bail-out helper: clear the session and return the given SW. */
static int reject(uint16_t sw) {
    l4_session_reset();
    return io_send_sw(sw);
}

int handler_begin_authwit(buffer_t *cdata) {
    l4_session_reset();

    uint8_t manifest_version;
    if (!buffer_read_u8(cdata, &manifest_version)) return reject(SWO_WRONG_DATA_LENGTH);
    if (manifest_version != L4_MANIFEST_VERSION) return reject(SW_UNKNOWN_MANIFEST_VERSION);

    uint8_t curve_id;
    if (!buffer_read_u8(cdata, &curve_id)) return reject(SWO_WRONG_DATA_LENGTH);
    /* M10: accept ECDSA-K (K1) OR Schnorr (GRUMPKIN). FINALIZE dispatches the
     * signing primitive + the B3 account recompute on this curve_id. Without
     * this the Schnorr authwit was rejected here before the finalize branch
     * (codex post-impl BLOCKER). */
    if (curve_id != L4_CURVE_ID_K1 && curve_id != L4_CURVE_ID_GRUMPKIN) {
        return reject(SW_INVALID_CURVE_ID);
    }

    uint8_t path_scheme;
    if (!buffer_read_u8(cdata, &path_scheme)) return reject(SWO_WRONG_DATA_LENGTH);
    if (path_scheme != L4_PATH_SCHEME_DEFAULT) return reject(SW_INVALID_PATH_SCHEME);

    uint8_t path_len;
    if (!buffer_read_u8(cdata, &path_len)) return reject(SWO_WRONG_DATA_LENGTH);
    if (path_len < L4_MIN_BIP32_PATH) return reject(SW_INVALID_PATH_SCHEME);
    if (path_len > MAX_BIP32_PATH_LEN) return reject(SW_BIP32_TOO_LONG);

    if (!buffer_read_bip32_path(cdata, G_l4_session.bip32_path, path_len)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    /* M9 B3: the authwit drives the device-VERIFIED `From` (FINALIZE recomputes this
     * account's address from the path and cross-checks it against `consumer`), so the
     * full canonical shape m/44'/AZTEC'/<acct>'/0/0 is required. AHW-064: this is now
     * the SHARED check, identical to the one the blind-sign + pubkey surfaces use. */
    if (!az_bip32_path_is_canonical(G_l4_session.bip32_path, path_len)) {
        return reject(SW_INVALID_PATH_SCHEME);
    }

    /* AHW-018 (wire v3): host-selected account template + salt. The allowlist pins
     * authwit to the audited (curve, profile) pairs (codex High); B3 at FINALIZE
     * re-derives the address for (path, profile, salt) + THIS device's keys and binds
     * `consumer` to it (derive-don't-trust). */
    uint8_t profile_id;
    if (!buffer_read_u8(cdata, &profile_id)) return reject(SWO_WRONG_DATA_LENGTH);
    if (!l4_authwit_curve_profile_allowed(curve_id, profile_id)) {
        return reject(SW_UNKNOWN_PROFILE_ID);
    }

    if (!buffer_read_bytes(cdata, G_l4_session.salt, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_session.salt)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_session.consumer, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_session.consumer)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_session.chain_id, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_session.chain_id)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_session.protocol_version, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_session.protocol_version)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_session.tx_nonce, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_session.tx_nonce)) return reject(SW_HASH_MISMATCH);

    uint8_t call_count;
    if (!buffer_read_u8(cdata, &call_count)) return reject(SWO_WRONG_DATA_LENGTH);
    if (call_count > L4_MAX_CALLS) return reject(SWO_WRONG_DATA_LENGTH);

    /* Reject trailing bytes — host framing bugs / malicious padding. */
    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);

    G_l4_session.manifest_version = manifest_version;
    G_l4_session.curve_id = curve_id;
    G_l4_session.profile_id = profile_id;
    G_l4_session.path_scheme = path_scheme;
    G_l4_session.bip32_path_len = path_len;
    G_l4_session.call_count = call_count;
    G_l4_session.calls_received = 0;
    G_l4_session.state = (call_count == 0) ? L4_CALLS_COMPLETE : L4_HEADER_PARSED;

    return io_send_sw(SWO_SUCCESS);
}
