/**
 * M10 — `AccountContract` backing Aztec's canonical `SchnorrAccount` with a Ledger
 * device (Grumpkin Schnorr signing key never leaves the device).
 *
 * P1 (entrypoint-seam-refactor): extends `LedgerAccountContractBase` (shared device
 * provider + clear-signing-entrypoint override). Differs from the ECDSA-K contract
 * only in the artifact, the 2-Field ctor args (the Grumpkin pubkey), and
 * `curveId=GRUMPKIN` so the device dispatches its Schnorr signing primitive. The
 * shared base is what lets `deployAccountViaEntrypoint` clear-sign Schnorr deploys
 * through the same seam as ECDSA.
 */
import { SchnorrAccountContractArtifact } from '@aztec/accounts/schnorr';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';

import { CURVE_ID } from './apdu.ts';
import {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
import { LedgerAccountContractBase } from './ledger-account-contract-base.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerSchnorrAccountContractOptions extends LedgerProviderOptions {}

export class LedgerSchnorrAccountContract extends LedgerAccountContractBase {
  constructor(transport: LedgerTransport, options: LedgerSchnorrAccountContractOptions) {
    /* The provider is scheme-generic; curveId=GRUMPKIN selects the device Schnorr
     * path (GET_SCHNORR_PUBKEY + Schnorr authwit/deploy sign). */
    super(
      new LedgerEcdsaKAuthWitnessProvider(transport, { ...options, curveId: CURVE_ID.GRUMPKIN }),
    );
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
}
