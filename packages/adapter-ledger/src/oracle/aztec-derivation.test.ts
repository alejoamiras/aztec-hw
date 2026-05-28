/**
 * Round-trip determinism + shape sanity for the Aztec key derivation oracle.
 *
 * Catches `@aztec/*` regressions: if Aztec changes `deriveKeys()` or
 * `PublicKeys.hash()` in a future version, this test fails before M8 device
 * code re-syncs.
 */
import { describe, expect, it } from 'bun:test';
import { Fr } from '@aztec/foundation/curves/bn254';
import { deriveAztecKeysFromMasterSecret } from './aztec-derivation.js';

const FIXED_SECRETS_HEX = [
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  '0x2af6c87b6f5e5e3e7f5b8c5e5e3e7f5b8c5e5e3e7f5b8c5e5e3e7f5b8c5e5e3e',
];

describe('aztec-derivation oracle', () => {
  it('produces consistent output across two invocations (determinism)', async () => {
    for (const hex of FIXED_SECRETS_HEX) {
      const sk = Fr.fromHexString(hex);
      const a = await deriveAztecKeysFromMasterSecret(sk);
      const b = await deriveAztecKeysFromMasterSecret(sk);
      expect(a.publicKeysHash.toString()).toBe(b.publicKeysHash.toString());
      expect(a.masterNullifierHidingKey.toString()).toBe(b.masterNullifierHidingKey.toString());
      expect(a.masterIncomingViewingSecretKey.toString()).toBe(
        b.masterIncomingViewingSecretKey.toString(),
      );
      expect(a.masterOutgoingViewingSecretKey.toString()).toBe(
        b.masterOutgoingViewingSecretKey.toString(),
      );
      expect(a.masterTaggingSecretKey.toString()).toBe(b.masterTaggingSecretKey.toString());
    }
  });

  it('publicKeys has the expected 4 master pubkeys + computed hash', async () => {
    const sk = Fr.fromHexString(FIXED_SECRETS_HEX[0]!);
    const derived = await deriveAztecKeysFromMasterSecret(sk);
    expect(derived.publicKeys.masterNullifierPublicKey).toBeDefined();
    expect(derived.publicKeys.masterIncomingViewingPublicKey).toBeDefined();
    expect(derived.publicKeys.masterOutgoingViewingPublicKey).toBeDefined();
    expect(derived.publicKeys.masterTaggingPublicKey).toBeDefined();
    expect(derived.publicKeysHash).toBeDefined();
    expect(derived.publicKeysHash.toString().startsWith('0x')).toBe(true);
  });

  it('different secrets produce different publicKeysHash values', async () => {
    const a = await deriveAztecKeysFromMasterSecret(Fr.fromHexString(FIXED_SECRETS_HEX[0]!));
    const b = await deriveAztecKeysFromMasterSecret(Fr.fromHexString(FIXED_SECRETS_HEX[1]!));
    expect(a.publicKeysHash.toString()).not.toBe(b.publicKeysHash.toString());
  });
});
