import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec/foundation/curves/bn254';
import {
  bigIntToBeBytes,
  ecdsaPreimage,
  normalizeLowS,
  packEcdsaSignature,
  SCALAR_BYTE_LENGTH,
  SECP256K1_HALF_N,
  SECP256K1_N,
  SECP256R1_HALF_N,
  SECP256R1_N,
  SIGNATURE_BYTE_LENGTH,
} from './ecdsa.ts';

const ZERO_32 = new Uint8Array(32);
const ONE_32 = (() => {
  const b = new Uint8Array(32);
  b[31] = 1;
  return b;
})();

describe('packEcdsaSignature', () => {
  test('produces 64-byte r||s with no v', () => {
    const sig = packEcdsaSignature(ZERO_32, ONE_32);
    expect(sig.length).toBe(SIGNATURE_BYTE_LENGTH);
    expect(Array.from(sig.subarray(0, 32))).toEqual(Array.from(ZERO_32));
    expect(Array.from(sig.subarray(32, 64))).toEqual(Array.from(ONE_32));
  });

  test('rejects wrong-length r', () => {
    expect(() => packEcdsaSignature(new Uint8Array(31), ONE_32)).toThrow();
    expect(() => packEcdsaSignature(new Uint8Array(33), ONE_32)).toThrow();
  });

  test('rejects wrong-length s (defends against r||s||v 65-byte vendor outputs)', () => {
    expect(() => packEcdsaSignature(ZERO_32, new Uint8Array(31))).toThrow();
    expect(() => packEcdsaSignature(ZERO_32, new Uint8Array(33))).toThrow();
    expect(() => packEcdsaSignature(ZERO_32, new Uint8Array(65))).toThrow();
  });
});

describe('normalizeLowS — secp256k1', () => {
  test('passes through low-s unchanged', () => {
    const halfN = bigIntToBeBytes(SECP256K1_HALF_N, SCALAR_BYTE_LENGTH);
    const normalized = normalizeLowS(halfN, 'secp256k1');
    expect(Array.from(normalized)).toEqual(Array.from(halfN));
  });

  test('flips high-s to canonical low form', () => {
    // s = halfN + 1 (just above the half-order threshold)
    const highS = bigIntToBeBytes(SECP256K1_HALF_N + 1n, SCALAR_BYTE_LENGTH);
    const normalized = normalizeLowS(highS, 'secp256k1');
    // n - (halfN + 1)
    const expected = bigIntToBeBytes(SECP256K1_N - SECP256K1_HALF_N - 1n, SCALAR_BYTE_LENGTH);
    expect(Array.from(normalized)).toEqual(Array.from(expected));
  });

  test('throws on wrong-length input', () => {
    expect(() => normalizeLowS(new Uint8Array(31), 'secp256k1')).toThrow();
  });
});

describe('normalizeLowS — secp256r1', () => {
  test('passes through low-s unchanged', () => {
    const halfN = bigIntToBeBytes(SECP256R1_HALF_N, SCALAR_BYTE_LENGTH);
    const normalized = normalizeLowS(halfN, 'secp256r1');
    expect(Array.from(normalized)).toEqual(Array.from(halfN));
  });

  test('flips high-s to canonical low form', () => {
    const highS = bigIntToBeBytes(SECP256R1_HALF_N + 1n, SCALAR_BYTE_LENGTH);
    const normalized = normalizeLowS(highS, 'secp256r1');
    const expected = bigIntToBeBytes(SECP256R1_N - SECP256R1_HALF_N - 1n, SCALAR_BYTE_LENGTH);
    expect(Array.from(normalized)).toEqual(Array.from(expected));
  });
});

describe('ecdsaPreimage', () => {
  test('returns 32-byte SHA-256 digest of outer_hash bytes', () => {
    const outerHash = Fr.ZERO;
    const preimage = ecdsaPreimage(outerHash);
    expect(preimage.length).toBe(32);
    // SHA-256 of 32 zero bytes (deterministic public test vector)
    // sha256(00 * 32) = 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    expect(Buffer.from(preimage).toString('hex')).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });
});
