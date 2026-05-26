/**
 * Host CLI for the Poseidon2 implementation under test. Builds against the
 * same .c files that ship in the Ledger app, with no BOLOS dependency.
 *
 * Modes:
 *   perm <hex32> <hex32> <hex32> <hex32>   — raw 4-lane permutation, prints 4 outputs.
 *   hash <hex32>...                        — Poseidon2 hash, prints 1 output.
 *   hash-sep <decimal-sep> <hex32>...      — Poseidon2 hash with separator.
 *   smoke                                  — runs built-in test-vector parity.
 *
 * Each hex input is exactly 64 hex chars (32 bytes BE), with optional "0x" prefix.
 * Outputs are 64 hex chars without prefix, one per line.
 *
 * Exit codes: 0 = OK, 1 = bad CLI usage, 2 = invalid input, 3 = smoke failure.
 */
#include "../../src/crypto/poseidon2/constants.h"
#include "../../src/crypto/poseidon2/fr.h"
#include "../../src/crypto/poseidon2/poseidon2.h"
#include "../../src/crypto/poseidon2/poseidon2_internal.h"

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

static int mode_perm(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "perm needs 4 hex32 inputs\n");
        return 2;
    }
    fr_t state[AZ_POSEIDON2_T];
    for (int i = 0; i < 4; i++) {
        uint8_t bytes[32];
        if (parse_hex32(argv[i], bytes) != 0) {
            fprintf(stderr, "bad hex32 at index %d\n", i);
            return 2;
        }
        if (!fr_from_bytes_be(&state[i], bytes)) {
            fprintf(stderr, "input %d >= p\n", i);
            return 2;
        }
    }
    az_poseidon2_permutation_inplace(state);
    for (int i = 0; i < 4; i++) {
        uint8_t out[32];
        fr_to_bytes_be(out, &state[i]);
        print_hex32(out);
    }
    return 0;
}

static int mode_hash(int argc, char **argv, int with_sep) {
    int sep_off = with_sep ? 1 : 0;
    if (with_sep && argc < 1) {
        fprintf(stderr, "hash-sep needs a separator\n");
        return 2;
    }
    uint32_t separator = 0;
    if (with_sep) {
        char *end = NULL;
        unsigned long v = strtoul(argv[0], &end, 10);
        if (end == argv[0] || v > 0xffffffffUL) {
            fprintf(stderr, "bad separator\n");
            return 2;
        }
        separator = (uint32_t)v;
    }
    int field_count = argc - sep_off;
    uint8_t *fields = NULL;
    if (field_count > 0) {
        fields = (uint8_t *)calloc((size_t)field_count, 32);
        if (!fields) return 2;
        for (int i = 0; i < field_count; i++) {
            if (parse_hex32(argv[sep_off + i], &fields[i * 32]) != 0) {
                fprintf(stderr, "bad hex32 at field %d\n", i);
                free(fields);
                return 2;
            }
        }
    }
    uint8_t out[32];
    int rc = with_sep
        ? az_poseidon2_hash_with_separator(fields, (size_t)field_count, separator, out)
        : az_poseidon2_hash(fields, (size_t)field_count, out);
    free(fields);
    if (rc != 0) {
        fprintf(stderr, "hash failed (input >= p?)\n");
        return 2;
    }
    print_hex32(out);
    return 0;
}

/* Smoke test: raw permutation parity against the constants-embedded test vector
 * (poseidon2_params.hpp:447-458). Tests fr.c + constants.c + poseidon2.c
 * without any sponge / API layer noise. */
static int mode_smoke(void) {
    fr_t state[AZ_POSEIDON2_T];
    for (int i = 0; i < AZ_POSEIDON2_T; i++) {
        state[i] = AZ_POSEIDON2_TEST_INPUT[i];
    }
    az_poseidon2_permutation_inplace(state);
    int ok = 1;
    for (int i = 0; i < AZ_POSEIDON2_T; i++) {
        if (!fr_eq(&state[i], &AZ_POSEIDON2_TEST_OUTPUT[i])) {
            uint8_t got[32], want[32];
            fr_to_bytes_be(got, &state[i]);
            fr_to_bytes_be(want, &AZ_POSEIDON2_TEST_OUTPUT[i]);
            fprintf(stderr, "MISMATCH at lane %d:\n  got:  ", i);
            for (int b = 0; b < 32; b++) fprintf(stderr, "%02x", got[b]);
            fprintf(stderr, "\n  want: ");
            for (int b = 0; b < 32; b++) fprintf(stderr, "%02x", want[b]);
            fputc('\n', stderr);
            ok = 0;
        }
    }
    if (ok) {
        printf("smoke OK\n");
        return 0;
    }
    return 3;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <perm|hash|hash-sep|smoke> ...\n", argv[0]);
        return 1;
    }
    const char *mode = argv[1];
    if (strcmp(mode, "perm") == 0) return mode_perm(argc - 2, argv + 2);
    if (strcmp(mode, "hash") == 0) return mode_hash(argc - 2, argv + 2, 0);
    if (strcmp(mode, "hash-sep") == 0) return mode_hash(argc - 2, argv + 2, 1);
    if (strcmp(mode, "smoke") == 0) return mode_smoke();
    fprintf(stderr, "unknown mode: %s\n", mode);
    return 1;
}
