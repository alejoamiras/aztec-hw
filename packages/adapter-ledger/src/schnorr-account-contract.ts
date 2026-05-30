/**
 * M10 — `AccountContract` backing Aztec's canonical `SchnorrAccount` with a
 * Ledger device (Grumpkin Schnorr signing key never leaves the device). Mirrors
 * account-contract.ts (the ECDSA-K version); the only differences are the
 * artifact, the 2-Field ctor args (the Grumpkin pubkey), and curveId=GRUMPKIN
 * so the device dispatches its Schnorr signing primitive.
 */
import { DefaultAccountContract } from '@aztec/accounts/defaults';
import { SchnorrAccountContractArtifact } from '@aztec/accounts/schnorr';
import type { AuthWitnessProvider } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { CompleteAddress } from '@aztec/stdlib/contract';

import { CURVE_ID } from './apdu.ts';
import {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerSchnorrAccountContractOptions extends LedgerProviderOptions {}

export class LedgerSchnorrAccountContract extends DefaultAccountContract {
  /* The provider is scheme-generic despite its name; curveId=GRUMPKIN selects
   * the device Schnorr path (GET_SCHNORR_PUBKEY + Schnorr authwit sign). */
  private readonly defaultProvider: LedgerEcdsaKAuthWitnessProvider;
  private overrideProvider: AuthWitnessProvider | null = null;

  constructor(transport: LedgerTransport, options: LedgerSchnorrAccountContractOptions) {
    super();
    this.defaultProvider = new LedgerEcdsaKAuthWitnessProvider(transport, {
      ...options,
      curveId: CURVE_ID.GRUMPKIN,
    });
  }

  override getContractArtifact(): Promise<ContractArtifact> {
    return Promise.resolve(SchnorrAccountContractArtifact);
  }

  /** SchnorrAccount::constructor(signing_pub_key_x: Field, signing_pub_key_y: Field).
   * Pulls the Grumpkin pubkey from the device and passes the two coords as Frs. */
  override async getInitializationFunctionAndArgs(): Promise<{
    constructorName: string;
    constructorArgs: Fr[];
  }> {
    const { x, y } = await this.defaultProvider.getPublicKeyXY();
    return {
      constructorName: 'constructor',
      constructorArgs: [Fr.fromBuffer(Buffer.from(x)), Fr.fromBuffer(Buffer.from(y))],
    };
  }

  override getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return this.overrideProvider ?? this.defaultProvider;
  }

  /** M8 P1 — temporary override for the two-pass deploy flow (spy → frozen). */
  setAuthWitnessOverride(provider: AuthWitnessProvider | null): void {
    this.overrideProvider = provider;
  }

  getProvider(): LedgerEcdsaKAuthWitnessProvider {
    return this.defaultProvider;
  }
}
