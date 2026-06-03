/**
 * P3 / HARD ITEM (a) — the `blind_signing` NVM toggle, end-to-end on the real app.elf.
 *
 * `blind_signing` is OFF by default (zero-initialized in NVRAM), sticky, and writable
 * ONLY by the on-device Settings switch — no APDU mutates it (settings.c / menu_nbgl.c).
 * When OFF, the legacy raw-hash SIGN_OUTER_HASH path is refused with
 * SW_BLIND_SIGN_DISABLED (0x6F13) BEFORE any UI/sign; when ON, it reaches the
 * nbgl_useCaseReviewBlindSigning ⚠ warning review and signs only on approval. The
 * decoded clear-signing path (b3 / verified-calls) is unaffected either way.
 *
 * This drives the whole lifecycle through the device UI: assert reject-when-OFF →
 * toggle ON in Settings → assert warn-and-sign → toggle OFF → assert reject again
 * (proves the toggle is reversible + sticky). It MUST run against a FRESH emulator
 * (NVRAM resets on Speculos restart → starts OFF); it also ends OFF so back-to-back
 * runs stay correct.
 *
 *   docker run -d --rm --name speculos-aztec -p 5005:5000 -p 9995:9999 \
 *     -v "$PWD/ledger-app/build/nanos2/bin:/app" ghcr.io/ledgerhq/speculos:latest \
 *     --display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf
 *   SPECULOS_URL=http://localhost:5005 bun test packages/adapter-ledger/src/blind-signing-toggle.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { defaultAztecPath } from './apdu.ts';
import { LedgerProvider } from './provider.ts';
import { toggleBlindSigning } from './speculos-settings.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';
import { unsafeSignOuterHash } from './unsafe.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const PATH = defaultAztecPath(0);
const OUTER = new Uint8Array(32).fill(0x42);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SPECULOS_URL)('P3 — blind_signing NVM toggle (FRESH emulator: starts OFF)', () => {
  const transport = new SpeculosTransport({
    baseUrl: SPECULOS_URL ?? 'http://localhost:5005',
    timeoutMs: 60_000,
  });
  const provider = new LedgerProvider(transport);

  /** Let any post-APDU status screen (nbgl_useCaseStatus / ReviewStatus) auto-dismiss
   * back to the home screen before the next UI navigation. */
  const settleHome = (): Promise<void> => sleep(3500);

  /** blind-sign review approver: both (accept the blind-signing warning), 5×right to
   * scroll intro/warning/path/hash, both (sign). Mirrors provider.test.ts. */
  const approveBlindSign = async (ctx: AutoConfirmContext): Promise<void> => {
    await ctx.sleep(500);
    await ctx.press('both');
    for (let i = 0; i < 5; i++) {
      await ctx.sleep(280);
      await ctx.press('right');
    }
    await ctx.sleep(280);
    await ctx.press('both');
  };

  test('default OFF → SIGN_OUTER_HASH refused with SW_BLIND_SIGN_DISABLED (0x6F13)', async () => {
    await expect(
      unsafeSignOuterHash(transport, PATH, OUTER, { autoConfirm: async () => {} }),
    ).rejects.toThrow('SW=0x6f13');
    await settleHome();
  });

  test('toggle ON in Settings → SIGN_OUTER_HASH reaches the ⚠ blind-sign review + signs', async () => {
    await toggleBlindSigning(transport);
    const sig = await unsafeSignOuterHash(transport, PATH, OUTER, {
      autoConfirm: approveBlindSign,
    });
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);
    await settleHome();
  });

  test('toggle OFF again → SIGN_OUTER_HASH refused once more (reversible + sticky)', async () => {
    await toggleBlindSigning(transport);
    await expect(
      unsafeSignOuterHash(transport, PATH, OUTER, { autoConfirm: async () => {} }),
    ).rejects.toThrow('SW=0x6f13');
    await settleHome();
  });
});
