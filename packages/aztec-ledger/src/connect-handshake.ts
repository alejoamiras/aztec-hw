/**
 * Mandatory connect handshake — the fail-closed device/SDK compatibility gate.
 *
 * Run BEFORE any safe device operation (it gates the account-contract path, not
 * the raw `./advanced` provider). Two independent checks:
 *   1. GET_VERSION — the device app version must fall in this build's supported
 *      RANGE `[min, maxExclusive)`.
 *   2. GET_CAPS — the device's capability bitmask must be a SUPERSET of the caps
 *      the requested flow needs (clear-sign + attest + the scheme's curve).
 *
 * This is SEPARATE from the OPTIONAL registry/manifest-id check (which rides the
 * `ClearSignPreflight` hook): the version+caps handshake is mandatory and shipped
 * in the SDK; the registry-id agreement is the consumer's (it ships the registry).
 * The device remains the ultimate authority — this is a fast, typed host gate.
 */
import { CAPS, CURVE_ID, type CurveId } from './apdu.ts';
import type { LedgerProvider, VersionInfo } from './provider.ts';

/** Device app versions this SDK build is verified against: `[min, maxExclusive)`. */
export const SUPPORTED_APP_VERSION = {
  min: { major: 0, minor: 1, patch: 0 },
  maxExclusive: { major: 1, minor: 0, patch: 0 },
} as const;

/** Caps every safe flow needs regardless of scheme (clear-signing + attested address). */
export const REQUIRED_CAPS_BASE = CAPS.CLEAR_SIGN | CAPS.ATTEST_ADDRESS;

function fmt(v: VersionInfo): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** -1 / 0 / 1 ordering of two semver-ish 3-tuples. */
function compareVersion(
  a: VersionInfo,
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function versionInRange(v: VersionInfo): boolean {
  return (
    compareVersion(v, SUPPORTED_APP_VERSION.min) >= 0 &&
    compareVersion(v, SUPPORTED_APP_VERSION.maxExclusive) < 0
  );
}

/** Required caps for a scheme = the base + the scheme's signing-curve cap. */
export function requiredCapsForCurve(curveId?: CurveId): number {
  const curveCap = curveId === CURVE_ID.GRUMPKIN ? CAPS.GRUMPKIN : CAPS.K1;
  return REQUIRED_CAPS_BASE | curveCap;
}

export class LedgerIncompatibleVersionError extends Error {
  constructor(readonly deviceVersion: VersionInfo) {
    super(
      `Ledger Aztec app ${fmt(deviceVersion)} is outside this SDK's supported range ` +
        `[${fmt(SUPPORTED_APP_VERSION.min)}, ${fmt(SUPPORTED_APP_VERSION.maxExclusive)}). ` +
        'Update the device app or the SDK so they match.',
    );
    this.name = 'LedgerIncompatibleVersionError';
  }
}

export class LedgerMissingCapabilityError extends Error {
  constructor(
    readonly deviceCaps: number,
    readonly missingCaps: number,
  ) {
    super(
      `Ledger Aztec app is missing required capabilities: device caps=0x${deviceCaps.toString(16)}, ` +
        `missing bits=0x${missingCaps.toString(16)}. The installed app is too old or a different build.`,
    );
    this.name = 'LedgerMissingCapabilityError';
  }
}

/**
 * Run the mandatory handshake. Throws {@link LedgerIncompatibleVersionError} or
 * {@link LedgerMissingCapabilityError} on mismatch; otherwise returns the probed
 * version + caps. `provider` is `Pick`ed so callers (and tests) can pass any
 * `getVersion`/`getCaps` source.
 */
export async function assertDeviceCompatible(
  provider: Pick<LedgerProvider, 'getVersion' | 'getCaps'>,
  requiredCaps: number,
): Promise<{ version: VersionInfo; caps: number }> {
  const version = await provider.getVersion();
  if (!versionInRange(version)) {
    throw new LedgerIncompatibleVersionError(version);
  }
  const caps = await provider.getCaps();
  const missing = requiredCaps & ~caps;
  if (missing !== 0) {
    throw new LedgerMissingCapabilityError(caps, missing >>> 0);
  }
  return { version, caps };
}
