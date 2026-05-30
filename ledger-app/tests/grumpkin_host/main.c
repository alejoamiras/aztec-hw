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
#include "../../src/crypto/pedersen.h"
#include "../../src/crypto/schnorr.h"
#include "../../src/l4/account_keys.h"
#include "../../src/l4/deploy_outer_hash.h"

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

/* pubkeys-hash <npk_x npk_y ivpk_x ivpk_y ovpk_x ovpk_y tpk_x tpk_y> (8 hex32)
 * -> publicKeysHash. Exercises az_account_public_keys_hash (M8 P6). */
static int mode_pubkeys_hash(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr, "pubkeys-hash needs 8 hex32 (npk/ivpk/ovpk/tpk x,y)\n");
    return 2;
  }
  az_affine_t pk[4];
  for (int i = 0; i < 4; i++) {
    if (parse_hex32(argv[i * 2], pk[i].x) != 0 || parse_hex32(argv[i * 2 + 1], pk[i].y) != 0) {
      fprintf(stderr, "bad hex32 at pubkey %d\n", i);
      return 2;
    }
  }
  uint8_t out[32];
  if (az_account_public_keys_hash(&pk[0], &pk[1], &pk[2], &pk[3], out) != 0) {
    fprintf(stderr, "public_keys_hash failed\n");
    return 2;
  }
  print_hex32(out);
  return 0;
}

/* address <publicKeysHash> <partial_address> <ivpk_x> <ivpk_y> -> address.
 * Exercises az_account_address (M8 P6). */
static int mode_address(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "address needs publicKeysHash partial ivpk_x ivpk_y (4 hex32)\n");
    return 2;
  }
  uint8_t pkh[32], partial[32];
  az_affine_t ivpk;
  if (parse_hex32(argv[0], pkh) != 0 || parse_hex32(argv[1], partial) != 0 ||
      parse_hex32(argv[2], ivpk.x) != 0 || parse_hex32(argv[3], ivpk.y) != 0) {
    fprintf(stderr, "bad hex32 input\n");
    return 2;
  }
  uint8_t out[32];
  if (az_account_address(pkh, partial, &ivpk, out) != 0) {
    fprintf(stderr, "address derivation failed\n");
    return 2;
  }
  print_hex32(out);
  return 0;
}

/* deploy-outer-hash <consumer> <chain> <version> <tx_nonce> <sponsor_fpc> (5 hex32)
 * <selector_u32_decimal> -> deploy authwit outer_hash. Exercises
 * az_deploy_compute_outer_hash (M8 P6d). */
static int mode_deploy_outer_hash(int argc, char **argv) {
  if (argc != 6) {
    fprintf(stderr, "deploy-outer-hash needs consumer chain version tx_nonce fpc (5 hex32) + selector_u32\n");
    return 2;
  }
  uint8_t consumer[32], chain[32], version[32], tx_nonce[32], fpc[32];
  if (parse_hex32(argv[0], consumer) != 0 || parse_hex32(argv[1], chain) != 0 ||
      parse_hex32(argv[2], version) != 0 || parse_hex32(argv[3], tx_nonce) != 0 ||
      parse_hex32(argv[4], fpc) != 0) {
    fprintf(stderr, "bad hex32 input\n");
    return 2;
  }
  char *end = NULL;
  unsigned long sel = strtoul(argv[5], &end, 10);
  if (end == argv[5] || sel > 0xffffffffUL) {
    fprintf(stderr, "bad selector u32\n");
    return 2;
  }
  uint8_t out[32];
  if (az_deploy_compute_outer_hash(consumer, chain, version, tx_nonce, fpc, (uint32_t)sel, out) !=
      0) {
    fprintf(stderr, "deploy outer_hash failed\n");
    return 2;
  }
  print_hex32(out);
  return 0;
}

/* mulp <scalar px py>... (triples of hex32) -> [scalar]·P as x,y per triple.
 * Exercises grumpkin_scalar_mul_affine (M10 P2, the Pedersen MSM vehicle).
 * scalar==0 or off-curve base prints two zero lines (infinity). */
static int mode_mulp(int argc, char **argv) {
  if (argc < 3 || argc % 3 != 0) {
    fprintf(stderr, "mulp needs triples: <scalar px py>...\n");
    return 2;
  }
  for (int i = 0; i < argc; i += 3) {
    uint8_t k[32], px[32], py[32];
    if (parse_hex32(argv[i], k) != 0 || parse_hex32(argv[i + 1], px) != 0 ||
        parse_hex32(argv[i + 2], py) != 0) {
      fprintf(stderr, "bad hex32 in mulp triple at %d\n", i);
      return 2;
    }
    uint8_t x[32], y[32];
    if (!grumpkin_scalar_mul_affine(x, y, k, px, py)) {
      memset(x, 0, 32);
      memset(y, 0, 32);
    }
    print_hex32(x);
    print_hex32(y);
  }
  return 0;
}

