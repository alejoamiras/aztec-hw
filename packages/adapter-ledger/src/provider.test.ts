/**
 * Speculos integration test for the Aztec Ledger app (L2 K1 baseline).
 *
 * Boots gated on `SPECULOS_URL` so unit-only test runs don't try to talk
 * to a non-existent emulator. Run via:
 *
 *   docker run -d --rm --name speculos-aztec \
 *     -p 5001:5000 -p 9999:9999 \
 *     -v "$(pwd)/ledger-app/bin:/app" \
 *     ghcr.io/ledgerhq/speculos:latest \
 *     --display headless --model nanosp --apdu-port 9999 --api-port 5000 \
 *     /app/app.elf
 *
 *   SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Point, verify } from '@noble/secp256k1';

import { SW } from './apdu.ts';
import { LedgerProvider } from './provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = [
  0x8000_002c, // 44'
  0x8000_0682, // 1666' (Aztec coin-type placeholder)
  0x8000_0000, // 0'
  0x0000_0000, // 0
  0x0000_0000, // 0
] as const;

/**
 * Speculos auto-confirm driver for `nbgl_useCaseReviewBlindSigning` on Nano S+.
 * Discovered flow (one `both` to accept the blind-sign warning, then 5 `right`
 * to scroll past intro/warning/path/hash-1/hash-2, then `both` on the Sign page):
 *
 *   p00 "Blind signing ahead — press both to accept risk"   → both
 *   p01 "Aztec authorization" (intro)                       → right
 *   p02 "INTERNAL build - do NOT ..." (warning)             → right
 *   p03 "Path: m/44'/1666'/0'/0/0"                          → right
 *   p04 "outer_hash (1/2): 4242…"                           → right
 *   p05 "outer_hash (2/2): …4242"                           → right
 *   p06 "Sign Aztec outer_hash?"                            → both ✓
 */
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

describe.skipIf(!SPECULOS_URL)('Ledger app — Speculos integration', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
  const provider = new LedgerProvider(transport);

  test('GET_VERSION returns 0.0.1', async () => {
    const v = await provider.getVersion();
    expect(v).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  test('GET_CAPS advertises CAPS_K1 only on L2 build', async () => {
    const caps = await provider.getCaps();
    // CAPS_K1 = 1 << 0; CAPS_R1 / CAPS_CLEAR_SIGN / CAPS_GRUMPKIN reserved.
    expect(caps).toBe(0x01);
  });

  test('GET_PUBLIC_KEY for Aztec path returns 64-byte uncompressed pubkey + chain code', async () => {
    const pk = await provider.getPublicKey(AZTEC_PATH);
    expect(pk.x.length).toBe(32);
    expect(pk.y.length).toBe(32);
    expect(pk.chainCode.length).toBe(32);
    // Validate it's on-curve via @noble/secp256k1.
    const sec1 = new Uint8Array(65);
    sec1[0] = 0x04;
    sec1.set(pk.x, 1);
    sec1.set(pk.y, 33);
    expect(() => Point.fromBytes(sec1)).not.toThrow();
  });

  test('SIGN_OUTER_HASH produces a sig that verifies under sha256(outer_hash)', async () => {
    const pk = await provider.getPublicKey(AZTEC_PATH);
    const sec1 = new Uint8Array(65);
    sec1[0] = 0x04;
    sec1.set(pk.x, 1);
    sec1.set(pk.y, 33);

    // Fixed outer_hash chosen so the test is reproducible.
    const outerHash = new Uint8Array(32).fill(0x42);

    const sig = await provider.signOuterHash(AZTEC_PATH, outerHash, {
      autoConfirm: approveReview,
    });
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);

    // Aztec ECDSA preimage = sha256(outer_hash). The device signs the same
    // digest; @noble.secp256k1's `verify` expects the *digest* (not the message)
    // when called with the low-level Signature API.
    const digest = new Uint8Array(createHash('sha256').update(outerHash).digest());
    const sig64 = new Uint8Array(64);
    sig64.set(sig.r, 0);
    sig64.set(sig.s, 32);

    // `prehash: false` tells noble we already hashed the message (the device
    // signed sha256(outer_hash) directly).
    const ok = verify(sig64, digest, sec1, { prehash: false });
    expect(ok).toBe(true);
  });

  test('SIGN_OUTER_HASH returns 6985 when the user rejects on-device', async () => {
    const outerHash = new Uint8Array(32).fill(0x01);
    // Same flow as approveReview but one extra `right` to step onto the
    // "Reject transaction" page (the screen after "Sign Aztec outer_hash?").
    const rejectFlow = async (ctx: AutoConfirmContext): Promise<void> => {
      await ctx.sleep(500);
      await ctx.press('both');
      for (let i = 0; i < 6; i++) {
        await ctx.sleep(280);
        await ctx.press('right');
      }
      await ctx.sleep(280);
      await ctx.press('both');
    };
    await expect(
      provider.signOuterHash(AZTEC_PATH, outerHash, { autoConfirm: rejectFlow }),
    ).rejects.toThrow('SW=0x6985');
  });
});
