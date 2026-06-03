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
 * P1: `buildL4Manifest` provides the device WIRE bytes only; the signed outer_hash is
 * the CANONICAL `computeOuterAuthWitHash` over `EncodedAppEntrypointCalls`. The old
 * host replica (the 2770bcb-pinned `claimedOuterHash`) is retired — the device rejects
 * on mismatch at runtime, and `l4-manifest-parity.test.ts` verifies the device's
 * algorithm matches the installed canonical (4.2.1).
 */

import { packEcdsaSignature } from '@alejoamiras/aztec-ledger-core';
import {
  AccountFeePaymentMethodOptions,
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
import type { CurveId } from './apdu.ts';
import { preflightIntent } from './clear_signing_v0/preflight.ts';
import type { DeployContext } from './deploy-context.ts';
import { buildL4Manifest } from './l4-manifest.ts';
import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';
import type { LedgerProvider, SignOuterHashOptions } from './provider.ts';

export interface ClearSigningEntrypointOptions {
  readonly bip32Path: readonly number[];
  readonly curveId?: CurveId;
  /** AHW-018 (wire v3): the account's deploy salt + allowlisted template id, sent on
   * BEGIN_AUTHWIT so the device re-derives the right account. Default salt Fr.ZERO,
   * profileId 0 (the K1 demo account); the Schnorr contract threads profileId 1. */
  readonly salt?: Uint8Array | bigint;
  readonly profileId?: number;
  readonly signOptions?: SignOuterHashOptions;
}

/**
 * Options for a DEPLOY routed through `wrapExecutionPayload` — the standard
 * entrypoint options PLUS the `DeployContext` the device needs for its M8-P6
 * sovereignty re-derivation (device re-derives pkh+address from its own secret,
 * rejects if != ctx.expectedAddress) + the deploy-review UI. The host carries it
 * via `fee.feeEntrypointOptions`, which aztec.js passes verbatim as `options`
 * (AccountEntrypointMetaPaymentMethod → account.wrapExecutionPayload). The inner
 * `DefaultAccountEntrypoint` only reads {cancellable,txNonce,feePaymentMethodOptions},
 * so the extra `deployContext` field is inert to it.
 */
export interface ClearSignDeployOptions extends DefaultAccountEntrypointOptions {
  /** Namespaced sideband (codex: avoid a raw top-level field collision) carried via
   * `fee.feeEntrypointOptions`; the stock entrypoint ignores unknown fields. */
  readonly ledgerDeployContext?: DeployContext;
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
    this.#assertClearSignPolicy(exec, options, 'tx');
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
    // DEPLOY (P0 b): the framework routes a self-paid account deploy through here
    // (DeployAccountMethod[deployer:ZERO] → getSelfFeePaymentMethod →
    // AccountEntrypointMetaPaymentMethod.getExecutionPayload →
    // account.wrapExecutionPayload(feePayload, chainInfo, feeEntrypointOptions)).
    // When a DeployContext rides in `options`, run the device DEPLOY flow (sovereignty
    // re-derive + deploy-review) over the SAME canonical outer_hash; else normal clear-sign.
    const deployContext = (options as ClearSignDeployOptions).ledgerDeployContext;
    if (deployContext) {
      this.#assertClearSignPolicy(exec, options, 'deploy');
      await this.#deploySignOnDevice(exec, chainInfo, options.txNonce, deployContext);
    } else {
      this.#assertClearSignPolicy(exec, options, 'tx');
      await this.#clearSignOnDevice(exec, chainInfo, options.txNonce);
    }
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
    const {
      hash: messageHash,
      bytes: messageHashBytes,
      nonce,
    } = await this.#canonicalOuterHash(exec, chainInfo, txNonce);

    // Device WIRE stream. We sign the CANONICAL messageHash (below, via
    // @aztec/entrypoints/encoding); the device independently recomputes the outer_hash
    // from this stream and rejects on mismatch (SW_HASH_MISMATCH). The host-vs-canonical
    // parity of this wire encoding is covered by l4-manifest-parity.test.ts — no per-tx
    // host replica (the old 2770bcb-pinned claimedOuterHash) is needed.
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: this.options.bip32Path,
      txNonce: new Uint8Array(nonce.toBuffer()),
      curveId: this.options.curveId,
      salt: this.options.salt,
      profileId: this.options.profileId,
    });

    await this.device.abortAuthwit();
    await this.device.beginAuthwit(manifest.header);
    for (const call of manifest.calls) await this.device.appendCall(call);
    const sig = await this.device.finalizeAndSign(messageHashBytes, this.options.signOptions ?? {});

    this.#pending = {
      hashHex: messageHash.toString(),
      wit: new AuthWitness(messageHash, Array.from(packEcdsaSignature(sig.r, sig.s))),
    };
  }

  /**
   * DEPLOY variant of `#clearSignOnDevice`: identical canonical outer_hash (so the
   * inner `wrapExecutionPayload`'s `createAuthWit(messageHash)` matches `#consume`),
   * but the device runs the DEPLOY flow — `begin_deploy_account` encodes the
   * DeployContext and re-derives publicKeysHash + address FROM THE DEVICE SECRET
   * (M8-P6), rejecting if != ctx.expectedAddress; `finalize_deploy_and_sign` renders
   * the deploy-review UI and signs the canonical outer_hash. The host messageHash is
   * a CROSS-CHECK (re-verified in `#consume`), never a trust input.
   */
  async #deploySignOnDevice(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    txNonce: Fr | undefined,
    deployContext: DeployContext,
  ): Promise<void> {
    const {
      hash: messageHash,
      bytes: messageHashBytes,
      nonce,
    } = await this.#canonicalOuterHash(exec, chainInfo, txNonce);

    // Host pre-validation (codex Medium): fail fast on a ctx that can't match runtime,
    // instead of sending the user into a doomed device review + opaque SW_HASH_MISMATCH.
    // The device STILL independently re-derives + verifies (M8-P6 sovereignty) — this is
    // a cross-check, never the gate.
    const ctxOk =
      bytesEqual(deployContext.expectedAddress, new Uint8Array(this.address.toBuffer())) &&
      bytesEqual(deployContext.chainId, new Uint8Array(chainInfo.chainId.toBuffer())) &&
      bytesEqual(deployContext.protocolVersion, new Uint8Array(chainInfo.version.toBuffer())) &&
      bytesEqual(deployContext.txNonce, new Uint8Array(nonce.toBuffer()));
    if (!ctxOk) {
      throw new Error(
        'LedgerClearSigningEntrypoint: DeployContext mismatches runtime (address/chain/version/nonce) — refusing to review',
      );
    }

    // Device DEPLOY flow (mirrors LedgerEcdsaKAuthWitnessProvider.createAuthWitForDeploy):
    // begin encodes + verifies the DeployContext (sovereignty), finalize reviews + signs.
    // AHW-057: abort proactively (clear any stale session, like the tx path) AND on throw.
    // A failure AFTER begin_deploy leaves the device's deploy-session armed
    // (L4_DEPLOY_CONTEXT); without the abort the NEXT op hits SW_DEPLOY_CONTEXT_WRONG_STATE
    // (0x6F11) and the wallet wedges until reconnect. ABORT (→ l4_session_reset) un-parks it.
    await this.device.abortAuthwit();
    try {
      await this.device.beginDeployAccount(deployContext);
      const sig = await this.device.finalizeDeployAndSign(
        messageHashBytes,
        this.options.signOptions ?? {},
      );
      this.#pending = {
        hashHex: messageHash.toString(),
        wit: new AuthWitness(messageHash, Array.from(packEcdsaSignature(sig.r, sig.s))),
      };
    } catch (e) {
      // Un-park the device so a thrown deploy doesn't wedge the wallet; best-effort
      // (don't mask the original error if the abort itself fails).
      await this.device.abortAuthwit().catch(() => {});
      throw e;
    }
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

  /** Canonical outer_hash over (calls, txNonce) + (address, chainId, version) — what
   * the inner entrypoint + the chain compute. Single source so the tx and deploy sign
   * paths can never attest different bytes (AHW-008). */
  async #canonicalOuterHash(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    txNonce?: Fr,
  ): Promise<{ hash: Fr; bytes: Uint8Array; nonce: Fr }> {
    const nonce = txNonce ?? Fr.ZERO;
    const encoded = await EncodedAppEntrypointCalls.create(exec.calls, nonce);
    const payloadHash = await encoded.hash();
    const hash = await computeOuterAuthWitHash(
      this.address,
      chainInfo.chainId,
      chainInfo.version,
      payloadHash,
    );
    return { hash, bytes: new Uint8Array(hash.toBuffer()), nonce };
  }

  /** AHW-003: the device-signed outer_hash covers ONLY calls+txNonce+(addr,chain,version).
   * authWitnesses, capsules, extraHashedArgs, fee mode, and cancellable are OUTSIDE it —
   * a host could attach/alter them after the device review. Refuse anything the device
   * didn't (and couldn't) show: reject smuggled payload fields + pin the fee mode + pin
   * cancellability BOTH ways — deploy MUST be cancellable=false, and a public tx MUST be
   * cancellable=true so the tx-nonce replay nullifier is emitted (AHW-049). Enforced HERE,
   * not only via the wallet default (session-embedded-wallet), so a host that drives the
   * entrypoint directly — or flips the wallet default — cannot strip the nullifier
   * (post-impl codex HIGH). */
  #assertClearSignPolicy(
    exec: ExecutionPayload,
    options: DefaultAccountEntrypointOptions,
    kind: 'tx' | 'deploy',
  ): void {
    if (exec.authWitnesses.length > 0) {
      throw new Error(
        'LedgerClearSigningEntrypoint: refusing to clear-sign a payload carrying extra authWitnesses (not reviewed)',
      );
    }
    if (exec.capsules.length > 0) {
      throw new Error(
        'LedgerClearSigningEntrypoint: refusing to clear-sign a payload carrying capsules (not reviewed)',
      );
    }
    if (exec.extraHashedArgs.length > 0) {
      throw new Error(
        'LedgerClearSigningEntrypoint: refusing to clear-sign a payload carrying extraHashedArgs (not reviewed)',
      );
    }
    if (options.feePaymentMethodOptions !== AccountFeePaymentMethodOptions.EXTERNAL) {
      throw new Error(
        'LedgerClearSigningEntrypoint: fee mode is NOT clear-signed; only EXTERNAL is allowed',
      );
    }
    if (kind === 'deploy' && options.cancellable !== false) {
      throw new Error(
        'LedgerClearSigningEntrypoint: deploy requires cancellable=false (cancellability is NOT clear-signed)',
      );
    }
    if (kind === 'tx' && options.cancellable !== true) {
      throw new Error(
        'LedgerClearSigningEntrypoint: clear-signed public tx requires cancellable=true so the ' +
          'tx-nonce replay nullifier is emitted (AHW-049); cancellability is NOT clear-signed',
      );
    }
  }
}
