/**
 * M8 Phase 6 host-parity for the device account-derivation core:
 *   - az_account_public_keys_hash  (publicKeysHash from the 4 master pubkeys)
 *   - az_account_address           (address from publicKeysHash + partial + ivpk)
 *
 * Both verified against the Phase 0 golden vectors (which carry the 4 pubkeys,
 * publicKeysHash, partialAddress, and address straight from Aztec's reference
 * deriveKeys/computeAddress). This pins the publicKeysHash 12-field poseidon2
 * encoding and the [preaddress]G + ivpk_m address chain BEFORE the begin_deploy
 * wiring (which is Speculos-only).
 *
 * Combined with the already-green pieces — sk→scalars (grumpkin-fq-wide-parity)
 * and scalar→pubkey (grumpkin-mul-parity) — the full chain sk → publicKeysHash
 * + address is now validated end-to-end against the reference.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

function runCli(args: string[]): string {
  const res = spawnSync(CLI, args, { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`cli ${args[0]} failed (status ${res.status}):\n${res.stderr}`);
  }
  return res.stdout.trim();
}

const strip = (s: string): string => (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');

interface PointJson {
  x: string;
  y: string;
  isInfinite: boolean;
}
interface Vector {
  secretKey: string;
  partialAddress: string;
  expected: {
    masterNullifierPublicKey: PointJson;
    masterIncomingViewingPublicKey: PointJson;
    masterOutgoingViewingPublicKey: PointJson;
    masterTaggingPublicKey: PointJson;
    publicKeysHash: string;
    address: string;
  };
}
interface GoldenVectorsFile {
  vectors: Vector[];
}

const golden: GoldenVectorsFile = JSON.parse(
  readFileSync(fileURLToPath(new URL('./oracle/golden-vectors.json', import.meta.url)), 'utf-8'),
);

beforeAll(() => {
  buildCli();
});

describe('az_account_public_keys_hash vs golden vectors', () => {
  test('publicKeysHash matches for 64 golden vectors', () => {
    for (const v of golden.vectors.slice(0, 64)) {
      const e = v.expected;
      const out = runCli([
        'pubkeys-hash',
        strip(e.masterNullifierPublicKey.x),
        strip(e.masterNullifierPublicKey.y),
        strip(e.masterIncomingViewingPublicKey.x),
        strip(e.masterIncomingViewingPublicKey.y),
        strip(e.masterOutgoingViewingPublicKey.x),
        strip(e.masterOutgoingViewingPublicKey.y),
        strip(e.masterTaggingPublicKey.x),
        strip(e.masterTaggingPublicKey.y),
      ]);
      expect(out).toBe(strip(e.publicKeysHash));
    }
  });
});

describe('az_account_address vs golden vectors', () => {
  test('address matches for 64 golden vectors', () => {
    for (const v of golden.vectors.slice(0, 64)) {
      const e = v.expected;
      const out = runCli([
        'address',
        strip(e.publicKeysHash),
        strip(v.partialAddress),
        strip(e.masterIncomingViewingPublicKey.x),
        strip(e.masterIncomingViewingPublicKey.y),
      ]);
      expect(out).toBe(strip(e.address));
    }
  });
});
