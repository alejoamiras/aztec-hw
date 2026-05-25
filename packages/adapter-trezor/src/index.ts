/**
 * Trezor adapter for Aztec.
 *
 * Implements `AuthWitnessProvider` for `EcdsaKAccount` via the Trezor `SignIdentity(gpg)`
 * lower-level path — the only viable Aztec surface on Trezor today (Wave 1 finding:
 * stock `TrezorConnect.requestLogin` doesn't expose `ecdsa_curve_name`).
 *
 * Phase A goal: blind-sign internal demo against the `trezor-firmware` emulator.
 * Phase B will add `IntentAuthWitnessProvider` for clear-signing once the Aztec SDK
 * accepts the extension upstream.
 */

export { type AztecIdentity, buildAztecIdentity, parseAztecIdentity } from './identity.ts';
export { TrezorEcdsaKAuthWitnessProvider } from './provider.ts';
export type { TrezorPublicKey, TrezorSignedIdentity, TrezorTransport } from './transport.ts';
