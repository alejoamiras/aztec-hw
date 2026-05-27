/**
 * INS_BEGIN_DEPLOY_ACCOUNT — parse, validate, profile-allowlist,
 * recompute partial_address chain (poseidon2 + Noir-ABI [u8;32] flatten),
 * trigger on-device review UI.
 *
 * Codex audit MAJOR #1: BEGIN commits ALL deploy semantics. FINALIZE adds
 * only `claimed_outer_hash`. The synthesized canonical-call list (init
 * payload + sponsor payload) is fully determined by the BEGIN inputs +
 * manifest-pinned profile — no extra host degrees of freedom at FINALIZE.
 *
 * Trust model (codex audit BLOCKER #2 corrected): v0 binds signing-key/
 * path + manifest-pinned class id + 3-pass fault recompute. It does NOT
 * cryptographically defend against host-supplied protocol-key spoofing
 * (publicKeys / ivpk_m). See plan.md §8.1 and the v0 device UI which
 * accompanies the address with the BIP-32 path so the user can spot
 * path mis-selection (the cheaper attack).
 */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "buffer.h"
#include "crypto_helpers.h"

#include "begin_deploy_account.h"
#include "../constants.h"
#include "../sw.h"
#include "../l4/fr_canonical.h"
#include "../l4/session.h"
#include "../l4/wire.h"
#include "../l4/deploy_address.h"
#include "../clear_signing_v0/deploy_profiles.gen.h"
#include "../ui/display.h"

/* Bail-out helper: clear BOTH session structs and return the given SW. */
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

/* Derive the secp256k1 signing pubkey (X, Y) from the BIP-32 path
 * stored in G_l4_deploy_session. Mirrors the get_public_key.c flow,
 * but writes the raw uncompressed (X, Y) directly into out_x/out_y.
 * Returns 0 on success. */
static int derive_signing_pubkey_xy(uint8_t out_x[32], uint8_t out_y[32]) {
    uint8_t raw[65]; /* 0x04 || X(32) || Y(32) */
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_get_pubkey_256(
        CX_CURVE_256K1,
        G_l4_deploy_session.bip32_path,
        G_l4_deploy_session.bip32_path_len,
        raw,
        chain_code,
        CX_SHA512);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK) {
        explicit_bzero(raw, sizeof(raw));
        return -1;
    }
    if (raw[0] != 0x04) {
        explicit_bzero(raw, sizeof(raw));
        return -1;
    }
    memcpy(out_x, &raw[1], 32);
    memcpy(out_y, &raw[33], 32);
    explicit_bzero(raw, sizeof(raw));
    return 0;
}

