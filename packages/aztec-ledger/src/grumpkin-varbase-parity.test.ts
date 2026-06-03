/**
 * Host-parity for the device variable-base Grumpkin mul [k]·P (M10 P2) — the
 * vehicle for the Pedersen MSM. Builds the grumpkin_cli (same device .c) and
 * checks `mulp` against bb.js `grumpkinMul(P, k)`.
 *
 * Vector #1 is [1]·P == P (identity) — the cheapest catch for base-point
 * loading / endianness / Montgomery confusion (codex pre-impl review).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  Fq,
  GRUMPKIN_GENERATOR,
  grumpkinMul,
  grumpkinMulGenerator,
  type Point,
} from './oracle/index.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`make failed:\n${res.stdout}\n${res.stderr}`);
}
function strip0x(s: string): string {
  return (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
}
function fqToBeHex(s: Fq): string {
  return s.toBuffer().toString('hex').padStart(64, '0');
}
function pointHex(p: Point): { x: string; y: string } {
  return { x: strip0x(p.x.toString()), y: strip0x(p.y.toString()) };
}

/** Device [k]·P for triples → {x,y} per triple. */
function runMulp(
  triples: Array<{ k: string; px: string; py: string }>,
): Array<{ x: string; y: string }> {
  const args: string[] = [];
  for (const t of triples) args.push(t.k, t.px, t.py);
  const res = spawnSync(CLI, ['mulp', ...args], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`cli mulp failed:\n${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  const out: Array<{ x: string; y: string }> = [];
  for (let i = 0; i < triples.length; i++) out.push({ x: lines[i * 2]!, y: lines[i * 2 + 1]! });
  return out;
}

beforeAll(buildCli);

describe('Grumpkin variable-base [k]·P host parity', () => {
  test('vector #1: [1]·P == P (identity / base loading)', async () => {
    const P = await grumpkinMulGenerator(Fq.random());
    const ph = pointHex(P);
    const [d] = runMulp([{ k: fqToBeHex(new Fq(1n)), px: ph.x, py: ph.y }]);
    expect(d?.x).toBe(ph.x);
    expect(d?.y).toBe(ph.y);
  });

  test('[1]·G == G', () => {
    const gh = pointHex(GRUMPKIN_GENERATOR);
    const [d] = runMulp([{ k: fqToBeHex(new Fq(1n)), px: gh.x, py: gh.y }]);
    expect(d?.x).toBe(gh.x);
    expect(d?.y).toBe(gh.y);
  });

  test('128 random [k]·P match bb.js byte-exact', async () => {
    const N = 128;
    const triples: Array<{ k: string; px: string; py: string }> = [];
    const refs: Point[] = [];
    for (let i = 0; i < N; i++) {
      const P = await grumpkinMulGenerator(Fq.random());
      const k = Fq.random();
      const ph = pointHex(P);
      triples.push({ k: fqToBeHex(k), px: ph.x, py: ph.y });
      refs.push(await grumpkinMul(P, k));
    }
    const device = runMulp(triples);
    for (let i = 0; i < N; i++) {
      const r = pointHex(refs[i]!);
      expect(device[i]?.x).toBe(r.x);
      expect(device[i]?.y).toBe(r.y);
    }
  });
});
