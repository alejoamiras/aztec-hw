/**
 * M9 A2 — single source of truth for the account path.
 *
 * `defaultDeployPath` now delegates to `defaultAztecPath` (one helper, no
 * byte-identical duplicate to drift). Each account index yields a distinct path,
 * so account #N is a genuinely separate account. The cross-source invariant
 * (connect/reveal/deploy all use the session's one `bip32Path`) is enforced
 * structurally (deps.bip32Path) + at runtime by the device's 0x6F0E address gate.
 */
import { describe, expect, test } from 'bun:test';
import { defaultAztecPath } from './apdu.ts';
import { defaultDeployPath } from './deploy-context.ts';

describe('account path (M9 A2)', () => {
  test('defaultDeployPath delegates to defaultAztecPath — one helper', () => {
    for (const n of [0, 1, 5, 0x7fff_ffff]) {
      expect([...defaultDeployPath(n)]).toEqual([...defaultAztecPath(n)]);
    }
  });

  test('each account index yields a distinct path (account component differs)', () => {
    const p0 = defaultAztecPath(0);
    const p1 = defaultAztecPath(1);
    expect([...p0]).not.toEqual([...p1]);
    // m/44'/AZTEC'/<account>'/0/0 — the account index is component 2.
    expect(p0[2]).not.toBe(p1[2]);
  });

  test('rejects a non-uint31 account index (via the single helper)', () => {
    expect(() => defaultAztecPath(-1)).toThrow();
    expect(() => defaultDeployPath(1.5)).toThrow();
  });
});
