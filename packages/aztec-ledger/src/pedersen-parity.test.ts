/**
 * Host-parity for the device Pedersen-3 hash (M10 P3) — the inner compression
 * of the Schnorr challenge. Builds grumpkin_cli (same device .c, incl.
 * src/crypto/pedersen.c + its lifted generators) and checks `pedersen` against
 * `@aztec/foundation` `pedersenHash` (bb.js WASM == the on-chain pedersen).
 *
 * Vector #1 is [0,0,0] → must equal x(3·g_len): it isolates the length term and
 * the g_len generator constant, the easiest silent miss (codex pre-impl review).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pedersenHash } from '@aztec/foundation/crypto/pedersen';
import { Fr } from '@aztec/foundation/curves/bn254';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`make failed:\n${res.stdout}\n${res.stderr}`);
}
function strip0x(s: string): string {
  return (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
}
function frHex(f: Fr): string {
  return f.toBuffer().toString('hex').padStart(64, '0');
}
function devicePedersen(v: [Fr, Fr, Fr]): string {
  const res = spawnSync(CLI, ['pedersen', frHex(v[0]), frHex(v[1]), frHex(v[2])], {
    encoding: 'utf-8',
  });
  if (res.status !== 0) throw new Error(`cli pedersen failed:\n${res.stderr}`);
  return res.stdout.trim();
}
async function ref(v: [Fr, Fr, Fr]): Promise<string> {
  return strip0x((await pedersenHash(v)).toString());
}

beforeAll(() => {
  buildCli();
});

describe('pedersen_hash3 device parity', () => {
  test('vector #1: [0,0,0] == x(3·g_len)', async () => {
    const v: [Fr, Fr, Fr] = [new Fr(0n), new Fr(0n), new Fr(0n)];
    expect(devicePedersen(v)).toBe(await ref(v));
  });

  test('fixed small + zero-mixing cases', async () => {
    const cases: Array<[Fr, Fr, Fr]> = [
      [new Fr(1n), new Fr(2n), new Fr(3n)],
      [new Fr(0n), new Fr(1n), new Fr(0n)],
      [new Fr(7n), new Fr(0n), new Fr(99n)],
      [new Fr(255n), new Fr(65537n), new Fr(1n)],
    ];
    for (const v of cases) expect(devicePedersen(v)).toBe(await ref(v));
  });

  test('64 random Fr triples byte-exact', async () => {
    for (let i = 0; i < 64; i++) {
      const v: [Fr, Fr, Fr] = [Fr.random(), Fr.random(), Fr.random()];
      expect(devicePedersen(v)).toBe(await ref(v));
    }
  });
});
