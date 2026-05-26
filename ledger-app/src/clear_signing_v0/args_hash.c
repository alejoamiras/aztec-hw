#include <string.h>

#include "args_hash.h"
#include "../crypto/poseidon2/poseidon2.h"

int cs_compute_args_hash(const uint8_t selector[L4_FR_BYTES],
                         const uint8_t (*args)[L4_FR_BYTES],
                         uint8_t args_count,
                         bool is_public,
                         uint8_t out_args_hash[L4_FR_BYTES]) {
    if (args_count > L4_MAX_ARGS) return -1;

    if (!is_public && args_count == 0) {
        /* hash.ts:computeVarArgsHash empty-args short-circuit → Fr.ZERO. */
        memset(out_args_hash, 0, L4_FR_BYTES);
        return 0;
    }

    /* Build the payload into a stack buffer.
     *
     * Worst case: PUBLIC + L4_MAX_ARGS = 1 selector + 4 args = 5 × 32 = 160 B.
     * Stack budget is comfortable. */
    uint8_t payload[(1u + L4_MAX_ARGS) * L4_FR_BYTES];
    size_t offset = 0;
    uint32_t separator;

    if (is_public) {
        memcpy(payload + offset, selector, L4_FR_BYTES);
        offset += L4_FR_BYTES;
        separator = L4_SEP_PUBLIC_CALLDATA;
    } else {
        separator = CS_SEP_FUNCTION_ARGS;
    }

    for (uint8_t i = 0; i < args_count; i++) {
        memcpy(payload + offset, args[i], L4_FR_BYTES);
        offset += L4_FR_BYTES;
    }

    /* az_poseidon2_hash_with_separator returns 0 on success. The payload size is
     * `offset / L4_FR_BYTES`. */
    return az_poseidon2_hash_with_separator(payload, offset / L4_FR_BYTES, separator, out_args_hash);
}
