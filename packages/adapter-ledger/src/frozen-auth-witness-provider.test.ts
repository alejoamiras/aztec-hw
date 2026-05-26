import { describe, expect, test } from 'bun:test';
import { AuthWitness } from '@aztec/stdlib/auth-witness';
import { Fr } from '@aztec-hwwallet-poc/core';

import {
  FrozenAuthWitnessProvider,
  FrozenWitnessMismatchError,
  FrozenWitnessUsedError,
} from './frozen-auth-witness-provider.ts';

function mockWitness(hash: Fr): AuthWitness {
  const sig = Array.from({ length: 64 }, (_, i) => new Fr(BigInt(i + 1)));
  return new AuthWitness(hash, sig);
}

describe('FrozenAuthWitnessProvider', () => {
  test('returns the frozen witness when framework hash matches', async () => {
    const hash = new Fr(0xdeadbeefn);
    const witness = mockWitness(hash);
    const provider = new FrozenAuthWitnessProvider(witness, hash);
    const got = await provider.createAuthWit(hash);
    expect(got).toBe(witness);
  });

  test('throws FrozenWitnessMismatchError on hash mismatch', async () => {
    const presignHash = new Fr(0xdeadbeefn);
    const frameworkHash = new Fr(0xcafef00dn);
    const provider = new FrozenAuthWitnessProvider(mockWitness(presignHash), presignHash);
    await expect(provider.createAuthWit(frameworkHash)).rejects.toBeInstanceOf(
      FrozenWitnessMismatchError,
    );
  });

  test('throws FrozenWitnessUsedError on second call', async () => {
    const hash = new Fr(0xdeadbeefn);
    const provider = new FrozenAuthWitnessProvider(mockWitness(hash), hash);
    await provider.createAuthWit(hash);
    await expect(provider.createAuthWit(hash)).rejects.toBeInstanceOf(FrozenWitnessUsedError);
  });

  test('accepts Buffer input (framework can pass Fr | Buffer)', async () => {
    const hash = new Fr(0x42n);
    const buf = hash.toBuffer();
    const provider = new FrozenAuthWitnessProvider(mockWitness(hash), hash);
    const got = await provider.createAuthWit(buf);
    expect(got.requestHash.toBigInt()).toBe(hash.toBigInt());
  });

  test('mismatch error carries expected + actual hashes for diagnostics', async () => {
    const presignHash = new Fr(0xdeadbeefn);
    const frameworkHash = new Fr(0xcafef00dn);
    const provider = new FrozenAuthWitnessProvider(mockWitness(presignHash), presignHash);
    try {
      await provider.createAuthWit(frameworkHash);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FrozenWitnessMismatchError);
      const err = e as FrozenWitnessMismatchError;
      expect(err.expectedHash.toLowerCase()).toContain('deadbeef');
      expect(err.actualHash.toLowerCase()).toContain('cafef00d');
    }
  });

  test('mismatch does NOT consume the witness (provider still usable with correct hash)', async () => {
    const hash = new Fr(0xdeadbeefn);
    const wrong = new Fr(0xbadn);
    const witness = mockWitness(hash);
    const provider = new FrozenAuthWitnessProvider(witness, hash);
    await expect(provider.createAuthWit(wrong)).rejects.toBeInstanceOf(FrozenWitnessMismatchError);
    /* A subsequent call with the correct hash MUST succeed — the mismatch
     * is not a permanent invalidation; it's a wrong-input rejection. */
    const got = await provider.createAuthWit(hash);
    expect(got).toBe(witness);
  });
});
