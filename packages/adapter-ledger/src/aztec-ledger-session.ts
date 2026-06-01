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

import { type AuthWitnessProvider, BaseAccount } from '@aztec/aztec.js/account';
import { AztecAddress, type CompleteAddress } from '@aztec/aztec.js/addresses';
import {
  Contract,
  type ContractMethod,
  getContractInstanceFromInstantiationParams,
} from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { waitForTx } from '@aztec/aztec.js/node';
import { AccountManager, ContractInitializationStatus } from '@aztec/aztec.js/wallet';
import {
  AccountFeePaymentMethodOptions,
  DefaultAccountEntrypoint,
} from '@aztec/entrypoints/account';
import { DefaultEntrypoint } from '@aztec/entrypoints/default';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { ContractInstanceWithAddress } from '@aztec/stdlib/contract';
import { GasFees, GasSettings } from '@aztec/stdlib/gas';
import { type ExecutionPayload, type TxHash, type TxReceipt, TxStatus } from '@aztec/stdlib/tx';
import type { ChainInfo } from '@aztec-hwwallet-poc/core';

import { AuthWitness } from '@aztec-hwwallet-poc/core';

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
import { FrozenAuthWitnessProvider } from './frozen-auth-witness-provider.ts';
import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';
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
   * Deploy the Ledger-backed account contract on-chain.
   *
   * M8 P1 — two-pass clear-signed deploy via the M7-P3-shipped device
   * handlers (`INS_BEGIN_DEPLOY_ACCOUNT` + `INS_FINALIZE_DEPLOY_AND_SIGN`).
   * Replaces the legacy blind-sign fallback. Sequence:
   *
   *   Pass 1 (spy): inject an `AuthWitnessProvider` that captures the
   *       framework-computed outer_hash and returns a stub witness; discard
   *       the resulting ExecutionPayload.
   *   Device sign: send DeployContext via BEGIN_DEPLOY_ACCOUNT (device runs
   *       its 3-pass partial_address parity recompute), then claimed_outer_hash
   *       via FINALIZE_DEPLOY_AND_SIGN. Device renders the NBGL deploy-review
   *       UI (address + path + fee), waits for user approval, signs.
   *   Pass 2 (frozen): inject a FrozenAuthWitnessProvider carrying the
   *       device witness. Re-run `deployMethod.request(...)` — the framework
   *       picks up the witness via createAuthWit. Discard nothing this time.
   *
   * deployer: AztecAddress.ZERO gates the multicall-wrap branch in
   * `request()` (deploy_account_method.js:60-70). Without it the request
   * returns a 2-call payload and DefaultEntrypoint throws "Expected a
   * single call, got 2".
   *
   * Phase 6 (safe-v4) closes the device-side publicKeysHash + address +
   * outer_hash recompute against host claims. As of Phase 1 the device
   * still records host-supplied publicKeysHash/expected_address without
   * refuting them — same trust model as M7 P3, just reached via the
   * clear-signed UI instead of blind-sign.
   */
  async deployAccount(opts: SubmitOptions = {}): Promise<SubmitResult> {
    const step = opts.onStep ?? (() => {});
    const session = this.deps.session;
    const accountContract = this.deps.accountContract;

    /* M10: scheme-aware deploy. The accountContract (chosen in connect) is already
     * the Schnorr or ECDSA-K contract — its getInitializationFunctionAndArgs pulls
     * the matching device pubkey for the ctor, and its provider carries the right
     * curveId. Here we pick the matching device deploy PROFILE + curve; the device
     * enforces the (curveId, profile arg_schema) pair and signs the (scheme-
     * independent) deploy outer_hash with the scheme's primitive. */
    const isSchnorr = this.deps.scheme === 'schnorr';
    /* M12 P1: resolve the deploy profile-id from generated metadata (was a
     * hardcoded `isSchnorr ? 1 : 0`). Fail-closed on a lookup miss. */
    const deployProfile = csDeployProfileLookup(DEPLOY_PROFILE_BY_SCHEME[this.deps.scheme]);
    if (!deployProfile) {
      throw new Error(`deployAccount: no deploy profile for scheme '${this.deps.scheme}'`);
    }
    const deployProfileId = deployProfile.profile_index;
    const deployCurveId = isSchnorr ? CURVE_ID.GRUMPKIN : CURVE_ID.SECP256K1;

    step('build', 'Building deploy method…');
    const chainInfo = await this.getChainInfo();

    /* DETERMINISTIC deploy authwit nonce. The deploy authwit is the account
     * entrypoint wrapping the sponsor fee call; its tx nonce defaults to
     * `Fr.random()` inside the framework (EncodedAppEntrypointCalls.create).
     * We MUST pin it via `feeEntrypointOptions.txNonce` and reuse the SAME
     * value in both request() passes — otherwise the spy pass and the frozen
     * pass would compute DIFFERENT outer_hashes and FrozenAuthWitnessProvider
     * would reject (this was a latent bug in the two-pass flow). The device
     * also needs this exact nonce to recompute + verify the outer_hash (P6d). */
    const txNonce = Fr.random();
    const deployFee = {
      paymentMethod: new SponsoredFeePaymentMethod(this.deps.sponsoredFpcAddress),
      feeEntrypointOptions: {
        txNonce,
        feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
        cancellable: false,
      },
    };

    /* Pass 1: spy AuthWitnessProvider captures the framework's outer_hash.
     *
     * CRITICAL ORDERING (codex-confirmed root cause): `getDeployMethod()` →
     * `getAccount()` SNAPSHOTS `getAuthWitnessProvider()` into the entrypoint at
     * build time (@aztec/accounts account_contract.ts:25-31 — the entrypoint's
     * `this.auth` is fixed then; it is NOT re-queried per createAuthWit). So the
     * override MUST be installed BEFORE the deploy method is built, and a FRESH
     * deploy method is built per pass. Installing it after `getDeployMethod()`
     * left the entrypoint on the default DEVICE provider, so neither the spy nor
     * the frozen override ever fired ("did not capture" in-browser; a device-APDU
     * timeout headless). */
    step('build', 'Computing deploy outer_hash (host)…');
    let capturedHash: Fr | undefined;
    const spyProvider: AuthWitnessProvider = {
      createAuthWit: async (messageHash: Fr | Buffer): Promise<AuthWitness> => {
        capturedHash =
          messageHash instanceof Fr ? messageHash : Fr.fromBuffer(Buffer.from(messageHash));
        /* Stub witness: 64 zero bytes. Pass-1's ExecutionPayload is never used. */
        return new AuthWitness(capturedHash, new Array(64).fill(0));
      },
    };
    accountContract.setAuthWitnessOverride(spyProvider);
    try {
      const spyDeployMethod = await this.accountManager.getDeployMethod();
      await spyDeployMethod.request({ deployer: AztecAddress.ZERO, fee: deployFee });
    } finally {
      accountContract.setAuthWitnessOverride(null);
    }
    if (!capturedHash) {
      throw new Error(
        'deployAccount: spy AuthWitnessProvider did not capture an outer_hash — ' +
          'override not installed before getDeployMethod() (ordering bug).',
      );
    }

    /* Build the DeployContext for the device. The device re-derives + verifies
     * publicKeysHash + address (P6c) and recomputes the deploy outer_hash from
     * this txNonce (P6d); the host-supplied fields are cross-checked, not trusted. */
    /* M9 A2: the deploy context path MUST be the session's configured path
     * (was hardcoded `defaultDeployPath(0)` — opus MAJOR: that diverges from
     * the account's signing/authwit path for any account index ≠ 0, and the
     * device would reject with 0x6F0E). Single source = this.deps.bip32Path. */
    const path = this.deps.bip32Path;
    const publicKeysHash = await this.completeAddress.publicKeys.hash();
    const deployCtx: DeployContext = {
      profileId: deployProfileId,
      curveId: deployCurveId,
      bip32Path: path,
      chainId: toBE32(chainInfo.chainId),
      protocolVersion: toBE32(chainInfo.version),
      txNonce: toBE32(txNonce),
      salt: toBE32(this.deps.salt),
      publicKeysHash: toBE32(publicKeysHash),
      expectedAddress: toBE32(this.address),
    };

    /* Device sign via BEGIN_DEPLOY_ACCOUNT + FINALIZE_DEPLOY_AND_SIGN. */
    step('sign', 'Awaiting clear-signed approval on device…');
    const witness = await this.deps.ledgerProvider.createAuthWitForDeploy(deployCtx, capturedHash);

    /* Pass 2: frozen provider carries the device witness. The framework's
     * createAuthWit hits the frozen provider, asserts hash-match, returns
     * the pre-signed witness. Result: ExecutionPayload with device sig. */
    step('prove', 'Signature received — building tx request…');
    const frozen = new FrozenAuthWitnessProvider(witness, capturedHash);
    accountContract.setAuthWitnessOverride(frozen);
    let executionPayload: ExecutionPayload;
    try {
      /* Fresh deploy method so its entrypoint snapshots the FROZEN provider
       * (same ordering rule as pass 1). Same `deployFee` (incl. the pinned
       * txNonce), so the framework recomputes the identical INNER auth hash
       * (the outer_hash the device signed); FrozenAuthWitnessProvider asserts
       * that match and returns the device witness. NB (codex MINOR): only the
       * inner auth hash is pinned here — the outer multicall wrapping may vary
       * between passes, but pass-1's payload is discarded, so it's irrelevant. */
      const frozenDeployMethod = await this.accountManager.getDeployMethod();
      executionPayload = await frozenDeployMethod.request({
        deployer: AztecAddress.ZERO,
        fee: deployFee,
      });
    } finally {
      accountContract.setAuthWitnessOverride(null);
    }

    const currentMinFees = await session.nodeClient.getCurrentMinFees();
    const maxFeesPerGas = currentMinFees.mul(2.5);
    const gasSettings = GasSettings.fallback({ maxFeesPerGas });
    /* deployer:ZERO universal-deploy path uses DefaultEntrypoint, NOT
     * DefaultAccountEntrypoint — the wrapped init+sponsor is already a
     * single call from request()'s multicall-wrap branch. */
    const entrypoint = new DefaultEntrypoint();
    const txRequest = await entrypoint.createTxExecutionRequest(
      executionPayload,
      gasSettings,
      chainInfo,
    );

    step('prove', 'Proving deploy tx (in-browser WASM)…');
    /* PXE v4.2.1 positional: proveTx(txRequest, scopes). The deploy's
     * additionalScopes injection from prepareDeployOptions lands here. */
    const provenTx = await session.pxeClient.proveTx(txRequest, [this.address]);
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    opts.onTxHash?.(txHash.toString());

    step('submit', `Submitting tx ${txHash.toString().slice(0, 10)}…`);
    await session.nodeClient.sendTx(tx);

    step('include', `Awaiting L2 inclusion (${txHash.toString().slice(0, 10)}…)`);
    /* Codex consult: PROPOSED matches aztec.js's isMined() + aztecscan
     * "mined" surface. waitForTx default CHECKPOINTED routinely 300s-times-out
     * on testnet while the tx is already on-chain. */
    const receipt = await waitForTx(session.nodeClient, txHash, {
      waitForStatus: TxStatus.PROPOSED,
      timeout: 900,
    });

    step('done', 'Account deployed (included in proposed block)');
    return { txHash, receipt };
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
      const { session, ledgerProvider } = this.deps;
      const accountContract = this.deps.accountContract;
      if (!(accountContract instanceof LedgerEcdsaKAccountContract)) {
        // P0 (b) proves the ECDSA-K deploy seam; the Schnorr mirror (same override
        // mechanism on LedgerSchnorrAccountContract) lands in P1 after this is proven.
        throw new Error(
          'deployAccountViaEntrypoint: ECDSA-K only for the P0 spike (Schnorr mirror in P1)',
        );
      }

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
    /* Codex 019e6ad4 Bug 2 diagnostic: pub→priv / priv→pub / priv→priv
     * trip a PreflightError on selector 0x32c5dcf8, which isn't any of
     * our four registered transfer selectors. Codex's read: artifact-
     * driven method-surface drift — log name+selector+type per call so
     * we can see whether the method lookup picked a wrong ABI entry. */
    // biome-ignore lint/suspicious/noConsole: temporary live-debug instrumentation
    console.log(
      '[transferUsdc] method=%s exec.calls=%o',
      method,
      exec.calls.map((c) => ({
        name: c.name,
        to: c.to.toString(),
        selector: c.selector.toString(),
        type: c.type,
        argsLen: c.args.length,
      })),
    );
    /* P1: TX now ALWAYS routes through the proper seam — the real EmbeddedWallet.sendTx
     * via LedgerClearSigningEntrypoint (in-band nonce). The submitClearSignedIntent
     * bypass is retired now that P0 proved this path on-chain (safe-v20/safe-v21). */
    return this.transferViaRealSendTx(exec, opts);
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
  async submitClearSignedIntent(
    exec: ExecutionPayload,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
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
    const work = this.runRecipe(exec, opts);
    this.inflight = work;
    try {
      return await work;
    } finally {
      this.inflight = null;
    }
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

  /**
   * 9-step submission recipe (plan-final.md §2). Pre-signs on the Ledger
   * with full clear-signing UI, then hands the witness to the framework
   * via FrozenAuthWitnessProvider.
   */
  private async runRecipe(exec: ExecutionPayload, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const step = opts.onStep ?? (() => {});
    const { ledgerProvider, session } = this.deps;

    step('build', 'Fetching chain info…');
    const chainInfo = await this.getChainInfo();

    const txNonce = Fr.random();

    step('build', 'Projecting clear-sign intent…');
    const intent = projectExecutionPayloadIntoCallIntent(exec, this.address, chainInfo);

    step('sign', 'Awaiting clear-signed approval on device…');
    const witness = await ledgerProvider.createAuthWitFromIntent(intent, txNonce);

    step('prove', 'Signature received — building tx request…');

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
    /* User feedback (M6.14): drip + transfer were taking minutes to reach
     * CHECKPOINTED. 10% padding was fine for empty blocks but doesn't
     * outbid competing transactions on a busy testnet. Bumped to 2.5x
     * the node-reported minimum — generous because the FPC pays the
     * fee anyway and we want fast inclusion for the demo. */
    const maxFeesPerGas = currentMinFees.mul(2.5);
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

    /* 8. Prove + send via the session's PXE + AztecNode. PXE v4.2.1
     *    takes `scopes: AztecAddress[]` as a positional 2nd arg
     *    (pxe.d.ts:201). 4.3.0 changed this to a ProveTxOpts object —
     *    codex 019e69ef flagged it as an upgrade trap. Pinned to 4.2.1
     *    because nulo's deployed contracts (USDC + Dripper) were
     *    address-derived at 4.2.0; mixing 4.3.0 PXE with 4.2.0 addresses
     *    risks address-derivation drift on registerContract. */
    step('prove', 'Proving tx (in-browser WASM)…');
    const provenTx = await session.pxeClient.proveTx(txRequest, [this.address]);
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    /* Surface the hash before submit so the UI can render an aztecscan
     * link mid-flight (testnet inclusion can take minutes). */
    opts.onTxHash?.(txHash.toString());
    step('submit', `Submitting tx ${txHash.toString().slice(0, 10)}…`);
    await session.nodeClient.sendTx(tx);

    step('include', `Awaiting L2 inclusion (${txHash.toString().slice(0, 10)}…)`);
    /* See deployAccount() above for the rationale on these opts —
     * same trade: PROPOSED unblocks the UI when aztecscan is already
     * showing the tx, 900s safety buffer for slow testnet days. */
    const receipt = await waitForTx(session.nodeClient, txHash, {
      waitForStatus: TxStatus.PROPOSED,
      timeout: 900,
    });
    step('done', 'Tx included');
    return { txHash, receipt };
  }
}
