/**
 * Grumpkin fixed-base scalar multiplication: [k]·G.
 *
 * This is the single operation Phase 6 needs in its hot path — every viewing
 * pubkey is `[viewing_scalar]·G`, and the address step is `[preaddress]·G`
 * (plus one affine add with ivpk_m). No arbitrary-base scalar mult is
 * required for M8, so only the generator variant is exposed.
 *
 * Scalar `k` is the Grumpkin SCALAR field element (BN254 base field,
 * 0x...d87cfd47), supplied as 32 big-endian bytes. The algorithm reads `k`
 * bit by bit; it does not perform `gk_fq` field arithmetic (that lives in
 * fq.c and is used by Phase 6 to derive `k` from SHA-512 output). A `k`
 * value ≥ the group order still yields the mathematically-correct
 * [k mod order]·G because order·G = O.
 *
 * Constant-time posture: the driver is double-and-add-ALWAYS (see
 * mul_generator.c) — identical operation sequence for every scalar bit AT AND
 * AFTER the first set bit. It is NOT fully constant-time: leading-zero bits of
 * `k` hit the infinity fast-path, leaking the scalar's effective bit-length
 * (codex Phase-3 review MAJOR). The underlying fr_t field ops are also not
 * micro-constant-time (point.h threat-model note). Both are accepted PoC
 * limitations; full side-channel resistance is Phase 9 / production work. Do
 * NOT represent this build as side-channel-resistant.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/**
 * Compute [k]·G and write the affine result as big-endian bytes.
 *
 * @param out_x      32-byte BE affine x-coordinate (Fr).
 * @param out_y      32-byte BE affine y-coordinate (Fr).
 * @param scalar_be  32-byte BE Grumpkin scalar k.
 * @return true if the result is a finite point; false if k ≡ 0 (result is the
 *         point at infinity, in which case out_x/out_y are zeroed).
 */
bool grumpkin_scalar_mul_generator(uint8_t out_x[32], uint8_t out_y[32],
                                   const uint8_t scalar_be[32]);
