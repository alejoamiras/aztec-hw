/**
 * Ledger adapter for Aztec — the clear-signing account contracts + provider that
 * drive the custom BOLOS app at `ledger-app/`.
 *
 *   - `LedgerTransport` is the swap point between Speculos (test) and real device.
 *   - `LedgerClearSigningEntrypoint` (via the account contracts' `getAccount`) is the
 *     production signing seam; `LedgerProvider` is the low-level APDU driver.
 *
 * (The earlier Trezor adapter + the core `IntentAuthWitnessProvider` path this header
 * once referenced were removed in the audit-remediation dead-code pass. The demo
 * session glue — `AztecLedgerSession`/`SessionEmbeddedWallet` — moved OUT to
 * apps/demo-browser in the aztec-ledger-extraction P0b step; this barrel is still
 * broad and gets trimmed to the safe root surface + subpaths in P0c.)
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
  CAPS,
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
  type CsDeployProfileId,
  csDeployProfileLookup,
} from './clear_signing_v0/deploy_profiles.generated.ts';
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
export {
  assertDeviceAttestedAddress,
  type DeviceAttestationCheck,
} from './receive-address-verify.ts';
export {
  LedgerSchnorrAccountContract,
  type LedgerSchnorrAccountContractOptions,
} from './schnorr-account-contract.ts';
// AHW-103: the raw cache read/write/clear-one primitives (`loadCachedSecret`,
// `cacheSecret`, `clearCachedSecret`) are NO LONGER public — they let any
// in-process consumer re-pull the revealed privacy root with no device approval.
// The barrel exposes only the "forget" control + a presence check; obtaining a
// secret goes through `revealOrReuseMasterSecret` (onboarding layer).
export { clearAllCachedSecrets, hasCachedSecret } from './secret-cache.ts';
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
