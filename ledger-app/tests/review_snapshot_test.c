/**
 * Firmware-native (host-compiled) unit test for the AHW-095 review snapshot.
 *
 * The blind-sign handler does: snap = review_snapshot_verify_blind_sign(live...);
 * if (snap == NULL) -> io_send_sw(SW_REVIEW_STATE_MISMATCH). Speculos cannot
 * inject a mid-review RAM mutation, so we prove the reject DECISION here: the
 * compare-back returns NULL on ANY divergence (hash, path, length, or disarmed),
 * and the snapshot pointer (signed FROM) only on an exact match.
 *
 * Build + run:
 *   cc -I src tests/review_snapshot_test.c src/review_snapshot.c -o /tmp/rs_test && /tmp/rs_test
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "../src/review_snapshot.h"

int main(void) {
    /* canonical-ish path m/44'/AZTEC'/0'/0/0 + a fixed outer_hash */
    uint32_t path[5] = {0x8000002cu, 0x80000a55u, 0x80000000u, 0u, 0u};
    uint8_t oh[AZTEC_OUTER_HASH_LEN];
    memset(oh, 0x42, sizeof(oh));

    /* not armed initially -> verify must reject */
    review_snapshot_disarm();
    assert(review_snapshot_verify_blind_sign(path, 5, oh) == NULL);

    /* capture, then an EXACT match returns the snapshot (the value we sign FROM) */
    review_snapshot_capture_blind_sign(path, 5, oh);
    const blind_sign_snapshot_t *ok = review_snapshot_verify_blind_sign(path, 5, oh);
    assert(ok != NULL);
    assert(memcmp(ok->outer_hash, oh, AZTEC_OUTER_HASH_LEN) == 0);
    assert(ok->bip32_path_len == 5);

    /* a mutated outer_hash (the classic post-review-clobber) -> reject (NULL) */
    uint8_t oh_bad[AZTEC_OUTER_HASH_LEN];
    memcpy(oh_bad, oh, sizeof(oh_bad));
    oh_bad[0] ^= 0x01;
    assert(review_snapshot_verify_blind_sign(path, 5, oh_bad) == NULL);
    /* last byte too (not just a prefix check) */
    memcpy(oh_bad, oh, sizeof(oh_bad));
    oh_bad[AZTEC_OUTER_HASH_LEN - 1] ^= 0x80;
    assert(review_snapshot_verify_blind_sign(path, 5, oh_bad) == NULL);

    /* a mutated path component -> reject */
    uint32_t path_bad[5];
    memcpy(path_bad, path, sizeof(path_bad));
    path_bad[2] = 0x80000001u; /* different account index */
    assert(review_snapshot_verify_blind_sign(path_bad, 5, oh) == NULL);

    /* a different path length -> reject */
    assert(review_snapshot_verify_blind_sign(path, 4, oh) == NULL);

    /* still armed: an exact match still verifies (verify is non-destructive) */
    assert(review_snapshot_verify_blind_sign(path, 5, oh) != NULL);

    /* disarm (single-use, as the handler does after copying) -> reject thereafter */
    review_snapshot_disarm();
    assert(review_snapshot_verify_blind_sign(path, 5, oh) == NULL);

    printf("AHW-095 review_snapshot reject-branch: ALL ASSERTS PASS "
           "(verify->NULL on hash/path/len mismatch + disarmed; handler maps NULL -> SW_REVIEW_STATE_MISMATCH)\n");
    return 0;
}
