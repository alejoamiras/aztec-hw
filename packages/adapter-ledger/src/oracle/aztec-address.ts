/**
 * M8 Phase 0 — Aztec address-derivation oracle.
 *
 * Wraps the full address chain: ctor args → initialization hash → salted
 * initialization hash → partial address → preaddress → address.
 *
 * The Phase 6 device-side `recompute_address()` must byte-match
 * `computeFullAddress()` here for arbitrary inputs.
 *
 * Reference:
 *   aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:22-91
 *   aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:46-62
 */
import type { Fr } from '@aztec/foundation/curves/bn254';
import { FunctionSelector } from '@aztec/stdlib/abi';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import {
  computeInitializationHashFromEncodedArgs,
  computePartialAddress,
  computeSaltedInitializationHash,
} from '@aztec/stdlib/contract';
import type { PublicKeys } from '@aztec/stdlib/keys';
import { computeAddress, computePreaddress } from '@aztec/stdlib/keys';

export {
  AztecAddress,
  computeAddress,
  computeInitializationHashFromEncodedArgs,
  computePartialAddress,
  computePreaddress,
  computeSaltedInitializationHash,
  FunctionSelector,
};

export interface FullAddressInputs {
  /** Contract class id of the account contract (e.g. EcdsaKAccountContract). */
  classId: Fr;
  /** Constructor function selector (NOT a raw Fr — typed `FunctionSelector`). */
  ctorSelector: FunctionSelector;
  /** Constructor arguments encoded as Fr fields per Noir ABI. */
  encodedCtorArgs: Fr[];
  /** Account-creation salt (random Fr per deploy). */
  salt: Fr;
  /** Deployer address (typically `AztecAddress.ZERO` for self-deploys). */
  deployer: AztecAddress;
  /** Four master public keys (derived from the Aztec master secret). */
  publicKeys: PublicKeys;
}

export interface FullAddressOutputs {
  initializationHash: Fr;
  saltedInitializationHash: Fr;
  partialAddress: Fr;
  preaddress: Fr;
  address: AztecAddress;
}

/**
 * Full address chain from primitive inputs. Mirrors the sequence the Phase 6
 * device-side BEGIN_DEPLOY_ACCOUNT must reproduce step-for-step.
 */
export async function computeFullAddress(args: FullAddressInputs): Promise<FullAddressOutputs> {
  const initializationHash = await computeInitializationHashFromEncodedArgs(
    args.ctorSelector,
    args.encodedCtorArgs,
  );
  const saltedInitializationHash = await computeSaltedInitializationHash({
    initializationHash,
    salt: args.salt,
    deployer: args.deployer,
  });
  const partialAddress = await computePartialAddress({
    originalContractClassId: args.classId,
    saltedInitializationHash,
  });
  const publicKeysHash = await args.publicKeys.hash();
  const preaddress = await computePreaddress(publicKeysHash, partialAddress);
  const address = await computeAddress(args.publicKeys, partialAddress);
  return {
    initializationHash,
    saltedInitializationHash,
    partialAddress,
    preaddress,
    address,
  };
}
