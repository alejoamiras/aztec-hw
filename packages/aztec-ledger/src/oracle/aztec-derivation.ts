/**
 * M8 Phase 0 — Aztec key derivation oracle.
 *
 * Anti-circularity discipline: this file imports ONLY from `@aztec/*` published
 * packages. NEVER from PoC code. The oracle is the GROUND TRUTH that device
 * output is compared against in Phase 3 (Grumpkin parity) and Phase 6
 * (publicKeysHash + address verification).
 *
 * Reference: aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:95-124
 */
import type { Fq, Fr } from '@aztec/foundation/curves/bn254';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { PublicKey, PublicKeys } from '@aztec/stdlib/keys';
import { deriveKeys, derivePublicKeyFromSecretKey } from '@aztec/stdlib/keys';

export interface DerivedAztecKeys {
  masterNullifierHidingKey: GrumpkinScalar;
  masterIncomingViewingSecretKey: GrumpkinScalar;
  masterOutgoingViewingSecretKey: GrumpkinScalar;
  masterTaggingSecretKey: GrumpkinScalar;
  publicKeys: PublicKeys;
  publicKeysHash: Fr;
}

/**
 * Aztec's canonical key derivation + PublicKeys.hash().
 *
 * The Phase 6 device-side implementation must byte-match this for arbitrary
 * `secretKey: Fr` inputs.
 */
export async function deriveAztecKeysFromMasterSecret(secretKey: Fr): Promise<DerivedAztecKeys> {
  const {
    masterNullifierHidingKey,
    masterIncomingViewingSecretKey,
    masterOutgoingViewingSecretKey,
    masterTaggingSecretKey,
    publicKeys,
  } = await deriveKeys(secretKey);
  const publicKeysHash = await publicKeys.hash();
  return {
    masterNullifierHidingKey,
    masterIncomingViewingSecretKey,
    masterOutgoingViewingSecretKey,
    masterTaggingSecretKey,
    publicKeys,
    publicKeysHash,
  };
}

/**
 * Wrap Grumpkin scalar * G — used for golden-vector generation against the
 * device's Phase 3 fixed-base scalar mult (`grumpkin_mul_generator`).
 */
export function publicKeyFromSecret(secretKey: Fq | GrumpkinScalar): Promise<PublicKey> {
  return derivePublicKeyFromSecretKey(secretKey as Fq);
}
