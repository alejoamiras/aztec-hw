#include "path_canonical.h"

#include "constants.h"

bool az_bip32_path_is_canonical(const uint32_t *path, uint8_t len) {
    return len == 5u && path[0] == (0x80000000u | 44u) && path[1] == AZTEC_COIN_TYPE_HARDENED &&
           (path[2] & 0x80000000u) != 0u && path[3] == 0u && path[4] == 0u;
}
