/**
 * Blake2s-256 (RFC 7693), unkeyed, single-shot. Little-endian word loads +
 * digest store, per the spec. Used for the Aztec Schnorr challenge only.
 */
#include "blake2s.h"

#include <string.h>

static const uint32_t BLAKE2S_IV[8] = {
    0x6A09E667UL, 0xBB67AE85UL, 0x3C6EF372UL, 0xA54FF53AUL,
    0x510E527FUL, 0x9B05688CUL, 0x1F83D9ABUL, 0x5BE0CD19UL,
};

static const uint8_t BLAKE2S_SIGMA[10][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
};

static uint32_t rotr32(uint32_t x, unsigned n) {
    return (x >> n) | (x << (32 - n));
}

static uint32_t load32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void store32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

/* Blake2s mixing G with rotation constants 16/12/8/7. */
#define G(r, i, a, b, c, d)                          \
    do {                                             \
        a = a + b + m[BLAKE2S_SIGMA[r][2 * i + 0]];  \
        d = rotr32(d ^ a, 16);                        \
        c = c + d;                                    \
        b = rotr32(b ^ c, 12);                        \
        a = a + b + m[BLAKE2S_SIGMA[r][2 * i + 1]];  \
        d = rotr32(d ^ a, 8);                         \
        c = c + d;                                    \
        b = rotr32(b ^ c, 7);                         \
    } while (0)

static void blake2s_compress(uint32_t h[8], const uint8_t block[64], uint32_t t_lo, uint32_t t_hi,
                             int last) {
    uint32_t m[16];
    uint32_t v[16];
    for (int i = 0; i < 16; i++) m[i] = load32le(block + 4 * i);
    for (int i = 0; i < 8; i++) v[i] = h[i];
    for (int i = 0; i < 8; i++) v[8 + i] = BLAKE2S_IV[i];
    v[12] ^= t_lo;
    v[13] ^= t_hi;
    if (last) v[14] ^= 0xFFFFFFFFUL;
    for (int r = 0; r < 10; r++) {
        G(r, 0, v[0], v[4], v[8], v[12]);
        G(r, 1, v[1], v[5], v[9], v[13]);
        G(r, 2, v[2], v[6], v[10], v[14]);
        G(r, 3, v[3], v[7], v[11], v[15]);
        G(r, 4, v[0], v[5], v[10], v[15]);
        G(r, 5, v[1], v[6], v[11], v[12]);
        G(r, 6, v[2], v[7], v[8], v[13]);
        G(r, 7, v[3], v[4], v[9], v[14]);
    }
    for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[8 + i];
}

void blake2s256(uint8_t out[32], const uint8_t *in, size_t inlen) {
    uint32_t h[8];
    for (int i = 0; i < 8; i++) h[i] = BLAKE2S_IV[i];
    /* Param block word 0: digest_len(32) | key_len(0)<<8 | fanout(1)<<16 | depth(1)<<24. */
    h[0] ^= 0x01010020UL;

    uint64_t counter = 0;
    const uint8_t *p = in;
    size_t remaining = inlen;

    /* All but the last block: full, non-final. */
    while (remaining > 64) {
        counter += 64;
        blake2s_compress(h, p, (uint32_t)counter, (uint32_t)(counter >> 32), 0);
        p += 64;
        remaining -= 64;
    }
    /* Final block: copy <=64 bytes into a zero-padded buffer. Handles inlen==0. */
    uint8_t block[64];
    memset(block, 0, sizeof(block));
    if (remaining > 0) memcpy(block, p, remaining);
    counter += remaining;
    blake2s_compress(h, block, (uint32_t)counter, (uint32_t)(counter >> 32), 1);

    for (int i = 0; i < 8; i++) store32le(out + 4 * i, h[i]);
}
