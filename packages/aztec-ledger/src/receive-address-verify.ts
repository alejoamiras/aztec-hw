/**
 * W4 (AHW-098) — fail-closed verification that a receive address was DEVICE-attested.
 *
 * The onboarding/receive address used to be host-derived and never device-attested
 * (a malicious host could substitute an address it controls). The device now derives
 * + attests its own address (INS_GET_AZTEC_ADDRESS); this helper is the host gate the
 * caller MUST pass before trusting that address:
 *
 *   - the device MUST advertise CAPS.ATTEST_ADDRESS — otherwise we refuse to onboard,
 *     with NO fallback to a host-derived address (the whole point of the finding); and
 *   - the device-attested address MUST byte-equal the host's independent derivation —
 *     a mismatch means the host tried to show/use an address the device did not author.
 *
 * Pure + side-effect-free so the fail-closed decision is unit-testable without a device.
 */
import { CAPS } from './apdu.ts';

export interface DeviceAttestationCheck {
  /** GET_CAPS bitmask read from the device. */
  readonly caps: number;
  /**
   * The 32-byte address the device attested via INS_GET_AZTEC_ADDRESS, or `undefined`
   * if attestation was not performed (e.g. the capability bit was absent so the caller
   * never issued the INS). `undefined` ALWAYS fails closed.
   */
  readonly attestedAddress: Uint8Array | undefined;
  /** The 32-byte address the host derived independently. */
  readonly hostAddress: Uint8Array;
}

/**
 * Throws unless the device advertised CAPS.ATTEST_ADDRESS AND its attested address
 * byte-equals the host derivation. Returns normally (void) on success.
 */
export function assertDeviceAttestedAddress(check: DeviceAttestationCheck): void {
  if ((check.caps & CAPS.ATTEST_ADDRESS) === 0) {
    throw new Error(
      'AHW-098: device does not advertise CAPS_ATTEST_ADDRESS — refusing to trust a ' +
        'receive address that cannot be device-attested (no fallback to host-derived).',
    );
  }
  if (check.attestedAddress === undefined) {
    throw new Error('AHW-098: no device attestation was produced for the receive address.');
  }
  if (check.attestedAddress.length !== 32 || check.hostAddress.length !== 32) {
    throw new Error('AHW-098: receive-address attestation expects 32-byte addresses.');
  }
  // Constant-time-ish byte compare (length already equal).
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= (check.attestedAddress[i] ?? 0) ^ (check.hostAddress[i] ?? 0);
  }
  if (diff !== 0) {
    throw new Error(
      'AHW-098: device-attested receive address != host-derived address — ' +
        'possible host substitution; refusing to proceed.',
    );
  }
}
