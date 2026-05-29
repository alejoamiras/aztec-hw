/**
 * M8 Phase 6 — full account derivation from the master secret (device-only).
 *
 * Composes: sk -> 4 viewing scalars (sha512ToGrumpkinScalar) -> 4 viewing
 * pubkeys ([k]G) -> publicKeysHash -> address. Uses cx_hash_sha512, so this
 * lives device-side (no host build) — but every sub-step is host-parity-tested
 * against the Phase 0 golden vectors:
 *   - sk -> scalar       grumpkin-fq-wide-parity.test.ts
 *   - scalar -> pubkey   grumpkin-mul-parity.test.ts
 *   - pubkeys -> hash    grumpkin-account-parity.test.ts
 *   - ...-> address       grumpkin-account-parity.test.ts
 *
 * `out_pkh` and `out_addr` are PUBLIC (safe to cache in session / display).
 * `sk` is SECRET — the caller wipes it. The four viewing scalars are derived
 * and wiped internally; they never escape this module.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * @param sk               32-byte master secret (Fr), secret-equivalent.
 * @param partial_address  32-byte partial address (device-recomputed).
 * @param out_pkh          32-byte publicKeysHash (public output).
 * @param out_addr         32-byte account address (public output).
 * @return 0 on success; -1 on fault, incl. an infinity viewing pubkey
 *         (a zero-derived scalar — never produced by a valid sk).
 */
int az_account_derive_from_secret(const uint8_t sk[32], const uint8_t partial_address[32],
                                  uint8_t out_pkh[32], uint8_t out_addr[32]);

/**
 * Full INDEPENDENT pass: path → sk → {publicKeysHash, address}, wiping `sk`
 * before return. Use this for fault-hardening recompute passes — each call
 * re-derives `sk` from the seed, so a glitch in the BIP-32/SHA-512/reduce step
 * cannot poison two passes identically (codex Phase-6c review MAJOR). Never
 * shares an `sk` buffer across passes.
 *
 * @return 0 on success; -1 on any derivation fault.
 */
int az_account_derive_from_path(const uint32_t *bip32_path, size_t bip32_path_len,
                                const uint8_t partial_address[32], uint8_t out_pkh[32],
                                uint8_t out_addr[32]);
