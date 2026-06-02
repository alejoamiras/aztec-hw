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
 * P1 (entrypoint-seam-refactor): device CLEAR-signing now routes through
 * `LedgerClearSigningEntrypoint` (built via `createClearSigningEntrypoint`), which
 * streams the call manifest to the device (BEGIN_AUTHWIT → APPEND_CALL → FINALIZE);
 * the device recomputes the outer_hash, renders decoded FT semantics, and rejects on
 * mismatch. This provider now exposes only:
 *   - `getPublicKeyXY()` — the signing pubkey for the account ctor;
 *   - `createClearSigningEntrypoint(addr)` — the proper clear-signing seam;
 *   - `createAuthWit()` — FAIL-CLOSED (AHW-001): blind hash-only signing is disabled;
 *     app-level authwits must use the clear-signing entrypoint. The device
 *     `blind_signing` setting (default OFF) is the separate device-level backstop.
 * The retired `createAuthWitFromIntent` (TX-driving) + `createAuthWitForDeploy`
 * (spy/freeze deploy) are gone — their job is the entrypoint's now.
 */

import type { AuthWitnessProvider } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { AuthWitness, Fr } from '@aztec-hwwallet-poc/core';
import { CURVE_ID, type CurveId } from './apdu.ts';
import { LedgerClearSigningEntrypoint } from './clear-signing-entrypoint.ts';
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
  /**
   * M10 — signature scheme. `CURVE_ID.SECP256K1` (default, ECDSA-K) or
   * `CURVE_ID.GRUMPKIN` (Schnorr). Drives the BEGIN_AUTHWIT header.key.curveId
   * (device dispatch) AND which pubkey APDU getPublicKeyXY calls.
   */
  readonly curveId?: CurveId;
}

export class LedgerEcdsaKAuthWitnessProvider implements AuthWitnessProvider {
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
    /* M10: Schnorr accounts derive a Grumpkin pubkey via GET_SCHNORR_PUBKEY;
     * ECDSA-K uses the secp256k1 GET_PUBLIC_KEY. Both return 64B X||Y. */
    const pk =
      this.options.curveId === CURVE_ID.GRUMPKIN
        ? await this.inner.getSchnorrPublicKey(this.options.bip32Path)
        : await this.inner.getPublicKey(this.options.bip32Path);
    this.cachedXY = { x: pk.x, y: pk.y };
    return this.cachedXY;
  }

  async createAuthWit(_messageHash: Fr | Buffer): Promise<AuthWitness> {
    /* AHW-001 (host fail-close): blind, hash-only authwit signing is DISABLED.
     * `EmbeddedWallet.sendTx` auto-derives app-level authwits from a tx's offchain
     * effects and would route them here for a blind (no-decode) device sign —
     * OUTSIDE the clear-sign review the user actually sees. We refuse outright:
     * app-level authorizations must go through the clear-signing entrypoint
     * (`createClearSigningEntrypoint`), which the device decodes + renders. The
     * device's `blind_signing` setting (default OFF) is the separate, user-sovereign
     * DEVICE-level backstop for any explicit raw sign; the host never blind-signs on
     * the auto path. (Schnorr never had a raw hash-only sign at all.) */
    throw new Error(
      'createAuthWit: blind (hash-only) authwit signing is disabled on the host. Route ' +
        'app-level authorizations through the clear-signing entrypoint (createClearSigningEntrypoint).',
    );
  }

  /**
   * P0 seam spike — build the in-band clear-signing entrypoint backed by THIS
   * provider's device + options. `BaseAccount(entrypoint, …)` then routes the
   * real `EmbeddedWallet.sendTx` through `createTxExecutionRequest`, which
   * clear-signs the full payload on the device in-band (consuming the framework
   * `txNonce`) — the proper seam, replacing the `submitClearSignedIntent` bypass.
   * Reuses the SAME device transport + options (path/curve/signOptions).
   */
  createClearSigningEntrypoint(address: AztecAddress): LedgerClearSigningEntrypoint {
    return new LedgerClearSigningEntrypoint(address, this.inner, {
      bip32Path: this.options.bip32Path,
      curveId: this.options.curveId,
      signOptions: this.options.signOptions,
    });
  }
}
