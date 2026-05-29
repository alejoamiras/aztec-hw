/**
 * Aztec master-secret derivation (shared). See aztec_secret.h.
 */
#include "aztec_secret.h"

#include <string.h>

#include "os.h"
#include "cx.h"
#include "crypto_helpers.h"

#include "../crypto/poseidon2/fr.h"

/* "aztec-master-secret-v1" (22 chars) + trailing NUL in a [23] array = the
 * 23-byte DOMAIN the host mirrors (master-secret.ts). */
static const uint8_t MASTER_SECRET_DOMAIN[23] = "aztec-master-secret-v1";

int az_derive_master_secret(const uint32_t *bip32_path, size_t bip32_path_len, uint8_t out_sk[32]) {
    cx_ecfp_256_private_key_t privkey;
    uint8_t chain_code[32];
    cx_err_t err = bip32_derive_init_privkey_256(CX_CURVE_256K1,
                                                 bip32_path,
                                                 bip32_path_len,
                                                 &privkey,
                                                 chain_code);
    explicit_bzero(chain_code, sizeof(chain_code));
    if (err != CX_OK || privkey.d_len != 32) {
        explicit_bzero(&privkey, sizeof(privkey));
        return -1;
    }

    /* input = DOMAIN(23) || privkey_d(32) = 55 bytes. */
    uint8_t input[23 + 32];
    memcpy(input, MASTER_SECRET_DOMAIN, 23);
    memcpy(input + 23, privkey.d, 32);
    explicit_bzero(&privkey, sizeof(privkey));

    uint8_t digest[64];
    if (cx_hash_sha512(input, sizeof(input), digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input));

    fr_t reduced;
    fr_from_bytes_wide_be(&reduced, digest);
    explicit_bzero(digest, sizeof(digest));
    fr_to_bytes_be(out_sk, &reduced);
    explicit_bzero(&reduced, sizeof(reduced));
    return 0;
}
