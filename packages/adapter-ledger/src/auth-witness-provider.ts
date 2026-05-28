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
 * M5 clear signing (live since the clear-signing-v0 arc): device recomputes
 * Poseidon2 over a streamed call manifest AND args_hash from raw args (the
 * trusted-session invariant — host's claimed args_hash never survives past
 * the APPEND_CALL parity gate), runs a strict-allowlist registry+verb lookup
 * with `from == consumer` enforced for 4-arg transfers, and renders decoded
 * FT semantics (amount + recipient + symbol) on-device. `createAuthWitFromIntent`
 * routes through that path. `createAuthWit(outerHash)` is the legacy L2
 * blind-sign path, kept available for txs the framework can't route through
 * the intent surface (account deploys, etc.).
 */
import {
  AuthWitness,
  type CallIntent,
  Fr,
  type IntentAuthWitnessProvider,
  packEcdsaSignature,
} from '@aztec-hwwallet-poc/core';
import { preflightIntent } from './clear_signing_v0/preflight.ts';
import type { DeployContext } from './deploy-context.ts';
import { buildL4Manifest } from './l4-manifest.ts';
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
   * **L4 verified-calls signing.** Builds the manifest from the intent, streams it
   * to the device (`BEGIN_AUTHWIT` → `APPEND_CALL` × N), submits the host-claimed
   * `outer_hash` via `FINALIZE_AND_SIGN`, and returns the signature *only* if the
   * device's independent recomputation agrees with our claim. Mismatch → device
   * rejects with `SW_HASH_MISMATCH` (never signs).
   *
   * Unlike the prior decorative path (`computeOuterHashForIntent`), this binds
   * the on-device review screens to the same `outer_hash` that the host's Aztec
   * verifier checks. The host is no longer the sole authority on what gets signed.
   */
  async createAuthWitFromIntent(intent: CallIntent, txNonce?: Fr): Promise<AuthWitness> {
    /* Host-side preflight (M5.4): mirrors the device's M5.2 strict-allowlist
     * gates. Fails fast with a clear TS error instead of burning APDU
     * round-trips to get an opaque 0x6F0x SW. */
    preflightIntent(intent);

    /* txNonce gets folded into the inner_hash payload (l4-manifest.ts:177).
     * When the caller pre-signs ahead of a framework createTxExecutionRequest
     * that uses a chosen nonce, they MUST pass that same nonce here or
     * FrozenAuthWitnessProvider will reject the witness as hash-mismatched.
     * Unset defaults to zero, matching the M5 demo where the framework
     * was not picking a custom nonce. */
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: this.options.bip32Path,
      txNonce: txNonce ? txNonce.toBuffer() : undefined,
    });

    /* Defensive: if any prior session is dangling on the device, ABORT clears it.
     * BEGIN_AUTHWIT itself also zeroes state, but a stray APPEND from an aborted
     * prior call won't be possible after this. Cheap, idempotent. */
    await this.inner.abortAuthwit();

    await this.inner.beginAuthwit(manifest.header);
    for (const call of manifest.calls) {
      await this.inner.appendCall(call);
    }
    const sig = await this.inner.finalizeAndSign(
      manifest.claimedOuterHash,
      this.options.signOptions ?? {},
    );
    const sigBytes = packEcdsaSignature(sig.r, sig.s);
    const outerHash = Fr.fromBuffer(Buffer.from(manifest.claimedOuterHash));
    return new AuthWitness(outerHash, Array.from(sigBytes));
  }

  /**
   * **M8 P1 — clear-signed deploy authwit.** Sends the M7-P3-shipped
   * `INS_BEGIN_DEPLOY_ACCOUNT` + `INS_FINALIZE_DEPLOY_AND_SIGN` flow:
   *   1. BEGIN encodes the DeployContext (profile id + path + chain + salt +
   *      publicKeysHash + expected_address) and runs the device's 3-pass
   *      partial_address parity recompute. Reject on internal mismatch.
   *   2. FINALIZE submits `messageHash` (the framework-computed outer_hash),
   *      renders the NBGL deploy-review UI (address + path + fee), waits for
   *      user approval, signs `sha256(messageHash)` with the BIP-32 ECDSA-K1
   *      key, runs duplicate-sign fault check, returns `(r, s)`.
   *
   * Returns an `AuthWitness` carrying `(messageHash, packed_sig_64)`. The
   * caller wraps this in a `FrozenAuthWitnessProvider` so the framework's
   * `account_entrypoint.ts:131` createAuthWit lookup returns this witness
   * during the second pass of `deployMethod.request(...)`.
   *
   * Phase 6 closure: the device-side `publicKeysHash` + address + outer_hash
   * recompute lands in Phase 6, alongside Grumpkin. As of Phase 1 the device
   * still trusts the host-supplied `publicKeysHash` and `expected_address`
   * — same trust model as M7 P3, but now reached via the clear-signed flow
   * with the deploy-review UI playing for real.
   */
  async createAuthWitForDeploy(
    ctx: DeployContext,
    messageHash: Fr | Buffer,
    opts?: SignOuterHashOptions,
  ): Promise<AuthWitness> {
    const outerHashFr =
      messageHash instanceof Fr ? messageHash : Fr.fromBuffer(Buffer.from(messageHash));
    const outerHashBytes = new Uint8Array(outerHashFr.toBuffer());

    /* M7 P3 already wired BEGIN_DEPLOY_ACCOUNT + FINALIZE_DEPLOY_AND_SIGN
     * end-to-end; we just sequence them with the framework-supplied hash. */
    await this.inner.beginDeployAccount(ctx);
    const sig = await this.inner.finalizeDeployAndSign(
      outerHashBytes,
      opts ?? this.options.signOptions ?? {},
    );
    const sigBytes = packEcdsaSignature(sig.r, sig.s);
    return new AuthWitness(outerHashFr, Array.from(sigBytes));
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
