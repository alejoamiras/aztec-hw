/**
 * Trezor `AuthWitnessProvider` implementation for Aztec's `EcdsaKAccount`.
 *
 * Architecture per codex review:
 *   - `SignIdentity` is the only viable lower-level path; stock `requestLogin` hides
 *     `ecdsaCurveName`. Adapter is built around explicit `IdentityType` protobuf shape.
 *   - `proto='gpg'` mandatory: only `gpg` mode signs `challenge_hidden` directly. Other
 *     protos fall back to Bitcoin message-signing semantics that Aztec wouldn't accept.
 *   - No separate GetPublicKey — pubkey comes back from `SignIdentity` as 33B compressed.
 *     Adapter caches it across calls and decompresses to 64B `x || y` for Aztec.
 *   - Marker byte (signature[0]) is `0x00` for gpg/ssh sigtypes — strip and ignore.
 *
 * Phase A: blind-sign. Device sees only `sha256(outer_hash.to_be_bytes())` digest.
 * `challenge_visual` is set to an explicit "INTERNAL — DO NOT SHIP" banner.
 * Phase B will implement `IntentAuthWitnessProvider` so the device reconstructs the
 * Aztec call stack from a `CallIntent` and refuses to sign on hash mismatch.
 */

import {
  AuthWitness,
  type AuthWitnessProvider,
  type CallIntent,
  ecdsaPreimage,
  Fr,
  type IntentAuthWitnessProvider,
  normalizeLowS,
  packEcdsaSignature,
  SCALAR_BYTE_LENGTH,
} from '@aztec-hwwallet-poc/core';
import { Point } from '@noble/secp256k1';
import { buildAztecIdentity, type IdentityType } from './identity.ts';
import { computeOuterHashForIntent, formatIntentForDevice } from './intent-utils.ts';
import type { TrezorTransport } from './transport.ts';

const COMPRESSED_PUBKEY_LENGTH = 33;
const TREZOR_SIG_BYTE_LENGTH = 65; // header(1) || r(32) || s(32)

export interface TrezorProviderOptions {
  /** Account index (0, 1, …) — embedded in IdentityType `path` field. */
  readonly accountIndex: number;
  /** Override `challenge_visual` banner. Default: explicit INTERNAL warning. */
  readonly visualBanner?: string;
}

export class TrezorEcdsaKAuthWitnessProvider implements IntentAuthWitnessProvider {
  private cachedXY?: { x: Uint8Array; y: Uint8Array };
  private readonly identity: IdentityType;
  private readonly visualBanner: string;

  constructor(
    private readonly transport: TrezorTransport,
    options: TrezorProviderOptions,
  ) {
    this.identity = buildAztecIdentity({ accountIndex: options.accountIndex });
    this.visualBanner = options.visualBanner ?? 'Aztec authorization (INTERNAL — DO NOT SHIP)';
  }

