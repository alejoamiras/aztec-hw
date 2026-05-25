/**
 * Shared types for the Aztec hardware-wallet PoC.
 *
 * Re-exports the upstream `@aztec/*` signing primitives that adapter packages need,
 * plus the proposed Option A extension shape (`IntentAuthWitnessProvider`) and the
 * `CallIntent` type that a device-side manifest-verifying signer would consume.
 *
 * Design basis: `../../../aztec-hardware-wallet/architectures/02-clear-signing-interface.md`.
 */

export type { AuthWitnessProvider, ChainInfo } from '@aztec/entrypoints/interfaces';
export { Fr } from '@aztec/foundation/curves/bn254';
export { AuthWitness, computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
export { AztecAddress } from '@aztec/stdlib/aztec-address';
export * from './ecdsa.ts';
export * from './intent.ts';
export * from './provider.ts';
