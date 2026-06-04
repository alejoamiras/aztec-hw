/**
 * Connect handshake — the mandatory version-range + required-caps gate.
 * Hardware-free: mock `getVersion`/`getCaps`. Covers happy path + each failure mode.
 */
import { describe, expect, test } from 'bun:test';
import { CAPS, CURVE_ID } from './apdu.ts';
import {
  assertDeviceCompatible,
  LedgerIncompatibleVersionError,
  LedgerMissingCapabilityError,
  REQUIRED_CAPS_BASE,
  requiredCapsForCurve,
  SUPPORTED_APP_VERSION,
} from './connect-handshake.ts';

const mockProvider = (version: { major: number; minor: number; patch: number }, caps: number) => ({
  getVersion: async () => version,
  getCaps: async () => caps,
});

/** The shipped device build: K1 | CLEAR_SIGN | GRUMPKIN | ATTEST_ADDRESS = 0x1D. */
const DEVICE_CAPS = CAPS.K1 | CAPS.CLEAR_SIGN | CAPS.GRUMPKIN | CAPS.ATTEST_ADDRESS;

describe('requiredCapsForCurve', () => {
  test('ECDSA-K needs base + K1; Schnorr needs base + GRUMPKIN; default = K1', () => {
    expect(requiredCapsForCurve(CURVE_ID.SECP256K1)).toBe(REQUIRED_CAPS_BASE | CAPS.K1);
    expect(requiredCapsForCurve(CURVE_ID.GRUMPKIN)).toBe(REQUIRED_CAPS_BASE | CAPS.GRUMPKIN);
    expect(requiredCapsForCurve()).toBe(REQUIRED_CAPS_BASE | CAPS.K1);
  });
});

describe('assertDeviceCompatible', () => {
  test('passes for an in-range version with a superset of the required caps', async () => {
    const { version, caps } = await assertDeviceCompatible(
      mockProvider(SUPPORTED_APP_VERSION.min, DEVICE_CAPS),
      requiredCapsForCurve(CURVE_ID.SECP256K1),
    );
    expect(version).toEqual(SUPPORTED_APP_VERSION.min);
    expect(caps).toBe(DEVICE_CAPS);
  });

  test('rejects a version below the supported minimum', async () => {
    await expect(
      assertDeviceCompatible(
        mockProvider({ major: 0, minor: 0, patch: 9 }, DEVICE_CAPS),
        REQUIRED_CAPS_BASE,
      ),
    ).rejects.toBeInstanceOf(LedgerIncompatibleVersionError);
  });

  test('rejects a version at the exclusive maximum (next major is breaking)', async () => {
    await expect(
      assertDeviceCompatible(
        mockProvider(SUPPORTED_APP_VERSION.maxExclusive, DEVICE_CAPS),
        REQUIRED_CAPS_BASE,
      ),
    ).rejects.toBeInstanceOf(LedgerIncompatibleVersionError);
  });

  test('rejects (with the exact missing bit) when a required capability is absent', async () => {
    const caps = CAPS.K1 | CAPS.CLEAR_SIGN; // lacks ATTEST_ADDRESS
    try {
      await assertDeviceCompatible(
        mockProvider(SUPPORTED_APP_VERSION.min, caps),
        requiredCapsForCurve(CURVE_ID.SECP256K1),
      );
      throw new Error('expected assertDeviceCompatible to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerMissingCapabilityError);
      expect((e as LedgerMissingCapabilityError).missingCaps).toBe(CAPS.ATTEST_ADDRESS);
    }
  });
});
