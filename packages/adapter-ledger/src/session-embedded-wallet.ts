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
import type { AztecNode } from '@aztec/aztec.js/node';
import type { PXE } from '@aztec/pxe/server';
import { EmbeddedWallet, type EmbeddedWalletOptions } from '@aztec/wallets/embedded';

export class SessionEmbeddedWallet extends EmbeddedWallet {
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
