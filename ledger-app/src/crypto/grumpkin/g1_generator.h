/**
 * Grumpkin generator point G, stored as 32-byte big-endian affine coordinates
 * in the BASE field (= poseidon2 fr_t = BN254 scalar field).
 *
 *   G.x = 1
 *   G.y = 17631683881184975370165255887551781615748388533673675138860
 *
 * Source: aztec-packages/yarn-project/constants/src/constants.gen.ts:495-496
 * (GRUMPKIN_ONE_X / GRUMPKIN_ONE_Y), cross-checks barretenberg
 * ecc/curves/grumpkin/grumpkin.hpp one_x/one_y. Verified on-curve over Fr
 * (y² = x³ − 17) by `/tmp/grumpkin-field-check.ts` during Phase 3.
 */
#pragma once

#include <stdint.h>

extern const uint8_t GRUMPKIN_G_X_BE[32];
extern const uint8_t GRUMPKIN_G_Y_BE[32];
