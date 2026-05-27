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
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import { Point, verify } from '@noble/secp256k1';
import { defaultAztecPath } from './apdu.ts';
import { LedgerProvider } from './provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
// Single source of truth for the Aztec derivation path — derived from
// AZTEC_COIN_TYPE so this test honours the env override (codex L2 MINOR #6).
const AZTEC_PATH = defaultAztecPath(0);

/**
 * Speculos auto-confirm driver for `nbgl_useCaseReviewBlindSigning` on Nano S+.
 * Discovered flow (one `both` to accept the blind-sign warning, then 5 `right`
 * to scroll past intro/warning/path/hash-1/hash-2, then `both` on the Sign page):
 *
 *   p00 "Blind signing ahead — press both to accept risk"   → both
 *   p01 "Aztec authorization" (intro)                       → right
 *   p02 "INTERNAL build - do NOT ..." (warning)             → right
 *   p03 "Path: m/44'/{AZTEC_COIN_TYPE}'/0'/0/0"             → right
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

  test('GET_CAPS advertises CAPS_K1 | CAPS_CLEAR_SIGN on the L4 build', async () => {
    const caps = await provider.getCaps();
    /* L2 baseline advertised K1 (0x01) only. L4 build adds CLEAR_SIGN (0x04)
     * so the host adapter can switch to the verified-calls streaming path. */
    expect(caps).toBe(0x05);
  });

  test('GET_PUBLIC_KEY for Aztec path returns 64-byte uncompressed pubkey (X||Y)', async () => {
    const pk = await provider.getPublicKey(AZTEC_PATH);
    expect(pk.x.length).toBe(32);
    expect(pk.y.length).toBe(32);
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

  /**
   * L2 acceptance criterion (plan-final.md §6 + §223): the signature must verify
   * via Aztec's actual `Ecdsa.verifySignature`, which is barretenberg-backed and
   * exercises the same code path the in-circuit `EcdsaKAccount` verifier runs.
   */
  test('SIGN_OUTER_HASH sig verifies under Aztec foundation Ecdsa (in-circuit parity)', async () => {
    const pk = await provider.getPublicKey(AZTEC_PATH);
    const pubKeyXY = Buffer.concat([Buffer.from(pk.x), Buffer.from(pk.y)]); // 64-byte x||y, no SEC1 prefix
    const outerHash = new Uint8Array(32).fill(0x42);

    const sig = await provider.signOuterHash(AZTEC_PATH, outerHash, {
      autoConfirm: approveReview,
    });

    // Aztec's EcdsaSignature carries (r, s, v). The device doesn't currently
    // return v (it's only needed for recovery, not verify); pad with 0.
    const aztecSig = new EcdsaSignature(Buffer.from(sig.r), Buffer.from(sig.s), Buffer.from([0]));
    const verifier = new Ecdsa('secp256k1');
    const ok = await verifier.verifySignature(outerHash, pubKeyXY, aztecSig);
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

  /* --- M7 P3 — clear-signed deploy ----------------------------------
   * These tests exercise the wire protocol; they don't drive the on-
   * device review UI button-by-button (the deploy NBGL flow has a
   * different page count than blind-sign). Full end-to-end with UI
   * driving lands when the host builder lands (M7 P4) and the demo
   * exercises it. Here we verify:
   *   - BEGIN_DEPLOY_ACCOUNT for the registered profile returns 0x9000
   *   - BEGIN_DEPLOY_ACCOUNT with an unknown profile_id returns 0x6F0D
   *   - FINALIZE_DEPLOY_AND_SIGN before BEGIN returns 0x6F11
   */
  test('BEGIN_DEPLOY_ACCOUNT accepts the registered profile and returns 0x9000', async () => {
    const ctx = {
      profileId: 0,
      bip32Path: AZTEC_PATH,
      chainId: new Uint8Array(32).fill(0x02),
      protocolVersion: new Uint8Array(32).fill(0x03),
      txNonce: new Uint8Array(32).fill(0x04),
      salt: new Uint8Array(32).fill(0x05),
      publicKeysHash: new Uint8Array(32).fill(0x06),
      expectedAddress: new Uint8Array(32).fill(0x07),
    };
    /* Force the canonical-Fr check on by zeroing the high byte (already 0 for
     * fill(0x02) since the BE fill puts 0x02 in [0]; canonical Fr requires
     * the value < curve modulus, so high-bit-clear is enough). */
    ctx.chainId[0] = 0x00;
    ctx.protocolVersion[0] = 0x00;
    ctx.txNonce[0] = 0x00;
    ctx.salt[0] = 0x00;
    ctx.publicKeysHash[0] = 0x00;
    ctx.expectedAddress[0] = 0x00;
    await expect(provider.beginDeployAccount(ctx)).resolves.toBeUndefined();
    /* Tidy up: send an ABORT to leave the device clean for the next test. */
    await provider.abortAuthwit();
  });

  test('BEGIN_DEPLOY_ACCOUNT rejects an unknown profile_id with 0x6F0D', async () => {
    const ctx = {
      profileId: 7 /* not registered — only 0 exists in v0 */,
      bip32Path: AZTEC_PATH,
      chainId: new Uint8Array(32),
      protocolVersion: new Uint8Array(32),
      txNonce: new Uint8Array(32),
      salt: new Uint8Array(32),
      publicKeysHash: new Uint8Array(32),
      expectedAddress: new Uint8Array(32),
    };
    await expect(provider.beginDeployAccount(ctx)).rejects.toThrow('SW=0x6f0d');
  });

  test('FINALIZE_DEPLOY_AND_SIGN before BEGIN returns 0x6F11', async () => {
    /* No BEGIN_DEPLOY_ACCOUNT has been called (we ABORTed at the end of
     * the prior test); the device should reject FINALIZE with the wrong-
     * state SW. */
    await provider.abortAuthwit();
    const outerHash = new Uint8Array(32);
    await expect(provider.finalizeDeployAndSign(outerHash)).rejects.toThrow('SW=0x6f11');
  });
});
