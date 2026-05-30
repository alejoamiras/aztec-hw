#pragma once

/**
 * Blake2s-256 (RFC 7693), unkeyed, single-shot. Standalone — no BOLOS SDK
 * (the nanos2 cx_ library ships only Blake2b). M10 needs this for the Aztec
 * Schnorr challenge `e_raw = Blake2s(pedersen(R.x,P.x,P.y) || msg)`
 * (barretenberg crypto/schnorr/schnorr.tcc). Host-parity tested against
 * node:crypto `blake2s256` + RFC-7693 vectors.
 */
#include <stddef.h>
#include <stdint.h>

/** out = Blake2s-256(in[0..inlen)). out is 32 bytes. inlen may be 0. */
void blake2s256(uint8_t out[32], const uint8_t *in, size_t inlen);
