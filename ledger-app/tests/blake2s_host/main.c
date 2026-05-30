/**
 * Host CLI for the device Blake2s-256 (the SAME src/crypto/blake2s.c shipped in
 * the app). Parity-tested from bun against node:crypto blake2s256 + RFC-7693.
 *
 * Modes:
 *   hash <hex> [<hex> ...]  — print blake2s256(bytes(hex)) as 64 hex, one/line.
 *                              empty hex "" hashes the empty message.
 *   smoke                    — RFC-7693 "abc" self-check; prints "smoke OK".
 */
#include "../../src/crypto/blake2s.h"

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

static int parse_hex(const char *hex, uint8_t *out, size_t maxlen, size_t *outlen) {
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    size_t n = strlen(hex);
    if (n % 2 != 0) return -1;
    size_t bytes = n / 2;
    if (bytes > maxlen) return -1;
    for (size_t i = 0; i < bytes; i++) {
        int hi = hex_nibble(hex[2 * i]);
        int lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    *outlen = bytes;
    return 0;
}

static void print_hex(const uint8_t *b, size_t n) {
    for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
    printf("\n");
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s hash <hex>... | smoke\n", argv[0]);
        return 1;
    }
    if (strcmp(argv[1], "hash") == 0) {
        static uint8_t in[8192];
        for (int a = 2; a < argc; a++) {
            size_t inlen = 0;
            if (parse_hex(argv[a], in, sizeof(in), &inlen) != 0) {
                fprintf(stderr, "invalid hex arg %d\n", a);
                return 2;
            }
            uint8_t out[32];
            blake2s256(out, in, inlen);
            print_hex(out, 32);
        }
        return 0;
    }
    if (strcmp(argv[1], "smoke") == 0) {
        uint8_t out[32];
        blake2s256(out, (const uint8_t *)"abc", 3);
        char got[65];
        for (int i = 0; i < 32; i++) snprintf(got + 2 * i, 3, "%02x", out[i]);
        const char *exp = "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982";
        if (strcmp(got, exp) != 0) {
            fprintf(stderr, "smoke FAIL: got %s\n", got);
            return 3;
        }
        printf("smoke OK\n");
        return 0;
    }
    fprintf(stderr, "unknown mode: %s\n", argv[1]);
    return 1;
}
