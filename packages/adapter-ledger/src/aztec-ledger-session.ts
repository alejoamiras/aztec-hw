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
 *  1. `deployAccount()` — two-pass CLEAR-signed deploy (M8). A spy auth
 *     provider captures the framework's deploy outer_hash; the device verifies
 *     its own publicKeysHash + address + recomputes the outer_hash (P6), signs;
 *     a FrozenAuthWitnessProvider replays the device witness on the second
 *     `request()`. The deploy authwit nonce is PINNED (feeEntrypointOptions.
 *     txNonce) so both passes + the device agree on the hash.
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

import { BaseAccount } from '@aztec/aztec.js/account';
import { AztecAddress, type CompleteAddress } from '@aztec/aztec.js/addresses';
import { Contract, type ContractMethod } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { waitForTx } from '@aztec/aztec.js/node';
import { AccountManager, ContractInitializationStatus } from '@aztec/aztec.js/wallet';
import { AccountFeePaymentMethodOptions } from '@aztec/entrypoints/account';
import { DefaultEntrypoint } from '@aztec/entrypoints/default';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { ContractInstanceWithAddress } from '@aztec/stdlib/contract';
import { GasSettings } from '@aztec/stdlib/gas';
import { type ExecutionPayload, type TxHash, type TxReceipt, TxStatus } from '@aztec/stdlib/tx';
import type { ChainInfo } from '@aztec-hwwallet-poc/core';

import { LedgerEcdsaKAccountContract } from './account-contract.ts';
import { LedgerSchnorrAccountContract } from './schnorr-account-contract.ts';

/** M10 — signature scheme for the session's account. */
export type AccountScheme = 'ecdsa' | 'schnorr';

