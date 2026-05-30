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
 * Trust model (M8 P6 — privacy-sovereignty gap CLOSED): in addition to the
 * signing-key/path binding + manifest-pinned class id + 3-pass partial-address
 * fault recompute, the device now DERIVES its own viewing keys from its seed,
 * computes publicKeysHash + address, and REJECTS if the host-supplied
 * public_keys_hash / expected_address disagree (SW_DEPLOY_PUBKEY_HASH_MISMATCH /
 * SW_DEPLOY_ADDRESS_MISMATCH). A hostile host can no longer get the device to
 * sign a deploy carrying host-controlled protocol keys. (The old M7 v0 note
 * that this was NOT defended is superseded.) See lessons/phase-6.md.
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
#include "../l4/account_derive.h"
#include "../l4/aztec_secret.h"
#include "../crypto/schnorr.h"
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

/* M10 — scheme-dispatched signing-pubkey derivation for the deploy. K1 uses the
 * secp256k1 child pubkey (derive_signing_pubkey_xy above); GRUMPKIN derives the
 * Schnorr signing scalar from the SAME path (child priv mod Fq, NEVER the master
 * secret) and returns its Grumpkin pubkey P = [priv]G. Mirrors the authwit B3
 * derivation in finalize_and_sign.c. */
static int deploy_derive_pubkey_xy(uint8_t out_x[32], uint8_t out_y[32]) {
    if (G_l4_deploy_session.curve_id == L4_CURVE_ID_GRUMPKIN) {
        uint8_t priv[32];
        if (az_derive_schnorr_signing_scalar(G_l4_deploy_session.bip32_path,
                                             G_l4_deploy_session.bip32_path_len, priv) != 0) {
            explicit_bzero(priv, 32);
            return -1;
        }
        bool ok = schnorr_grumpkin_pubkey(out_x, out_y, priv);
        explicit_bzero(priv, 32);
        return ok ? 0 : -1;
    }
    return derive_signing_pubkey_xy(out_x, out_y);
}

/* M10 — scheme-dispatched partial-address. Both branches share the init/salted/
 * partial chain (profile-pinned selector/deployer/class_id + session salt); only
 * the ctor args_hash differs (64 byte-frs for ECDSA-K vs 2 Frs for Schnorr).
 * Selected by the profile's arg_schema, which BEGIN already paired to curve_id. */
