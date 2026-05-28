/**
 * Stability test: every committed golden vector re-derives to the same bytes
 * when re-run through Aztec's canonical path TODAY. If this test fails after
 * a `@aztec/*` version bump, the device-side code MUST be reverified before
 * any release ships.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Fr } from '@aztec/foundation/curves/bn254';

import { computeAddress } from './aztec-address.js';
import { deriveAztecKeysFromMasterSecret } from './aztec-derivation.js';

interface PointJson {
  x: string;
  y: string;
  isInfinite: boolean;
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

interface GoldenVectorsFile {
  version: number;
  n: number;
  seed: string;
  vectors: Vector[];
}

const goldenPath = fileURLToPath(new URL('./golden-vectors.json', import.meta.url));
const golden: GoldenVectorsFile = JSON.parse(readFileSync(goldenPath, 'utf-8'));

describe('golden vectors stability', () => {
  it(`re-derives all ${golden.n} vectors byte-exact through Aztec's path`, async () => {
    for (const vector of golden.vectors) {
      const sk = Fr.fromHexString(vector.secretKey);
      const partial = Fr.fromHexString(vector.partialAddress);

      const derived = await deriveAztecKeysFromMasterSecret(sk);
      const address = await computeAddress(derived.publicKeys, partial);

      expect(derived.masterNullifierHidingKey.toString()).toBe(
        vector.expected.masterNullifierHidingKey,
      );
      expect(derived.masterIncomingViewingSecretKey.toString()).toBe(
        vector.expected.masterIncomingViewingSecretKey,
      );
      expect(derived.masterOutgoingViewingSecretKey.toString()).toBe(
        vector.expected.masterOutgoingViewingSecretKey,
      );
      expect(derived.masterTaggingSecretKey.toString()).toBe(
        vector.expected.masterTaggingSecretKey,
      );

      expect(derived.publicKeys.masterNullifierPublicKey.x.toString()).toBe(
        vector.expected.masterNullifierPublicKey.x,
      );
      expect(derived.publicKeys.masterNullifierPublicKey.y.toString()).toBe(
        vector.expected.masterNullifierPublicKey.y,
      );
      expect(derived.publicKeys.masterIncomingViewingPublicKey.x.toString()).toBe(
        vector.expected.masterIncomingViewingPublicKey.x,
      );
      expect(derived.publicKeys.masterIncomingViewingPublicKey.y.toString()).toBe(
        vector.expected.masterIncomingViewingPublicKey.y,
      );
      expect(derived.publicKeys.masterOutgoingViewingPublicKey.x.toString()).toBe(
        vector.expected.masterOutgoingViewingPublicKey.x,
      );
      expect(derived.publicKeys.masterOutgoingViewingPublicKey.y.toString()).toBe(
        vector.expected.masterOutgoingViewingPublicKey.y,
      );
      expect(derived.publicKeys.masterTaggingPublicKey.x.toString()).toBe(
        vector.expected.masterTaggingPublicKey.x,
      );
      expect(derived.publicKeys.masterTaggingPublicKey.y.toString()).toBe(
        vector.expected.masterTaggingPublicKey.y,
      );

      expect(derived.publicKeysHash.toString()).toBe(vector.expected.publicKeysHash);
      expect(address.toString()).toBe(vector.expected.address);
    }
  });

  it('vector file metadata is intact', () => {
    expect(golden.version).toBe(1);
    expect(golden.n).toBe(golden.vectors.length);
    expect(golden.vectors.length).toBeGreaterThanOrEqual(256);
    expect(golden.seed).toBe('m8-phase-0-golden-vectors-v1');
  });
});
