/**
 * M8 Phase 4 — master-secret derivation tests.
 *
 * Two layers:
 *  1. Host-parity for the device's `fr_from_bytes_wide_be` (the novel C math):
 *     random 64-byte digests → device CLI `wide-reduce` must byte-match Aztec's
 *     `Fr.fromBufferReduce`. This is the part that could be wrong.
 *  2. TS-reference checks for the full derivation formula (DOMAIN ‖ x ‖ y →
 *     SHA-512 → reduce). The device composes cx_hash_sha512 (trusted BOLOS
 *     primitive) with the parity-tested wide-reduce, so reference + parity
 *     together pin the device output (modulo SHA-512 correctness).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Fr } from '@aztec/foundation/curves/bn254';
import {
  AZTEC_MASTER_SECRET_DOMAIN,
  deriveMasterSecretFromPrivkey,
  reduceWideToFr,
} from './master-secret.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'poseidon2_host');
const CLI = join(HOST_DIR, 'poseidon2_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

function deviceWideReduce(wide: Uint8Array): string {
  const hex = Buffer.from(wide).toString('hex');
  const res = spawnSync(CLI, ['wide-reduce', hex], { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`cli wide-reduce failed (status ${res.status}):\n${res.stderr}`);
  }
  return res.stdout.trim();
}

beforeAll(() => {
  buildCli();
});

describe('fr_from_bytes_wide_be host parity', () => {
  test('domain separator is exactly 23 bytes ("aztec-master-secret-v1" + NUL)', () => {
    expect(AZTEC_MASTER_SECRET_DOMAIN.length).toBe(23);
    expect(AZTEC_MASTER_SECRET_DOMAIN[22]).toBe(0x00);
    expect(Buffer.from(AZTEC_MASTER_SECRET_DOMAIN.subarray(0, 22)).toString('ascii')).toBe(
      'aztec-master-secret-v1',
    );
  });

  test('device wide-reduce matches Fr.fromBufferReduce on 128 random vectors', () => {
    for (let i = 0; i < 128; i++) {
      const wide = new Uint8Array(randomBytes(64));
      const device = deviceWideReduce(wide);
      const reference = Fr.fromBufferReduce(Buffer.from(wide)).toString().slice(2);
      expect(device).toBe(reference);
    }
  });

  test('boundary vectors: 0, p-1, p, p+1, 2^512-1', () => {
    const P = Fr.MODULUS;
    const cases: bigint[] = [0n, P - 1n, P, P + 1n, (1n << 512n) - 1n];
    for (const v of cases) {
      const wide = Buffer.from(v.toString(16).padStart(128, '0'), 'hex');
      const device = deviceWideReduce(new Uint8Array(wide));
      const reference = Fr.fromBufferReduce(wide).toString().slice(2);
      expect(device).toBe(reference);
    }
  });

  test('reduceWideToFr (host ref) agrees with device on random vectors', () => {
    for (let i = 0; i < 16; i++) {
      const wide = new Uint8Array(randomBytes(64));
      const hostRef = Buffer.from(reduceWideToFr(wide)).toString('hex');
      const device = deviceWideReduce(wide);
      expect(device).toBe(hostRef);
    }
  });
});

describe('master-secret derivation formula (privkey-based)', () => {
  test('deriveMasterSecretFromPrivkey is deterministic + in Fr range', () => {
    const priv = new Uint8Array(randomBytes(32));
    const a = deriveMasterSecretFromPrivkey(priv);
    const b = deriveMasterSecretFromPrivkey(priv);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(a.length).toBe(32);
    /* Result must be < Fr.MODULUS (canonical). */
    const asBig = BigInt(`0x${Buffer.from(a).toString('hex')}`);
    expect(asBig < Fr.MODULUS).toBe(true);
  });

  test('different private keys derive different secrets', () => {
    const p1 = new Uint8Array(32).fill(1);
    const p2 = new Uint8Array(32).fill(2);
    const s1 = Buffer.from(deriveMasterSecretFromPrivkey(p1)).toString('hex');
    const s2 = Buffer.from(deriveMasterSecretFromPrivkey(p2)).toString('hex');
    expect(s1).not.toBe(s2);
  });

  test('derivation = device-equivalent compose (sha512 then device wide-reduce)', () => {
    /* Proves the device path: cx_hash_sha512(DOMAIN‖privkey) then
     * fr_from_bytes_wide_be == our reference. We compute SHA-512 in TS (= the
     * trusted BOLOS primitive) and feed the digest to the device wide-reduce.
     * The device sources `privkey` from BIP-32; here we supply a known scalar.
     * (The privkey→secret link is what makes the secret non-public — codex
     * Phase-4 BLOCKER fix.) */
    const priv = new Uint8Array(randomBytes(32));
    const input = new Uint8Array(AZTEC_MASTER_SECRET_DOMAIN.length + 32);
    input.set(AZTEC_MASTER_SECRET_DOMAIN, 0);
    input.set(priv, AZTEC_MASTER_SECRET_DOMAIN.length);
    const digest = new Uint8Array(createHash('sha512').update(input).digest());
    const deviceComposed = deviceWideReduce(digest);
    const reference = Buffer.from(deriveMasterSecretFromPrivkey(priv)).toString('hex');
    expect(deviceComposed).toBe(reference);
  });
});
