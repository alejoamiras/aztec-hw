/**
 * AHW-097 (W3) — the raw blind-sign primitive is OFF the public driver, the root
 * barrel, AND `./advanced`; reaching it requires the deliberate
 * `@alejoamiras/aztec-ledger-sdk/unsafe` import.
 *
 * AHW-103 — the privacy-root cache reread primitives are public NOWHERE. After
 * the P0c barrel cut, the presence/forget controls + the onboarding-owned
 * reveal-or-reuse moved to the expert `./advanced` subpath (outside the
 * fail-closed root surface) — never the root barrel. Pure shape test, no Speculos.
 */
import { describe, expect, test } from 'bun:test';
import * as advanced from './advanced.ts';
import * as root from './index.ts';
import { LedgerProvider } from './provider.ts';
import * as unsafe from './unsafe.ts';

describe('AHW-097 — raw signOuterHash is not a public-surface oracle', () => {
  test('LedgerProvider no longer exposes a signOuterHash method', () => {
    const p = new LedgerProvider({} as never);
    expect('signOuterHash' in p).toBe(false);
    expect((p as unknown as Record<string, unknown>).signOuterHash).toBeUndefined();
    // The reviewed finalize paths remain (device recomputes before signing).
    expect(typeof (p as unknown as Record<string, unknown>).finalizeAndSign).toBe('function');
    expect(typeof (p as unknown as Record<string, unknown>).finalizeDeployAndSign).toBe('function');
  });

  test('neither the root barrel nor ./advanced surfaces a raw signer', () => {
    const r = root as unknown as Record<string, unknown>;
    const a = advanced as unknown as Record<string, unknown>;
    expect(r.signOuterHash).toBeUndefined();
    expect(r.unsafeSignOuterHash).toBeUndefined();
    // ./advanced exposes the raw LedgerProvider but NOT the blind-sign oracle.
    expect(a.signOuterHash).toBeUndefined();
    expect(a.unsafeSignOuterHash).toBeUndefined();
  });

  test('the raw signer is reachable only via the ./unsafe subpath', () => {
    expect(typeof unsafe.unsafeSignOuterHash).toBe('function');
  });
});

describe('AHW-103 — privacy-root cache reread is public nowhere', () => {
  test('neither root nor ./advanced exports the raw cache read/write/clear-one primitives', () => {
    const r = root as unknown as Record<string, unknown>;
    const a = advanced as unknown as Record<string, unknown>;
    for (const k of ['loadCachedSecret', 'cacheSecret', 'clearCachedSecret']) {
      expect(r[k]).toBeUndefined();
      expect(a[k]).toBeUndefined();
    }
  });

  test('the safe root barrel exposes NO cache/reveal controls (they are ./advanced-only)', () => {
    const r = root as unknown as Record<string, unknown>;
    expect(r.hasCachedSecret).toBeUndefined();
    expect(r.clearAllCachedSecrets).toBeUndefined();
    expect(r.revealOrReuseMasterSecret).toBeUndefined();
  });

  test('./advanced exposes only presence + forget + the onboarding-owned reveal-or-reuse', () => {
    const a = advanced as unknown as Record<string, unknown>;
    expect(typeof a.hasCachedSecret).toBe('function');
    expect(typeof a.clearAllCachedSecrets).toBe('function');
    expect(typeof a.revealOrReuseMasterSecret).toBe('function');
  });
});
