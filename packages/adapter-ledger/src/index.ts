/**
 * Ledger adapter for Aztec — the clear-signing account contracts + provider that
 * drive the custom BOLOS app at `ledger-app/`.
 *
 *   - `LedgerTransport` is the swap point between Speculos (test) and real device.
 *   - `LedgerClearSigningEntrypoint` (via the account contracts' `getAccount`) is the
 *     production signing seam; `LedgerProvider` is the low-level APDU driver.
 *
 * (The earlier Trezor adapter + the core `IntentAuthWitnessProvider` path this header
 * once referenced were removed in the audit-remediation dead-code pass.)
 */

export {
  LedgerEcdsaKAccountContract,
  type LedgerEcdsaKAccountContractOptions,
} from './account-contract.ts';
export {
  AZTEC_COIN_TYPE,
  AZTEC_COIN_TYPE_HARDENED,
  type AzCall,
  type AzKeyPath,
  type AzManifestHeader,
  CLA,
  CURVE_ID,
  type CurveId,
  defaultAztecPath,
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
  AztecLedgerSession,
  type AztecLedgerSessionConnectOptions,
  type AztecLedgerSessionDeps,
  DEFAULT_ACCOUNT_SALT,
  type PhaseId,
  type SubmitOptions,
  type SubmitResult,
  type SubmitStepHandler,
} from './aztec-ledger-session.ts';
export {
  type DeployContext,
  defaultDeployPath,
  encodeBeginDeployAccountBody,
} from './deploy-context.ts';
export {
  deviceCacheKey,
  type RevealedMasterSecret,
  type RevealOrReuseResult,
  revealMasterSecret,
  revealOrReuseMasterSecret,
} from './onboarding.ts';
export {
  LedgerProvider,
  type LedgerPublicKey,
  type LedgerSignature,
  type SignOuterHashOptions,
  type VersionInfo,
} from './provider.ts';
// AHW-103: the raw cache read/write/clear-one primitives (`loadCachedSecret`,
// `cacheSecret`, `clearCachedSecret`) are NO LONGER public — they let any
// in-process consumer re-pull the revealed privacy root with no device approval.
// The barrel exposes only the "forget" control + a presence check; obtaining a
// secret goes through `revealOrReuseMasterSecret` (onboarding layer).
export { clearAllCachedSecrets, hasCachedSecret } from './secret-cache.ts';
export { SessionEmbeddedWallet } from './session-embedded-wallet.ts';
export {
  type ButtonId,
  SpeculosTransport,
  type SpeculosTransportOptions,
} from './speculos-transport.ts';
export type {
  ApduRequest,
  ApduResponse,
  AutoConfirmContext,
  LedgerTransport,
} from './transport.ts';
export {
  createWebHidTransport,
  WebHidDeviceDisconnectedError,
  WebHidLedgerTransport,
  WebHidNotSupportedError,
} from './webhid-transport.ts';
