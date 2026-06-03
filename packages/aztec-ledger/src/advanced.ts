/**
 * `aztec-ledger/advanced` — the EXPERT, UNGUARDED surface.
 *
 * ⚠️ OUTSIDE the fail-closed guarantees of the root barrel. Everything here is
 * for building custom flows and is your responsibility to use safely:
 *
 *   - `LedgerProvider` — the raw APDU driver (no entrypoint, no attestation).
 *   - `revealMasterSecret` / `revealOrReuseMasterSecret` — the onboarding flow
 *     that DISCLOSES the device's viewing/privacy root to host memory (under one
 *     on-device approval). The spend key never leaves the device; the viewing
 *     root does, by design. Treat the returned secret as sensitive.
 *   - the in-memory secret cache controls + the low-level auth-witness provider.
 *   - raw APDU / BIP-32 path constants + the generated deploy-profile lookup.
 *
 * Normal consumers should use the root barrel and `getAccount()`.
 */

export {
  AZTEC_COIN_TYPE,
  AZTEC_COIN_TYPE_HARDENED,
  type AzCall,
  type AzKeyPath,
  type AzManifestHeader,
  CLA,
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
export { defaultDeployPath, encodeBeginDeployAccountBody } from './deploy-context.ts';
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
} from './provider.ts';
export { clearAllCachedSecrets, hasCachedSecret } from './secret-cache.ts';
export type { ApduRequest, ApduResponse } from './transport.ts';
