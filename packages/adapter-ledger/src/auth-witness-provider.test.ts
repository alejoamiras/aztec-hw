/**
 * Tests for LedgerEcdsaKAuthWitnessProvider.
 *  - createAuthWit() — host fail-close (AHW-001): blind, hash-only signing is
 *    DISABLED; it must throw. No device needed (throws before any transport call).
 *  - getPublicKeyXY() — Speculos-gated (needs the device).
 * Clear-signing itself is covered by clear-signing-entrypoint.test.ts + the
 * on-chain entrypoint proofs. The deleted createAuthWitFromIntent/forDeploy tests
 * are gone with those methods.
 */
import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec-hwwallet-poc/core';
import { defaultAztecPath } from './apdu.ts';
import { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import { SpeculosTransport } from './speculos-transport.ts';
import type { LedgerTransport } from './transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = defaultAztecPath(0);

describe('LedgerEcdsaKAuthWitnessProvider — host fail-close (AHW-001)', () => {
  test('createAuthWit refuses blind (hash-only) signing', async () => {
    // createAuthWit throws before touching the transport, so a stub suffices.
    const provider = new LedgerEcdsaKAuthWitnessProvider({} as unknown as LedgerTransport, {
      bip32Path: AZTEC_PATH,
    });
    await expect(provider.createAuthWit(new Fr(0x42n))).rejects.toThrow(
      /blind .*signing is disabled/i,
    );
  });
});

describe.skipIf(!SPECULOS_URL)('LedgerEcdsaKAuthWitnessProvider — Speculos integration', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
  const provider = new LedgerEcdsaKAuthWitnessProvider(transport, { bip32Path: AZTEC_PATH });

  test('getPublicKeyXY returns 32+32 byte coordinates', async () => {
    const { x, y } = await provider.getPublicKeyXY();
    expect(x.length).toBe(32);
    expect(y.length).toBe(32);
  });
});
