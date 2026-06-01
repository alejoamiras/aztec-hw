/**
 * Speculos-gated integration test for LedgerEcdsaKAuthWitnessProvider.
 *
 * P1 (entrypoint-seam-refactor): the provider's clear-signing moved to
 * `LedgerClearSigningEntrypoint` (validated on-chain + by the entrypoint's runtime
 * parity assert). What remains to cover here is the retained provider surface:
 *   - `getPublicKeyXY()` — the account-ctor pubkey;
 *   - `createAuthWit(outerHash)` — the hash-only blind sign kept for app-level authwits,
 * verified against Aztec's own `Ecdsa.verifySignature`. The deleted
 * `createAuthWitFromIntent`/`createAuthWitForDeploy` tests are gone with those methods.
 */
import { describe, expect, test } from 'bun:test';
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import { Fr } from '@aztec-hwwallet-poc/core';
import { defaultAztecPath } from './apdu.ts';
import { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = defaultAztecPath(0);

/**
 * Robust NBGL auto-confirm — walks right until the final approve page is in the
 * event queue, then both-presses. The approve page renders the device's
 * `finishTitle` ("Sign Aztec …?"), unique to that page.
 */
async function approveReview(ctx: AutoConfirmContext): Promise<void> {
  const APPROVE_HINTS = ['Sign Aztec'];
  const REJECT_HINT = 'Reject transaction';
  const PAGE_SETTLE_MS = 280;

  const recentTexts = async (): Promise<string[]> => {
    const events = await ctx.getEvents();
    return events.slice(-8).map((e) => e.text);
  };

  await ctx.clearEvents();
  await ctx.sleep(PAGE_SETTLE_MS);
  /* Dismiss any intro/welcome splash. */
  await ctx.press('both');
  await ctx.sleep(PAGE_SETTLE_MS);

  for (let i = 0; i < 40; i++) {
    const texts = await recentTexts();
    const joined = texts.join(' | ');
    const hasApprove = APPROVE_HINTS.some((h) => joined.includes(h));
    const lastText = texts[texts.length - 1] ?? '';
    const onReject = lastText.includes(REJECT_HINT);

    if (hasApprove && !onReject) {
      await ctx.press('both');
      return;
    }
    if (onReject) {
      /* Overshot — go back to the previous (Approve) page. */
      await ctx.press('left');
    } else {
      await ctx.press('right');
    }
    await ctx.sleep(PAGE_SETTLE_MS);
  }
  throw new Error('approveReview: never reached the Approve page');
}

describe.skipIf(!SPECULOS_URL)('LedgerEcdsaKAuthWitnessProvider — Speculos integration', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
  const provider = new LedgerEcdsaKAuthWitnessProvider(transport, {
    bip32Path: AZTEC_PATH,
    signOptions: { autoConfirm: approveReview },
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
  }, 30_000);
});
