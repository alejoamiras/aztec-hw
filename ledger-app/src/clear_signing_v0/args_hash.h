/**
 * On-device args_hash recompute for clear-signing v0.
 *
 * Mirrors `yarn-project/stdlib/src/hash/hash.ts`:
 *   - PUBLIC: poseidon2HashWithSeparator([selector_as_Fr, ...args], PUBLIC_CALLDATA=2760353947)
 *   - PRIVATE empty: Fr.ZERO short-circuit (matches computeVarArgsHash)
 *   - PRIVATE non-empty: poseidon2HashWithSeparator(args, FUNCTION_ARGS=3576554347)
 *
 * Used by the APPEND_CALL parity gate (closes the trusted-session hole codex
 * M5 final-review MAJOR #4 flagged) and by parity.c's three-pass finalize
 * re-derivation.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "../l4/wire.h"

/* Domain separator from constants.gen.ts:FUNCTION_ARGS. */
#define CS_SEP_FUNCTION_ARGS 3576554347u

/**
 * Recompute args_hash from selector + raw args + visibility.
 *
 * @param selector       32 BE bytes (canonical Fr; high 28 must be zero — caller already enforced)
 * @param args           array of args_count × 32 BE bytes
 * @param args_count     0..L4_MAX_ARGS
 * @param is_public      true → public path (selector prepended); false → private path (FUNCTION_ARGS, no selector)
 * @param out_args_hash  32 BE bytes
 *
 * @return 0 on success, -1 on Fr canonicality error in selector or args.
 */
int cs_compute_args_hash(const uint8_t selector[L4_FR_BYTES],
                         const uint8_t (*args)[L4_FR_BYTES],
                         uint8_t args_count,
                         bool is_public,
                         uint8_t out_args_hash[L4_FR_BYTES]);
