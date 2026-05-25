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
 * Aztec SLIP-44 coin type. **Build-time override** (final-critique §4): do NOT
 * hardcode a number into executable code; this constant exists so a future
 * SatoshiLabs registration drops in without source changes. PoC placeholder is
 * 1666 (unused on the registry as of May 2026 — `unverified — research target`).
 */
export const AZTEC_COIN_TYPE = 1666;

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

/** Status words (per ISO 7816-4 convention). */
export const SW = {
  OK: 0x9000,
  CONDITIONS_NOT_SATISFIED: 0x6985, // user rejected on-device
  WRONG_DATA: 0x6a80, // malformed APDU payload
  INVALID_INS: 0x6d00,
  INVALID_CLA: 0x6e00,
  HASH_MISMATCH: 0x6a82, // on-device outer_hash didn't match what the host expected
  UNKNOWN_MANIFEST_VERSION: 0x6a83,
} as const;

export type StatusWord = (typeof SW)[keyof typeof SW];
