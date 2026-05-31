/**
 * M11 P4 — negative-APDU tests against the REAL device wire handlers on Speculos
 * (codex: "fuzz the handler seam, not just the TS encoders"). Each sends a
 * minimal malformed body that trips an early reject in begin_authwit.c /
 * begin_deploy_account.c and asserts the exact fail-closed SW. Complements the
 * host-compiled fuzz harness (UB/ASan) — this proves the on-device LOGIC rejects
 * malformed input with the right status, on the actual app.elf.
 *
 * Gated on SPECULOS_URL (Speculos must run the current build on :5001):
 *   SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/wire-negative.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { CURVE_ID, INS, MANIFEST_VERSION } from './apdu.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;

/* device sw.h */
const SW = {
  OK: 0x9000,
  HASH_MISMATCH: 0x6f01,
  BAD_VERSION: 0x6f02,
  BAD_PATH: 0x6f03,
  BAD_CURVE: 0x6f04,
  UNKNOWN_PROFILE: 0x6f0d,
} as const;

describe.skipIf(!SPECULOS_URL)('M11 P4 — wire-parser negative APDUs (handler fail-closed)', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5001' });
  const send = async (ins: number, data: number[]): Promise<number> => {
    const r = await transport.send({
      ins: ins as never,
      p1: 0,
      p2: 0,
      data: Uint8Array.from(data),
    });
    return Number(r.sw);
  };

  test('BEGIN_AUTHWIT bad manifest version → SW_UNKNOWN_MANIFEST_VERSION', async () => {
    expect(await send(INS.BEGIN_AUTHWIT, [0x99])).toBe(SW.BAD_VERSION);
  });

  test('BEGIN_AUTHWIT bad curve_id → SW_INVALID_CURVE_ID', async () => {
    expect(await send(INS.BEGIN_AUTHWIT, [MANIFEST_VERSION, 0x99])).toBe(SW.BAD_CURVE);
  });

  test('BEGIN_AUTHWIT bad path_scheme → SW_INVALID_PATH_SCHEME', async () => {
    expect(await send(INS.BEGIN_AUTHWIT, [MANIFEST_VERSION, CURVE_ID.SECP256K1, 0x99])).toBe(
      SW.BAD_PATH,
    );
  });

  test('BEGIN_DEPLOY (curve,profile) mismatch: K1 + Schnorr profile → SW_INVALID_CURVE_ID', async () => {
    /* profile 1 = SchnorrAccount, curve K1 → the device enforces the exact pair. */
    expect(await send(INS.BEGIN_DEPLOY_ACCOUNT, [MANIFEST_VERSION, 1, CURVE_ID.SECP256K1])).toBe(
      SW.BAD_CURVE,
    );
  });

  test('BEGIN_DEPLOY unknown profile id → SW_UNKNOWN_PROFILE_ID', async () => {
    expect(await send(INS.BEGIN_DEPLOY_ACCOUNT, [MANIFEST_VERSION, 0x99])).toBe(SW.UNKNOWN_PROFILE);
  });

  test('BEGIN_AUTHWIT empty body → rejected (never 0x9000)', async () => {
    expect(await send(INS.BEGIN_AUTHWIT, [])).not.toBe(SW.OK);
  });

  test('BEGIN_DEPLOY truncated header (no curve byte) → rejected (never 0x9000)', async () => {
    /* version + profile only; the handler must fail-closed reading curve/path, not sign. */
    expect(await send(INS.BEGIN_DEPLOY_ACCOUNT, [MANIFEST_VERSION, 0])).not.toBe(SW.OK);
  });
});