import { CURVE_ID, defaultAztecPath } from './apdu.ts';
import type { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import {
  type CsDeployProfileId,
  csDeployProfileLookup,
} from './clear_signing_v0/deploy_profiles.generated.ts';
import type { DeployContext } from './deploy-context.ts';
import { SessionEmbeddedWallet } from './session-embedded-wallet.ts';
import type { LedgerTransport } from './transport.ts';

/** Convert any Fr-like (Fr, AztecAddress) to a 32-byte big-endian Uint8Array. */
function toBE32(value: { toBuffer(): Buffer }): Uint8Array {
  return new Uint8Array(value.toBuffer());
}

/**
 * Deterministic account-deploy salt (M8 P7.2). The Ledger is the wallet: one
 * account per device path, reproducible across reconnects. A RANDOM salt would
 * change the derived address on every connect (plan-audit BLOCKER 1) — onboarding
 * could show one address while the next session resolves a different, empty
 * account. Fixed `Fr.ZERO` makes the address recompute from (device secret,
 * signing pubkey, salt) alone with zero persisted state — which is also why
 * recovery needs no sidecar. `connect()` still accepts an explicit `salt`
 * override (tests pin their own).
 */
export const DEFAULT_ACCOUNT_SALT: Fr = Fr.ZERO;

/**
 * M12 P1 — host deploy-profile selection by scheme, sourced from the generated
 * `deploy_profiles` metadata. The string-union value (not a magic number) makes a
 * codegen rename a COMPILE error; the runtime lookup (in deployAccount) fail-closes
 * on a miss. Replaces a hardcoded `isSchnorr ? 1 : 0` that would silently sign the
 * wrong template if the codegen ever renumbered `profile_index`.
 */
export const DEPLOY_PROFILE_BY_SCHEME: Record<AccountScheme, CsDeployProfileId> = {
  ecdsa: 'DEPLOY_ACCOUNT_ECDSAK_V1',
  schnorr: 'DEPLOY_ACCOUNT_SCHNORR_V1',
};

export interface AztecLedgerSessionDeps {
  /** Ephemeral wallet (PXE + wallet DB) for the session. */
  readonly session: SessionEmbeddedWallet;
  /** Ledger-backed account contract — ECDSA-K or Schnorr (M10). */
  readonly accountContract: LedgerEcdsaKAccountContract | LedgerSchnorrAccountContract;
  /** Direct handle to the provider (for clear-signing pre-sign). */
  readonly ledgerProvider: LedgerEcdsaKAuthWitnessProvider;
  /** M10 — the account's signature scheme. */
  readonly scheme: AccountScheme;
  /** Master secret Fr — derived 4 protocol keys live in browser memory. */
  readonly secret: Fr;
  /** Account-deploy salt Fr. */
  readonly salt: Fr;
  /** M9 A2: the resolved BIP-32 path — the SINGLE source of truth for the
   * signing pubkey, authwit path, deploy context, and secret-cache key. */
  readonly bip32Path: readonly number[];
  /**
   * Live USDC contract instance — actual deployed shape (publicKeys,
   * initHash, salt, address). PXE rejects address-only overrides.
   */
  readonly usdcInstance: ContractInstanceWithAddress;
  /** Live Dripper contract instance — same provenance constraint. */
  readonly dripperInstance: ContractInstanceWithAddress;
  /** Live SponsoredFPC contract instance — PXE must have this registered or
   * sponsor calls fail with "Unknown contract" during simulation. */
  readonly sponsoredFpcInstance: ContractInstanceWithAddress;
  /** Live SponsoredFPC contract address (slot 2 in M5 manifest). */
  readonly sponsoredFpcAddress: AztecAddress;
  /** Wonderland Token contract artifact (for Contract.at). */
  readonly tokenArtifact: ContractArtifact;
  /** Wonderland Dripper contract artifact (for Contract.at). */
  readonly dripperArtifact: ContractArtifact;
  /** SponsoredFPC contract artifact (from @aztec/noir-contracts.js). */
  readonly sponsoredFpcArtifact: ContractArtifact;
}

export interface SubmitResult {
  readonly txHash: TxHash;
  readonly receipt: TxReceipt;
}

/** Canonical phase IDs for the 6-step submission pipeline (M7). The host
 * UI consumes the phase to drive a deterministic timeline — NEVER infer
 * the phase by string-matching the label. The label is a free-text human
 * caption shown beneath the timeline; the phase is the source of truth.
 *
 * Order is monotonic — the UI's reducer throws in dev/test if it sees
 * a backwards transition (codex audit MINOR #1). */
export type PhaseId = 'build' | 'sign' | 'prove' | 'submit' | 'include' | 'done';

/** INVARIANT: only the adapter calls `onStep`. The browser UI never
 * synthesizes phase callbacks — that would let a malicious renderer
 * lie to the user about device state. Document at call site. */
export type SubmitStepHandler = (phase: PhaseId, label: string) => void;

export interface SubmitOptions {
  readonly onStep?: SubmitStepHandler;
  /** P0 seam spike — route this submission through the REAL `EmbeddedWallet.sendTx`
   * via `LedgerClearSigningEntrypoint` (in-band device clear-signing) instead of the
   * `submitClearSignedIntent` bypass. Gated behind `?seam=entrypoint` in the demo;
   * the legacy path stays the default until the seam is proven (delete-nothing). */
  readonly viaEntrypoint?: boolean;
  /** Fired ONCE per submission, the moment the proven tx's hash is known
   * (between `prove` and `submit`). Lets the UI surface an aztecscan link
   * while we're still waiting for L2 inclusion — handy when testnet is
   * slow and the user wants to check status out-of-band. Hash is the
   * `txHash.toString()` form (0x-prefixed hex). */
  readonly onTxHash?: (txHash: string) => void;
}

export interface AztecLedgerSessionConnectOptions {
  /** Aztec node JSON-RPC URL (e.g. https://rpc.testnet.aztec-labs.com). */
  readonly nodeUrl: string;
  /** Open Ledger transport (Speculos / WebHID / hw-transport-node-hid). */
  readonly transport: LedgerTransport;
  /** Optional override BIP-32 path; defaults to Aztec's standard. */
  readonly bip32Path?: readonly number[];
  /** M10 — signature scheme. 'ecdsa' (default, EcdsaKAccount) or 'schnorr'
   * (SchnorrAccount, Grumpkin). Picks the account contract + device curve_id;
   * distinct deterministic accounts per scheme (different class_id ⇒ address). */
  readonly scheme?: AccountScheme;
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
  /** Live SponsoredFPC contract instance (PXE must have it for sponsor calls). */
  readonly sponsoredFpcInstance: ContractInstanceWithAddress;
  /** SponsoredFPC contract artifact (from @aztec/noir-contracts.js). */
  readonly sponsoredFpcArtifact: ContractArtifact;
  /** Live SponsoredFPC address (slot 2 in M5 manifest; salt=0 protocol-pinned). */
  readonly sponsoredFpcAddress: AztecAddress;
  /** Optional pre-chosen account salt. Defaults to DEFAULT_ACCOUNT_SALT
   * (deterministic — reproducible address across reconnects; M8 P7.2). */
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
    /* M9 A2: resolve the BIP-32 path ONCE — the single source of truth for this
     * account. The account contract (signing pubkey + authwit path), the deploy
     * context, and the secret-cache key all flow from this one value, so a stale
     * or divergent index can't slip in (opus MAJOR: `deployAccount` used to
     * hardcode `defaultDeployPath(0)` independently of the connected account). */
    // Copy the array (codex NIT): the caller owns `opts.bip32Path`; storing a
    // copy means a later caller mutation can't reintroduce path drift.
    const bip32Path: readonly number[] = [...(opts.bip32Path ?? defaultAztecPath())];
    const scheme: AccountScheme = opts.scheme ?? 'ecdsa';
    const accountContract =
      scheme === 'schnorr'
        ? new LedgerSchnorrAccountContract(opts.transport, { bip32Path })
        : new LedgerEcdsaKAccountContract(opts.transport, { bip32Path });
    const ledgerProvider = accountContract.getProvider();
    const secret = opts.secret ?? Fr.random();
    /* M8 P7.2: deterministic salt by default so the SAME device reproduces the
     * SAME account on every connect (reconnect == recovery). Random salt was the
     * plan-audit BLOCKER. Onboarding passes the device secret as `opts.secret`;
     * tests may pin their own `opts.salt`. */
    const salt = opts.salt ?? DEFAULT_ACCOUNT_SALT;

    const accountManager = await AccountManager.create(session, secret, accountContract, salt);
    const accountAddress = accountManager.address;
    const accountCompleteAddress = await accountManager.getCompleteAddress();

    /* Plumb the Account into SessionEmbeddedWallet's external-account
     * registry so:
     *  - `getAccountFromAddress` returns our Ledger-backed account
     *  - `walletDB.retrieveAccount(from)` (called directly by
     *    `simulateViaEntrypoint`, embedded_wallet.ts:260) finds a stub
     *    entry with the right `type` so simulation can build the stub
     *    account. SigningKey is irrelevant in our flow since
     *    getAccountFromAddress short-circuits before createAccountInternal.
     * Surfaced via playwright as "Account 0x… does not exist on this
     * wallet" when Deploy first ran. */
    const accountForCache = await accountManager.getAccount();
    await session.registerExternalAccount(accountAddress, accountForCache, secret, salt);

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
    /* Without this, sponsor simulation fails with "Unknown contract
     * 0x254082…1257" — surfaced via playwright. */
    await session.registerContract(opts.sponsoredFpcInstance, opts.sponsoredFpcArtifact);

    const deps: AztecLedgerSessionDeps = {
      session,
      accountContract,
      ledgerProvider,
      scheme,
      secret,
      salt,
      bip32Path,
      usdcInstance: opts.usdcInstance,
      dripperInstance: opts.dripperInstance,
      sponsoredFpcInstance: opts.sponsoredFpcInstance,
      sponsoredFpcArtifact: opts.sponsoredFpcArtifact,
      sponsoredFpcAddress: opts.sponsoredFpcAddress,
      tokenArtifact: opts.tokenArtifact,
      dripperArtifact: opts.dripperArtifact,
    };
    return new AztecLedgerSession(deps, accountAddress, accountCompleteAddress, accountManager);
  }

  /**
   * P0 SPIKE (b) — DEPLOY through the PROPER seam. Routes a self-paid account
   * deploy through our `LedgerClearSigningEntrypoint.wrapExecutionPayload` using the
   * framework's OWN carrier: `fee.feeEntrypointOptions`. The flow (verified in 4.2.1):
   * `DeployAccountMethod.request({ deployer: ZERO, fee })` → self-deploy branch →
   * `getSelfFeePaymentMethod` → `AccountEntrypointMetaPaymentMethod.getExecutionPayload`
   * → `account.wrapExecutionPayload(feePayload, chainInfo, feeEntrypointOptions)`. We
   * carry the `DeployContext` in `feeEntrypointOptions`, so our entrypoint runs the
   * device DEPLOY flow IN-BAND (M8-P6 sovereignty re-derive + deploy-review) — NO
   * spy/freeze. Delete-nothing: the entrypoint override is reversible and the legacy
   * `deployAccount` stays intact until this is proven on-chain.
   */
  async deployAccountViaEntrypoint(opts: SubmitOptions = {}): Promise<SubmitResult> {
    if (this.inflight) {
      throw new Error(
        'AztecLedgerSession: another submission in flight; await it before issuing a new one',
      );
    }
    const work = (async (): Promise<SubmitResult> => {
      const step = opts.onStep ?? (() => {});
      const { session, accountContract, ledgerProvider } = this.deps;
      /* P1: both contracts extend LedgerAccountContractBase → both expose
       * setEntrypointOverride, so the deploy seam is scheme-agnostic (ECDSA-K + Schnorr).
       * The provider's createClearSigningEntrypoint is likewise scheme-generic (curveId). */

      const deployProfile = csDeployProfileLookup(DEPLOY_PROFILE_BY_SCHEME[this.deps.scheme]);
      if (!deployProfile) {
        throw new Error(`deployAccountViaEntrypoint: no deploy profile for '${this.deps.scheme}'`);
      }
      const isSchnorr = this.deps.scheme === 'schnorr';
      const deployCurveId = isSchnorr ? CURVE_ID.GRUMPKIN : CURVE_ID.SECP256K1;

      step('build', 'Building deploy (entrypoint seam)…');
      const chainInfo = await this.getChainInfo();
      const txNonce = Fr.random();

      /* DeployContext the device needs (identical to the legacy path) — rides in
       * feeEntrypointOptions. The device re-derives pkh+address from its own secret
       * and rejects if != expectedAddress (M8-P6 sovereignty). */
      const publicKeysHash = await this.completeAddress.publicKeys.hash();
      const deployContext: DeployContext = {
        profileId: deployProfile.profile_index,
        curveId: deployCurveId,
        bip32Path: this.deps.bip32Path,
        chainId: toBE32(chainInfo.chainId),
        protocolVersion: toBE32(chainInfo.version),
        txNonce: toBE32(txNonce),
        salt: toBE32(this.deps.salt),
        publicKeysHash: toBE32(publicKeysHash),
        expectedAddress: toBE32(this.address),
      };

      /* Install our entrypoint so getDeployMethod() snapshots it (ordering rule). */
      const entrypoint = ledgerProvider.createClearSigningEntrypoint(this.address);
      accountContract.setEntrypointOverride(entrypoint);
      let executionPayload: ExecutionPayload;
      try {
        const deployFee = {
          paymentMethod: new SponsoredFeePaymentMethod(this.deps.sponsoredFpcAddress),
          feeEntrypointOptions: {
            txNonce,
            feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
            cancellable: false,
            /* The carrier under test: our entrypoint reads this (namespaced) in
             * wrapExecutionPayload. request() is called ONCE here, then we prove/send
             * manually — so the device is prompted exactly once (codex: request() is
             * not pure; simulate/send would re-call it). */
            ledgerDeployContext: deployContext,
          },
        };
        step('sign', 'Awaiting clear-signed deploy approval on device…');
        const deployMethod = await this.accountManager.getDeployMethod();
        executionPayload = await deployMethod.request({
          deployer: AztecAddress.ZERO,
          fee: deployFee,
        });
      } finally {
        accountContract.setEntrypointOverride(null);
      }

      step('prove', 'Signature received — building tx request…');
      const currentMinFees = await session.nodeClient.getCurrentMinFees();
      const gasSettings = GasSettings.fallback({ maxFeesPerGas: currentMinFees.mul(2.5) });
      /* deployer:ZERO universal-deploy wraps via DefaultMultiCallEntrypoint already,
       * so the outer tx uses DefaultEntrypoint (single pre-wrapped call). */
      const txRequest = await new DefaultEntrypoint().createTxExecutionRequest(
        executionPayload,
        gasSettings,
        chainInfo,
      );

      step('prove', 'Proving deploy tx (in-browser WASM)…');
      const provenTx = await session.pxeClient.proveTx(txRequest, [this.address]);
      const tx = await provenTx.toTx();
      const txHash = tx.getTxHash();
      opts.onTxHash?.(txHash.toString());
      step('submit', `Submitting tx ${txHash.toString().slice(0, 10)}…`);
      await session.nodeClient.sendTx(tx);
      step('include', `Awaiting L2 inclusion (${txHash.toString().slice(0, 10)}…)`);
      const receipt = await waitForTx(session.nodeClient, txHash, {
        waitForStatus: TxStatus.PROPOSED,
        timeout: 900,
      });
      step('done', 'Account deployed (entrypoint seam)');
      return { txHash, receipt };
    })();
    this.inflight = work;
    try {
      return await work;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Read-only view of the session deps for rendering metadata (instances,
   * fee-payer, artifacts). M8 P7.2 (impl-audit `bb56tmdxj` MAJOR): the
   * viewing-root `secret` is STRIPPED — it must not be reachable via any public
   * accessor. The PXE receives it internally during `connect()`
   * (registerExternalAccount / registerContract); nothing outside needs it back.
   */
  get internalDeps(): Readonly<Omit<AztecLedgerSessionDeps, 'secret'>> {
    const { secret: _secret, ...rest } = this.deps;
    return rest;
  }

  /** M9 A2: the account's resolved BIP-32 path — single source of truth
   * (signing pubkey, authwit path, deploy context, secret-cache key all use it). */
  get bip32Path(): readonly number[] {
    return this.deps.bip32Path;
  }

  /**
   * M9 A3: is THIS account already initialized on-chain? Uses the wallet's
   * init-status (NOT `node.getContract`, which only means "publicly registered"
   * and false-positives on registered-but-uninitialized accounts — opus MAJOR).
   * The account instance is registered in `connect()`, so the private
   * init-nullifier check gives a definitive INITIALIZED/UNINITIALIZED answer.
   * Lets the UI skip Deploy for an account that already exists (e.g. a prior
   * session's, since the deterministic salt makes the address stable).
   */
  async isDeployed(): Promise<boolean> {
    const meta = await this.deps.session.getContractMetadata(this.accountAddress);
    return meta.initializationStatus === ContractInitializationStatus.INITIALIZED;
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
  async dripUsdc(amount: bigint, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const step = opts.onStep ?? (() => {});
    step('build', 'Building drip payload…');
    const dripper = this.contractAt(this.deps.dripperInstance.address, this.deps.dripperArtifact);
    const callContractMethod = this.requireMethod(dripper, 'drip_to_public');
    const exec = await callContractMethod(this.deps.usdcInstance.address, amount).request({
      fee: { paymentMethod: this.sponsoredFee() },
    });
    /* P1: drip is a TX — route it through the proper seam (real sendTx + entrypoint),
     * same as transfers. transferViaRealSendTx is generic over the fee-merged exec. */
    return this.transferViaRealSendTx(exec, opts);
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

  async transferUsdcPubToPub(
    to: AztecAddress,
    amount: bigint,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    return this.transferUsdc('transfer_public_to_public', to, amount, opts);
  }

  async transferUsdcPrivToPub(
    to: AztecAddress,
    amount: bigint,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    return this.transferUsdc('transfer_private_to_public', to, amount, opts);
  }

  async transferUsdcPubToPriv(
    to: AztecAddress,
    amount: bigint,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    return this.transferUsdc('transfer_public_to_private', to, amount, opts);
  }

  async transferUsdcPrivToPriv(
    to: AztecAddress,
    amount: bigint,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    return this.transferUsdc('transfer_private_to_private', to, amount, opts);
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
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const step = opts.onStep ?? (() => {});
    step('build', `Building ${method} payload…`);
    const token = this.contractAt(this.deps.usdcInstance.address, this.deps.tokenArtifact);
    const callContractMethod = this.requireMethod(token, method);
    const exec = await callContractMethod(this.address, to, amount, 0n).request({
      fee: { paymentMethod: this.sponsoredFee() },
    });
    /* P1: TX now ALWAYS routes through the proper seam — the real EmbeddedWallet.sendTx
     * via LedgerClearSigningEntrypoint (in-band nonce). The submitClearSignedIntent
     * bypass is retired now that P0 proved this path on-chain (safe-v20/safe-v21). */
    return this.transferViaRealSendTx(exec, opts);
  }

  /**
   * P0 SPIKE (hard gate) — drive a transfer through the REAL `EmbeddedWallet.sendTx`
   * via `LedgerClearSigningEntrypoint` (in-band device clear-signing). Proves the
   * proper seam end-to-end WITHOUT touching `getAccount()` or the deploy path —
   * delete-nothing. The framework picks `txNonce`, hands it to our
   * `createTxExecutionRequest`; the device clear-signs THAT nonce and the same
   * request is proven + sent → `nonce_signed == nonce_on_chain` by construction
   * (a mismatch would fail the proof / be rejected). Returns the mined receipt.
   *
   * NB1: `sendTx` pre-simulates via a stub account (no device prompt); the device
   *   is invoked exactly once, on the real prove (codex-confirmed).
   * NB2: `exec` is FEE-MERGED — the SponsoredFPC payment method is embedded in the
   *   payload (via `.request({ fee: { paymentMethod } })`), same as
   *   `submitClearSignedIntent`. The wallet-level `SendOptions.fee` only carries
   *   `gasSettings`, not the payment method.
   */
  async transferViaRealSendTx(
    exec: ExecutionPayload,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    if (this.inflight) {
      throw new Error(
        'AztecLedgerSession: another submission in flight; await it before issuing a new one',
      );
    }
    const work = (async (): Promise<SubmitResult> => {
      const step = opts.onStep ?? (() => {});
      const { ledgerProvider, session } = this.deps;

      step('build', 'Building in-band clear-signing account…');
      const entrypoint = ledgerProvider.createClearSigningEntrypoint(this.address);
      const account = new BaseAccount(entrypoint, ledgerProvider, this.accountCompleteAddress);
      session.overrideAccount(this.address, account);

      /* Gas parity with runRecipe: 2.5x the node minimum for fast testnet
       * inclusion (the SponsoredFPC pays). The fee PAYMENT METHOD is already
       * embedded in `exec`; wallet-level SendOptions.fee carries only gasSettings. */
      const currentMinFees = await session.nodeClient.getCurrentMinFees();
      const gasSettings = GasSettings.fallback({ maxFeesPerGas: currentMinFees.mul(2.5) });

      step('sign', 'Awaiting clear-signed approval on device (real sendTx)…');
      const sent = await session.sendTx(exec, { from: this.address, fee: { gasSettings } });

      const { receipt } = sent;
      const { txHash } = receipt;
      opts.onTxHash?.(txHash.toString());
      step('done', `Tx included (${txHash.toString().slice(0, 10)}…)`);
      return { txHash, receipt };
    })();
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
}
