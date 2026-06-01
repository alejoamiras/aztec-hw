/**
 * SessionEmbeddedWallet — thin subclass of @aztec/wallets' EmbeddedWallet
 * that exposes the `pxe` and `aztecNode` fields publicly (they're
 * `protected` on BaseWallet). The `AztecLedgerSession` wrapper needs
 * direct access to register contract instances, fetch chain info, and
 * submit pre-built TxExecutionRequests through the PXE without casting.
 *
 * Why a subclass and not "just downcast and access protected fields":
 *  - In TS, `as unknown as { pxe: PXE }` works at runtime but is a lie
 *    to the type checker and brittle across BaseWallet refactors.
 *  - A subclass-with-getters is type-safe AND survives upstream protected
 *    field renames at compile time.
 *
 * Why ephemeral by default in the factory:
 *  - PoC sessions hold a master `secret` Fr in JS memory; we do NOT want
 *    that to land in IndexedDB across page reloads. `ephemeral: true`
 *    forces in-memory KV stores for BOTH the PXE state and the wallet DB
 *    (see embedded/entrypoints/browser.ts:40-69).
 *  - Upstream lesson: `ephemeral` is a TOP-LEVEL `EmbeddedWalletOptions`
 *    flag, NOT nested under `pxe`. Easy to get wrong.
 */
import type { Account } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Fr } from '@aztec/foundation/curves/bn254';
import type { PXE } from '@aztec/pxe/server';
import { EmbeddedWallet, type EmbeddedWalletOptions } from '@aztec/wallets/embedded';

export class SessionEmbeddedWallet extends EmbeddedWallet {
  /**
   * In-memory map of address → Account, populated by AztecLedgerSession
   * after AccountManager.create returns. We override
   * `getAccountFromAddress` to consult this map FIRST because the
   * upstream EmbeddedWallet's implementation rebuilds the account from
   * a stored `signingKey: Buffer` in WalletDB — that won't work for our
   * Ledger-backed flow where the K1 signing key never leaves the device.
   */
  private readonly externalAccounts = new Map<string, Account>();

  /** Register a pre-built Account (Ledger-backed) so subsequent
   *  `getAccountFromAddress` lookups resolve through this cache. ALSO
   *  writes a minimal `walletDB.storeAccount` entry — upstream's
   *  `simulateViaEntrypoint` calls `walletDB.retrieveAccount(from)`
   *  DIRECTLY (embedded_wallet.ts:260) before falling through to
   *  `getAccountFromAddress`, so we need both paths covered. */
  async registerExternalAccount(
    address: AztecAddress,
    account: Account,
    secret: Fr,
    salt: Fr,
    /* Scheme-correct WalletDB type. `EmbeddedWallet.sendTx` ALWAYS pre-simulates
     * (embedded_wallet.js:78 → simulateViaEntrypoint → buildAccountOverrides), and
     * that path reads the stored `type` to pick the stub artifact + args
     * (`type === 'schnorr' ? [Fr.ZERO, Fr.ZERO] : [Buffer32, Buffer32]`, :146) and
     * `createStubAccount(addr, type)` (:187). Storing a Schnorr account as
     * 'ecdsasecp256k1' gas-estimated it against an ECDSA-K stub — benign ONLY because
     * both schemes share the `entrypoint` selector, so it simulated OK by luck. We
     * store the correct type so the right-scheme stub is used. The Schnorr stub takes
     * Fr.ZERO args (not our placeholder signingKey), and the sim is gas-estimation
     * only, so the real proved/sent tx (our registered BaseAccount) is unaffected. */
    accountType: 'ecdsasecp256k1' | 'schnorr',
  ): Promise<void> {
    this.externalAccounts.set(address.toString(), account);
    /* WalletDB only needs `type` and `secretKey` / `salt` to satisfy the upstream
     * lookup — `signingKey` is consumed by `createAccountInternal` which we never
     * reach (our `getAccountFromAddress` short-circuits). Zero Buffer placeholder. */
    await this.walletDB.storeAccount(address, {
      type: accountType,
      secretKey: secret,
      salt,
      signingKey: Buffer.alloc(32),
      alias: 'ledger',
    });
  }

  /** P0 seam spike — swap the cached `Account` for `address` (e.g. to a
   * `BaseAccount` backed by `LedgerClearSigningEntrypoint`) so the real
   * `sendTx` routes through it. The walletDB entry written by
   * `registerExternalAccount` already covers upstream's direct
   * `retrieveAccount(from)` path, so no DB write is needed here. */
  overrideAccount(address: AztecAddress, account: Account): void {
    this.externalAccounts.set(address.toString(), account);
  }

  protected override async getAccountFromAddress(address: AztecAddress): Promise<Account> {
    const cached = this.externalAccounts.get(address.toString());
    if (cached) return cached;
    return super.getAccountFromAddress(address);
  }

  /**
   * Build an ephemeral session wallet against the given node URL.
   *
   * The returned wallet's PXE + wallet DB are both in-memory: no IndexedDB,
   * no localStorage. Reloading the page wipes the session — appropriate
   * for a HW-wallet flow where the master `secret` is regenerated per
   * session and only the K1 signing key (on the Ledger) is persistent.
   *
   * `proverEnabled` defaults to true. The first call after `create()` will
   * pay the WASM-prover initialization cost (~3-5s in-browser) before any
   * tx can be assembled; consumers should surface this in their UI.
   */
  static async createEphemeral(
    nodeUrl: string,
    opts: { proverEnabled?: boolean } = {},
  ): Promise<SessionEmbeddedWallet> {
    const options: EmbeddedWalletOptions = {
      ephemeral: true,
      pxe: {
        proverEnabled: opts.proverEnabled ?? true,
      },
    };
    /* `EmbeddedWallet.create` is generic over the subclass; invoking it on
     * `SessionEmbeddedWallet` as the static-method `this` returns our subclass
     * type. The cast is needed because @aztec/wallets types the static `this`
     * via a constructor signature that the runtime resolves correctly. */
    return (await SessionEmbeddedWallet.create(nodeUrl, options)) as SessionEmbeddedWallet;
  }

  /**
   * Public accessor for the underlying PXE — used by `AztecLedgerSession`
   * to register contract instances (Token, Dripper, SponsoredFPC) and to
   * call `proveTx` directly when bypassing the framework's random-txNonce
   * `sendTx` path.
   */
  get pxeClient(): PXE {
    return this.pxe;
  }

  /**
   * Public accessor for the underlying AztecNode. Used to query chain
   * info (chainId, version) during CallIntent construction. The
   * `aztecNode` field on BaseWallet is `protected readonly`.
   */
  get nodeClient(): AztecNode {
    return this.aztecNode;
  }
}
