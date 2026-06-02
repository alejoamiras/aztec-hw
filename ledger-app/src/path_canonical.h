/**
 * Canonical Aztec BIP-32 path check — single source of truth (AHW-064).
 *
 * The dangerous key-using surfaces (raw-hash blind sign + pubkey exports) used to
 * accept ANY 1..10-component path while the L4 handlers enforced the full canonical
 * shape. This unifies the check so every handler that derives a key validates the
 * SAME path: m/44'/AZTEC_COIN_TYPE'/account'/0/0.
 *
 * NB: Ledger's OS-enforced PATH_APP_LOAD_PARAMS already bounds derivation to the
 * app's coin scope (no cross-app key theft); this is defense-in-depth on top.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/** True iff `path` (length `len`) is exactly m/44'/AZTEC_COIN_TYPE'/account'/0/0:
 * len == 5, components 0 and 1 are the fixed hardened 44' / coin-type, component 2
 * (account) is hardened, and the last two (change / index) are 0. */
bool az_bip32_path_is_canonical(const uint32_t *path, uint8_t len);
