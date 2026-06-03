/**
 * EXPLICITLY UNSAFE surface — NOT exported from the package root (AHW-097).
 *
 * `unsafeSignOuterHash` signs an ARBITRARY 32-byte digest with NO on-device
 * manifest review beyond the device's own blind-signing toggle (default OFF).
 * A normal consumer must NEVER reach this — clear-signing goes through
 * `LedgerClearSigningEntrypoint` (the account contracts' `getAccount`). It lives
 * behind the `@aztec/adapter-ledger/unsafe` subpath so importing it is a
 * deliberate, auditable act rather than something every root consumer gets.
 *
 * Takes a `LedgerTransport` directly (not a `LedgerProvider`) so the raw
 * capability is not a method on the root-exported driver.
 */
import { INS, SW } from './apdu.ts';
import type { LedgerSignature, SignOuterHashOptions } from './provider.ts';
import type { LedgerTransport } from './transport.ts';

/**
 * Strict BIP-32 path encoder. Mirrors the internal `LedgerProvider` encoder
 * (kept local to the unsafe module so this surface has no extra public deps);
 * refuses empty / over-long / out-of-range components rather than coercing.
 */
function encodeBip32Path(path: readonly number[]): Uint8Array {
  if (path.length === 0) {
    throw new Error('BIP-32 path must not be empty');
  }
  if (path.length > 10) {
    throw new Error(`BIP-32 path too long: ${path.length} > 10`);
  }
  const out = new Uint8Array(1 + 4 * path.length);
  out[0] = path.length;
  for (let i = 0; i < path.length; i++) {
    const v = path[i]!;
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
      throw new Error(`BIP-32 path component ${i} must be uint32 (got ${String(v)})`);
    }
    out[1 + 4 * i] = (v >>> 24) & 0xff;
    out[2 + 4 * i] = (v >>> 16) & 0xff;
    out[3 + 4 * i] = (v >>> 8) & 0xff;
    out[4 + 4 * i] = v & 0xff;
  }
  return out;
}

/**
 * Raw blind-sign: sign `outerHash` under `bip32Path` with NO clear-sign review.
 * Rejected on-device unless blind-signing is explicitly enabled (default OFF,
 * NVM-sticky). Deliberate opt-in only — see the module header.
 */
export async function unsafeSignOuterHash(
  transport: LedgerTransport,
  bip32Path: readonly number[],
  outerHash: Uint8Array,
  opts: SignOuterHashOptions = {},
): Promise<LedgerSignature> {
  if (outerHash.length !== 32) {
    throw new Error(`outerHash must be 32 bytes, got ${outerHash.length}`);
  }
  const pathBytes = encodeBip32Path(bip32Path);
  const body = new Uint8Array(pathBytes.length + outerHash.length);
  body.set(pathBytes, 0);
  body.set(outerHash, pathBytes.length);
  const r = await transport.send({ ins: INS.SIGN_OUTER_HASH, data: body }, opts.autoConfirm);
  if (r.sw !== SW.OK) {
    throw new Error(`SIGN_OUTER_HASH failed: SW=0x${r.sw.toString(16).padStart(4, '0')}`);
  }
  if (r.data.length !== 64) {
    throw new Error(`SIGN_OUTER_HASH: expected 64 bytes (r||s), got ${r.data.length}`);
  }
  return { r: r.data.slice(0, 32), s: r.data.slice(32, 64) };
}
