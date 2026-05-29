/**
 * M8 Phase 6 — full account derivation from the master secret. See header.
 */
#include "account_derive.h"

#include <string.h>

#include "os.h"
#include "cx.h"

#include "account_keys.h"
#include "aztec_secret.h"
#include "../crypto/grumpkin/fq.h"
#include "../crypto/grumpkin/mul_generator.h"

/* Aztec DomainSeparator values for sha512ToGrumpkinScalar (constants.gen.ts:
 * 517-520). npk<-NHK_M, ivpk<-IVSK_M, ovpk<-OVSK_M, tpk<-TSK_M; address uses
 * ivpk (derivation.ts:50-61). */
#define KEYGEN_NHK_M  242137788u
#define KEYGEN_IVSK_M 2747825907u
#define KEYGEN_OVSK_M 4272201051u
#define KEYGEN_TSK_M  1546190975u

/* Derive one viewing pubkey: scalar = sha512ToGrumpkinScalar([sk, domsep]) =
 * gk_fq_from_bytes_wide_be(SHA-512(sk || uint32BE(domsep))); out = [scalar]G.
 * Returns 0 on success, -1 on infinity (zero scalar). Wipes all secret temps. */
static int derive_viewing_pubkey(const uint8_t sk[32], uint32_t domsep, az_affine_t *out) {
    uint8_t input[32 + 4];
    memcpy(input, sk, 32);
    input[32] = (uint8_t)(domsep >> 24);
    input[33] = (uint8_t)(domsep >> 16);
    input[34] = (uint8_t)(domsep >> 8);
    input[35] = (uint8_t)domsep;

    uint8_t digest[64];
    if (cx_hash_sha512(input, sizeof(input), digest, sizeof(digest)) != 64) {
        explicit_bzero(input, sizeof(input));
        explicit_bzero(digest, sizeof(digest));
        return -1;
    }
    explicit_bzero(input, sizeof(input));

    gk_fq_t scalar;
    gk_fq_from_bytes_wide_be(&scalar, digest);
    explicit_bzero(digest, sizeof(digest));

    uint8_t scalar_be[32];
    gk_fq_to_bytes_be(scalar_be, &scalar);
    explicit_bzero(&scalar, sizeof(scalar));

    int ok = grumpkin_scalar_mul_generator(out->x, out->y, scalar_be);
    explicit_bzero(scalar_be, sizeof(scalar_be));
    return ok ? 0 : -1; /* infinity (zero-derived key) -> fault */
}

int az_account_derive_from_secret(const uint8_t sk[32], const uint8_t partial_address[32],
                                  uint8_t out_pkh[32], uint8_t out_addr[32]) {
    az_affine_t npk, ivpk, ovpk, tpk;
    if (derive_viewing_pubkey(sk, KEYGEN_NHK_M, &npk) != 0) return -1;
    if (derive_viewing_pubkey(sk, KEYGEN_IVSK_M, &ivpk) != 0) return -1;
    if (derive_viewing_pubkey(sk, KEYGEN_OVSK_M, &ovpk) != 0) return -1;
    if (derive_viewing_pubkey(sk, KEYGEN_TSK_M, &tpk) != 0) return -1;

    int rc = az_account_public_keys_hash(&npk, &ivpk, &ovpk, &tpk, out_pkh);
    if (rc != 0) return rc;
    /* address uses the master incoming-viewing pubkey (ivpk). */
    return az_account_address(out_pkh, partial_address, &ivpk, out_addr);
}

int az_account_derive_from_path(const uint32_t *bip32_path, size_t bip32_path_len,
                                const uint8_t partial_address[32], uint8_t out_pkh[32],
                                uint8_t out_addr[32]) {
    /* Each call re-derives sk from the seed so independent recompute passes
     * cover the BIP-32/SHA-512/reduce step too (codex Phase-6c review MAJOR:
     * never share an sk buffer across passes). */
    uint8_t sk[32];
    if (az_derive_master_secret(bip32_path, bip32_path_len, sk) != 0) {
        explicit_bzero(sk, sizeof(sk));
        return -1;
    }
    int rc = az_account_derive_from_secret(sk, partial_address, out_pkh, out_addr);
    explicit_bzero(sk, sizeof(sk));
    return rc;
}
