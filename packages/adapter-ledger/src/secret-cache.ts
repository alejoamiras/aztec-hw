/**
 * In-session cache for the revealed device PRIVACY ROOT (master secret).
 *
 * The privacy root is RE-DERIVED from the Ledger each session (reconnect → reveal →
 * identical keys). This cache exists ONLY so repeated page actions within ONE page
 * lifetime don't re-prompt the device — it is NOT a backup.
 *
 * MEMORY-ONLY (AHW-048). The secret lives solely on the JS heap for the page's
 * lifetime — NO sessionStorage / localStorage / IndexedDB / disk. Rationale:
 *   - sessionStorage survived in-tab reloads AND is readable by ANY same-origin
 *     script (XSS / injected extension) with zero new Ledger prompt — a
 *     privacy-root-grade exfiltration. Dropping it means a reload re-reveals (one
 *     extra device tap), which is the correct trade for the most sensitive material:
 *     the shortest possible lifetime, nothing persisted at rest.
 *   - the LIVE in-memory value is still readable by same-origin script while present
 *     (unavoidable — the secret must be in RAM to derive viewing keys), but it does
 *     not OUTLIVE the page and is never written anywhere persistent.
 *
 * The cache key is scheme-blind ON PURPOSE: the revealed secret is the account's ONE
 * privacy root — identical for ECDSA-K and Schnorr at the same path (it is the seed
 * for all four viewing keys, scheme-independent; see the reveal UI / AHW-047). Reusing
 * it across schemes at one path is exactly what the single reveal approval authorized,
 * not a silent second grant.
 */
import { Fr } from '@aztec/foundation/curves/bn254';

/** Heap-only store, gone when the page unloads. Keyed by the caller's device-scoped
 * id (see onboarding.deviceCacheKey) so a different device/account index is a MISS. */
const mem = new Map<string, string>();

/** Cache the revealed secret for this page lifetime. Stores hex; no 0x prefix. */
export function cacheSecret(secret: Fr, key: string): void {
  mem.set(key, secret.toBuffer().toString('hex'));
}

/** The cached secret for `key`, or undefined if none (fresh page / cleared). */
export function loadCachedSecret(key: string): Fr | undefined {
  const hex = mem.get(key);
  return hex ? Fr.fromBuffer(Buffer.from(hex, 'hex')) : undefined;
}

/** Forget the secret for `key` (e.g. on disconnect). */
export function clearCachedSecret(key: string): void {
  mem.delete(key);
}

/** Forget ALL cached secrets — the "Forget secret" / full-disconnect control. */
export function clearAllCachedSecrets(): void {
  mem.clear();
}
