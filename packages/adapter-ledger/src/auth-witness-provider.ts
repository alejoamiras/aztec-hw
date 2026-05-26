/**
 * Ledger `AuthWitnessProvider` implementation for Aztec's `EcdsaKAccount`.
 *
 * Mirrors `@aztec-hwwallet-poc/adapter-trezor`'s `TrezorEcdsaKAuthWitnessProvider`
 * but talks to the custom Aztec Ledger BOLOS app (`ledger-app/`) over an
 * `LedgerTransport` (Speculos in tests, `@ledgerhq/hw-transport-*` in prod).
 *
 * Key contract differences vs. Trezor:
 *   - Device-side SHA-256: the Ledger app accepts the raw 32-byte `outer_hash`
 *     and internally computes `sha256(outer_hash)` before signing
 *     (plan-final.md §2 / final-critique §1). We send the outer_hash, NOT
 *     the pre-hashed digest.
 *   - Device returns raw `r || s` (64 B), low-S normalized on-device. No `v`,
 *     no Trezor header byte, no DER.
 *   - Standalone `GET_PUBLIC_KEY` APDU — no probe-sign needed to fetch x||y.
 *
 * Phase A — blind sign (L2). UI confirmation is rendered by the device firmware
 * via `nbgl_useCaseReviewBlindSigning`, not by host text. The "INTERNAL — DO NOT
 * SHIP" banner is baked into the on-device flow.
 *
 * Phase B / L4 — clear signing. Device recomputes Poseidon2 over a streamed call
 * manifest and verifies the host-claimed outer_hash matches. Until then,
 * `createAuthWitFromIntent` is just decorative on the host side.
 */
import {
  AuthWitness,
  type CallIntent,
  computeOuterHashForIntent,
  Fr,
  type IntentAuthWitnessProvider,
  packEcdsaSignature,
} from '@aztec-hwwallet-poc/core';
import { LedgerProvider, type SignOuterHashOptions } from './provider.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerProviderOptions {
  /** BIP-32 path the device should use. */
  readonly bip32Path: readonly number[];
  /**
   * Optional auto-confirm hook for Speculos. Real-device builds leave this
   * `undefined`; the user confirms on the physical screen.
   */
  readonly signOptions?: SignOuterHashOptions;
}

export class LedgerEcdsaKAuthWitnessProvider implements IntentAuthWitnessProvider {
  private readonly inner: LedgerProvider;
  private cachedXY?: { x: Uint8Array; y: Uint8Array };

  constructor(
    transport: LedgerTransport,
    private readonly options: LedgerProviderOptions,
  ) {
    this.inner = new LedgerProvider(transport);
  }

  /**
   * 64-byte `X || Y` shape that Aztec's `EcdsaKAccount` constructor expects.
   * Caches across calls so subsequent createAuthWit calls don't re-probe.
   */
  async getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }> {
    if (this.cachedXY) return this.cachedXY;
    const pk = await this.inner.getPublicKey(this.options.bip32Path);
    this.cachedXY = { x: pk.x, y: pk.y };
    return this.cachedXY;
  }

  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const outerHash = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(messageHash);
    return this.signAndWrap(outerHash);
  }

  /**
   * **Phase B.1 decorative clear-signing parity.** Compute `outer_hash` host-side
   * from a `CallIntent`, then blind-sign on the device. Until L4 ports
   * on-device Poseidon2, this offers no extra security guarantee beyond
   * `createAuthWit` — the device still cannot verify the intent matches the
   * outer_hash it is about to sign.
   */
  async createAuthWitFromIntent(intent: CallIntent): Promise<AuthWitness> {
    const outerHash = await computeOuterHashForIntent(intent);
    return this.signAndWrap(outerHash);
  }

  private async signAndWrap(outerHash: Fr): Promise<AuthWitness> {
    const outerBytes = new Uint8Array(outerHash.toBuffer());
    const sig = await this.inner.signOuterHash(
      this.options.bip32Path,
      outerBytes,
      this.options.signOptions ?? {},
    );
    const sigBytes = packEcdsaSignature(sig.r, sig.s);
    return new AuthWitness(outerHash, Array.from(sigBytes));
  }
}
