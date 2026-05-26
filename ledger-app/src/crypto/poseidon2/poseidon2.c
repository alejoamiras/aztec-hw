/**
 * Poseidon2 over BN254 Fr — implementation.
 *
 * Mirrors barretenberg's `poseidon2_permutation.hpp` and `sponge/sponge.hpp`,
 * using our local Montgomery 4×u64 Fr backend (`fr.h`) and pre-computed
 * round constants (`constants.h`).
 *
 * Algorithm pinned to aztec-packages commit
 * `2770bcb82d40323060c2f9c71aaf293b640efbef`; constants regenerated via
 * `packages/adapter-ledger/scripts/gen-poseidon2-constants.ts`.
 */
#include "poseidon2.h"
#include "poseidon2_internal.h"
#include "constants.h"
#include "fr.h"
#include "fr_params.h"

#include <stdint.h>
#include <string.h>

#define POSEIDON2_RATE 3
#define POSEIDON2_CAPACITY 1

/* External 4×4 MDS layer.
 *
 * Hardcoded multiplication by
 *   | 5 7 1 3 |
 *   | 4 6 1 1 |
 *   | 1 3 5 7 |
 *   | 1 1 4 6 |
 *
 * Sequence translated 1-to-1 from `poseidon2_permutation.hpp:45-76`. */
static void mds_external(fr_t state[AZ_POSEIDON2_T]) {
    fr_t t0, t1, t2, t3, t4, t5, t6, t7;

    fr_add(&t0, &state[0], &state[1]); /* A + B */
    fr_add(&t1, &state[2], &state[3]); /* C + D */

    fr_add(&t2, &state[1], &state[1]); /* 2B */
    fr_add(&t2, &t2, &t1);             /* 2B + C + D */

    fr_add(&t3, &state[3], &state[3]); /* 2D */
    fr_add(&t3, &t3, &t0);             /* 2D + A + B */

    fr_add(&t4, &t1, &t1);
    fr_add(&t4, &t4, &t4);
    fr_add(&t4, &t4, &t3); /* A + B + 4C + 6D */

    fr_add(&t5, &t0, &t0);
    fr_add(&t5, &t5, &t5);
    fr_add(&t5, &t5, &t2); /* 4A + 6B + C + D */

    fr_add(&t6, &t3, &t5); /* 5A + 7B + C + 3D */
    fr_add(&t7, &t2, &t4); /* A + 3B + 5C + 7D */

    fr_set(&state[0], &t6);
    fr_set(&state[1], &t5);
    fr_set(&state[2], &t7);
    fr_set(&state[3], &t4);
}

/* Internal-round linear layer.
 *
 *   result[i] = (D_i - 1) * state[i] + sum_j state[j]
 *
 * Equivalent to multiplication by the internal matrix; we store
 * `D_i - 1` to elide one addition per lane. */
static void mds_internal(fr_t state[AZ_POSEIDON2_T]) {
    fr_t sum;
    fr_set(&sum, &state[0]);
    for (int i = 1; i < AZ_POSEIDON2_T; i++) {
        fr_add(&sum, &sum, &state[i]);
    }
    for (int i = 0; i < AZ_POSEIDON2_T; i++) {
        fr_mul(&state[i], &state[i], &AZ_POSEIDON2_DIAG_MINUS_ONE[i]);
        fr_add(&state[i], &state[i], &sum);
    }
}

/* x -> x^5, computed as x · (x²)² (3 squarings + 1 mul, but the spec uses
 * sqr+sqr+mul = 2 sqrs + 1 mul for x^4 then x · x^4). */
static void apply_single_sbox(fr_t *x) {
    fr_t x2, x4;
    fr_sqr(&x2, x);
    fr_sqr(&x4, &x2);
    fr_mul(x, &x4, x);
}

static void apply_sbox_full(fr_t state[AZ_POSEIDON2_T]) {
    for (int i = 0; i < AZ_POSEIDON2_T; i++) {
        apply_single_sbox(&state[i]);
    }
}

static void add_round_constants_full(fr_t state[AZ_POSEIDON2_T], const fr_t rc[AZ_POSEIDON2_T]) {
    for (int i = 0; i < AZ_POSEIDON2_T; i++) {
        fr_add(&state[i], &state[i], &rc[i]);
    }
}

