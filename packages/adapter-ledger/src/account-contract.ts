/**
 * `AccountContract` implementation that backs `EcdsaKAccount` with a Ledger device
 * instead of an in-memory `signingPrivateKey`. Mirrors `@aztec/accounts/ecdsa`'s
 * `EcdsaKBaseAccountContract`, but the signing key never leaves the device.
 *
 * This is what makes the L2 acceptance test exercise the **real** Aztec
 * account / entrypoint code path (plan-final.md §223): `BaseAccount` +
 * `DefaultAccountEntrypoint` consume our `LedgerEcdsaKAuthWitnessProvider`
 * via the standard `getAccount(...)` flow, not a hand-rolled facsimile.
 */
import { DefaultAccountContract } from '@aztec/accounts/defaults';
import { EcdsaKAccountContractArtifact } from '@aztec/accounts/ecdsa';
import { type Account, type AuthWitnessProvider, BaseAccount } from '@aztec/aztec.js/account';
import type { EntrypointInterface } from '@aztec/entrypoints/interfaces';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { CompleteAddress } from '@aztec/stdlib/contract';

import {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerEcdsaKAccountContractOptions extends LedgerProviderOptions {}

export class LedgerEcdsaKAccountContract extends DefaultAccountContract {
  private readonly defaultProvider: LedgerEcdsaKAuthWitnessProvider;
  /** M8 P1 — temporary override for the two-pass deploy flow. When set,
   * `getAuthWitnessProvider` returns this instead of the default device-backed
   * provider. The deploy builder uses it to inject a spy (pass 1) then a
   * `FrozenAuthWitnessProvider` carrying the pre-signed device witness (pass 2).
   * Outside of the deploy flow it's always `null`. */
  private overrideProvider: AuthWitnessProvider | null = null;
  /** P0 seam spike — temporary `EntrypointInterface` override. When set,
   * `getAccount()` builds the account around THIS entrypoint (our
   * `LedgerClearSigningEntrypoint`) instead of the framework's
   * `DefaultAccountEntrypoint`. The deploy spike uses it to route
   * `getDeployMethod()` through the proper clear-signing seam; `null` restores the
   * default. Reversible, never persisted across deploy boundaries (mirrors
   * `setAuthWitnessOverride`). */
  private entrypointOverride: EntrypointInterface | null = null;

  constructor(transport: LedgerTransport, options: LedgerEcdsaKAccountContractOptions) {
    super();
    this.defaultProvider = new LedgerEcdsaKAuthWitnessProvider(transport, options);
  }

  override getContractArtifact(): Promise<ContractArtifact> {
    return Promise.resolve(EcdsaKAccountContractArtifact);
  }

  /**
   * Returns the args the Noir `EcdsaKAccount::constructor(signing_pub_key_x, signing_pub_key_y)`
   * expects — `[[...x], [...y]]`, each a `[u8; 32]`. Pulls the pubkey from the device.
   */
  override async getInitializationFunctionAndArgs(): Promise<{
    constructorName: string;
    constructorArgs: Buffer[];
  }> {
    const { x, y } = await this.defaultProvider.getPublicKeyXY();
    return {
      constructorName: 'constructor',
      constructorArgs: [Buffer.from(x), Buffer.from(y)],
    };
  }

  override getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return this.overrideProvider ?? this.defaultProvider;
  }

  /**
   * M8 P1 — install a temporary auth-provider override. Used by the deploy
   * builder to capture the framework's outer_hash via a spy (pass 1) and then
   * hand back a `FrozenAuthWitnessProvider` carrying the pre-signed device
   * witness (pass 2). Pass `null` to restore the default device-backed
   * provider. Never persisted across deploy boundaries.
   */
  setAuthWitnessOverride(provider: AuthWitnessProvider | null): void {
    this.overrideProvider = provider;
  }

  /** Exposed for tests + the demo CLI; the framework only sees this via `getAuthWitnessProvider`. */
  getProvider(): LedgerEcdsaKAuthWitnessProvider {
    return this.defaultProvider;
  }

  /** P0 seam spike — install/clear the `EntrypointInterface` override (see field). */
  setEntrypointOverride(entrypoint: EntrypointInterface | null): void {
    this.entrypointOverride = entrypoint;
  }

  /**
   * When an entrypoint override is installed, build the account around it (our
   * proper clear-signing seam) instead of the framework's `DefaultAccountEntrypoint`.
   * `getDeployMethod()` SNAPSHOTS this at build time, so the override MUST be set
   * before the deploy method is built (same ordering rule as `setAuthWitnessOverride`).
   */
  override getAccount(completeAddress: CompleteAddress): Account {
    if (this.entrypointOverride) {
      return new BaseAccount(
        this.entrypointOverride,
        this.getAuthWitnessProvider(completeAddress),
        completeAddress,
      );
    }
    return super.getAccount(completeAddress);
  }
}
