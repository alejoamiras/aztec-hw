import { describe, expect, test } from 'bun:test';
import { buildAztecIdentity, parseAccountIndex, serializeIdentity } from './identity.ts';

describe('buildAztecIdentity', () => {
  test('produces gpg-proto IdentityType for account/0', () => {
    const id = buildAztecIdentity({ accountIndex: 0 });
    expect(id.proto).toBe('gpg');
    expect(id.host).toBe('aztec');
    expect(id.path).toBe('/account/0');
    expect(id.index).toBe(0);
  });

  test('encodes account index in path field', () => {
    expect(buildAztecIdentity({ accountIndex: 42 }).path).toBe('/account/42');
  });

  test('rejects negative or non-integer indices', () => {
    expect(() => buildAztecIdentity({ accountIndex: -1 })).toThrow();
    expect(() => buildAztecIdentity({ accountIndex: 0.5 })).toThrow();
    expect(() => buildAztecIdentity({ accountIndex: Number.NaN })).toThrow();
  });

  test('rejects out-of-range indices', () => {
    expect(() => buildAztecIdentity({ accountIndex: 2 ** 31 })).toThrow();
  });
});

describe('serializeIdentity', () => {
  test('matches Trezor wire format: proto://host/path', () => {
    const id = buildAztecIdentity({ accountIndex: 5 });
    expect(serializeIdentity(id)).toBe('gpg://aztec/account/5');
  });

  test('handles optional user and port fields', () => {
    expect(
      serializeIdentity({
        proto: 'gpg',
        user: 'alice',
        host: 'aztec',
        port: '8080',
        path: '/account/0',
        index: 0,
      }),
    ).toBe('gpg://alice@aztec:8080/account/0');
  });
});

describe('parseAccountIndex', () => {
  test('round-trips with build', () => {
    for (const i of [0, 1, 7, 100, 2 ** 31 - 1]) {
      expect(parseAccountIndex(buildAztecIdentity({ accountIndex: i }))).toBe(i);
    }
  });

  test('rejects non-Aztec-form paths', () => {
    expect(() =>
      parseAccountIndex({
        proto: 'gpg',
        host: 'aztec',
        path: '/wallet/0',
        index: 0,
      }),
    ).toThrow();
  });
});
