/**
 * ECDSA helpers for the Aztec `EcdsaKAccount` / `EcdsaRAccount` paths.
 *
 * Anchored on:
 *   - `../../../aztec-hardware-wallet/architectures/00-aztec-signing-surface.md` §2
 *   - `../../../aztec-hardware-wallet/architectures/01a-aztec-reference-conformance.md` §1.2/§1.3
 *
 * Aztec's ECDSA verifier accepts:
 *   - Curve: secp256k1 (K1Account) or secp256r1 (RAccount)
 *   - Signature shape: 64 bytes = `r(32) ‖ s(32)`. NO `v`/recovery byte. NOT DER.
 *   - Pre-hash: `sha256(outer_hash.to_be_bytes())` (NOT EIP-191, NOT Keccak-256)
 *   - Low-s normalization is applied by Aztec's reference signer; HW deterministic-k
 *     signers usually do the same (Bitcoin-style BIP-66). Verifier behaviour on
 *     high-s is an open research item (O4 in 01a) — assume low-s is required.
 *
 * Everything below works in Uint8Array — Buffer subtype mismatches under strict
 * `noUncheckedIndexedAccess` are not worth fighting.
 */

import { createHash } from 'node:crypto';
import type { Fr } from '@aztec/foundation/curves/bn254';

export const SIGNATURE_BYTE_LENGTH = 64;
export const SCALAR_BYTE_LENGTH = 32;

/**
 * Compute the bytes Aztec's `EcdsaKAccount` / `EcdsaRAccount` verifier expects to be ECDSA-signed.
 *
 * Returns the SHA-256 digest of the BE-encoded `outer_hash` Field element.
 * The HW device receives this 32-byte digest and signs it with secp256k1 (K1) or
 * secp256r1 (R1) ECDSA. Importantly: there is NO EIP-191 `\x19Ethereum Signed Message:\n32`
 * prefix and the hash is SHA-256 — not Keccak-256.
 */
export function ecdsaPreimage(outerHash: Fr): Uint8Array {
  const bytes = outerHash.toBuffer();
  if (bytes.length !== SCALAR_BYTE_LENGTH) {
    throw new Error(
      `Unexpected outer_hash byte length: got ${bytes.length}, expected ${SCALAR_BYTE_LENGTH}`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/**
 * Pack a (r, s) ECDSA signature into the 64-byte `r ‖ s` layout the Aztec verifier expects.
 *
 * - Drops the `v`/recovery byte (Aztec's auth-witness path doesn't use it).
 * - Refuses DER-encoded inputs by enforcing raw 32-byte components.
 * - Refuses any extra bytes (defensive against a vendor SDK returning `r ‖ s ‖ v` etc.).
 */
export function packEcdsaSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  if (r.length !== SCALAR_BYTE_LENGTH) {
    throw new Error(`Bad r length: expected ${SCALAR_BYTE_LENGTH}, got ${r.length}`);
  }
  if (s.length !== SCALAR_BYTE_LENGTH) {
    throw new Error(`Bad s length: expected ${SCALAR_BYTE_LENGTH}, got ${s.length}`);
  }
  const sig = new Uint8Array(SIGNATURE_BYTE_LENGTH);
  sig.set(r, 0);
  sig.set(s, SCALAR_BYTE_LENGTH);
  return sig;
}

/**
 * secp256k1 curve order, used for low-s normalization.
 *
 * n = 0xFFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFE BAAEDCE6 AF48A03B BFD25E8C D0364141
 */
export const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
export const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * secp256r1 (P-256) curve order.
 *
 * n = 0xFFFFFFFF 00000000 FFFFFFFF FFFFFFFF BCE6FAAD A7179E84 F3B9CAC2 FC632551
 */
export const SECP256R1_N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
export const SECP256R1_HALF_N = SECP256R1_N / 2n;

/**
 * Normalize ECDSA `s` to the low-half (per BIP-66, applied by Aztec's reference signer).
 *
 * If `s > n/2`, returns the canonical low-s form `n - s`. Otherwise returns `s` unchanged.
 *
 * @param sBytes 32-byte BE `s` component
 * @param curve  'secp256k1' or 'secp256r1'
 * @returns      32-byte BE `s` component, low-half normalized
 */
export function normalizeLowS(sBytes: Uint8Array, curve: 'secp256k1' | 'secp256r1'): Uint8Array {
  if (sBytes.length !== SCALAR_BYTE_LENGTH) {
    throw new Error(`Bad s length: expected ${SCALAR_BYTE_LENGTH}, got ${sBytes.length}`);
  }
  const n = curve === 'secp256k1' ? SECP256K1_N : SECP256R1_N;
  const halfN = curve === 'secp256k1' ? SECP256K1_HALF_N : SECP256R1_HALF_N;
  const s = beBytesToBigInt(sBytes);
  if (s <= halfN) return new Uint8Array(sBytes);
  return bigIntToBeBytes(n - s, SCALAR_BYTE_LENGTH);
}

export function beBytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < length guaranteed
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

export function bigIntToBeBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) {
    throw new Error(`bigIntToBeBytes refuses negative input: ${value}`);
  }
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error(`bigint ${value} does not fit in ${length} bytes`);
  }
  return out;
}
