/**
 * Abstract Trezor transport — implemented by `@trezor/connect`-backed code for
 * real / emulator devices, or by a mock for unit tests.
 *
 * Models the lower-level `SignIdentity` protobuf surface (cf. `trezor-firmware/core/src/apps/misc/sign_identity.py`):
 *
 *   GetPublicKey(identity, ecdsa_curve_name) → PublicKey  -- pseudo-form via SignIdentity GET
 *   SignIdentity(identity, challenge_hidden, ecdsa_curve_name) → SignedIdentity {address, public_key, signature}
 *
 * `signature` is `marker_byte(1) || r(32) || s(32) || v(1)?` in Trezor's wire format
 * (variant differs by curve); the adapter strips marker/v and returns raw `r ‖ s` to Aztec.
 */

export interface TrezorPublicKey {
  /** Uncompressed secp256k1 public key, 65 bytes: `0x04 || X(32) || Y(32)`. */
  readonly bytes: Uint8Array;
}

export interface TrezorSignedIdentity {
  /**
   * Raw signature bytes as Trezor returns them. The caller is responsible for
   * stripping the leading marker byte (and trailing v if present) before
   * feeding into Aztec's auth-witness path.
   */
  readonly signature: Uint8Array;
  /** Public key the device used to sign, redundantly returned for cross-check. */
  readonly publicKey: TrezorPublicKey;
}

export interface TrezorTransport {
  /**
   * Get the device's public key for a given SLIP-0013 identity + ECDSA curve.
   *
   * @param identity      SLIP-0013 identity URL (e.g. `aztec://account/0`).
   * @param ecdsaCurve    `secp256k1` for `EcdsaKAccount`; `nist256p1` for `EcdsaRAccount`.
   */
  getPublicKey(identity: string, ecdsaCurve: 'secp256k1' | 'nist256p1'): Promise<TrezorPublicKey>;

  /**
   * Sign a raw 32-byte challenge digest via `SignIdentity(proto="gpg")`.
   * The device shows `challenge_visual` for user confirmation; `challenge_hidden`
   * is the actual signed payload.
   *
   * @param identity         SLIP-0013 identity URL.
   * @param ecdsaCurve       Signing curve.
   * @param challengeHidden  32-byte digest to sign (Aztec passes `sha256(outer_hash.to_be_bytes())`).
   * @param challengeVisual  Optional human-readable label (Phase A: terse "Aztec auth-witness" + truncated hash).
   */
  signIdentity(args: {
    identity: string;
    ecdsaCurve: 'secp256k1' | 'nist256p1';
    challengeHidden: Uint8Array;
    challengeVisual?: string;
  }): Promise<TrezorSignedIdentity>;

  /** Optional explicit disconnect / cleanup hook. */
  close?(): Promise<void>;
}
