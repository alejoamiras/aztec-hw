/**
 * M8 P7.1 — onboarding: reveal the device's Aztec master secret so the browser
 * session derives the SAME account the device verifies at deploy time.
 *
 * Why this is load-bearing: `AztecLedgerSession.connect()` defaults the session
 * secret to `Fr.random()`. Under M8 the device derives publicKeysHash + address
 * from its OWN seed and rejects host mismatches (0x6F0F / 0x6F0E), so a random
 * secret makes every deploy reject. The session secret MUST be the device's
 * master secret. This is a deliberate, user-approved disclosure of the VIEWING
 * root (not spend authority): the device shows a high-friction reveal screen
 * and the host feeds the result into Aztec's `deriveKeys()`.
 *
 * Recovery is the same seam re-run: reconnect the device → reveal again → the
 * deterministic derivation reproduces the identical account (see
 * implementations-plan/m8-full-sovereignty/phase-7-8-plan.md).
 */
import { Fr } from '@aztec/foundation/curves/bn254';
import { defaultAztecPath } from './apdu.ts';
import { masterSecretChecksum } from './master-secret.ts';
import { LedgerProvider, type SignOuterHashOptions } from './provider.ts';
import { cacheSecret, loadCachedSecret } from './secret-cache.ts';
import type { LedgerTransport } from './transport.ts';

export interface RevealedMasterSecret {
  /** The 32-byte Aztec `Fr` master secret (already canonical, < Fr modulus). */
  readonly secret: Fr;
  /**
   * 4-hex confirmation checksum the device ALSO displays. The UI shows this so
   * the user can cross-check the device returned the same secret the host got.
   * (Typo/integrity check — not an authenticity proof.)
   */
  readonly checksum: string;
}

/**
 * Reveal the device's Aztec master secret for `bip32Path` (one device approval).
 *
 * The caller passes the returned `secret` straight into
 * `AztecLedgerSession.connect({ secret, salt, bip32Path })` at the SAME path so
 * the derived account matches what the device verifies. `opts.autoConfirm`
 * drives the on-device approval under Speculos in tests.
 */
export async function revealMasterSecret(
  transport: LedgerTransport,
  bip32Path: readonly number[] = defaultAztecPath(),
  opts: SignOuterHashOptions = {},
): Promise<RevealedMasterSecret> {
  const provider = new LedgerProvider(transport);
  const bytes = await provider.getAztecMasterSecret(bip32Path, opts);
  if (bytes.length !== 32) {
    throw new Error(`master secret must be 32 bytes, got ${bytes.length}`);
  }
  // The device already reduced mod Fr, so the value is canonical; `fromBuffer`
  // (which asserts < modulus) is the right call and doubles as an invariant check.
  const secret = Fr.fromBuffer(Buffer.from(bytes));
  const checksum = masterSecretChecksum(bytes);
  return { secret, checksum };
}

/**
 * M9 A1 — device-bound cache key for `bip32Path`: the full secp256k1 signing
 * pubkey `x‖y` as hex. A collision-resistant session identifier for
 * `(device seed, account index)` — keying the secret cache by this makes a
 * different device OR a different account index a cache MISS, forcing a fresh
 * reveal rather than reusing the prior context's viewing root (codex MAJOR 1:
 * the cache was previously global → cross-device/index reuse). `getPublicKey`
 * needs no on-device approval, so this is cheap to call before deciding whether
 * to reveal.
 *
 * AHW-079: this key is the approval-free signing pubkey, a stable (seed, path)
 * pseudonym. Its PERSISTENT-pseudonym half is dissolved by AHW-048 (the secret cache
 * is now memory-only — the key is never written to storage). We keep the pubkey as the
 * key because it is what gives the cross-device/index cache-MISS property (a random
 * per-tab handle could not distinguish devices). The residual — that an origin can
 * harvest the pubkey by calling `getPublicKey` at all — is inherent to Ledger's
 * approval-free pubkey export (platform; see AHW-080), not to this cache.
 */
export async function deviceCacheKey(
  transport: LedgerTransport,
  bip32Path: readonly number[] = defaultAztecPath(),
): Promise<string> {
  const pk = await new LedgerProvider(transport).getPublicKey(bip32Path);
  return Buffer.concat([Buffer.from(pk.x), Buffer.from(pk.y)]).toString('hex');
}

export interface RevealOrReuseResult extends RevealedMasterSecret {
  /** True if the secret came from the in-session cache (no fresh device reveal). */
  readonly fromCache: boolean;
}

/**
 * AHW-103 — reveal-or-reuse, OWNED by the onboarding layer so consumers never
 * touch the raw secret cache. Computes the device-scoped cache key, returns the
 * cached secret if present, else does exactly ONE device reveal and caches it
 * for the page lifetime. `opts.onReveal` fires just before the device approval
 * (cache miss only) so the UI can prompt. This is the only sanctioned way to get
 * the revealed privacy root — `loadCachedSecret`/`cacheSecret` are no longer on
 * the package's public surface.
 */
export async function revealOrReuseMasterSecret(
  transport: LedgerTransport,
  bip32Path: readonly number[] = defaultAztecPath(),
  opts: SignOuterHashOptions & { readonly onReveal?: () => void } = {},
): Promise<RevealOrReuseResult> {
  const key = await deviceCacheKey(transport, bip32Path);
  const cached = loadCachedSecret(key);
  if (cached) {
    return { secret: cached, checksum: 'cached', fromCache: true };
  }
  opts.onReveal?.();
  const revealed = await revealMasterSecret(transport, bip32Path, opts);
  cacheSecret(revealed.secret, key);
  return { ...revealed, fromCache: false };
}
