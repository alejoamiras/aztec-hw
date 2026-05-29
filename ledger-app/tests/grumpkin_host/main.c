/**
 * Host CLI for the Grumpkin scalar-mult implementation under test. Compiles
 * against the SAME .c files that ship in the Ledger app (the poseidon2 fr_t
 * coordinate field + the grumpkin/ EC sources), with no BOLOS dependency.
 *
 * Modes:
 *   mul <hex32> [<hex32> ...]   — for each scalar k, print [k]·G as two lines:
 *                                  affine x (64 hex), then affine y (64 hex).
 *                                  k ≡ 0 prints two all-zero lines (infinity).
 *   smoke                        — built-in self-checks; prints "smoke OK".
 *
 * Each scalar is exactly 64 hex chars (32 bytes BE), optional "0x" prefix.
 * Exit codes: 0 = OK, 1 = bad usage, 2 = invalid input, 3 = smoke failure.
 */
#include "../../src/crypto/grumpkin/fq.h"
#include "../../src/crypto/grumpkin/g1_generator.h"
#include "../../src/crypto/grumpkin/mul_generator.h"
#include "../../src/crypto/grumpkin/point.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int parse_hex32(const char *hex, uint8_t out[32]) {
  if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
  if (strlen(hex) != 64) return -1;
  for (int i = 0; i < 32; i++) {
    int hi = hex_nibble(hex[i * 2]);
    int lo = hex_nibble(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return 0;
}

static void print_hex32(const uint8_t bytes[32]) {
  for (int i = 0; i < 32; i++) printf("%02x", bytes[i]);
  putchar('\n');
}

static int mode_mul(int argc, char **argv) {
  if (argc < 1) {
    fprintf(stderr, "mul needs >= 1 hex32 scalar\n");
    return 2;
  }
  for (int i = 0; i < argc; i++) {
    uint8_t k[32];
    if (parse_hex32(argv[i], k) != 0) {
      fprintf(stderr, "bad hex32 scalar at index %d\n", i);
      return 2;
    }
    uint8_t x[32], y[32];
    grumpkin_scalar_mul_generator(x, y, k);
    print_hex32(x);
    print_hex32(y);
  }
  return 0;
}

static int mode_smoke(void) {
  /* [1]·G must equal G. */
  uint8_t one[32] = {0};
  one[31] = 1;
  uint8_t x[32], y[32];
  if (!grumpkin_scalar_mul_generator(x, y, one)) {
    fprintf(stderr, "smoke: [1]G returned infinity\n");
    return 3;
  }
  if (memcmp(x, GRUMPKIN_G_X_BE, 32) != 0 || memcmp(y, GRUMPKIN_G_Y_BE, 32) != 0) {
    fprintf(stderr, "smoke: [1]G != G\n");
    return 3;
  }

  /* [2]·G must be a finite on-curve point. */
  uint8_t two[32] = {0};
  two[31] = 2;
  uint8_t x2[32], y2[32];
  if (!grumpkin_scalar_mul_generator(x2, y2, two)) {
    fprintf(stderr, "smoke: [2]G returned infinity\n");
    return 3;
  }
  fr_t fx2, fy2;
  if (!fr_from_bytes_be(&fx2, x2) || !fr_from_bytes_be(&fy2, y2)) {
    fprintf(stderr, "smoke: [2]G coords not canonical\n");
    return 3;
  }
  if (!grumpkin_affine_on_curve(&fx2, &fy2)) {
    fprintf(stderr, "smoke: [2]G not on curve\n");
    return 3;
  }

  /* [0]·G must be infinity (returns false, zeroed coords). */
  uint8_t zero[32] = {0};
  uint8_t xz[32], yz[32];
  if (grumpkin_scalar_mul_generator(xz, yz, zero)) {
    fprintf(stderr, "smoke: [0]G was not infinity\n");
    return 3;
  }

  printf("smoke OK\n");
  return 0;
}

/* fq-wide-reduce <hex128> — reduce a 64-byte BE value mod the Grumpkin scalar
 * order, print the 32-byte result. Exercises gk_fq_from_bytes_wide_be, which
 * Phase 6 uses for sha512ToGrumpkinScalar (viewing-key derivation). */
static int mode_fq_wide_reduce(int argc, char **argv) {
  if (argc != 1) {
    fprintf(stderr, "fq-wide-reduce needs exactly one 128-hex (64-byte) arg\n");
    return 2;
  }
  const char *hex = argv[0];
  if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
  if (strlen(hex) != 128) {
    fprintf(stderr, "fq-wide-reduce arg must be 128 hex chars (64 bytes)\n");
    return 2;
  }
  uint8_t wide[64];
  for (int i = 0; i < 64; i++) {
    int hi = hex_nibble(hex[i * 2]);
    int lo = hex_nibble(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) {
      fprintf(stderr, "bad hex in fq-wide-reduce input\n");
      return 2;
    }
    wide[i] = (uint8_t)((hi << 4) | lo);
  }
  gk_fq_t r;
  gk_fq_from_bytes_wide_be(&r, wide);
  uint8_t out[32];
  gk_fq_to_bytes_be(out, &r);
  print_hex32(out);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s mul <hex32>... | fq-wide-reduce <hex128> | smoke\n", argv[0]);
    return 1;
  }
  if (strcmp(argv[1], "mul") == 0) return mode_mul(argc - 2, argv + 2);
  if (strcmp(argv[1], "fq-wide-reduce") == 0) return mode_fq_wide_reduce(argc - 2, argv + 2);
  if (strcmp(argv[1], "smoke") == 0) return mode_smoke();
  fprintf(stderr, "unknown mode: %s\n", argv[1]);
  return 1;
}
