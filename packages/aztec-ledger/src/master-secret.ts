/**
 * M8 Phase 4 — Aztec master-secret derivation (host reference + spec).
 *
 * The device's `INS_GET_AZTEC_MASTER_SECRET` returns a 32-byte Aztec `Fr`
 * derived deterministically from the BIP-32 secp256k1 child PRIVATE key:
 *
 *   master_secret = SHA-512( DOMAIN ‖ privkey_d(32) ) mod Fr
 *
 * where DOMAIN = "aztec-master-secret-v1\0" (23 bytes incl. trailing NUL) and
 * Fr is the BN254 scalar field (0x...f0000001) — the field Aztec's
 * `deriveKeys(secretKey: Fr)` consumes. The reduction is a wide reduction of
 * the 512-bit SHA-512 output mod a ~254-bit prime (bias ≤ 2^-256).
 *
 * IMPORTANT (codex Phase-4 review BLOCKER): the secret hashes the PRIVATE key,
 * NOT the public key. Hashing the pubkey would be insecure — `GET_PUBLIC_KEY`
 * hands the host X‖Y with no confirmation, so a hostile host could recompute
 * the "secret" offline and bypass the reveal gate. SHA-512 is one-way, so
 * disclosing `H(DOMAIN ‖ privkey)` (gated by user approval) does not leak the
 * signing key, but the result is underivable without the device.
 *
 * Production note: the host NEVER derives the master secret itself (it has no
 * private key) — it calls the INS and feeds the result to `deriveKeys`. The
 * functions here exist only as the executable SPEC / test reference. The
 * reduction reference is `@aztec/foundation` Fr (`Fr.fromBufferReduce` is
 * Aztec's own); SHA-512 is Node's standard `crypto`. No PoC crypto here.
 */
import { createHash } from 'node:crypto';
import { Fr } from '@aztec/foundation/curves/bn254';

/** Domain separator: "aztec-master-secret-v1" (22 ASCII) + trailing NUL byte
 * = 23 bytes. Built explicitly so the trailing 0x00 is unambiguous and matches
 * the C side `static const uint8_t DOMAIN[23] = "aztec-master-secret-v1";`
 * (a 22-char literal in a [23] array zero-fills byte index 22). */
export const AZTEC_MASTER_SECRET_DOMAIN: Uint8Array = (() => {
  const ascii = new TextEncoder().encode('aztec-master-secret-v1');
  const out = new Uint8Array(ascii.length + 1);
  out.set(ascii, 0);
  out[ascii.length] = 0x00;
  return out;
})();

/** SHA-512 of an arbitrary byte string (Node std crypto). */
function sha512(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha512').update(data).digest());
}

/**
 * Reduce a 64-byte big-endian value mod Fr. Mirrors the device's
 * `fr_from_bytes_wide_be`. `Fr.fromBufferReduce` is Aztec's canonical wide
 * reduction.
 */
export function reduceWideToFr(wide: Uint8Array): Uint8Array {
  if (wide.length !== 64) {
    throw new Error(`reduceWideToFr expects 64 bytes, got ${wide.length}`);
  }
  return new Uint8Array(Fr.fromBufferReduce(Buffer.from(wide)).toBuffer());
}

/**
 * Master-secret derivation from a secp256k1 PRIVATE key scalar (32 BE bytes).
 * Returns the 32-byte Aztec `Fr` master secret. This is the reference the
 * device's INS_GET_AZTEC_MASTER_SECRET handler must match (the device sources
 * `privkey` from BIP-32; tests supply a known scalar). Test/spec only — the
 * production host has no private key and instead calls the INS.
 */
export function deriveMasterSecretFromPrivkey(privkey: Uint8Array): Uint8Array {
  if (privkey.length !== 32) {
    throw new Error(`privkey must be 32 bytes, got ${privkey.length}`);
  }
  const input = new Uint8Array(AZTEC_MASTER_SECRET_DOMAIN.length + 32);
  input.set(AZTEC_MASTER_SECRET_DOMAIN, 0);
  input.set(privkey, AZTEC_MASTER_SECRET_DOMAIN.length);
  return reduceWideToFr(sha512(input));
}

/** 4-char confirmation checksum the device shows after a reveal:
 * first 2 bytes of SHA-256("aztec-vk-confirm-v1" ‖ secret), as 4 hex chars.
 * Lets the user cross-check the host-displayed secret against the device. */
export function masterSecretChecksum(secret: Uint8Array): string {
  const tag = new TextEncoder().encode('aztec-vk-confirm-v1');
  const input = new Uint8Array(tag.length + secret.length);
  input.set(tag, 0);
  input.set(secret, tag.length);
  return createHash('sha256').update(input).digest().subarray(0, 2).toString('hex');
}
