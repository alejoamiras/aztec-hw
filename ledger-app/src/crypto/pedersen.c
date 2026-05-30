/**
 * Aztec/barretenberg Pedersen-3 hash (M10 P3). See pedersen.h.
 *
 * Generators are PLAIN affine Grumpkin coordinates (BE), lifted verbatim from
 * aztec-packages `barretenberg/.../ecc/groups/precomputed_generators_grumpkin_impl.hpp`
 * and confirmed byte-identical to `@aztec/foundation` `crypto/pedersen.noble.ts`
 * (which builds points via `new ProjectivePoint(x,y,1n)` — i.e. plain, not
 * Montgomery). The host-parity test against foundation `pedersenHash` is the
 * integrity gate on these constants (a wrong/backdoored generator diverges on
 * vector #1). Provenance: the constants are identical in both sources above.
 */
#include "pedersen.h"

#include <string.h>

#include "grumpkin/mul_generator.h"
#include "grumpkin/point.h"
#include "poseidon2/fr.h"

/* "pedersen_hash_length" generator. */
static const char GEN_LEN_X[] = "2df8b940e5890e4e1377e05373fae69a1d754f6935e6a780b666947431f2cdcd";
static const char GEN_LEN_Y[] = "2ecd88d15967bc53b885912e0d16866154acb6aac2d3f85e27ca7eefb2c19083";
/* "DEFAULT_DOMAIN_SEPARATOR" generators, indices 0..2. */
static const char GEN0_X[] = "083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5a";
static const char GEN0_Y[] = "1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935d";
static const char GEN1_X[] = "054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402";
static const char GEN1_Y[] = "209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126";
static const char GEN2_X[] = "1c44f2a5207c81c28a8321a5815ce8b1311024bbed131819bbdaf5a2ada84748";
static const char GEN2_Y[] = "03aaee36e6422a1d0191632ac6599ae9eba5ac2c17a8c920aa3caf8b89c5f8a8";

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Parse a 64-char hex literal into 32 BE bytes. Returns false on malformed. */
static bool hex32(const char *h, uint8_t out[32]) {
    if (strlen(h) != 64) return false;
    for (int i = 0; i < 32; i++) {
        int hi = hex_nibble(h[2 * i]);
        int lo = hex_nibble(h[2 * i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

static bool is_zero32(const uint8_t v[32]) {
    uint8_t acc = 0;
    for (int i = 0; i < 32; i++) acc |= v[i];
    return acc == 0;
}

/* acc += [scalar]·(gen_x_hex, gen_y_hex), where scalar is a canonical Fr (BE).
 * Skips when scalar == 0 (the term is the identity), matching noble. */
static bool accumulate_term(grumpkin_point_t *acc, const uint8_t scalar[32], const char *gen_x_hex,
                            const char *gen_y_hex) {
    if (is_zero32(scalar)) return true;
    uint8_t gx[32], gy[32];
    if (!hex32(gen_x_hex, gx) || !hex32(gen_y_hex, gy)) return false;
    uint8_t tx[32], ty[32];
    if (!grumpkin_scalar_mul_affine(tx, ty, scalar, gx, gy)) return false;
    fr_t fx, fy;
    if (!fr_from_bytes_be(&fx, tx) || !fr_from_bytes_be(&fy, ty)) return false;
    grumpkin_point_add_affine(acc, acc, &fx, &fy);
    return true;
}

bool pedersen_hash3(uint8_t out_x[32], const uint8_t v0[32], const uint8_t v1[32],
                    const uint8_t v2[32]) {
    /* Enforce the canonical-Fr input invariant (codex): reject non-canonical. */
    fr_t chk;
    if (!fr_from_bytes_be(&chk, v0) || !fr_from_bytes_be(&chk, v1) ||
        !fr_from_bytes_be(&chk, v2)) {
        return false;
    }

    grumpkin_point_t acc;
    grumpkin_point_set_infinity(&acc);

    /* Length term: [inputs.size()==3]·g_len (always present). */
    uint8_t three[32];
    memset(three, 0, sizeof(three));
    three[31] = 3;
    if (!accumulate_term(&acc, three, GEN_LEN_X, GEN_LEN_Y)) return false;

    /* Input terms (skip zeros, per noble). */
    if (!accumulate_term(&acc, v0, GEN0_X, GEN0_Y)) return false;
    if (!accumulate_term(&acc, v1, GEN1_X, GEN1_Y)) return false;
    if (!accumulate_term(&acc, v2, GEN2_X, GEN2_Y)) return false;

    uint8_t out_y[32];
    bool ok = grumpkin_point_to_affine_be(out_x, out_y, &acc);
    grumpkin_secure_wipe(out_y, sizeof(out_y));
    return ok;
}