/* pedersen <v0 v1 v2> (3 hex32) -> pedersen_hash3([v0,v1,v2]).x. M10 P3. */
static int mode_pedersen(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "pedersen needs exactly 3 hex32 inputs\n");
    return 2;
  }
  uint8_t v0[32], v1[32], v2[32];
  if (parse_hex32(argv[0], v0) != 0 || parse_hex32(argv[1], v1) != 0 ||
      parse_hex32(argv[2], v2) != 0) {
    fprintf(stderr, "bad hex32 in pedersen input\n");
    return 2;
  }
  uint8_t x[32];
  if (!pedersen_hash3(x, v0, v1, v2)) {
    fprintf(stderr, "pedersen_hash3 failed (non-canonical input or infinity)\n");
    return 2;
  }
  print_hex32(x);
  return 0;
}

/* schnorr-pubkey <priv> (hex32) -> P = priv·G as x,y. M10 P4. */
static int mode_schnorr_pubkey(int argc, char **argv) {
  if (argc != 1) {
    fprintf(stderr, "schnorr-pubkey needs 1 hex32 priv\n");
    return 2;
  }
  uint8_t priv[32];
  if (parse_hex32(argv[0], priv) != 0) {
    fprintf(stderr, "bad hex32 priv\n");
    return 2;
  }
  uint8_t px[32], py[32];
  if (!schnorr_grumpkin_pubkey(px, py, priv)) {
    fprintf(stderr, "schnorr pubkey failed (priv 0 / non-canonical)\n");
    return 2;
  }
  print_hex32(px);
  print_hex32(py);
  return 0;
}

/* schnorr-sign <priv> <k> <msg> (3 hex32) -> sig = s||e_raw (128 hex). M10 P4. */
static int mode_schnorr_sign(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "schnorr-sign needs priv k msg (3 hex32)\n");
    return 2;
  }
  uint8_t priv[32], k[32], msg[32];
  if (parse_hex32(argv[0], priv) != 0 || parse_hex32(argv[1], k) != 0 ||
      parse_hex32(argv[2], msg) != 0) {
    fprintf(stderr, "bad hex32 input\n");
    return 2;
  }
  uint8_t sig[64];
  if (!schnorr_grumpkin_sign_with_nonce(sig, priv, k, msg)) {
    fprintf(stderr, "schnorr sign failed (reject condition)\n");
    return 2;
  }
  for (int i = 0; i < 64; i++) printf("%02x", sig[i]);
  putchar('\n');
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: %s mul <hex32>... | mulp <scalar px py>... | pedersen <3 hex32> | "
            "schnorr-pubkey <hex32> | schnorr-sign <priv k msg> | "
            "fq-wide-reduce <hex128> | pubkeys-hash <8 hex32> | address <4 hex32> | "
            "deploy-outer-hash <5 hex32> <selector_u32> | smoke\n",
            argv[0]);
    return 1;
  }
  if (strcmp(argv[1], "mul") == 0) return mode_mul(argc - 2, argv + 2);
  if (strcmp(argv[1], "mulp") == 0) return mode_mulp(argc - 2, argv + 2);
  if (strcmp(argv[1], "pedersen") == 0) return mode_pedersen(argc - 2, argv + 2);
  if (strcmp(argv[1], "schnorr-pubkey") == 0) return mode_schnorr_pubkey(argc - 2, argv + 2);
  if (strcmp(argv[1], "schnorr-sign") == 0) return mode_schnorr_sign(argc - 2, argv + 2);
  if (strcmp(argv[1], "fq-wide-reduce") == 0) return mode_fq_wide_reduce(argc - 2, argv + 2);
  if (strcmp(argv[1], "pubkeys-hash") == 0) return mode_pubkeys_hash(argc - 2, argv + 2);
  if (strcmp(argv[1], "address") == 0) return mode_address(argc - 2, argv + 2);
  if (strcmp(argv[1], "deploy-outer-hash") == 0) return mode_deploy_outer_hash(argc - 2, argv + 2);
  if (strcmp(argv[1], "smoke") == 0) return mode_smoke();
  fprintf(stderr, "unknown mode: %s\n", argv[1]);
  return 1;
}
