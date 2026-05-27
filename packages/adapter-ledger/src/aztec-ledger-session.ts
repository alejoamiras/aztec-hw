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
import {
  Contract,
  type ContractMethod,
  getContractInstanceFromInstantiationParams,
} from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { waitForTx } from '@aztec/aztec.js/node';
import { AccountManager } from '@aztec/aztec.js/wallet';
import {
  AccountFeePaymentMethodOptions,
  DefaultAccountEntrypoint,
} from '@aztec/entrypoints/account';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { ContractInstanceWithAddress } from '@aztec/stdlib/contract';
import { GasFees, GasSettings } from '@aztec/stdlib/gas';
import type { ExecutionPayload, TxHash, TxReceipt } from '@aztec/stdlib/tx';
import type { ChainInfo } from '@aztec-hwwallet-poc/core';

import { LedgerEcdsaKAccountContract } from './account-contract.ts';
import { defaultAztecPath } from './apdu.ts';
import type { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import { FrozenAuthWitnessProvider } from './frozen-auth-witness-provider.ts';
import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';
import { SessionEmbeddedWallet } from './session-embedded-wallet.ts';
import type { LedgerTransport } from './transport.ts';

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
  /**
   * Live USDC contract instance — actual deployed shape (publicKeys,
   * initHash, salt, address). PXE rejects address-only overrides.
   */
  readonly usdcInstance: ContractInstanceWithAddress;
  /** Live Dripper contract instance — same provenance constraint. */
  readonly dripperInstance: ContractInstanceWithAddress;
  /** Live SponsoredFPC contract address (slot 2 in M5 manifest). */
  readonly sponsoredFpcAddress: AztecAddress;
  /** Wonderland Token contract artifact (for Contract.at). */
  readonly tokenArtifact: ContractArtifact;
  /** Wonderland Dripper contract artifact (for Contract.at). */
  readonly dripperArtifact: ContractArtifact;
}

export interface SubmitResult {
  readonly txHash: TxHash;
  readonly receipt: TxReceipt;
}

