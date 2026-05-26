/**
 * Poseidon2 round constants + Montgomery parameters for BN254 Fr.
 *
 * Generated from aztec-packages commit 2770bcb82d40323060c2f9c71aaf293b640efbef.
 * Audit pin (per barretenberg AUDIT STATUS comment):
 *   dd03c4a23ab067274b4964cacb36d1545f73fb14
 *
 * DO NOT EDIT. Regenerate via:
 *   bun run packages/adapter-ledger/scripts/gen-poseidon2-constants.ts
 */
#pragma once

#include "fr.h"
#include "poseidon2.h"

#define AZ_POSEIDON2_ROUNDS_F_HALF 4
#define AZ_POSEIDON2_ROUNDS_P_COUNT 56

/* Leading full rounds (4 rounds, 4 lanes each, Montgomery form). */
extern const fr_t AZ_POSEIDON2_RC_LEADING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T];

/* Partial rounds (56 rounds, lane 0 only — other lanes are zero by construction). */
extern const fr_t AZ_POSEIDON2_RC_PARTIAL[AZ_POSEIDON2_ROUNDS_P_COUNT];

/* Trailing full rounds (4 rounds, 4 lanes each, Montgomery form). */
extern const fr_t AZ_POSEIDON2_RC_TRAILING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T];

/* internal_matrix_diagonal_minus_one (4 lanes, Montgomery form). */
extern const fr_t AZ_POSEIDON2_DIAG_MINUS_ONE[AZ_POSEIDON2_T];

/* Raw-permutation parity vectors (Montgomery form). Smoke test from
 * poseidon2_params.hpp:447-458, bypasses sponge. */
extern const fr_t AZ_POSEIDON2_TEST_INPUT[AZ_POSEIDON2_T];
extern const fr_t AZ_POSEIDON2_TEST_OUTPUT[AZ_POSEIDON2_T];
