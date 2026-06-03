/**
 * `AccountContract` implementation that backs `EcdsaKAccount` with a Ledger device
 * instead of an in-memory `signingPrivateKey`. Mirrors `@aztec/accounts/ecdsa`'s
 * `EcdsaKBaseAccountContract`, but the signing key never leaves the device.
 *
 * P1 (entrypoint-seam-refactor): the device-provider + clear-signing-entrypoint
 * override now live in `LedgerAccountContractBase` (shared with the Schnorr
 * contract). This class provides only the ECDSA-K artifact + the ctor args
 * (the secp256k1 pubkey x‖y). Signing routes through `LedgerClearSigningEntrypoint`
 * via the standard `getAccount(...)` flow — the real Aztec account/entrypoint path.
 */
import { EcdsaKAccountContractArtifact } from '@aztec/accounts/ecdsa';
import type { ContractArtifact } from '@aztec/stdlib/abi';

import {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
import { LedgerAccountContractBase } from './ledger-account-contract-base.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerEcdsaKAccountContractOptions extends LedgerProviderOptions {}

export class LedgerEcdsaKAccountContract extends LedgerAccountContractBase {
  constructor(transport: LedgerTransport, options: LedgerEcdsaKAccountContractOptions) {
    super(new LedgerEcdsaKAuthWitnessProvider(transport, options));
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
}
