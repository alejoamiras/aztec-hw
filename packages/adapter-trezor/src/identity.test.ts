import { describe, expect, test } from 'bun:test';
import { buildAztecIdentity, parseAztecIdentity } from './identity.ts';

describe('buildAztecIdentity', () => {
  test('formats account/0 correctly', () => {
    expect(buildAztecIdentity(0)).toBe('aztec://account/0');
  });

  test('formats higher account indices', () => {
    expect(buildAztecIdentity(42)).toBe('aztec://account/42');
  });

  test('rejects negative indices', () => {
    expect(() => buildAztecIdentity(-1)).toThrow();
  });

  test('rejects non-integer indices', () => {
    expect(() => buildAztecIdentity(0.5)).toThrow();
    expect(() => buildAztecIdentity(NaN)).toThrow();
  });

  test('rejects out-of-range indices', () => {
    expect(() => buildAztecIdentity(2 ** 31)).toThrow();
  });
});

describe('parseAztecIdentity', () => {
  test('round-trips with build', () => {
    for (const i of [0, 1, 7, 100, 2 ** 31 - 1]) {
      expect(parseAztecIdentity(buildAztecIdentity(i)).accountIndex).toBe(i);
    }
  });

  test('rejects wrong scheme', () => {
    expect(() => parseAztecIdentity('http://account/0')).toThrow();
    expect(() => parseAztecIdentity('account/0')).toThrow();
  });

  test('rejects wrong path prefix', () => {
    expect(() => parseAztecIdentity('aztec://wallet/0')).toThrow();
  });

  test('rejects non-integer index', () => {
    expect(() => parseAztecIdentity('aztec://account/abc')).toThrow();
    expect(() => parseAztecIdentity('aztec://account/0.5')).toThrow();
    expect(() => parseAztecIdentity('aztec://account/-1')).toThrow();
  });

  test('rejects leading-zero indices to enforce canonical form', () => {
    expect(() => parseAztecIdentity('aztec://account/01')).toThrow();
  });
});
