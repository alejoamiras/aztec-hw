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
  /* M7 P3 — clear-signed deploy. Same shape as BEGIN/APPEND/FINALIZE
   * but for the DEPLOY_ACCOUNT_ECDSAK_V1 profile, NOT a verb call. */
  BEGIN_DEPLOY_ACCOUNT: 0x10,
  FINALIZE_DEPLOY_AND_SIGN: 0x11,
  /* M8 P4 — reveal the 32-byte Aztec master secret (Fr) for this path, after
   * a high-friction on-device confirmation. The host runs it through Aztec's
   * deriveKeys() to reconstruct the viewing keys. See master-secret.ts. */
  GET_AZTEC_MASTER_SECRET: 0x12,
  /* M10 — Grumpkin Schnorr signing pubkey P=priv·G (64B X||Y) for the
   * SchnorrAccount ctor. Non-sensitive, no confirmation (like GET_PUBLIC_KEY). */
  GET_SCHNORR_PUBKEY: 0x13,
} as const;

export type Ins = (typeof INS)[keyof typeof INS];

/** Curve identifier byte. */
export const CURVE_ID = {
  SECP256K1: 1,
  SECP256R1: 2,
  GRUMPKIN: 3,
} as const;

export type CurveId = (typeof CURVE_ID)[keyof typeof CURVE_ID];

/** Path-derivation scheme byte.
 *
 * `DEFAULT (0)` is the only scheme the device honors at L4 — corresponds to
 * `m/44'/AZTEC_COIN_TYPE'/account'/0/0`. SLIP_0013 and SLIP_44 explicit are
 * reserved for future hierarchical/multi-key schemes; device rejects them today.
 */
export const PATH_SCHEME = {
  DEFAULT: 0,
  SLIP_0013_AZTEC: 1,
  SLIP_44_AZTEC: 2,
} as const;

export type PathScheme = (typeof PATH_SCHEME)[keyof typeof PATH_SCHEME];

/** Aztec capability bits returned by GET_CAPS (mirrors `caps_e` in ledger-app/src/types.h). */
export const CAPS = {
  K1: 1 << 0,
  R1: 1 << 1,
  CLEAR_SIGN: 1 << 2,
  GRUMPKIN: 1 << 3,
} as const;

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

/**
 * Assert a BIP-32 path is the exact canonical Aztec shape
 * `m/44'/AZTEC'/<acct>'/0/0` that the device enforces (M9 B3 — the reveal,
 * deploy AND authwit handlers all reject anything else with 0x6F03). Throwing
 * here lets the host fail fast with a legible message instead of bouncing off
 * an opaque device status word (codex post-impl LOW: the encoder previously
 * accepted 5..10 components, drifting from the device's exact-5 requirement).
 */
export function assertCanonicalAztecPath(path: readonly number[]): void {
  const ok =
    path.length === 5 &&
    path[0] === hardened(44) &&
    path[1] === AZTEC_COIN_TYPE_HARDENED &&
    ((path[2] ?? 0) & 0x8000_0000) !== 0 && // account component hardened (undefined → fails)
    path[3] === 0x0000_0000 &&
    path[4] === 0x0000_0000;
  if (!ok) {
    throw new Error(
      `bip32 path must be canonical m/44'/AZTEC'/<acct>'/0/0, got [${path.join(', ')}]`,
    );
  }
}

export interface AzManifestHeader {
  /** Bumps when the manifest wire layout changes. Device rejects unknown versions. */
  readonly manifestVersion: number;
  readonly key: AzKeyPath;
  /** AHW-018 (wire v3): the account template (allowlisted, paired with curveId) the
   * device re-derives the address for. */
  readonly profileId: number;
  /** AHW-018 (wire v3): the account-deploy salt (32 B). The device binds `consumer`
   * to the address derived from (path, profile, salt) + its own keys. */
  readonly salt: Uint8Array; // 32 B
  readonly consumer: Uint8Array; // 32 B
  readonly chainId: Uint8Array; // 32 B
  /** Aztec `chainInfo.version` — renamed from `authVersion` per L4 deep-plan §2. */
  readonly protocolVersion: Uint8Array; // 32 B
  readonly txNonce: Uint8Array; // 32 B
  /** Non-padding calls only; device checks ≤ APP_MAX_CALLS = 5. */
  readonly callCount: number;
}

export interface AzCall {
  readonly argsHash: Uint8Array; // 32 B
  readonly functionSelectorField: Uint8Array; // 32 B
  readonly targetAddressField: Uint8Array; // 32 B
  /** Bit0 public; bit1 hide_msg_sender; bit2 static. Bit3+ MUST be zero. */
  readonly flags: number;
  /** Raw Fr args (each 32 B BE). length must be <= APP_MAX_ARGS. M5.1+ wire. */
  readonly args: readonly Uint8Array[];
}

/** Call flag bit layout (mirrors `L4_CALL_FLAG_*` in ledger-app/src/l4/wire.h). */
export const CALL_FLAG = {
  PUBLIC: 1 << 0,
  HIDE_MSG_SENDER: 1 << 1,
  STATIC: 1 << 2,
} as const;

export const APP_MAX_CALLS = 5;
/** Manifest format version. Bumped to 2 for the clear-signing v0 wire extension
 * (raw args streamed alongside args_hash). v1 firmware rejects v2 manifests and
 * vice versa — no compatibility path (codex M5 final-review MAJOR #2). */
/** v3 (AHW-018): BEGIN_AUTHWIT carries profile_id + salt. Shared with deploy (a hard
 * cut — device rejects older versions, host emits v3 only; no fallback). */
export const MANIFEST_VERSION = 3;
export const FR_BYTES = 32;
/** Max number of raw Fr args per APPEND_CALL — fits all aztec-standards FT
 * verbs (4-arg transfer, 2-arg mint, 0-arg sponsor) inside one 255 B APDU. */
export const APP_MAX_ARGS = 4;

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
  REGISTRY_MISS: 0x6f08,
  DECODER_MISS: 0x6f09,
  DECODER_DESYNC: 0x6f0a,
  VISIBILITY_MISMATCH: 0x6f0b,
  DELEGATED_SPEND_UNSUPPORTED: 0x6f0c,
  /* M7 P3 — clear-signed deploy. */
  UNKNOWN_PROFILE_ID: 0x6f0d,
  DEPLOY_ADDRESS_MISMATCH: 0x6f0e, // AHW-006: LIVE M8 sovereignty gate — device-derived address != host expected_address
  DEPLOY_PUBKEY_HASH_MISMATCH: 0x6f0f, // AHW-006: LIVE M8 sovereignty gate — device-derived publicKeysHash != host
  DEPLOY_CONTEXT_TWICE: 0x6f10,
  DEPLOY_CONTEXT_WRONG_STATE: 0x6f11,
  /* M9 B3 — authwit consumer ≠ device-recomputed account address (fail-closed). */
  AUTHWIT_CONSUMER_MISMATCH: 0x6f12,
} as const;

export type StatusWord = (typeof SW)[keyof typeof SW];
