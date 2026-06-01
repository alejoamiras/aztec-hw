/**
 * M-seam P0 — `LedgerClearSigningEntrypoint`: the PROPER seam for device
 * clear-signing, replacing the hash-only `AuthWitnessProvider` + the parallel
 * `createAuthWitFromIntent` driving + the deploy spy/freeze.
 *
 * aztec.js routes all tx signing through `EntrypointInterface.createTxExecutionRequest(exec, …)`
 * (and `wrapExecutionPayload` for self-paid deploy), which receive the FULL
 * `ExecutionPayload` — exactly what a clear-signing device needs. We compose the
 * stock `DefaultAccountEntrypoint` (so the canonical entrypoint-arg encoding +
 * `TxExecutionRequest` assembly are REUSED, not copied) and give it an inner
 * `AuthWitnessProvider` whose `createAuthWit(messageHash)` returns a device
 * witness we produced IN-BAND, moments earlier, by clear-signing the same calls.
 *
 * Why in-band (audit B2): `BaseWallet.sendTx` chooses `txNonce` and passes it
 * into `createTxExecutionRequest`, then proves *that exact* request. Signing
 * inside this method (consuming that `txNonce`) makes the device sign exactly the
 * nonce that lands on-chain — no pre-sign/freeze mismatch.
 *
 * Security: the device independently recomputes the outer_hash from the streamed
 * calls and rejects on mismatch (`SW_HASH_MISMATCH`); the host `messageHash` is a
 * CROSS-CHECK, never a trust input. `#consume` enforces stream-A-claim-B: the
 * inner entrypoint's recomputed hash MUST equal the hash we showed+signed on the
 * device, else we refuse to hand back a witness.
 *
 * P0 keeps `buildL4Manifest` (our device wire-encoding) for the stream, and
 * asserts its `claimedOuterHash` equals the CANONICAL `computeOuterAuthWitHash`
 * over `EncodedAppEntrypointCalls` — the parity that justifies dropping the
 * replica in P1.
 */
import {
  DefaultAccountEntrypoint,
  type DefaultAccountEntrypointOptions,
} from '@aztec/entrypoints/account';
import { EncodedAppEntrypointCalls } from '@aztec/entrypoints/encoding';
import type { ChainInfo, EntrypointInterface } from '@aztec/entrypoints/interfaces';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AuthWitness, computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { GasSettings } from '@aztec/stdlib/gas';
import type { ExecutionPayload, TxExecutionRequest } from '@aztec/stdlib/tx';

import { packEcdsaSignature } from '@aztec-hwwallet-poc/core';
import type { CurveId } from './apdu.ts';
import { preflightIntent } from './clear_signing_v0/preflight.ts';
import { buildL4Manifest } from './l4-manifest.ts';
import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';
import type { LedgerProvider, SignOuterHashOptions } from './provider.ts';

export interface ClearSigningEntrypointOptions {
  readonly bip32Path: readonly number[];
  readonly curveId?: CurveId;
  readonly signOptions?: SignOuterHashOptions;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export class LedgerClearSigningEntrypoint implements EntrypointInterface {
  readonly #inner: DefaultAccountEntrypoint;
  /** One-shot device witness produced by the in-band clear-sign, keyed by hash. */
  #pending: { readonly hashHex: string; readonly wit: AuthWitness } | null = null;

  constructor(
    private readonly address: AztecAddress,
    private readonly device: LedgerProvider,
    private readonly options: ClearSigningEntrypointOptions,
  ) {
    // The inner entrypoint owns the canonical encoding + request assembly. Its
    // auth provider returns OUR in-band device witness (hash-checked).
    this.#inner = new DefaultAccountEntrypoint(address, {
      createAuthWit: (messageHash: Fr | Buffer) => this.#consume(messageHash),
    });
  }

  async createTxExecutionRequest(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<TxExecutionRequest> {
    await this.#clearSignOnDevice(exec, chainInfo, options.txNonce);
    // Delegate: the inner re-derives the same messageHash and calls our
    // createAuthWit, which returns the device witness iff the hash matches.
    return this.#inner.createTxExecutionRequest(exec, gasSettings, chainInfo, options);
  }

  async wrapExecutionPayload(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    options: DefaultAccountEntrypointOptions,
  ): Promise<ExecutionPayload> {
    await this.#clearSignOnDevice(exec, chainInfo, options.txNonce);
    return this.#inner.wrapExecutionPayload(exec, chainInfo, options);
  }

  /** Stream the calls to the device, clear-sign, stash the witness keyed by the
   * CANONICAL outer_hash. */
  async #clearSignOnDevice(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    txNonce?: Fr,
  ): Promise<void> {
    const intent = projectExecutionPayloadIntoCallIntent(exec, this.address, chainInfo);
    preflightIntent(intent); // keep the host-side allowlist (clear TS errors, not opaque device SW)

    // Canonical hash (what the inner entrypoint + the chain compute).
    const nonce = txNonce ?? Fr.ZERO;
    const encoded = await EncodedAppEntrypointCalls.create(exec.calls, nonce);
    const payloadHash = await encoded.hash();
    const messageHash = await computeOuterAuthWitHash(
      this.address,
      chainInfo.chainId,
      chainInfo.version,
      payloadHash,
    );
    const messageHashBytes = new Uint8Array(messageHash.toBuffer());

    // Device wire stream (our encoding) + PARITY: our replica == canonical.
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: this.options.bip32Path,
      txNonce: new Uint8Array(nonce.toBuffer()),
      curveId: this.options.curveId,
    });
    if (!bytesEqual(manifest.claimedOuterHash, messageHashBytes)) {
      throw new Error(
        'clear-sign parity failure: device manifest outer_hash != canonical EncodedAppEntrypointCalls hash',
      );
    }

    await this.device.abortAuthwit();
    await this.device.beginAuthwit(manifest.header);
    for (const call of manifest.calls) await this.device.appendCall(call);
    const sig = await this.device.finalizeAndSign(messageHashBytes, this.options.signOptions ?? {});

    this.#pending = {
      hashHex: messageHash.toString(),
      wit: new AuthWitness(messageHash, Array.from(packEcdsaSignature(sig.r, sig.s))),
    };
  }

  /** Hand the inner entrypoint the device witness — only if its recomputed hash
   * matches the one we showed + signed (stream-A-claim-B guard). */
  async #consume(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const hf = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(Buffer.from(messageHash));
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || pending.hashHex !== hf.toString()) {
      throw new Error(
        'LedgerClearSigningEntrypoint: inner hash does not match the device-signed hash (refusing to sign what was not reviewed)',
      );
    }
    return pending.wit;
  }
}
