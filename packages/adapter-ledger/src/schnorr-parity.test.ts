/**
 * Host-parity for the device Schnorr-over-Grumpkin construction (M10 P4). Builds
 * grumpkin_cli (same device .c) and checks `schnorr-sign` two ways:
 *  - VALIDITY: the device sig verifies under @aztec/foundation `Schnorr` (== the
 *    on-chain barretenberg verifier) — proves the whole construction matches.
 *  - SERIALIZATION (vector #1): byte-exact vs a JS replication of the same
 *    deterministic-k construction (R=k·G, pedersen, blake2s, e=e_raw mod n,
 *    s=k−priv·e), inspecting s and e_raw — catches a wrong e_raw/s byte order
 *    that verify-only could mask (codex pre-impl review).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pedersenHash } from '@aztec/foundation/crypto/pedersen';
import { Schnorr, SchnorrSignature } from '@aztec/foundation/crypto/schnorr';
import { Fq, grumpkinMulGenerator, type Point } from './oracle/index.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');
const N = Fq.MODULUS; // Grumpkin group order = Fq modulus
const schnorr = new Schnorr();

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`make failed:\n${res.stdout}\n${res.stderr}`);
}
function strip0x(s: string): string {
  return (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
}
function fqHex(f: Fq): string {
  return f.toBuffer().toString('hex').padStart(64, '0');
}
function pointHex(p: Point): { x: string; y: string } {
  return { x: strip0x(p.x.toString()), y: strip0x(p.y.toString()) };
}
function deviceSign(privHex: string, kHex: string, msgHex: string): string {
  const r = spawnSync(CLI, ['schnorr-sign', privHex, kHex, msgHex], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`schnorr-sign failed:\n${r.stderr}`);
  return r.stdout.trim();
}
function devicePubkey(privHex: string): { x: string; y: string } {
  const r = spawnSync(CLI, ['schnorr-pubkey', privHex], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`schnorr-pubkey failed:\n${r.stderr}`);
  const [x, y] = r.stdout.trim().split('\n');
  return { x: x ?? '', y: y ?? '' };
}
async function verify(msg: Buffer, priv: Fq, sigHex: string): Promise<boolean> {
  const P = await grumpkinMulGenerator(priv);
  return schnorr.verifySignature(
    new Uint8Array(msg),
    P,
    new SchnorrSignature(Buffer.from(sigHex, 'hex')),
  );
}

beforeAll(buildCli);

describe('Schnorr-over-Grumpkin device parity', () => {
  test('pubkey: device priv·G == bb.js', async () => {
    const priv = Fq.random();
    const dev = devicePubkey(fqHex(priv));
    const ref = pointHex(await grumpkinMulGenerator(priv));
    expect(dev.x).toBe(ref.x);
    expect(dev.y).toBe(ref.y);
  });

  test('vector #1: byte-exact vs JS replication + verifies', async () => {
    const priv = new Fq(12345n);
    const k = new Fq(67890n);
    const msg = Buffer.alloc(32, 0x07);
    const sigHex = deviceSign(fqHex(priv), fqHex(k), msg.toString('hex'));

    // JS replication of the same deterministic-k construction.
    const P = await grumpkinMulGenerator(priv);
    const R = await grumpkinMulGenerator(k);
    const compressed = await pedersenHash([R.x, P.x, P.y]);
    const eRaw = createHash('blake2s256')
      .update(Buffer.concat([compressed.toBuffer(), msg]))
      .digest();
    const e = BigInt(`0x${eRaw.toString('hex')}`) % N;
    const privB = BigInt(`0x${fqHex(priv)}`);
    const kB = BigInt(`0x${fqHex(k)}`);
    const s = (((kB - privB * e) % N) + N) % N;
    const expected = s.toString(16).padStart(64, '0') + eRaw.toString('hex');

    expect(sigHex).toBe(expected);
    expect(await verify(msg, priv, sigHex)).toBe(true);
  });

  test('64 random (priv,k,msg): device sig verifies under bb.js', async () => {
    for (let i = 0; i < 64; i++) {
      const priv = Fq.random();
      const k = Fq.random();
      const msg = randomBytes(32);
      const sigHex = deviceSign(fqHex(priv), fqHex(k), msg.toString('hex'));
      expect(await verify(msg, priv, sigHex)).toBe(true);
    }
  });
});
