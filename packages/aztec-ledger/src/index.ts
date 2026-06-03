/**
 * `aztec-ledger` — the safe, fail-closed public surface.
 *
 * This root barrel exports ONLY the safe-by-default API + types: the account
 * contracts (which sign via the device through `getAccount`'s clear-signing
 * entrypoint), the device-attested-address check (AHW-098, on by default), the
 * default derivation path, the version/caps surface, and the transport TYPE.
 *
 * It deliberately exports NO concrete transport, NO raw APDU signer, and NO
 * key-reveal / onboarding flow:
 *   - concrete transports  → `./webhid`, `./speculos` (and `./node-hid`, P3)
 *   - raw signer           → `./unsafe`  (AHW-097, loud + gated)
 *   - raw `LedgerProvider`, reveal, onboarding, low-level APDU → `./advanced`
 *     (the expert surface, OUTSIDE the fail-closed guarantees)
 *
 * (`connectLedger` / `LedgerConnection` / typed errors / the `ClearSignPreflight`
 * hook type land here in P1/P4 of the extraction plan.)
 */

export {
  LedgerEcdsaKAccountContract,
  type LedgerEcdsaKAccountContractOptions,
} from './account-contract.ts';
export {
  CAPS,
  CURVE_ID,
  type CurveId,
  defaultAztecPath,
} from './apdu.ts';
export type { DeployContext } from './deploy-context.ts';
export type { VersionInfo } from './provider.ts';
export {
  assertDeviceAttestedAddress,
  type DeviceAttestationCheck,
} from './receive-address-verify.ts';
export {
  LedgerSchnorrAccountContract,
  type LedgerSchnorrAccountContractOptions,
} from './schnorr-account-contract.ts';
export type { AutoConfirmContext, LedgerTransport } from './transport.ts';
