#pragma once

/**
 * M10 — SchnorrAccount deploy constants, computed from @aztec/accounts/schnorr
 * 4.2.1 (class_id = computeContractClassId; ctor selector =
 * FunctionSelector(constructor(Field,Field))). Pinned + parity-checked by
 * schnorr-partial-parity.test.ts. P6 codegen will fold these into
 * CS_DEPLOY_PROFILES[1]; this hand-written bridge unblocks the device B3 +
 * sign path. Salt + deployer are Fr.ZERO (demo default / universal deploy).
 */
#include <stdint.h>

#define SCHNORR_ACCOUNT_CTOR_SELECTOR_U32 0xcd9728afu

/* class_id = 0x1e86cb5f3581f982b9c2c2b8a45fc4d0dfdb93cdab87e6deee55ec69d7f19703 */
static const uint8_t SCHNORR_ACCOUNT_CLASS_ID_BE[32] = {
    0x1e, 0x86, 0xcb, 0x5f, 0x35, 0x81, 0xf9, 0x82, 0xb9, 0xc2, 0xc2,
    0xb8, 0xa4, 0x5f, 0xc4, 0xd0, 0xdf, 0xdb, 0x93, 0xcd, 0xab, 0x87,
    0xe6, 0xde, 0xee, 0x55, 0xec, 0x69, 0xd7, 0xf1, 0x97, 0x03,
};
