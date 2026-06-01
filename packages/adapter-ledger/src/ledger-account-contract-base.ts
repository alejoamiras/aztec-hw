/**
 * Shared base for the Ledger-backed `AccountContract`s (ECDSA-K + Schnorr). Holds the
 * device-backed provider + the `EntrypointInterface` override that routes signing
 * through `LedgerClearSigningEntrypoint` (the proper clear-signing seam). Subclasses
 * provide only their artifact + initialization args (the per-scheme bits).
 *
 * P1 (entrypoint-seam-refactor): replaces the per-contract spy/freeze
 * `setAuthWitnessOverride` machinery (deleted with the legacy two-pass deploy) with a
 * single `setEntrypointOverride` used by `AztecLedgerSession.deployAccountViaEntrypoint`.
 * Dedups what was duplicated across the two contracts; the device-signing key never
 * leaves the Ledger in either scheme.
 */
import { DefaultAccountContract } from '@aztec/accounts/defaults';
import { type Account, type AuthWitnessProvider, BaseAccount } from '@aztec/aztec.js/account';
import type { EntrypointInterface } from '@aztec/entrypoints/interfaces';
import type { CompleteAddress } from '@aztec/stdlib/contract';

import type { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';

export abstract class LedgerAccountContractBase extends DefaultAccountContract {
  /** One-shot override installed by the deploy flow so `getDeployMethod()` snapshots
   * an account built around our entrypoint; `null` = the framework's default account. */
  #entrypointOverride: EntrypointInterface | null = null;

  /** The provider is scheme-generic — `curveId` selects ECDSA-K vs Grumpkin/Schnorr. */
  constructor(protected readonly defaultProvider: LedgerEcdsaKAuthWitnessProvider) {
    super();
  }

  /** P1 — install/clear the `EntrypointInterface` override (mirrors the retired
   * `setAuthWitnessOverride`; reversible, never persisted across deploy boundaries). */
  setEntrypointOverride(entrypoint: EntrypointInterface | null): void {
    this.#entrypointOverride = entrypoint;
  }

  /** When an override is installed, build the account around it (our clear-signing
   * seam) — `getDeployMethod()` SNAPSHOTS `getAccount()`, so the override must be set
   * before the deploy method is built. Otherwise defer to the framework's default. */
  override getAccount(completeAddress: CompleteAddress): Account {
    if (this.#entrypointOverride) {
      return new BaseAccount(
        this.#entrypointOverride,
        this.getAuthWitnessProvider(completeAddress),
        completeAddress,
      );
    }
    return super.getAccount(completeAddress);
  }

  override getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return this.defaultProvider;
  }

  /** Exposed for tests + the demo; the framework only sees this via `getAuthWitnessProvider`. */
  getProvider(): LedgerEcdsaKAuthWitnessProvider {
    return this.defaultProvider;
  }
}
