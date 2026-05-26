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
import type { AuthWitnessProvider } from '@aztec/aztec.js/account';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { CompleteAddress } from '@aztec/stdlib/contract';

import {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerEcdsaKAccountContractOptions extends LedgerProviderOptions {}

export class LedgerEcdsaKAccountContract extends DefaultAccountContract {
  private readonly provider: LedgerEcdsaKAuthWitnessProvider;

  constructor(transport: LedgerTransport, options: LedgerEcdsaKAccountContractOptions) {
    super();
    this.provider = new LedgerEcdsaKAuthWitnessProvider(transport, options);
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
    const { x, y } = await this.provider.getPublicKeyXY();
    return {
      constructorName: 'constructor',
      constructorArgs: [Buffer.from(x), Buffer.from(y)],
    };
  }

  override getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return this.provider;
  }

  /** Exposed for tests + the demo CLI; the framework only sees this via `getAuthWitnessProvider`. */
  getProvider(): LedgerEcdsaKAuthWitnessProvider {
    return this.provider;
  }
}