void az_poseidon2_permutation_inplace(fr_t state[AZ_POSEIDON2_T]) {
    /* Initial linear layer. */
    mds_external(state);

    /* 4 leading full rounds. */
    for (int i = 0; i < AZ_POSEIDON2_ROUNDS_F_HALF; i++) {
        add_round_constants_full(state, AZ_POSEIDON2_RC_LEADING[i]);
        apply_sbox_full(state);
        mds_external(state);
    }

    /* 56 partial rounds (only state[0] gets sbox + rc). */
    for (int i = 0; i < AZ_POSEIDON2_ROUNDS_P_COUNT; i++) {
        fr_add(&state[0], &state[0], &AZ_POSEIDON2_RC_PARTIAL[i]);
        apply_single_sbox(&state[0]);
        mds_internal(state);
    }

    /* 4 trailing full rounds. */
    for (int i = 0; i < AZ_POSEIDON2_ROUNDS_F_HALF; i++) {
        add_round_constants_full(state, AZ_POSEIDON2_RC_TRAILING[i]);
        apply_sbox_full(state);
        mds_external(state);
    }
}

/* --- Sponge ------------------------------------------------------------- */

static void duplex(az_poseidon2_sponge_t *s) {
    for (int i = 0; i < POSEIDON2_RATE; i++) {
        fr_add(&s->state[i], &s->state[i], &s->cache[i]);
    }
    az_poseidon2_permutation_inplace(s->state);
    for (int i = 0; i < POSEIDON2_RATE; i++) {
        fr_zero(&s->cache[i]);
    }
}

static void absorb_internal(az_poseidon2_sponge_t *s, const fr_t *x) {
    if (s->cache_size == POSEIDON2_RATE) {
        duplex(s);
        fr_set(&s->cache[0], x);
        s->cache_size = 1;
    } else {
        fr_set(&s->cache[s->cache_size], x);
        s->cache_size++;
    }
}

void az_poseidon2_sponge_init(az_poseidon2_sponge_t *s, uint64_t input_count) {
    for (int i = 0; i < AZ_POSEIDON2_T; i++) fr_zero(&s->state[i]);
    for (int i = 0; i < POSEIDON2_RATE; i++) fr_zero(&s->cache[i]);
    s->cache_size = 0;

    /* IV = input_count << 64. In limb terms (little-endian): limb[1] = input_count. */
    fr_t iv_normal = {{ 0, input_count, 0, 0 }};
    fr_mul(&s->state[AZ_POSEIDON2_T - 1], &iv_normal, &AZ_FR_R2);
}

int az_poseidon2_sponge_absorb_bytes(az_poseidon2_sponge_t *s, const uint8_t bytes[AZ_FR_BYTE_LEN]) {
    fr_t x;
    if (!fr_from_bytes_be(&x, bytes)) {
        return -1;
    }
    absorb_internal(s, &x);
    return 0;
}

void az_poseidon2_sponge_absorb_u64(az_poseidon2_sponge_t *s, uint64_t v) {
    fr_t x;
    fr_from_u64(&x, v);
    absorb_internal(s, &x);
}

void az_poseidon2_sponge_squeeze(az_poseidon2_sponge_t *s, uint8_t out[AZ_FR_BYTE_LEN]) {
    duplex(s);
    fr_to_bytes_be(out, &s->state[0]);
}

/* --- Public API --------------------------------------------------------- */

int az_poseidon2_hash(const uint8_t *fields, size_t count, uint8_t out[AZ_FR_BYTES]) {
    az_poseidon2_sponge_t s;
    az_poseidon2_sponge_init(&s, (uint64_t)count);
    for (size_t i = 0; i < count; i++) {
        if (az_poseidon2_sponge_absorb_bytes(&s, &fields[i * AZ_FR_BYTE_LEN]) != 0) {
            return -1;
        }
    }
    az_poseidon2_sponge_squeeze(&s, out);
    return 0;
}

int az_poseidon2_hash_with_separator(const uint8_t *fields,
                                     size_t count,
                                     uint32_t separator,
                                     uint8_t out[AZ_FR_BYTES]) {
    az_poseidon2_sponge_t s;
    /* Separator is prepended as the FIRST field, so the IV-encoded length is
     * `count + 1`. Matches `poseidon2HashWithSeparator` in
     * `yarn-project/foundation/src/crypto/poseidon/index.ts`. */
    az_poseidon2_sponge_init(&s, (uint64_t)count + 1ULL);
    az_poseidon2_sponge_absorb_u64(&s, (uint64_t)separator);
    for (size_t i = 0; i < count; i++) {
        if (az_poseidon2_sponge_absorb_bytes(&s, &fields[i * AZ_FR_BYTE_LEN]) != 0) {
            return -1;
        }
    }
    az_poseidon2_sponge_squeeze(&s, out);
    return 0;
}
