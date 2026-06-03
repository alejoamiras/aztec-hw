/**
 * AHW-098 (W4) — fail-closed receive-address attestation gate. Pure unit tests for
 * the suppression paths the finding called out (missing-cap-fails-closed,
 * wrong-tuple-rejects). The happy round-trip against the real device is in
 * provider.m8.test.ts ("GET_AZTEC_ADDRESS attests the SAME address…").
 */
import { describe, expect, test } from 'bun:test';
import { CAPS } from './apdu.ts';
import { assertDeviceAttestedAddress } from './receive-address-verify.ts';

const ALL_CAPS = CAPS.K1 | CAPS.CLEAR_SIGN | CAPS.GRUMPKIN | CAPS.ATTEST_ADDRESS;
const addr = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe('AHW-098 — assertDeviceAttestedAddress (fail-closed)', () => {
  test('passes when the device advertises ATTEST_ADDRESS and addresses match', () => {
    expect(() =>
      assertDeviceAttestedAddress({
        caps: ALL_CAPS,
        attestedAddress: addr(0xab),
        hostAddress: addr(0xab),
      }),
    ).not.toThrow();
  });

  test('missing-cap-fails-closed: throws when ATTEST_ADDRESS bit is absent (NO fallback)', () => {
    // Even if the (would-be) attested address matches, an un-capable device is refused.
    expect(() =>
      assertDeviceAttestedAddress({
        caps: CAPS.K1 | CAPS.CLEAR_SIGN | CAPS.GRUMPKIN, // no ATTEST_ADDRESS
        attestedAddress: addr(0xab),
        hostAddress: addr(0xab),
      }),
    ).toThrow(/CAPS_ATTEST_ADDRESS|no fallback/i);
  });

  test('throws when attestation was not produced (undefined)', () => {
    expect(() =>
      assertDeviceAttestedAddress({
        caps: ALL_CAPS,
        attestedAddress: undefined,
        hostAddress: addr(0xab),
      }),
    ).toThrow(/no device attestation/i);
  });

  test('wrong-tuple-rejects: throws when device-attested != host-derived', () => {
    expect(() =>
      assertDeviceAttestedAddress({
        caps: ALL_CAPS,
        attestedAddress: addr(0xab),
        hostAddress: addr(0xcd), // host claims a different address than the device authored
      }),
    ).toThrow(/!= host-derived|substitution/i);
  });

  test('a single-byte difference is caught (not just a prefix check)', () => {
    const a = addr(0x11);
    const b = addr(0x11);
    b[31] = 0x12; // last byte differs
    expect(() =>
      assertDeviceAttestedAddress({ caps: ALL_CAPS, attestedAddress: a, hostAddress: b }),
    ).toThrow(/!= host-derived|substitution/i);
  });
});
