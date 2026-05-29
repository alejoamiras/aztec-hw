/**
 * M8 P7.2 — in-session cache for the revealed device master secret.
 *
 * The viewing root is RE-DERIVED from the Ledger each session (reconnect →
 * reveal → identical keys). This cache exists ONLY so repeated page actions
 * within one session don't re-prompt the device — it is NOT a backup.
 *
 * Storage is in-memory + `sessionStorage` (wiped when the tab closes).
 * DELIBERATELY no `localStorage` / IndexedDB / disk: persisting the viewing root
 * at rest would be a mnemonic-grade disclosure, against the "never written to
 * disk" security model (impl-audit `bb56tmdxj` + the owner's reframe).
 * `sessionStorage` survives a reload within the same tab; it does not survive
 * closing it. Treat the browser as untrusted — XSS/extension access to the live
 * value is equivalent to reading the viewing root, hence the minimal lifetime.
 */
import { Fr } from '@aztec/foundation/curves/bn254';

const STORAGE_PREFIX = 'aztec-vk-secret:';
/** Mirror so the cache also works where sessionStorage is absent (tests, SSR). */
const mem = new Map<string, string>();

/** sessionStorage if present + usable; undefined otherwise (never throws). */
function sessionStore(): Storage | undefined {
  try {
    return typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis
      ? (globalThis as { sessionStorage: Storage }).sessionStorage
      : undefined;
  } catch {
    // Sandboxed iframes throw on access — fall back to in-memory only.
    return undefined;
  }
}

/**
 * Cache the revealed secret for this session. `key` lets callers scope by device
 * path (default: a single account). Stores hex; no 0x prefix.
 */
export function cacheSecret(secret: Fr, key = 'default'): void {
  const hex = secret.toBuffer().toString('hex');
  mem.set(key, hex);
  sessionStore()?.setItem(STORAGE_PREFIX + key, hex);
}

/** The cached secret for `key`, or undefined if none (fresh session / wiped). */
export function loadCachedSecret(key = 'default'): Fr | undefined {
  const hex = mem.get(key) ?? sessionStore()?.getItem(STORAGE_PREFIX + key) ?? undefined;
  if (!hex) return undefined;
  return Fr.fromBuffer(Buffer.from(hex, 'hex'));
}

/** Forget the secret for `key` (e.g. on disconnect). */
export function clearCachedSecret(key = 'default'): void {
  mem.delete(key);
  sessionStore()?.removeItem(STORAGE_PREFIX + key);
}

/** Forget ALL cached secrets — the "Forget secret" / full-disconnect control. */
export function clearAllCachedSecrets(): void {
  mem.clear();
  const s = sessionStore();
  if (!s) return;
  for (let i = s.length - 1; i >= 0; i--) {
    const k = s.key(i);
    if (k?.startsWith(STORAGE_PREFIX)) s.removeItem(k);
  }
}
