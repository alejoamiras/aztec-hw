/**
 * Pinned addresses + constructor args for nulo's deployed faucet contracts.
 * Mirrors `nulo/nulo-2/packages/faucet/src/contracts/deployments.json`.
 *
 * The instances are computed via `getContractInstanceFromInstantiationParams`
 * with the actual salt/constructorArtifact/constructorArgs so the PXE
 * `registerContract` call accepts them (codex post-impl §BLOCKER 1 — PXE
 * recomputes the address from the FULL instance and rejects address-only
 * overrides).
 */
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import type { ContractInstanceWithAddress } from '@aztec/stdlib/contract';

/* JSON imports — Vite handles these natively. */
import dripperArtifact from '@defi-wonderland/aztec-standards/target/dripper-Dripper.json' with {
  type: 'json',
};
import tokenArtifact from '@defi-wonderland/aztec-standards/target/token_contract-Token.json' with {
  type: 'json',
};

export const NULO_DRIPPER_ADDRESS = AztecAddress.fromString(
  '0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070',
);
export const NULO_USDC_ADDRESS = AztecAddress.fromString(
  '0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5',
);

/** SponsoredFPC at the protocol-canonical salt=0 — deployed on testnet. */
export const SPONSORED_FPC_ADDRESS = AztecAddress.fromString(
  '0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257',
);

export const DRIPPER_SALT = 1337n;
export const USDC_SALT = 4242n;
export const USDC_DECIMALS = 6;

export const TOKEN_ARTIFACT = tokenArtifact as unknown as ContractArtifact;
export const DRIPPER_ARTIFACT = dripperArtifact as unknown as ContractArtifact;

/**
 * Recompute the Dripper's deployed instance. Constructor has zero args.
 * Salt = 1337 (from nulo's deployments.json).
 */
export async function dripperInstance(): Promise<ContractInstanceWithAddress> {
  const instance = await getContractInstanceFromInstantiationParams(DRIPPER_ARTIFACT, {
    salt: new Fr(DRIPPER_SALT),
    constructorArtifact: 'constructor',
    constructorArgs: [],
    deployer: AztecAddress.ZERO,
  });
  if (!instance.address.equals(NULO_DRIPPER_ADDRESS)) {
    throw new Error(
      `Dripper instance address ${instance.address} doesn't match nulo pin ${NULO_DRIPPER_ADDRESS}. ` +
        `Has the artifact pin or salt drifted from nulo/packages/faucet/deployments.json?`,
    );
  }
  return instance;
}

/**
 * Recompute USDC's deployed instance.
 * Constructor: `constructor_with_minter('USDC', 'USDC', 6, dripperAddress)`.
 * Salt = 4242 (from nulo's deployments.json).
 */
export async function usdcInstance(): Promise<ContractInstanceWithAddress> {
  const instance = await getContractInstanceFromInstantiationParams(TOKEN_ARTIFACT, {
    salt: new Fr(USDC_SALT),
    constructorArtifact: 'constructor_with_minter',
    constructorArgs: ['USDC', 'USDC', USDC_DECIMALS, NULO_DRIPPER_ADDRESS],
    deployer: AztecAddress.ZERO,
  });
  if (!instance.address.equals(NULO_USDC_ADDRESS)) {
    throw new Error(
      `USDC instance address ${instance.address} doesn't match nulo pin ${NULO_USDC_ADDRESS}. ` +
        `Has the artifact pin or constructor args drifted from nulo/packages/faucet/deployments.json?`,
    );
  }
  return instance;
}
