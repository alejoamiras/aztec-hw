#pragma once

#include <stdint.h>

/**
 * Instruction class of the Aztec application.
 */
#define CLA 0xE0

/** Length of APPNAME variable in the Makefile. */
#define APPNAME_LEN (sizeof(APPNAME) - 1)

/** Length of MAJOR || MINOR || PATCH version triple. */
#define APPVERSION_LEN 3

/** Maximum length of application name. */
#define MAX_APPNAME_LEN 64

/** Aztec outer_hash byte length (32-byte BE Fr scalar). */
#define AZTEC_OUTER_HASH_LEN 32

/** ECDSA secp256k1 signature length in r || s (no v). */
#define ECDSA_K1_SIG_LEN 64

/** Maximum BIP-32 path depth we accept. */
#define MAX_BIP32_PATH_LEN 10

/**
 * Aztec SLIP-44 coin type — build-time override per
 * implementations-plan/hw-wallet-poc-ledger/plan-final.md §2 (final critique §4).
 * PoC default 1666; production sets `make AZTEC_COIN_TYPE=N`.
 */
#ifndef AZTEC_COIN_TYPE
#define AZTEC_COIN_TYPE 1666
#endif

#define AZTEC_COIN_TYPE_HARDENED (0x80000000u | AZTEC_COIN_TYPE)
