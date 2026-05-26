/**
 * Trezor adapter for Aztec.
 *
 * Implements `AuthWitnessProvider` for `EcdsaKAccount` via Trezor's `SignIdentity`
 * lower-level path. Architecture follows codex review of Trezor firmware + Connect
 * (see implementations-plan/hw-wallet-poc-v0/lessons/phase-A-codex-review-1.md).
 *
 * Phase A: blind-sign internal demo against the trezor-firmware emulator.
 * Phase B: `IntentAuthWitnessProvider` for clear-signing once the Aztec SDK extension lands.
 */

export { computeOuterHashForIntent, formatIntentForDevice } from '@aztec-hwwallet-poc/core';
export {
  type AztecIdentityOptions,
  buildAztecIdentity,
  type IdentityType,
  parseAccountIndex,
  serializeIdentity,
} from './identity.ts';
export { TrezorEcdsaKAuthWitnessProvider, type TrezorProviderOptions } from './provider.ts';
export type { TrezorSignedIdentity, TrezorTransport } from './transport.ts';
export {
  type TrezorlibSubprocessOptions,
  TrezorlibSubprocessTransport,
} from './trezorlib-subprocess-transport.ts';
