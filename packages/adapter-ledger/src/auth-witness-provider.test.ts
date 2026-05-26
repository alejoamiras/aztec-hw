/**
 * Speculos-gated integration test for LedgerEcdsaKAuthWitnessProvider.
 *
 * Mirrors the adapter-trezor provider tests: drives the device through the
 * same `IntentAuthWitnessProvider` surface Aztec's account-contract flow
 * consumes, and verifies the produced AuthWitness against Aztec's own
 * Ecdsa.verifySignature.
 */
import { describe, expect, test } from 'bun:test';
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import {
  AztecAddress,
  type CallIntent,
  Fr,
  isIntentAuthWitnessProvider,
} from '@aztec-hwwallet-poc/core';

import { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = [0x8000_002c, 0x8000_0682, 0x8000_0000, 0x0000_0000, 0x0000_0000] as const;

async function approveReview(ctx: AutoConfirmContext): Promise<void> {
  await ctx.sleep(500);
  await ctx.press('both');
  for (let i = 0; i < 5; i++) {
    await ctx.sleep(280);
    await ctx.press('right');
  }
  await ctx.sleep(280);
  await ctx.press('both');
}

function makeStubIntent(): CallIntent {
  return {
    consumer: AztecAddress.fromBigInt(0xacc0_dead_beefn),
    chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
    calls: [
      {
        contractAddress: AztecAddress.fromBigInt(0xc0_ffee_c0_ffeen),
        selector: new Fr(0xa9059cbbn),
        args: [new Fr(0x42n)],
        isPadding: false,
      },
    ],
  };
}

describe.skipIf(!SPECULOS_URL)('LedgerEcdsaKAuthWitnessProvider — Speculos integration', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
  const provider = new LedgerEcdsaKAuthWitnessProvider(transport, {
    bip32Path: AZTEC_PATH,
    signOptions: { autoConfirm: approveReview },
  });

  test('implements IntentAuthWitnessProvider', () => {
    expect(isIntentAuthWitnessProvider(provider)).toBe(true);
  });

  test('getPublicKeyXY returns 32+32 byte coordinates', async () => {
    const { x, y } = await provider.getPublicKeyXY();
    expect(x.length).toBe(32);
    expect(y.length).toBe(32);
  });

  test('createAuthWit produces an AuthWitness whose sig verifies under Aztec Ecdsa', async () => {
    // Pick a 31-byte value so it always fits in BN254's field modulus.
    const outerHash = new Fr(
      0x42_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242_4242n,
    );
    const authWit = await provider.createAuthWit(outerHash);

    // AuthWitness wraps (messageHash, witnessFields[]) — the 64-byte r||s lives in fields 0..63
    // as raw bytes wrapped one-per-Fr (Aztec's Noir auth-witness convention).
    const witness = authWit.witness;
    expect(witness.length).toBe(64);
    const sigBytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      sigBytes[i] = Number(witness[i]!.toBigInt());
    }
    const r = sigBytes.slice(0, 32);
    const s = sigBytes.slice(32, 64);

    const { x, y } = await provider.getPublicKeyXY();
    const pubKeyXY = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
    const aztecSig = new EcdsaSignature(Buffer.from(r), Buffer.from(s), Buffer.from([0]));
    const verifier = new Ecdsa('secp256k1');
    const ok = await verifier.verifySignature(outerHash.toBuffer(), pubKeyXY, aztecSig);
    expect(ok).toBe(true);
  });

  test('createAuthWitFromIntent host-derives outer_hash + signs it', async () => {
    const intent = makeStubIntent();
    const authWit = await provider.createAuthWitFromIntent(intent);
    expect(authWit.witness.length).toBe(64);
    // The wrapped messageHash should be a non-zero Fr (the host-derived outer_hash).
    expect(authWit.requestHash.toString()).not.toBe(Fr.ZERO.toString());
  });
});
