/**
 * AHW-097 (W3) — the raw blind-sign primitive is OFF the public driver and the
 * root barrel; reaching it requires the deliberate `@aztec/adapter-ledger/unsafe`
 * import. Pure shape test — no Speculos.
 */
import { describe, expect, test } from 'bun:test';
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

  test('the package root barrel surfaces no raw signer', () => {
    const r = root as unknown as Record<string, unknown>;
    expect(r.signOuterHash).toBeUndefined();
    expect(r.unsafeSignOuterHash).toBeUndefined();
  });

  test('the raw signer is reachable only via the ./unsafe subpath', () => {
    expect(typeof unsafe.unsafeSignOuterHash).toBe('function');
  });
});
