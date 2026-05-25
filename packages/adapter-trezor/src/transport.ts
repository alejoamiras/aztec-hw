/**
 * Abstract Trezor transport — implemented by `@trezor/connect-node` or `trezorlib`-bridge
 * for real / emulator devices, or by a mock for unit tests.
 *
 * Models the `SignIdentity` protobuf surface only (per codex review: stock
 * `TrezorConnect.requestLogin` doesn't expose `ecdsaCurveName`; the lowest legitimate
 * surface for Aztec K1 is `trezorlib.misc.sign_identity` or a custom
 * `@trezor/transport` + `@trezor/protobuf` client).
 *
 * IMPORTANT (codex finding #3): there is no separate `GetPublicKey(identity, curve)` API
 * for the SLIP-0013 auth namespace. The public key is returned as a side effect of
 * `SignIdentity`. So this transport collapses to a single `signIdentity` call that
 * returns both the signature AND the compressed public key.
 *
 * Why compressed pubkey: Trezor's `SignedIdentity.public_key` is 33 bytes
 * (`02/03 || X(32)`) per `HDNode.public_key()`. The adapter decompresses to 64 bytes
 * `x || y` for Aztec's `EcdsaKAccount` constructor.
 */

import type { IdentityType } from './identity.ts';

export interface TrezorSignedIdentity {
  /**
   * 33-byte secp256k1 compressed public key returned by the device:
   *   `0x02 || X(32)` (Y even)  OR  `0x03 || X(32)` (Y odd)
   *
   * The adapter decompresses this to 64 bytes `X || Y` (no prefix) for Aztec.
   */
  readonly compressedPublicKey: Uint8Array;

  /**
   * 65-byte signature wire format from Trezor: `header(1) || r(32) || s(32)`.
   *
   * `header` is normally `27 + parity + 4*compressed`, BUT codex finding #5:
   * `SignIdentity` overwrites byte 0 with `0x00` for `gpg` and `ssh` sigtypes.
   * So the adapter strips byte 0 and ignores it (no recovery info available).
   */
  readonly signature: Uint8Array;
}

export interface TrezorTransport {
  /**
   * Invoke `SignIdentity(proto, hidden, visual, ecdsaCurveName)` on the device.
   *
   * @param identity         Aztec `IdentityType` (see `identity.ts`). Adapter enforces `proto='gpg'`.
   * @param ecdsaCurve       Signing curve: `'secp256k1'` (K1Account) or `'nist256p1'` (RAccount).
   * @param challengeHidden  32-byte digest to sign DIRECTLY (no internal hashing).
   *                         Adapter passes `sha256(outer_hash.to_be_bytes())`.
   * @param challengeVisual  Human-readable string shown on-device. Phase A: INTERNAL banner.
   */
  signIdentity(args: {
    identity: IdentityType;
    ecdsaCurve: 'secp256k1' | 'nist256p1';
    challengeHidden: Uint8Array;
    challengeVisual: string;
  }): Promise<TrezorSignedIdentity>;

  /** Optional explicit disconnect / cleanup hook. */
  close?(): Promise<void>;
}
