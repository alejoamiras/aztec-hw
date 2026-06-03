/**
 * M8 P7.1 — unit coverage for revealMasterSecret with a mock transport (no
 * Speculos needed). The on-device reveal itself is covered end-to-end in
 * provider.m8.test.ts; here we prove the helper's wrapping logic: it issues the
 * right INS, forwards autoConfirm, returns the secret as a canonical Fr, and
 * computes the cross-check checksum. The canonical guard documents the
 * invariant that the device returns an already-reduced (< Fr) value.
 */
import { describe, expect, test } from 'bun:test';
import { INS, SW } from './apdu.ts';
import { masterSecretChecksum } from './master-secret.ts';
import { revealMasterSecret } from './onboarding.ts';
import type { ApduRequest, LedgerTransport } from './transport.ts';

function fixedTransport(
  secretBytes: Uint8Array,
  onSend?: (req: ApduRequest, autoConfirmPassed: boolean) => void,
): LedgerTransport {
  return {
    async send(req, autoConfirm) {
      onSend?.(req, autoConfirm !== undefined);
      return { data: secretBytes, sw: SW.OK };
    },
  };
}

describe('revealMasterSecret', () => {
  test('returns the device secret as a canonical Fr + matching checksum', async () => {
    const bytes = new Uint8Array(32).fill(0x11);
    bytes[0] = 0x00; // first byte < 0x30 ⇒ value < Fr modulus (canonical)
    let seenIns: number | undefined;
    let autoConfirmForwarded = false;
    const transport = fixedTransport(bytes, (req, acPassed) => {
      seenIns = req.ins;
      autoConfirmForwarded = acPassed;
    });

    const { secret, checksum } = await revealMasterSecret(transport, undefined, {
      autoConfirm: async () => {},
    });

    expect(seenIns).toBe(INS.GET_AZTEC_MASTER_SECRET);
    expect(autoConfirmForwarded).toBe(true);
    expect(new Uint8Array(secret.toBuffer())).toEqual(bytes);
    expect(checksum).toBe(masterSecretChecksum(bytes));
    expect(checksum).toMatch(/^[0-9a-f]{4}$/);
  });

  test('rejects a non-canonical secret (≥ Fr modulus)', async () => {
    const tooBig = new Uint8Array(32).fill(0xff); // > Fr modulus ⇒ fromBuffer throws
    await expect(revealMasterSecret(fixedTransport(tooBig))).rejects.toThrow();
  });
});
