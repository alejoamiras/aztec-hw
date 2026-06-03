/**
 * M11 P3 edge vectors (codex Major) — directly exercise the EXCEPTIONAL cmov-
 * select paths of the now-branch-free `grumpkin_point_add_affine` that a normal
 * scalar mul never reaches: P==Q (doubling), P==−Q (infinity), ∞+Q. The byte-
 * identical parity tests cover the generic path; these cover the rare paths the
 * P3 branch surgery actually changed.
 *
 * Non-circular: the reference points come from the device's own fixed-base [k]G
 * (`mul`), whose ladder computes e.g. [6]G via the GENERIC madd + doubling, NOT
 * via add_affine's P==Q exceptional path. So `point-add(P,P) == mul(6)` matches a
 * value computed two different ways ⇒ the exceptional cmov is correct.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');
/* BN254 Fr = the Grumpkin COORDINATE field (poseidon2 fr_t modulus). */
const FR_BASE = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

function cli(...args: string[]): string[] {
  const r = spawnSync(CLI, args, { encoding: 'utf-8' });
  if (r.status !== 0)
    throw new Error(`cli ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
  return r.stdout.trim().split('\n');
}
function mulG(k: bigint): { x: string; y: string } {
  const o = cli('mul', k.toString(16).padStart(64, '0'));
  return { x: o[0], y: o[1] };
}
function pointAdd(px: string, py: string, qx: string, qy: string, inf = false, ip = false): string {
  const args = ['point-add', px, py, qx, qy];
  if (inf) args.push('inf');
  if (ip) args.push('ip'); /* run the add in place: out aliases p */
  const o = cli(...args);
  return o[0] === 'INF' ? 'INF' : `${o[0]}|${o[1]}`;
}

beforeAll(() => {
  const r = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`make failed: ${r.stdout}\n${r.stderr}`);
});

describe('M11 P3 — point_add_affine exceptional cmov-select edge vectors', () => {
  test('P + P == [2]P  (H==0, r==0 → doubling cmov)', () => {
    const P = mulG(3n);
    const twoP = mulG(6n); /* [3]G + [3]G = [6]G, computed via the generic ladder */
    expect(pointAdd(P.x, P.y, P.x, P.y)).toBe(`${twoP.x}|${twoP.y}`);
  });

  test('P + (−P) == ∞  (H==0, r≠0 → infinity cmov)', () => {
    const P = mulG(3n);
    const negPy = ((FR_BASE - BigInt(`0x${P.y}`)) % FR_BASE).toString(16).padStart(64, '0');
    expect(pointAdd(P.x, P.y, P.x, negPy)).toBe('INF');
  });

  test('∞ + Q == Q  (z==0 cmov)', () => {
    const Q = mulG(5n);
    expect(pointAdd('0'.repeat(64), '0'.repeat(64), Q.x, Q.y, true)).toBe(`${Q.x}|${Q.y}`);
  });

  test('generic P + Q == [8]G  (madd, no exceptional path)', () => {
    const P = mulG(3n);
    const Q = mulG(5n);
    const eightG = mulG(8n);
    expect(pointAdd(P.x, P.y, Q.x, Q.y)).toBe(`${eightG.x}|${eightG.y}`);
  });

  /* M11 P7 (codex post-impl blocker): out may alias p — Pedersen accumulates in
   * place, add_affine(acc, acc, …) at pedersen.c:67. The P==Q doubling candidate
   * must read the ORIGINAL p, not the generic result already written into out.
   * The branchy safe-v8 code doubled p before any write; the first P3 cut wrote
   * out then doubled the corrupted p. Separate-buffer vectors can't catch it. */
  test('P + P IN PLACE (out aliases p) == [2]P  (aliasing regression guard)', () => {
    const P = mulG(3n);
    const twoP = mulG(6n);
    expect(pointAdd(P.x, P.y, P.x, P.y, false, true)).toBe(`${twoP.x}|${twoP.y}`);
  });
});