export interface AztecLedgerSessionConnectOptions {
  /** Aztec node JSON-RPC URL (e.g. https://rpc.testnet.aztec-labs.com). */
  readonly nodeUrl: string;
  /** Open Ledger transport (Speculos / WebHID / hw-transport-node-hid). */
  readonly transport: LedgerTransport;
  /** Optional override BIP-32 path; defaults to Aztec's standard. */
  readonly bip32Path?: readonly number[];
  /** Wonderland Token contract artifact (loaded JSON). */
  readonly tokenArtifact: ContractArtifact;
  /** Wonderland Dripper contract artifact (loaded JSON). */
  readonly dripperArtifact: ContractArtifact;
  /**
   * Live USDC contract instance. MUST be the actual deployed instance
   * (with the right publicKeys + salt + initHash + address); PXE
   * rejects address-only overrides. Caller computes this via
   * `getContractInstanceFromInstantiationParams(artifact, { salt,
   * constructorArtifact, constructorArgs })` using the values from
   * nulo's deployments.json.
   */
  readonly usdcInstance: ContractInstanceWithAddress;
  /** Live Dripper contract instance — same provenance constraint. */
  readonly dripperInstance: ContractInstanceWithAddress;
  /** Live SponsoredFPC address (salt=0 on both sandbox and testnet). */
  readonly sponsoredFpcAddress: AztecAddress;
  /** Optional pre-chosen account salt. Defaults to a fresh Fr.random(). */
  readonly salt?: Fr;
  /** Optional pre-chosen master secret. Defaults to a fresh Fr.random(). */
  readonly secret?: Fr;
  /** Enable in-browser proving (default true). Heavy WASM init on first use. */
  readonly proverEnabled?: boolean;
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
    private readonly accountManager: AccountManager,
  ) {}

  /**
   * Build a fresh AztecLedgerSession against a live Aztec node.
   *
   * 1. Spawn the ephemeral SessionEmbeddedWallet (PXE + wallet DB in-memory).
   *    First call pays ~3-5s WASM-prover init cost.
   * 2. Build the LedgerEcdsaKAccountContract from the provided transport.
   * 3. Generate (or reuse) the master secret + salt.
   * 4. AccountManager.create(...) derives the address from secret + salt
   *    + Ledger signing pubkey. Does NOT deploy — deployAccount() does.
   * 5. Register the {USDC, Dripper, SponsoredFPC} contract instances in
   *    the PXE so contract.methods.X(...) calls can encode against them.
   *
   * Heavy: blocks on prover init + node sync. Frontend should show a
   * progress indicator.
   */
  static async connect(opts: AztecLedgerSessionConnectOptions): Promise<AztecLedgerSession> {
    const session = await SessionEmbeddedWallet.createEphemeral(opts.nodeUrl, {
      proverEnabled: opts.proverEnabled ?? true,
    });
    const accountContract = new LedgerEcdsaKAccountContract(opts.transport, {
      bip32Path: opts.bip32Path ?? defaultAztecPath(),
    });
    const ledgerProvider = accountContract.getProvider();
    const secret = opts.secret ?? Fr.random();
    const salt = opts.salt ?? Fr.random();

    const accountManager = await AccountManager.create(session, secret, accountContract, salt);
    const accountAddress = accountManager.address;
    const accountCompleteAddress = await accountManager.getCompleteAddress();

    /* Register the user's account-contract instance FIRST. PXE rejects
     * tx simulation with "Unknown contract" until the consumer address is
     * registered (surfaced via playwright as 'Unknown contract 0x2e8…'
     * on first drip). The framework's standard EmbeddedWallet.createECDSAK
     * path does this automatically in createAccountInternal; we bypass
     * that path because we don't have the raw signing key (Ledger holds
     * it), so we have to register the instance manually here. */
    const accountInstance = accountManager.getInstance();
    const accountArtifact = await accountContract.getContractArtifact();
    await session.registerContract(accountInstance, accountArtifact, secret);

    /* Register the pinned demo contracts. We require the caller to pass
     * already-built ContractInstanceWithAddress objects because PXE rejects
     * address-only overrides — it recomputes the address from the FULL
     * instance (publicKeys, initHash, salt) and throws on mismatch
     * (codex post-impl review §BLOCKER 1, pxe.ts:674-689). */
    await session.registerContract(opts.usdcInstance, opts.tokenArtifact);
    await session.registerContract(opts.dripperInstance, opts.dripperArtifact);

    const deps: AztecLedgerSessionDeps = {
      session,
      accountContract,
      ledgerProvider,
      secret,
      salt,
      usdcInstance: opts.usdcInstance,
      dripperInstance: opts.dripperInstance,
      sponsoredFpcAddress: opts.sponsoredFpcAddress,
      tokenArtifact: opts.tokenArtifact,
      dripperArtifact: opts.dripperArtifact,
    };
    return new AztecLedgerSession(deps, accountAddress, accountCompleteAddress, accountManager);
  }

  /**
   * Deploy the Ledger-backed account contract on-chain. Uses the
   * framework's standard sendTx path — random txNonce is fine because
   * the user blind-signs the deploy outer_hash once on-device.
   *
   * Subsequent submitClearSignedIntent calls bypass that path.
   */
  async deployAccount(): Promise<SubmitResult> {
    const deployMethod = await this.accountManager.getDeployMethod();
    const result = await deployMethod.send({
      from: this.address,
      fee: { paymentMethod: new SponsoredFeePaymentMethod(this.deps.sponsoredFpcAddress) },
    });
    return { txHash: result.receipt.txHash, receipt: result.receipt };
  }

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
   * Drip 1000 USDC into this Ledger account (sponsored). Wraps the
   * `Dripper.drip_to_public(USDC, amount)` call with the SponsoredFPC
   * fee path and submits via the clear-signing recipe.
   *
   * Convenience-wrapper status: SIGNATURE-ONLY for v0.5. The frontend
   * (M6.4) can call `submitClearSignedIntent(exec)` directly with a
   * pre-built fee-merged ExecutionPayload. Full wrappers land at M6.5
   * (alpha-testnet e2e) once the in-browser PXE has a contract artifact
   * loaded for nulo's Dripper.
   */
  /**
   * Common builder: instantiate a contract handle bound to our session wallet.
   * `Contract.at` itself does not hit the chain — the artifact + address are
   * all it needs to dispatch method calls.
   */
  private contractAt(address: AztecAddress, artifact: ContractArtifact): Contract {
    return Contract.at(address, artifact, this.deps.session);
  }

  /** SponsoredFeePaymentMethod bound to this session's pinned FPC address. */
  private sponsoredFee(): SponsoredFeePaymentMethod {
    return new SponsoredFeePaymentMethod(this.deps.sponsoredFpcAddress);
  }

  /**
   * Drip 1000 USDC into this Ledger account (sponsored). Calls
   * `Dripper.drip_to_public(USDC_ADDR, amount)`. Amount is u64 (atomic).
   */
  async dripUsdc(amount: bigint): Promise<SubmitResult> {
    const dripper = this.contractAt(this.deps.dripperInstance.address, this.deps.dripperArtifact);
    /* `Contract.methods` is an artifact-keyed Proxy — TS types it as
     * `Record<string, ContractMethod | undefined>` so dynamic access is
     * possibly-undefined. The artifact provenance is verified at M6.0
     * codegen time, so we use a typed alias to surface a clear error
     * if the upstream artifact ever drops drip_to_public. */
    const callContractMethod = this.requireMethod(dripper, 'drip_to_public');
    const exec = await callContractMethod(this.deps.usdcInstance.address, amount).request({
      fee: { paymentMethod: this.sponsoredFee() },
    });
    return this.submitClearSignedIntent(exec);
  }

  /**
   * Type-narrowing helper: pull a method off contract.methods or throw a
   * meaningful error. Centralizes the artifact-drift surface area.
   */
  private requireMethod(contract: Contract, name: string): ContractMethod {
    const m = (contract.methods as Record<string, ContractMethod | undefined>)[name];
    if (!m) {
      throw new Error(`Contract artifact missing method "${name}" — check artifact pin`);
    }
    return m;
  }

  async transferUsdcPubToPub(to: AztecAddress, amount: bigint): Promise<SubmitResult> {
    return this.transferUsdc('transfer_public_to_public', to, amount);
  }

  async transferUsdcPrivToPub(to: AztecAddress, amount: bigint): Promise<SubmitResult> {
    return this.transferUsdc('transfer_private_to_public', to, amount);
  }

  async transferUsdcPubToPriv(to: AztecAddress, amount: bigint): Promise<SubmitResult> {
    return this.transferUsdc('transfer_public_to_private', to, amount);
  }

  async transferUsdcPrivToPriv(to: AztecAddress, amount: bigint): Promise<SubmitResult> {
    return this.transferUsdc('transfer_private_to_private', to, amount);
  }

  /**
   * Shared transfer dispatcher — picks the method by name and builds the
   * sponsor-merged ExecutionPayload. All four 4-arg transfer verbs have
   * the same shape: `(from, to, amount, nonce)`. `from` MUST equal the
   * session address (M5.2 strict-allowlist enforces this on-device with
   * SW_DELEGATED_SPEND_UNSUPPORTED — we'd surface it during pre-sign).
   */
  private async transferUsdc(
    method:
      | 'transfer_public_to_public'
      | 'transfer_private_to_public'
      | 'transfer_public_to_private'
      | 'transfer_private_to_private',
    to: AztecAddress,
    amount: bigint,
  ): Promise<SubmitResult> {
    const token = this.contractAt(this.deps.usdcInstance.address, this.deps.tokenArtifact);
    const callContractMethod = this.requireMethod(token, method);
    /* `nonce` arg is the authwitness inner-nonce — 0n means no separate
     * delegated authwit; our clear-signing flow is self-spend only so 0
     * is correct. */
    const exec = await callContractMethod(this.address, to, amount, 0n).request({
      fee: { paymentMethod: this.sponsoredFee() },
    });
    return this.submitClearSignedIntent(exec);
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

  /**
   * Cached ChainInfo, fetched lazily on first submission. Reused for every
   * subsequent submission — chainId/version are stable for a given network.
   */
  private chainInfoCache: ChainInfo | null = null;

  private async getChainInfo(): Promise<ChainInfo> {
    if (this.chainInfoCache) return this.chainInfoCache;
    const nodeInfo = await this.deps.session.nodeClient.getNodeInfo();
    this.chainInfoCache = {
      chainId: new Fr(BigInt(nodeInfo.l1ChainId)),
      version: new Fr(BigInt(nodeInfo.rollupVersion)),
    };
    return this.chainInfoCache;
  }

  /**
   * 9-step submission recipe (plan-final.md §2). Pre-signs on the Ledger
   * with full clear-signing UI, then hands the witness to the framework
   * via FrozenAuthWitnessProvider.
   */
  private async runRecipe(exec: ExecutionPayload): Promise<SubmitResult> {
    const { ledgerProvider, session } = this.deps;

    /* 1. Chain info (replay protection). */
    const chainInfo = await this.getChainInfo();

    /* 2. Pick OUR own txNonce (bypassing BaseWallet.sendTx's random one
     *    at base_wallet.ts:180). The witness binds to this nonce via the
     *    encodedCalls.hash() preimage; framework's createTxExecutionRequest
     *    must use the same value. */
    const txNonce = Fr.random();

    /* 3. Project ExecutionPayload → CallIntent (pure function; byte-deterministic
     *    given the M5 manifest's verbs, see L4.1 host-parity tests). */
    const intent = projectExecutionPayloadIntoCallIntent(exec, this.address, chainInfo);

    /* 4. Pre-sign via Ledger CLEAR-SIGNING. The device shows decoded
     *    fields (Transfer 1.5 USDC, From: you, To: 0xabcd…) and
     *    enforces M5.2 strict-allowlist gates before returning a sig. */
    /* Pass the chosen txNonce so the device-side outer_hash bound to the
     * witness matches what the framework will compute later in step 7
     * (codex would have caught this — surfaced via playwright as
     * FrozenWitnessMismatchError on the first drip run). */
    const witness = await ledgerProvider.createAuthWitFromIntent(intent, txNonce);

    /* 5. Wrap in FrozenAuthWitnessProvider — one-shot, hash-asserted.
     *    The framework's account_entrypoint.ts:131 computes its own
     *    messageHash and calls this provider's createAuthWit; if there's
     *    drift between our pre-sign hash and the framework's recompute,
     *    we throw FrozenWitnessMismatchError rather than handing over
     *    a witness for the wrong tx. */
    const frozen = new FrozenAuthWitnessProvider(witness, witness.requestHash);

    /* 6. Build a one-shot DefaultAccountEntrypoint pointed at our
     *    frozen provider. The framework's normal sendTx path would
     *    construct the same shape via AccountManager + the registered
     *    AuthWitnessProvider — we bypass that here because we need
     *    control over txNonce. */
    const entrypoint = new DefaultAccountEntrypoint(this.address, frozen);

    /* 7. Construct the tx request with OUR chosen txNonce.
     *    Codex post-impl §BLOCKER 2: even with a sponsored FPC fee-payer,
     *    upstream validation still checks maxFeesPerGas
     *    (gas_validator.ts:167-178). The wallet-sdk's BaseWallet fills
     *    this from aztecNode.getCurrentMinFees() (base_wallet.ts:245);
     *    we do the same here. The 10% padding mirrors `minFeePadding`. */
    const currentMinFees = await session.nodeClient.getCurrentMinFees();
    const maxFeesPerGas = currentMinFees.mul(1.1);
    const gasSettings = GasSettings.fallback({ maxFeesPerGas });
    /* `feePaymentMethodOptions` is the u8 fee-payment-mode arg the entrypoint
     * ABI requires (account_entrypoint.ts:204). For the sponsored FPC path
     * the account contract is NOT the fee payer — the FPC contract is —
     * so EXTERNAL (=0). Passing `undefined` here surfaced as
     * "Undefined argument fee_payment_method of type integer" at first
     * playwright drip. */
    const txRequest = await entrypoint.createTxExecutionRequest(exec, gasSettings, chainInfo, {
      cancellable: false,
      txNonce,
      feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
    });

    /* 8. Prove + send via the session's PXE + AztecNode. The raw PXE v4.2.1
     *    interface takes `scopes: AztecAddress[]` as a positional 2nd arg
     *    (pxe.d.ts:201); the wallet-sdk wraps that in an options object. We
     *    call the raw shape directly here. */
    const provenTx = await session.pxeClient.proveTx(txRequest, [this.address]);
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    await session.nodeClient.sendTx(tx);

    /* 9. Wait for inclusion. waitForTx polls the node's tx-receipts API
     *    until the tx is mined or rejected. */
    const receipt = await waitForTx(session.nodeClient, txHash);
    return { txHash, receipt };
  }
}
