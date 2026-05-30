/**
 * Host-parity test for the device Blake2s-256 (M10 P1). Builds
 * `ledger-app/tests/blake2s_host/blake2s_cli` (the SAME src/crypto/blake2s.c the
 * app ships) and checks it byte-for-byte against node:crypto `blake2s256` for
 * RFC-7693 + edge-length + random inputs.
 *
 * The Aztec Schnorr challenge always hashes a 64-byte preimage
 * (`pedersen(R.x,P.x,P.y)(32) || msg(32)`), so vector #1 is an exact 64-byte
 * input — that catches the classic full-block/final-block counter bug that an
 * empty-string vector would miss (codex pre-impl review).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'blake2s_host');
const CLI = join(HOST_DIR, 'blake2s_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

function deviceHash(hexInputs: string[]): string[] {
  const res = spawnSync(CLI, ['hash', ...hexInputs], { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`cli hash failed (status ${res.status}):\n${res.stderr}`);
  }
  return res.stdout.trim().split('\n');
}

function ref(hex: string): string {
  return createHash('blake2s256').update(Buffer.from(hex, 'hex')).digest('hex');
}

beforeAll(buildCli);

describe('blake2s256 device parity', () => {
  test('vector #1: exact 64-byte input (Schnorr preimage shape)', () => {
    const input = randomBytes(64).toString('hex');
    expect(deviceHash([input])[0]).toBe(ref(input));
  });

  test('RFC-7693 "abc" + edge lengths (empty, 63, 64, 65, 128)', () => {
    const abc = Buffer.from('abc').toString('hex');
    const inputs = [
      abc,
      '',
      randomBytes(63).toString('hex'),
      randomBytes(64).toString('hex'),
      randomBytes(65).toString('hex'),
      randomBytes(128).toString('hex'),
    ];
    const got = deviceHash(inputs);
    inputs.forEach((h, i) => {
      expect(got[i]).toBe(ref(h));
    });
    expect(got[0]).toBe('508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982');
  });

  test('100 random inputs of varied length', () => {
    const inputs = Array.from({ length: 100 }, () =>
      randomBytes(Math.floor(Math.random() * 200)).toString('hex'),
    );
    const got = deviceHash(inputs);
    inputs.forEach((h, i) => {
      expect(got[i]).toBe(ref(h));
    });
  });
});