  /**
   * Aztec `EcdsaKAccount` constructor args:
   *   `[signing_pub_key.x.to_be_bytes::<32>(), signing_pub_key.y.to_be_bytes::<32>()]`.
   *
   * Forces a single `SignIdentity` round-trip (with a deterministic dummy digest) to
   * fetch the pubkey from the device. Result is cached for subsequent createAuthWit calls.
   */
  async getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }> {
    if (this.cachedXY) return this.cachedXY;
    // No standalone get-pubkey API for SLIP-0013 — perform a probe sign to populate the cache.
    // The actual signature is discarded; we only need the returned compressedPublicKey.
    const probeDigest = new Uint8Array(SCALAR_BYTE_LENGTH); // 32 zero bytes
    const signed = await this.transport.signIdentity({
      identity: this.identity,
      ecdsaCurve: 'secp256k1',
      challengeHidden: probeDigest,
      challengeVisual: `${this.visualBanner}\n(initial public-key fetch)`,
    });
    this.cachedXY = decompressPubkey(signed.compressedPublicKey);
    return this.cachedXY;
  }

  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const outerHash = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(messageHash);
    const challengeHidden = ecdsaPreimage(outerHash);
    const visual = this.buildBlindSignVisual(challengeHidden);
    return this.signAndWrap(outerHash, challengeHidden, visual);
  }

  /**
   * **Phase B.1 — decorative clear-signing.** Accept a structured `CallIntent`, derive
   * `outer_hash` from it host-side, render a human-readable summary into `challenge_visual`
   * so the device confirmation screen shows what the user is authorizing.
   *
   * IMPORTANT: this is **decorative only**. The device does not yet recompute
   * `outer_hash` from the displayed fields — a malicious host could in principle show
   * benign visual text while signing a malicious digest. For internal demos this is a
   * real UX upgrade over blind-sign; for public release we need Poseidon2 on-device
   * (Phase B.2, firmware-side work) before this becomes security-grade.
   */
  async createAuthWitFromIntent(intent: CallIntent): Promise<AuthWitness> {
    const outerHash = await computeOuterHashForIntent(intent);
    const challengeHidden = ecdsaPreimage(outerHash);
    const visual = this.buildIntentVisual(intent);
    return this.signAndWrap(outerHash, challengeHidden, visual);
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private async signAndWrap(
    outerHash: Fr,
    challengeHidden: Uint8Array,
    challengeVisual: string,
  ): Promise<AuthWitness> {
    const signed = await this.transport.signIdentity({
      identity: this.identity,
      ecdsaCurve: 'secp256k1',
      challengeHidden,
      challengeVisual,
    });
    if (!this.cachedXY) {
      this.cachedXY = decompressPubkey(signed.compressedPublicKey);
    }
    const { r, s } = unpackTrezorSecp256k1Signature(signed.signature);
    const sNormalized = normalizeLowS(s, 'secp256k1');
    const sigBytes = packEcdsaSignature(r, sNormalized);
    return new AuthWitness(outerHash, Array.from(sigBytes));
  }

  private buildBlindSignVisual(digest: Uint8Array): string {
    const truncatedHex = Buffer.from(digest.slice(0, 6)).toString('hex');
    return `${this.visualBanner}\nDigest: 0x${truncatedHex}…`;
  }

  private buildIntentVisual(intent: CallIntent): string {
    return `${this.visualBanner}\n${formatIntentForDevice(intent)}`;
  }
}

/**
 * Strip the Trezor `SignIdentity` wire-format signature into raw `(r, s)`.
 *
 * Wire: `header(1) || r(32) || s(32)` = 65 bytes. For `gpg`/`ssh` sigtypes `header`
 * is overwritten with `0x00` by `sign_identity.py` (codex finding #5). We ignore it.
 */
function unpackTrezorSecp256k1Signature(raw: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  if (raw.length !== TREZOR_SIG_BYTE_LENGTH) {
    throw new Error(
      `Unexpected Trezor signature length: expected ${TREZOR_SIG_BYTE_LENGTH} (header || r || s), got ${raw.length}`,
    );
  }
  return {
    r: raw.slice(1, 1 + SCALAR_BYTE_LENGTH),
    s: raw.slice(1 + SCALAR_BYTE_LENGTH, 1 + 2 * SCALAR_BYTE_LENGTH),
  };
}

/**
 * Decompress a 33-byte compressed secp256k1 public key (`02/03 || X(32)`) to 64 bytes
 * `X || Y` — the shape Aztec's `EcdsaKAccount` constructor expects.
 */
function decompressPubkey(compressed: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (compressed.length !== COMPRESSED_PUBKEY_LENGTH) {
    throw new Error(
      `Compressed pubkey must be ${COMPRESSED_PUBKEY_LENGTH} bytes (02/03 || X), got ${compressed.length}`,
    );
  }
  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error(
      `Compressed pubkey prefix must be 0x02 or 0x03, got 0x${prefix?.toString(16) ?? 'undef'}`,
    );
  }
  const point = Point.fromBytes(compressed);
  const uncompressed = point.toBytes(false); // 65 bytes: 0x04 || X || Y
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error(
      `noble returned non-standard uncompressed pubkey (length ${uncompressed.length}, prefix 0x${uncompressed[0]?.toString(16) ?? 'undef'})`,
    );
  }
  return {
    x: uncompressed.slice(1, 1 + SCALAR_BYTE_LENGTH),
    y: uncompressed.slice(1 + SCALAR_BYTE_LENGTH, 1 + 2 * SCALAR_BYTE_LENGTH),
  };
}
