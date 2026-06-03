/**
 * M8 Phase 0 — Grumpkin curve oracle.
 *
 * Re-exports Aztec's Grumpkin (via bb.js WASM) so Phase 3 parity tests have a
 * single import path. Anti-circularity: imports ONLY from `@aztec/*`.
 *
 * Reference: aztec-packages/yarn-project/foundation/src/crypto/grumpkin/index.ts
 */
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { Fq, Fr } from '@aztec/foundation/curves/bn254';
import { Point } from '@aztec/foundation/curves/grumpkin';

export { Fq, Fr, Grumpkin, Point };

/** Grumpkin generator G. Hardcoded constant on the device too (Phase 3). */
export const GRUMPKIN_GENERATOR = Grumpkin.generator;

/** Fixed-base scalar mult: [k]G. The op the device performs in Phase 3 hot path. */
export function grumpkinMulGenerator(scalar: Fq): Promise<Point> {
  return Grumpkin.mul(GRUMPKIN_GENERATOR, scalar);
}

/** Variable-base scalar mult: [k]P. Used only by some oracle scenarios. */
export function grumpkinMul(point: Point, scalar: Fq): Promise<Point> {
  return Grumpkin.mul(point, scalar);
}

/** Affine point addition. Phase 6 uses this for `address = (preaddress * G) + ivpk_m`. */
export function grumpkinAdd(a: Point, b: Point): Promise<Point> {
  return Grumpkin.add(a, b);
}
