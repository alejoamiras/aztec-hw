/**
 * Host-parity test for the device-side Grumpkin fixed-base scalar mult.
 *
 * Builds `ledger-app/tests/grumpkin_host/grumpkin_cli` (which compiles the
 * SAME C sources that ship in the Ledger app: the poseidon2 fr_t coordinate
 * field + `src/crypto/grumpkin/*.c`) and checks `[k]·G` matches Aztec's
 * barretenberg Grumpkin (bb.js WASM) for every vector.
 *
 * This is the Phase 3 correctness gate. If the device's field assignment,
 * curve formulas, or generator constant were wrong, the very first random
 * vector would diverge from the bb.js reference.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Fq, grumpkinMulGenerator, type Point } from './oracle/index.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

/** Run `mul` with a batch of BE-hex scalars; returns [x,y] hex pairs (no 0x). */
function runMul(scalarsHex: string[]): Array<{ x: string; y: string }> {
  const res = spawnSync(CLI, ['mul', ...scalarsHex], { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`cli mul failed (status ${res.status}):\n${res.stderr}`);
  }
  const lines = res.stdout.trim().split('\n');
  if (lines.length !== scalarsHex.length * 2) {
    throw new Error(`expected ${scalarsHex.length * 2} output lines, got ${lines.length}`);
  }
  const out: Array<{ x: string; y: string }> = [];
  for (let i = 0; i < scalarsHex.length; i++) {
    out.push({ x: lines[i * 2]!, y: lines[i * 2 + 1]! });
  }
  return out;
}

/** bb.js reference [k]·G → {x,y} as 64-hex (no 0x). */
async function referenceMul(scalar: Fq): Promise<{ x: string; y: string }> {
  const p: Point = await grumpkinMulGenerator(scalar);
  return { x: strip0x(p.x.toString()), y: strip0x(p.y.toString()) };
}

function strip0x(s: string): string {
  return (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
}

function fqToBeHex(scalar: Fq): string {
  return scalar.toBuffer().toString('hex').padStart(64, '0');
}

beforeAll(() => {
  if (!existsSync(CLI)) buildCli();
});

afterAll(() => {
  /* leave the binary for ad-hoc debugging. */
});

describe('Grumpkin [k]G host parity', () => {
  test('smoke self-check ([1]G=G, [2]G on-curve, [0]G=infinity)', () => {
    const res = spawnSync(CLI, ['smoke'], { encoding: 'utf-8' });
    expect(res.stdout.trim()).toBe('smoke OK');
    expect(res.status).toBe(0);
  });

  test('fixed edge vectors match bb.js', async () => {
    const scalars = [new Fq(1n), new Fq(2n), new Fq(3n), new Fq(255n), new Fq(65537n)];
    const device = runMul(scalars.map(fqToBeHex));
    for (let i = 0; i < scalars.length; i++) {
      const ref = await referenceMul(scalars[i]!);
      expect(device[i]!.x).toBe(ref.x);
      expect(device[i]!.y).toBe(ref.y);
    }
  });

  test('256 random scalars match bb.js byte-exact', async () => {
    const N = 256;
    const scalars: Fq[] = [];
    for (let i = 0; i < N; i++) scalars.push(Fq.random());

    const device = runMul(scalars.map(fqToBeHex));
    for (let i = 0; i < N; i++) {
      const ref = await referenceMul(scalars[i]!);
      expect(device[i]!.x).toBe(ref.x);
      expect(device[i]!.y).toBe(ref.y);
    }
  });
});
