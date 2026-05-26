/**
 * Ledger adapter for Aztec.
 *
 * Implementation status: APDU spec + transport interface scaffolded.
 * Actual provider class lands once the C app at `ledger-app/` is buildable
 * (see `implementations-plan/hw-wallet-poc-ledger/plan-final.md` §6).
 *
 * Architecture mirrors `@aztec-hwwallet-poc/adapter-trezor`:
 *   - `LedgerTransport` is the swap point between Speculos (test) and real device
 *   - `LedgerProvider` will implement `IntentAuthWitnessProvider` from core
 */

export {
  type AzCall,
  type AzKeyPath,
  type AzManifestHeader,
  CLA,
  CURVE_ID,
  type CurveId,
  INS,
  type Ins,
  PATH_SCHEME,
  type PathScheme,
  type StatusWord,
  SW,
} from './apdu.ts';
export {
  LedgerEcdsaKAuthWitnessProvider,
  type LedgerProviderOptions,
} from './auth-witness-provider.ts';
export {
  LedgerProvider,
  type LedgerPublicKey,
  type LedgerSignature,
  type SignOuterHashOptions,
  type VersionInfo,
} from './provider.ts';
export {
  type AutoConfirmContext,
  type ButtonId,
  SpeculosTransport,
  type SpeculosTransportOptions,
} from './speculos-transport.ts';
export type { ApduRequest, ApduResponse, LedgerTransport } from './transport.ts';
