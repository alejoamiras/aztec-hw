#include "review_snapshot.h"

#include <string.h>

/* Out-of-band: NOT a field of global_ctx_t, so a mid-review GET_PUBLIC_KEY (which
 * overwrites the pk_info/sign_info union + bip32_path) cannot corrupt it. */
static blind_sign_snapshot_t g_blind_snapshot;

void review_snapshot_capture_blind_sign(const uint32_t *path, uint8_t path_len,
                                        const uint8_t outer_hash[AZTEC_OUTER_HASH_LEN]) {
    memset(&g_blind_snapshot, 0, sizeof(g_blind_snapshot));
    if (path_len > MAX_BIP32_PATH_LEN) {
        return; /* leaves armed=false → verify fails closed */
    }
    g_blind_snapshot.bip32_path_len = path_len;
    for (uint8_t i = 0; i < path_len; i++) {
        g_blind_snapshot.bip32_path[i] = path[i];
    }
    memcpy(g_blind_snapshot.outer_hash, outer_hash, AZTEC_OUTER_HASH_LEN);
    g_blind_snapshot.armed = true;
}

const blind_sign_snapshot_t *review_snapshot_verify_blind_sign(
    const uint32_t *live_path, uint8_t live_path_len,
    const uint8_t live_outer_hash[AZTEC_OUTER_HASH_LEN]) {
    if (!g_blind_snapshot.armed) {
        return NULL;
    }
    if (live_path_len != g_blind_snapshot.bip32_path_len) {
        return NULL;
    }
    uint32_t pdiff = 0;
    for (uint8_t i = 0; i < g_blind_snapshot.bip32_path_len; i++) {
        pdiff |= live_path[i] ^ g_blind_snapshot.bip32_path[i];
    }
    uint8_t hdiff = 0;
    for (uint8_t i = 0; i < AZTEC_OUTER_HASH_LEN; i++) {
        hdiff |= (uint8_t)(live_outer_hash[i] ^ g_blind_snapshot.outer_hash[i]);
    }
    if (pdiff != 0 || hdiff != 0) {
        return NULL;
    }
    return &g_blind_snapshot;
}

void review_snapshot_disarm(void) {
    memset(&g_blind_snapshot, 0, sizeof(g_blind_snapshot));
}
