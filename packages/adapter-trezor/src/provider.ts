/**
 * Trezor `AuthWitnessProvider` implementation for Aztec's `EcdsaKAccount`.
 *
 * Phase A: blind-sign. The device sees only the `sha256(outer_hash.to_be_bytes())`
 * digest in `challenge_hidden` — no human-meaningful tx summary on screen. Acceptable
 * for INTERNAL research demos only (see `architectures/02-clear-signing-interface.md`).
 * `challengeVisual` is set to a terse "Aztec authorization (INTERNAL — DO NOT SHIP)"
 * banner plus a truncated hex of the digest, so the user can at least eyeball that
 * the host hasn't substituted a different request — but this is decorative without
 * cryptographic binding.
 *
 * Phase B will implement `IntentAuthWitnessProvider` so the device reconstructs the
 * Aztec call stack from a `CallIntent` and refuses to sign on hash mismatch.
 */

import {
  AuthWitness,
  type AuthWitnessProvider,
  ecdsaPreimage,
  Fr,
  normalizeLowS,
  packEcdsaSignature,
  SCALAR_BYTE_LENGTH,
} from '@aztec-hwwallet-poc/core';
import { buildAztecIdentity } from './identity.ts';
import type { TrezorTransport } from './transport.ts';

/** Length of the Trezor secp256k1 signature wire format = `marker(1) || r(32) || s(32)` = 65 bytes. */
const TREZOR_SECP256K1_SIG_BYTE_LENGTH = 65;

export interface TrezorProviderOptions {
  /** Account index (0, 1, 2, …) — selects which Aztec signing key on the device. */
  readonly accountIndex: number;
  /**
   * Optional override for the `challenge_visual` text shown on-device.
   * Default: terse "Aztec authorization (INTERNAL — DO NOT SHIP)" + truncated digest.
   * Phase B / production: replaced by structured intent display.
   */
  readonly visualBanner?: string;
}

export class TrezorEcdsaKAuthWitnessProvider implements AuthWitnessProvider {
  private cachedPublicKey?: Uint8Array;
  private readonly identity: string;
  private readonly visualBanner: string;

  constructor(
    private readonly transport: TrezorTransport,
    options: TrezorProviderOptions,
  ) {
    this.identity = buildAztecIdentity(options.accountIndex);
    this.visualBanner = options.visualBanner ?? 'Aztec authorization (INTERNAL — DO NOT SHIP)';
  }

  /**
   * Fetch the device's secp256k1 public key — used at account-contract deployment
   * time as the `EcdsaKAccount` constructor arg (`signing_pub_key_x`, `signing_pub_key_y`).
   *
   * Returns the **uncompressed** 65-byte form `0x04 || X(32) || Y(32)`.
   * Aztec's `EcdsaKAccount` constructor splits this into `[X(32)]` + `[Y(32)]` args.
   */
  async getPublicKey(): Promise<Uint8Array> {
    if (this.cachedPublicKey) return this.cachedPublicKey;
    const pk = await this.transport.getPublicKey(this.identity, 'secp256k1');
    if (pk.bytes.length !== 65 || pk.bytes[0] !== 0x04) {
      throw new Error(
        `Unexpected public-key format: expected 65-byte uncompressed (0x04 || X || Y), got ${pk.bytes.length} bytes with prefix 0x${pk.bytes[0]?.toString(16) ?? 'undef'}`,
      );
    }
    this.cachedPublicKey = pk.bytes;
    return pk.bytes;
  }

  /**
   * Aztec `EcdsaKAccount` constructor args:
   *   `[signing_pub_key.x.to_be_bytes::<32>(), signing_pub_key.y.to_be_bytes::<32>()]`.
   *
   * Returns `{ x, y }` ready to splat into the constructor.
   */
  async getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }> {
    const pk = await this.getPublicKey();
    // Skip the 0x04 prefix.
    return {
      x: pk.slice(1, 1 + SCALAR_BYTE_LENGTH),
      y: pk.slice(1 + SCALAR_BYTE_LENGTH, 1 + 2 * SCALAR_BYTE_LENGTH),
    };
  }

  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const outerHash = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(messageHash);
    const challengeHidden = ecdsaPreimage(outerHash);

    const visual = buildVisualBanner(this.visualBanner, challengeHidden);
    const signed = await this.transport.signIdentity({
      identity: this.identity,
      ecdsaCurve: 'secp256k1',
      challengeHidden,
      challengeVisual: visual,
    });

    const { r, s } = unpackTrezorSecp256k1Signature(signed.signature);
    const sNormalized = normalizeLowS(s, 'secp256k1');
    const sigBytes = packEcdsaSignature(r, sNormalized);

    // AuthWitness witness is a flat array of bytes-as-numbers (Fr | number).
    return new AuthWitness(outerHash, Array.from(sigBytes));
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

/**
 * Strip Trezor's wire-format signature into raw `(r, s)`.
 *
 * Trezor's `SignIdentity` secp256k1 output is `marker_byte(1) || r(32) || s(32)`:
 * the leading marker byte (`0x1f + recovery_id`) is Ethereum-style recovery info
 * Aztec doesn't consume.
 */
function unpackTrezorSecp256k1Signature(raw: Uint8Array): {
  marker: number;
  r: Uint8Array;
  s: Uint8Array;
} {
  if (raw.length !== TREZOR_SECP256K1_SIG_BYTE_LENGTH) {
    throw new Error(
      `Unexpected Trezor signature length: expected ${TREZOR_SECP256K1_SIG_BYTE_LENGTH} bytes (marker || r || s), got ${raw.length}`,
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees byte 0 exists
  const marker = raw[0]!;
  const r = raw.slice(1, 1 + SCALAR_BYTE_LENGTH);
  const s = raw.slice(1 + SCALAR_BYTE_LENGTH, 1 + 2 * SCALAR_BYTE_LENGTH);
  return { marker, r, s };
}

function buildVisualBanner(banner: string, digest: Uint8Array): string {
  const truncatedHex = Buffer.from(digest.slice(0, 6)).toString('hex');
  return `${banner}\nDigest: 0x${truncatedHex}…`;
}