static int deploy_compute_partial(const uint8_t pubkey_x[32], const uint8_t pubkey_y[32],
                                  const cs_deploy_profile_t *profile, uint8_t out_args_hash[32],
                                  uint8_t out_init_hash[32], uint8_t out_partial_address[32]) {
    if (profile->arg_schema == CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY) {
        return az_schnorr_compute_partial_address(
            pubkey_x, pubkey_y, profile->ctor_selector_u32, G_l4_deploy_session.salt,
            profile->deployer, profile->account_class_id, out_args_hash, out_init_hash,
            out_partial_address);
    }
    return az_deploy_compute_partial_address(pubkey_x, pubkey_y, profile->ctor_selector_u32,
                                             G_l4_deploy_session.salt, profile->deployer,
                                             profile->account_class_id, out_args_hash, out_init_hash,
                                             out_partial_address);
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
    /* M10: scheme lives on curve_id, deploy template on profile_id. Accept ECDSA-K
     * (K1) OR Schnorr (GRUMPKIN), and enforce the EXACT (curve_id, profile) pairing
     * so a host can't pair a K1 curve with a Schnorr template or vice-versa (codex
     * deploy advice — fail-closed against scheme/template confusion). */
    if (curve_id == L4_CURVE_ID_K1) {
        if (profile->arg_schema != CS_DEPLOY_ARG_SCHEMA_ECDSA_K_PUBKEY_XY) {
            return reject(SW_INVALID_CURVE_ID);
        }
    } else if (curve_id == L4_CURVE_ID_GRUMPKIN) {
        if (profile->arg_schema != CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY) {
            return reject(SW_INVALID_CURVE_ID);
        }
    } else {
        return reject(SW_INVALID_CURVE_ID);
    }

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
    /* M9 (codex MAJOR): the deploy UI shows "Account #N" by masking path[2], so
     * enforce the FULL canonical shape m/44'/AZTEC'/<acct>'/0/0 — else a host
     * could pass a non-canonical path and the device would show a misleading #N. */
    /* NB: use the LOCAL `path_len` — G_l4_deploy_session.bip32_path_len is not
     * assigned until after the Fr reads below (~line 175), so reading the field
     * here saw 0 and rejected every canonical deploy with 0x6F03. The path
     * COMPONENTS were already written into the session array by
     * buffer_read_bip32_path above, so [2]/[3]/[4] are valid here. */
    if (path_len != 5u || (G_l4_deploy_session.bip32_path[2] & 0x80000000u) == 0u ||
        G_l4_deploy_session.bip32_path[3] != 0u || G_l4_deploy_session.bip32_path[4] != 0u) {
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
    if (deploy_derive_pubkey_xy(signing_pubkey_x, signing_pubkey_y) != 0) {
        explicit_bzero(signing_pubkey_x, 32);
        explicit_bzero(signing_pubkey_y, 32);
        return reject(SWO_UNKNOWN);
    }

    uint8_t args_hash_pass1[32];
    uint8_t init_hash_pass1[32];
    uint8_t partial_pass1[32];
    if (deploy_compute_partial(signing_pubkey_x, signing_pubkey_y, profile, args_hash_pass1,
                               init_hash_pass1, partial_pass1) != 0) {
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
    if (deploy_compute_partial(signing_pubkey_x, signing_pubkey_y, profile, args_hash_pass2,
                               init_hash_pass2, partial_pass2) != 0) {
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

    /* --- M8 P6: device-derived publicKeysHash + address verification --------
     * Derive the account's viewing keys from THIS device's seed and verify the
     * host's claimed public_keys_hash + expected_address against them. This is
     * the privacy-sovereignty gate: the host can no longer deploy an account
     * with host-controlled viewing keys and have the device sign it.
     *
     * Two FULLY-INDEPENDENT passes (self-consistency vs fault injection), THEN
     * host equality. Per codex P6 design: the host controls both claimed values,
     * so "device == host" alone is not glitch-proof -- the self-consistency
     * check across independent passes is the integrity anchor. Each pass
     * re-derives sk from the seed (codex Phase-6c review MAJOR: az_account_-
     * derive_from_path never shares an sk buffer, so a fault in the BIP-32/
     * SHA-512/reduce step can't poison both passes identically). FINALIZE
     * re-derives a third time before signing. Cache only PUBLIC outputs; sk +
     * viewing scalars are wiped inside each pass and never persist. */
    uint8_t pkh_pass1[32], addr_pass1[32];
    uint8_t pkh_pass2[32], addr_pass2[32];
    if (az_account_derive_from_path(G_l4_deploy_session.bip32_path,
                                    G_l4_deploy_session.bip32_path_len,
                                    G_l4_deploy_session.partial_address_local,
                                    pkh_pass1, addr_pass1) != 0 ||
        az_account_derive_from_path(G_l4_deploy_session.bip32_path,
                                    G_l4_deploy_session.bip32_path_len,
                                    G_l4_deploy_session.partial_address_local,
                                    pkh_pass2, addr_pass2) != 0) {
        explicit_bzero(pkh_pass1, 32);
        explicit_bzero(addr_pass1, 32);
        explicit_bzero(pkh_pass2, 32);
        explicit_bzero(addr_pass2, 32);
        return reject(SWO_UNKNOWN);
    }

    /* Self-consistency (fault) -- an internal pass1/pass2 mismatch is NOT a
     * host disagreement, so it returns the generic fault SW (codex P6 trap). */
    if (ct_memcmp32(pkh_pass1, pkh_pass2) != 0 || ct_memcmp32(addr_pass1, addr_pass2) != 0) {
        explicit_bzero(pkh_pass1, 32);
        explicit_bzero(addr_pass1, 32);
        explicit_bzero(pkh_pass2, 32);
        explicit_bzero(addr_pass2, 32);
        return reject(SW_HASH_MISMATCH);
    }
    explicit_bzero(pkh_pass2, 32);
    explicit_bzero(addr_pass2, 32);

    /* Host equality -- the sovereignty gate. */
    if (ct_memcmp32(pkh_pass1, G_l4_deploy_session.public_keys_hash) != 0) {
        explicit_bzero(pkh_pass1, 32);
        explicit_bzero(addr_pass1, 32);
        return reject(SW_DEPLOY_PUBKEY_HASH_MISMATCH);
    }
    if (ct_memcmp32(addr_pass1, G_l4_deploy_session.expected_address) != 0) {
        explicit_bzero(pkh_pass1, 32);
        explicit_bzero(addr_pass1, 32);
        return reject(SW_DEPLOY_ADDRESS_MISMATCH);
    }

    /* Cache device-authored public values for FINALIZE's recompute + the UI.
     * (pkh/addr are public; the bzero is tidy discipline, not a secrecy need.) */
    memcpy(G_l4_deploy_session.public_keys_hash_local, pkh_pass1, 32);
    memcpy(G_l4_deploy_session.address_local, addr_pass1, 32);
    explicit_bzero(pkh_pass1, 32);
    explicit_bzero(addr_pass1, 32);

    /* L4_DEPLOY_CONTEXT lives on the shared l4_state_e machine. */
    G_l4_session.state = L4_DEPLOY_CONTEXT;

    /* SUCCESS — the host will stream FINALIZE_DEPLOY_AND_SIGN next,
     * which then triggers the on-device review UI. (Same flow shape
     * as BEGIN_AUTHWIT → APPEND_CALL × N → FINALIZE_AND_SIGN.) */
    return io_send_sw(SWO_SUCCESS);
}