int handler_begin_deploy_account(buffer_t *cdata) {
    /* Mutual-exclusion with the AUTHWIT path. The session_reset call
     * inside reject() clears BOTH structs, so we don't need to be
     * defensive here. We allow re-issue only from L4_IDLE — running a
     * second BEGIN_DEPLOY mid-flight is a state-machine violation. */
    if (G_l4_session.state != L4_IDLE) {
        return reject(SW_DEPLOY_CONTEXT_WRONG_STATE);
    }
    /* Reset both: deploy session is the one we'll populate, but the
     * AUTHWIT struct must be zero too in case of a recovered residue. */
    l4_session_reset();

    uint8_t manifest_version;
    if (!buffer_read_u8(cdata, &manifest_version)) return reject(SWO_WRONG_DATA_LENGTH);
    if (manifest_version != L4_MANIFEST_VERSION) return reject(SW_UNKNOWN_MANIFEST_VERSION);

    uint8_t profile_id;
    if (!buffer_read_u8(cdata, &profile_id)) return reject(SWO_WRONG_DATA_LENGTH);
    const cs_deploy_profile_t *profile = cs_deploy_profile_lookup(profile_id);
    if (profile == NULL) return reject(SW_UNKNOWN_PROFILE_ID);

    uint8_t curve_id;
    if (!buffer_read_u8(cdata, &curve_id)) return reject(SWO_WRONG_DATA_LENGTH);
    if (curve_id != L4_CURVE_ID_K1) return reject(SW_INVALID_CURVE_ID);

    uint8_t path_scheme;
    if (!buffer_read_u8(cdata, &path_scheme)) return reject(SWO_WRONG_DATA_LENGTH);
    if (path_scheme != L4_PATH_SCHEME_DEFAULT) return reject(SW_INVALID_PATH_SCHEME);

    uint8_t path_len;
    if (!buffer_read_u8(cdata, &path_len)) return reject(SWO_WRONG_DATA_LENGTH);
    if (path_len < L4_MIN_BIP32_PATH) return reject(SW_INVALID_PATH_SCHEME);
    if (path_len > MAX_BIP32_PATH_LEN) return reject(SW_BIP32_TOO_LONG);

    if (!buffer_read_bip32_path(cdata, G_l4_deploy_session.bip32_path, path_len)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    /* Path canonicality — same as AUTHWIT path. */
    if (G_l4_deploy_session.bip32_path[0] != (0x80000000u | 44u)) {
        return reject(SW_INVALID_PATH_SCHEME);
    }
    if (G_l4_deploy_session.bip32_path[1] != AZTEC_COIN_TYPE_HARDENED) {
        return reject(SW_INVALID_PATH_SCHEME);
    }

    /* Fr-canonical fields, fixed order: chain_id, protocol_version,
     * tx_nonce, salt, public_keys_hash, expected_address. */
    if (!buffer_read_bytes(cdata, G_l4_deploy_session.chain_id, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.chain_id)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.protocol_version, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.protocol_version)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.tx_nonce, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.tx_nonce)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.salt, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.salt)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.public_keys_hash, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.public_keys_hash)) return reject(SW_HASH_MISMATCH);

    if (!buffer_read_bytes(cdata, G_l4_deploy_session.expected_address, L4_FR_BYTES)) {
        return reject(SWO_WRONG_DATA_LENGTH);
    }
    if (!l4_fr_is_canonical(G_l4_deploy_session.expected_address)) return reject(SW_HASH_MISMATCH);

    /* Reject trailing bytes (host framing bugs / malicious padding). */
    if (cdata->size != cdata->offset) return reject(SWO_WRONG_DATA_LENGTH);

    G_l4_deploy_session.manifest_version = manifest_version;
    G_l4_deploy_session.profile_id = profile_id;
    G_l4_deploy_session.curve_id = curve_id;
    G_l4_deploy_session.path_scheme = path_scheme;
    G_l4_deploy_session.bip32_path_len = path_len;

    /* --- Parity pass 1: derive pubkey + compute partial address ----- */
    uint8_t signing_pubkey_x[32];
    uint8_t signing_pubkey_y[32];
    if (derive_signing_pubkey_xy(signing_pubkey_x, signing_pubkey_y) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        return reject(SWO_UNKNOWN);
    }

    uint8_t args_hash_pass1[32];
    uint8_t init_hash_pass1[32];
    uint8_t partial_pass1[32];
    if (az_deploy_compute_partial_address(
            signing_pubkey_x,
            signing_pubkey_y,
            profile->ctor_selector_u32,
            G_l4_deploy_session.salt,
            profile->deployer,
            profile->account_class_id,
            args_hash_pass1,
            init_hash_pass1,
            partial_pass1) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        explicit_bzero(args_hash_pass1, 32);
        explicit_bzero(init_hash_pass1, 32);
        explicit_bzero(partial_pass1, 32);
        return reject(SWO_UNKNOWN);
    }

    /* --- Parity pass 2: independent recompute, fault detection ------ */
    uint8_t args_hash_pass2[32];
    uint8_t init_hash_pass2[32];
    uint8_t partial_pass2[32];
    if (az_deploy_compute_partial_address(
            signing_pubkey_x,
            signing_pubkey_y,
            profile->ctor_selector_u32,
            G_l4_deploy_session.salt,
            profile->deployer,
            profile->account_class_id,
            args_hash_pass2,
            init_hash_pass2,
            partial_pass2) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        explicit_bzero(args_hash_pass1, 32);
        explicit_bzero(init_hash_pass1, 32);
        explicit_bzero(partial_pass1, 32);
        explicit_bzero(args_hash_pass2, 32);
        explicit_bzero(init_hash_pass2, 32);
        explicit_bzero(partial_pass2, 32);
        return reject(SWO_UNKNOWN);
    }

    /* Pubkey buffers consumed — zero before going further. */
    explicit_bzero(signing_pubkey_x, 32);
    explicit_bzero(signing_pubkey_y, 32);

    if (ct_memcmp32(args_hash_pass1, args_hash_pass2) != 0 ||
        ct_memcmp32(init_hash_pass1, init_hash_pass2) != 0 ||
        ct_memcmp32(partial_pass1, partial_pass2) != 0) {
        explicit_bzero(args_hash_pass1, 32);
        explicit_bzero(args_hash_pass2, 32);
        explicit_bzero(init_hash_pass1, 32);
        explicit_bzero(partial_pass1, 32);
        explicit_bzero(init_hash_pass2, 32);
        explicit_bzero(partial_pass2, 32);
        return reject(SW_HASH_MISMATCH);
    }

    /* Stash the verified-by-double-recompute values for FINALIZE's outer_hash
     * binding (P4 wires this) and the third parity pass. */
    memcpy(G_l4_deploy_session.args_hash_local, args_hash_pass1, 32);
    memcpy(G_l4_deploy_session.init_hash_local, init_hash_pass1, 32);
    memcpy(G_l4_deploy_session.partial_address_local, partial_pass1, 32);
    explicit_bzero(args_hash_pass1, 32);
    explicit_bzero(args_hash_pass2, 32);
    explicit_bzero(init_hash_pass1, 32);
    explicit_bzero(init_hash_pass2, 32);
    explicit_bzero(partial_pass1, 32);
    explicit_bzero(partial_pass2, 32);

    /* L4_DEPLOY_CONTEXT lives on the shared l4_state_e machine. */
    G_l4_session.state = L4_DEPLOY_CONTEXT;

    /* SUCCESS — the host will stream FINALIZE_DEPLOY_AND_SIGN next,
     * which then triggers the on-device review UI. (Same flow shape
     * as BEGIN_AUTHWIT → APPEND_CALL × N → FINALIZE_AND_SIGN.) */
    return io_send_sw(SWO_SUCCESS);
}
