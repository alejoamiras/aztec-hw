/**
 * M8 P7.2 — secret-cache unit coverage. Runs under bun (no sessionStorage), so
 * it exercises the in-memory fallback path; the browser sessionStorage path is
 * the same code with a backing store. Proves round-trip, per-key scoping, and
 * the wipe controls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Fr } from '@aztec/foundation/curves/bn254';
import {
  cacheSecret,
  clearAllCachedSecrets,
  clearCachedSecret,
  loadCachedSecret,
} from './secret-cache.ts';

describe('secret-cache', () => {
  afterEach(() => clearAllCachedSecrets());

  test('round-trips a secret within the session', () => {
    const s = Fr.random();
    const k = 'pubkey-hex-k0';
    expect(loadCachedSecret(k)).toBeUndefined();
    cacheSecret(s, k);
    expect(loadCachedSecret(k)?.toString()).toBe(s.toString());
  });

  test('scopes by key — clearing one leaves others intact', () => {
    const a = Fr.random();
    const b = Fr.random();
    cacheSecret(a, 'path-a');
    cacheSecret(b, 'path-b');
    clearCachedSecret('path-a');
    expect(loadCachedSecret('path-a')).toBeUndefined();
    expect(loadCachedSecret('path-b')?.toString()).toBe(b.toString());
  });

  test('clearAll wipes everything', () => {
    cacheSecret(Fr.random(), 'x');
    cacheSecret(Fr.random(), 'y');
    clearAllCachedSecrets();
    expect(loadCachedSecret('x')).toBeUndefined();
    expect(loadCachedSecret('y')).toBeUndefined();
  });
});
