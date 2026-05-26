/**
 * AztecLedgerSession — orchestrator for an in-browser HW-wallet flow.
 *
 * Holds:
 *  - A `SessionEmbeddedWallet` (PXE + wallet DB, ephemeral, browser-only).
 *  - A `LedgerEcdsaKAccountContract` (K1 signing key lives ON the device).
 *  - The session's master `secret: Fr` and deterministic `salt: Fr`.
 *  - Pinned contract instances for the demo (USDC, Dripper, SponsoredFPC).
 *
 * Two submission paths:
 *  1. `deployAccount()` — uses the framework's standard `BaseWallet.sendTx`
 *     path. Random `txNonce` is fine because the user blind-signs the deploy
 *     outer_hash once on-device. This matches every other Aztec wallet's
 *     first-time UX.
 *  2. `submitClearSignedIntent(exec)` — bypasses `BaseWallet.sendTx` (which
 *     hardcodes `txNonce: Fr.random()` at base_wallet.ts:180) and runs the
 *     9-step recipe to pre-sign on-device with clear-signing, then hand
 *     the witness to the framework via FrozenAuthWitnessProvider.
 *     M5 manifest already covers the verbs:
 *       - DRIP_PUB     (dripUsdc)
 *       - TRANSFER_PUB_PUB    (transferUsdcPubToPub)
 *       - TRANSFER_PRIV_PUB   (transferUsdcPrivToPub)
 *       - TRANSFER_PUB_PRIV   (transferUsdcPubToPriv)
 *       - TRANSFER_PRIV_PRIV  (transferUsdcPrivToPriv)
 *
 * Concurrency: `submitClearSignedIntent` is serialized via an in-flight
 * mutex. The Ledger holds a single L4 session at a time; two parallel
 * submissions would corrupt the device state. Convenience wrappers
 * route through `submitClearSignedIntent`, so they share the mutex.
 */
import type { AztecAddress, CompleteAddress } from '@aztec/aztec.js/addresses';
import type { TxHash, TxReceipt } from '@aztec/aztec.js/tx';
import type { ExecutionPayload } from '@aztec/stdlib/tx';
import type { Fr } from '@aztec-hwwallet-poc/core';

import type { LedgerEcdsaKAccountContract } from './account-contract.ts';
import type { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import type { SessionEmbeddedWallet } from './session-embedded-wallet.ts';

export interface AztecLedgerSessionDeps {
  /** Ephemeral wallet (PXE + wallet DB) for the session. */
  readonly session: SessionEmbeddedWallet;
  /** Ledger-backed K1 account contract. */
  readonly accountContract: LedgerEcdsaKAccountContract;
  /** Direct handle to the provider (for clear-signing pre-sign). */
  readonly ledgerProvider: LedgerEcdsaKAuthWitnessProvider;
  /** Master secret Fr — derived 4 protocol keys live in browser memory. */
  readonly secret: Fr;
  /** Account-deploy salt Fr. */
  readonly salt: Fr;
  /** Live USDC contract address (slot 0 in M5 manifest). */
  readonly usdcAddress: AztecAddress;
  /** Live Dripper contract address (slot 3 in M5 manifest). */
  readonly dripperAddress: AztecAddress;
  /** Live SponsoredFPC contract address (slot 2 in M5 manifest). */
  readonly sponsoredFpcAddress: AztecAddress;
}

export interface SubmitResult {
  readonly txHash: TxHash;
  readonly receipt: TxReceipt;
}

/**
 * Class is constructed by `AztecLedgerSession.connect(opts)`; tests can
 * also pass in pre-built deps to exercise wiring without spinning up a
 * real EmbeddedWallet / PXE.
 *
 * The actual `connect()` factory + the full submission recipe land in
 * follow-up commits — this scaffold pins the public surface so the
 * frontend (M6.4) can import a stable shape today.
 */
export class AztecLedgerSession {
  /* Single in-flight mutex. Set to a Promise while a submit is mid-flight;
   * `await` it to serialize subsequent submissions. The mutex protects the
   * SHARED device L4 session, not just our JS state. */
  private inflight: Promise<unknown> | null = null;

  constructor(
    private readonly deps: AztecLedgerSessionDeps,
    private readonly accountAddress: AztecAddress,
    private readonly accountCompleteAddress: CompleteAddress,
  ) {}

  /**
   * Read-only view of the session deps. Internal — exposed for tests and
   * for the demo UI to render fee-payer/address metadata. The `runRecipe`
   * implementation in M6.3.next reads from this same field.
   */
  get internalDeps(): Readonly<AztecLedgerSessionDeps> {
    return this.deps;
  }

  /** The deployed account address (deterministic from secret + salt + signing pubkey). */
  get address(): AztecAddress {
    return this.accountAddress;
  }

  /** Full CompleteAddress (address + public keys). */
  get completeAddress(): CompleteAddress {
    return this.accountCompleteAddress;
  }

  /**
   * The 9-step recipe from plan-final.md §2.
   * Accepts a FEE-MERGED ExecutionPayload — exactly the shape produced by
   *   contract.methods.X(...).request({ fee: { paymentMethod: sponsoredFee } })
   * which yields `[sponsor_unconditionally, app_call]` in that order.
   *
   * For v0 we assert `exec.calls.length === 2` (single-app-call contract).
   * Multi-app batches are out of scope until a future arc.
   */
  async submitClearSignedIntent(exec: ExecutionPayload): Promise<SubmitResult> {
    if (this.inflight) {
      throw new Error(
        'AztecLedgerSession: another submission in flight; await it before issuing a new one',
      );
    }
    if (exec.calls.length !== 2) {
      throw new Error(
        `submitClearSignedIntent expects [sponsor, app] (2 calls); got ${exec.calls.length}`,
      );
    }
    const work = this.runRecipe(exec);
    this.inflight = work;
    try {
      return await work;
    } finally {
      this.inflight = null;
    }
  }

  private async runRecipe(_exec: ExecutionPayload): Promise<SubmitResult> {
    /* The recipe wires together the FrozenAuthWitnessProvider + a manual
     * DefaultAccountEntrypoint dispatch + PXE proveTx+sendTx. The
     * Aztec-side details (computeOuterAuthWitHash, EncodedAppEntrypointCalls,
     * the gasSettings shape) need a small amount of glue that I'm staging
     * in a follow-up commit so this M6.3 split lands testably:
     *
     *  1. Build CallIntent from exec.calls + chosen txNonce
     *  2. ledgerProvider.createAuthWitFromIntent(intent) → AuthWitness + outerHash
     *  3. new FrozenAuthWitnessProvider(witness, outerHash)
     *  4. new DefaultAccountEntrypoint(address, frozen)
     *  5. entrypoint.createTxExecutionRequest(exec, gasSettings, chainInfo,
     *     { txNonce, cancellable: false, feePaymentMethodOptions: undefined })
     *  6. session.pxeClient.proveTx(txRequest)
     *  7. session.pxeClient.sendTx(provenTx)
     *  8. session.pxeClient.getTxReceipt(...) loop until mined
     *
     * Stub throws so the test harness still exercises the in-flight mutex
     * and shape assertions on the way in.
     */
    throw new Error('AztecLedgerSession.runRecipe: wired in M6.3.next');
  }
}
