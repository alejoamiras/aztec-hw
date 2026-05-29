/**
 * Host-parity for the device's `gk_fq_from_bytes_wide_be` (M8 Phase 6 prereq):
 * reduce a 64-byte SHA-512 digest mod the Grumpkin SCALAR order. Two layers:
 *
 *  1. Raw parity: random + boundary 64-byte vectors → device CLI `fq-wide-reduce`
 *     must byte-match a bigint reduction mod the Grumpkin order (Fq.MODULUS).
 *  2. Integration: for each Phase 0 golden vector, the four viewing scalars
 *     (nhk/ivsk/ovsk/tsk) must equal `gk_fq_from_bytes_wide_be(SHA-512(sk ‖
 *     uint32BE(domainSep)))` — i.e. the device path reproduces Aztec's
 *     `sha512ToGrumpkinScalar([secretKey, DomainSeparator.X])`. SHA-512 is the
 *     trusted BOLOS primitive (computed in TS here); the device-novel reduce is
 *     under test.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fq } from './oracle/index.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

/** Aztec DomainSeparator enum values (constants.gen.ts:517-520). */
const DOMAIN_SEP = {
  NHK_M: 242137788,
  IVSK_M: 2747825907,
  OVSK_M: 4272201051,
  TSK_M: 1546190975,
} as const;

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

function deviceFqWideReduce(wide: Uint8Array): string {
  const res = spawnSync(CLI, ['fq-wide-reduce', Buffer.from(wide).toString('hex')], {
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    throw new Error(`cli fq-wide-reduce failed (status ${res.status}):\n${res.stderr}`);
  }
  return res.stdout.trim();
}

/** bigint mod Grumpkin order, as 64-hex (no 0x). */
function refReduce(wide: Uint8Array): string {
  const v = BigInt(`0x${Buffer.from(wide).toString('hex')}`);
  return (v % Fq.MODULUS).toString(16).padStart(64, '0');
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/** sha512ToGrumpkinScalar([sk, domainSep]) device-equivalent: digest then the
 * device's gk_fq wide-reduce. */
function deviceViewingScalar(skHex: string, sep: number): string {
  const sk = Buffer.from(skHex.startsWith('0x') ? skHex.slice(2) : skHex, 'hex');
  const input = new Uint8Array(32 + 4);
  input.set(new Uint8Array(sk), 0);
  input.set(u32be(sep), 32);
  const digest = new Uint8Array(createHash('sha512').update(input).digest());
  return deviceFqWideReduce(digest);
}

interface GoldenVectorsFile {
  vectors: Array<{
    secretKey: string;
    expected: {
      masterNullifierHidingKey: string;
      masterIncomingViewingSecretKey: string;
      masterOutgoingViewingSecretKey: string;
      masterTaggingSecretKey: string;
    };
  }>;
}

const golden: GoldenVectorsFile = JSON.parse(
  readFileSync(fileURLToPath(new URL('./oracle/golden-vectors.json', import.meta.url)), 'utf-8'),
);

beforeAll(() => {
  buildCli();
});

describe('gk_fq_from_bytes_wide_be host parity', () => {
  test('device matches bigint mod Grumpkin order on 128 random vectors', () => {
    for (let i = 0; i < 128; i++) {
      const wide = new Uint8Array(randomBytes(64));
      expect(deviceFqWideReduce(wide)).toBe(refReduce(wide));
    }
  });

  test('boundary vectors: 0, q-1, q, q+1, 2^512-1', () => {
    const Q = Fq.MODULUS;
    for (const v of [0n, Q - 1n, Q, Q + 1n, (1n << 512n) - 1n]) {
      const wide = new Uint8Array(Buffer.from(v.toString(16).padStart(128, '0'), 'hex'));
      expect(deviceFqWideReduce(wide)).toBe(refReduce(wide));
    }
  });
});

describe('viewing-scalar derivation vs Phase 0 golden vectors', () => {
  test('all 4 viewing scalars match for the first 32 golden vectors', () => {
    /* 32 of 256 keeps the test ~fast (4 spawns each); raw parity above covers
     * the reduce broadly. This proves sha512ToGrumpkinScalar reproduction. */
    const sample = golden.vectors.slice(0, 32);
    for (const v of sample) {
      const strip = (s: string) => (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
      expect(deviceViewingScalar(v.secretKey, DOMAIN_SEP.NHK_M)).toBe(
        strip(v.expected.masterNullifierHidingKey),
      );
      expect(deviceViewingScalar(v.secretKey, DOMAIN_SEP.IVSK_M)).toBe(
        strip(v.expected.masterIncomingViewingSecretKey),
      );
      expect(deviceViewingScalar(v.secretKey, DOMAIN_SEP.OVSK_M)).toBe(
        strip(v.expected.masterOutgoingViewingSecretKey),
      );
      expect(deviceViewingScalar(v.secretKey, DOMAIN_SEP.TSK_M)).toBe(
        strip(v.expected.masterTaggingSecretKey),
      );
    }
  });
});
