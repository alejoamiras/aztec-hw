/**
 * M8 Phase 0 — Golden-vector generator.
 *
 * Generates N deterministic `(secretKey, partialAddress)` pairs and captures
 * every intermediate value Aztec's `deriveKeys` + address-derivation chain
 * produces. Output is committed as `src/oracle/golden-vectors.json` so:
 *
 *   - Phase 3 (Grumpkin scalar mult): device-derived viewing pubkeys must
 *     match the `{nh,iv,ov,t}pk_m` values for each vector.
 *   - Phase 6 (publicKeysHash + address): device must match these byte-exact.
 *   - Catches `@aztec/*` version drift: the stability test in
 *     `golden-vectors.stability.test.ts` re-runs Aztec's path on each vector's
 *     input and asserts equality with the stored output. If Aztec ever bumps
 *     a derivation parameter, this test fails before device code re-syncs.
 *
 * Determinism: inputs are SHA-256 expansions of a fixed seed string +
 * label + index. Re-running this script with the same seed produces
 * byte-identical output.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { Point } from '@aztec/foundation/curves/grumpkin';

import { computeAddress } from '../src/oracle/aztec-address.js';
import { deriveAztecKeysFromMasterSecret } from '../src/oracle/aztec-derivation.js';

const N = 256;
const SEED = 'm8-phase-0-golden-vectors-v1';

/** Deterministic Fr expansion via SHA-512 of a labeled seed, then wide
 * reduction mod Fr.MODULUS. SHA-512 is wider than Fr's 254-bit range, so
 * `fromBufferReduce` (vs. `fromBuffer`) is mandatory — `fromBuffer` rejects
 * anything ≥ MODULUS. */
async function deterministicFr(label: string, index: number): Promise<Fr> {
  const input = new TextEncoder().encode(`${SEED}::${label}::${index}`);
  const digest = await crypto.subtle.digest('SHA-512', input);
  return Fr.fromBufferReduce(Buffer.from(digest));
}

interface PointJson {
  x: string;
  y: string;
  isInfinite: boolean;
}

function pointToJson(p: Point): PointJson {
  return {
    x: p.x.toString(),
    y: p.y.toString(),
    isInfinite: Boolean(p.isInfinite),
  };
}

interface Vector {
  index: number;
  secretKey: string;
  partialAddress: string;
  expected: {
    masterNullifierHidingKey: string;
    masterIncomingViewingSecretKey: string;
    masterOutgoingViewingSecretKey: string;
    masterTaggingSecretKey: string;
    masterNullifierPublicKey: PointJson;
    masterIncomingViewingPublicKey: PointJson;
    masterOutgoingViewingPublicKey: PointJson;
    masterTaggingPublicKey: PointJson;
    publicKeysHash: string;
    address: string;
  };
}

async function generate(): Promise<Vector[]> {
  const vectors: Vector[] = [];
  for (let i = 0; i < N; i++) {
    const secretKey = await deterministicFr('secretKey', i);
    const partialAddress = await deterministicFr('partialAddress', i);
    const derived = await deriveAztecKeysFromMasterSecret(secretKey);
    const address = await computeAddress(derived.publicKeys, partialAddress);
    vectors.push({
      index: i,
      secretKey: secretKey.toString(),
      partialAddress: partialAddress.toString(),
      expected: {
        masterNullifierHidingKey: derived.masterNullifierHidingKey.toString(),
        masterIncomingViewingSecretKey: derived.masterIncomingViewingSecretKey.toString(),
        masterOutgoingViewingSecretKey: derived.masterOutgoingViewingSecretKey.toString(),
        masterTaggingSecretKey: derived.masterTaggingSecretKey.toString(),
        masterNullifierPublicKey: pointToJson(derived.publicKeys.masterNullifierPublicKey),
        masterIncomingViewingPublicKey: pointToJson(
          derived.publicKeys.masterIncomingViewingPublicKey,
        ),
        masterOutgoingViewingPublicKey: pointToJson(
          derived.publicKeys.masterOutgoingViewingPublicKey,
        ),
        masterTaggingPublicKey: pointToJson(derived.publicKeys.masterTaggingPublicKey),
        publicKeysHash: derived.publicKeysHash.toString(),
        address: address.toString(),
      },
    });
  }
  return vectors;
}

const vectors = await generate();
const out = JSON.stringify({ version: 1, n: N, seed: SEED, vectors }, null, 2);
const outPath = fileURLToPath(new URL('../src/oracle/golden-vectors.json', import.meta.url));
writeFileSync(outPath, `${out}\n`);
console.log(`Wrote ${vectors.length} vectors to ${outPath}`);
