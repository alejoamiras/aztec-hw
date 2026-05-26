/**
 * Aztec Ledger app — APDU command set + request/response layouts.
 *
 * Mirrors the C struct definitions in `ledger-app/src/apdu_types.h`. Single
 * source of TS truth; if the device-side spec changes, this file is the host-side
 * sync point. See `implementations-plan/hw-wallet-poc-ledger/plan-final.md` §2.
 *
 * CLA = 0xE0 (standard Ledger app convention).
 *
 * **No session_id in the wire format** (final-critique §3): Ledger apps are
 * single-threaded with one in-flight context. Session state lives in app
 * globals on the device; zero on every error/reject/abort.
 */

export const CLA = 0xe0;

/** INS bytes — codex's consolidated streaming command set. */
export const INS = {
  GET_VERSION: 0x01,
  GET_CAPS: 0x02,
  GET_PUBLIC_KEY: 0x03,
  SIGN_OUTER_HASH: 0x04,
  BEGIN_AUTHWIT: 0x05,
  APPEND_CALL: 0x06,
  FINALIZE_AND_SIGN: 0x07,
  ABORT: 0x08,
} as const;

export type Ins = (typeof INS)[keyof typeof INS];

/** Curve identifier byte. */
export const CURVE_ID = {
  SECP256K1: 1,
  SECP256R1: 2,
  GRUMPKIN: 3,
} as const;

export type CurveId = (typeof CURVE_ID)[keyof typeof CURVE_ID];

/** Path-derivation scheme byte. */
export const PATH_SCHEME = {
  SLIP_0013_AZTEC: 1,
  SLIP_44_AZTEC: 2,
} as const;

export type PathScheme = (typeof PATH_SCHEME)[keyof typeof PATH_SCHEME];

export interface AzKeyPath {
  readonly curveId: CurveId;
  readonly pathScheme: PathScheme;
  /** Up to 10 BIP-32 path components (hardened or not, encoded as uint32). */
  readonly path: readonly number[];
}

/**
 * Aztec SLIP-44 coin type — env-driven so the PoC placeholder doesn't bake into
 * client code (codex L2 MINOR #6 / final-critique §4).
 *
 * Override at runtime with `AZTEC_COIN_TYPE=N`; default `1666` is documented as
 * an unregistered placeholder. The device-side Makefile honours the same name
 * (`make AZTEC_COIN_TYPE=N`).
 */
export const AZTEC_COIN_TYPE: number = (() => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.AZTEC_COIN_TYPE;
  if (raw === undefined || raw === '') return 1666;
  // Strict decimal-only — rejects "1666junk", " 1666 ", "0x10", etc.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`AZTEC_COIN_TYPE env must be a decimal uint31, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 0x7fff_ffff) {
    throw new Error(`AZTEC_COIN_TYPE env must fit in uint31, got "${raw}"`);
  }
  return n;
})();

/**
 * Hardened SLIP-44 coin-type path component (`0x8000_0000 | AZTEC_COIN_TYPE`).
 *
 * `>>> 0` is the canonical idiom to coerce JS's signed-int32 bitwise result
 * back to an unsigned uint32 — without it, `0x80000000 | 1666` returns
 * `-2147481982`, which the strict path encoder correctly rejects.
 */
export const AZTEC_COIN_TYPE_HARDENED: number = (0x8000_0000 | AZTEC_COIN_TYPE) >>> 0;

/**
 * Mark a BIP-32 path component as hardened. Returns an unsigned uint32.
 * Validates `index` to a uint31 — silent wrap on bad input would be a footgun
 * (codex L2 follow-up #2 NIT).
 */
export function hardened(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fff_ffff) {
    throw new Error(`hardened(): index must be a uint31, got ${index}`);
  }
  return (0x8000_0000 | index) >>> 0;
}

/** Default Aztec BIP-32 path `m/44'/AZTEC_COIN_TYPE'/{account}'/0/0`. */
export function defaultAztecPath(account = 0): readonly number[] {
  if (!Number.isInteger(account) || account < 0 || account > 0x7fff_ffff) {
    throw new Error(`account must be a uint31, got ${account}`);
  }
  return [hardened(44), AZTEC_COIN_TYPE_HARDENED, hardened(account), 0x0000_0000, 0x0000_0000];
}

export interface AzManifestHeader {
  /** Bumps when the manifest wire layout changes. Device rejects unknown versions. */
  readonly manifestVersion: number;
  readonly key: AzKeyPath;
  readonly consumer: Uint8Array; // 32 B
  readonly chainId: Uint8Array; // 32 B
  readonly authVersion: Uint8Array; // 32 B
  readonly txNonce: Uint8Array; // 32 B
  /** Non-padding calls only; device checks ≤ APP_MAX_CALLS = 5. */
  readonly callCount: number;
}

export interface AzCall {
  readonly argsHash: Uint8Array; // 32 B
  readonly functionSelectorField: Uint8Array; // 32 B
  readonly targetAddressField: Uint8Array; // 32 B
  /** Bit0 public; bit1 hide_msg_sender; bit2 static; bit3 padding. */
  readonly flags: number;
}

/**
 * Status words mirrored from `ledger-app/src/sw.h`. Aztec-specific codes use the
 * proprietary 6Fxx range to avoid colliding with the SDK's ISO `SWO_*` constants
 * (codex L2 MINOR #5 — single source of truth restored).
 */
export const SW = {
  OK: 0x9000,
  // ISO-standard codes the SDK already emits.
  CONDITIONS_NOT_SATISFIED: 0x6985, // user rejected on-device / Aztec SW_USER_REJECTED
  WRONG_DATA_LENGTH: 0x6a87,
  INCORRECT_P1_P2: 0x6a86,
  INVALID_INS: 0x6d00,
  INVALID_CLA: 0x6e00,
  UNKNOWN: 0x6f00,
  // Aztec-specific codes from `ledger-app/src/sw.h`.
  HASH_MISMATCH: 0x6f01,
  UNKNOWN_MANIFEST_VERSION: 0x6f02,
  INVALID_PATH_SCHEME: 0x6f03,
  INVALID_CURVE_ID: 0x6f04,
  BIP32_TOO_LONG: 0x6f05,
  DUP_SIG_MISMATCH: 0x6f06,
  NOT_IMPLEMENTED: 0x6f07,
} as const;

export type StatusWord = (typeof SW)[keyof typeof SW];
