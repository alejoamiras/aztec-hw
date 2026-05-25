/**
 * Phase A CLI demo — TrezorEcdsaKAuthWitnessProvider end-to-end against a fake transport.
 *
 * Usage:
 *     bun run start
 *
 * What this proves (in-process, no device):
 *   - The adapter's preimage computation matches Aztec's K1 verifier expectation
 *     (SHA-256 of `outer_hash.to_be_bytes()`).
 *   - Marker-byte stripping is correct.
 *   - The packed `r ‖ s` signature verifies against the public key the device claims.
 *
 * What this does NOT prove:
 *   - Real Trezor wire compatibility (waiting on codex review for `SignIdentity` format).
 *   - Aztec Noir-circuit acceptance (M0a + M0b, separate harness).
 *
 * ⚠️  Open question (pending codex review): the SHA-256 layering between adapter,
 *     Trezor device, and Aztec verifier may not line up the way the circuit expects.
 *     This fake-transport demo passes verification because both fake-sign and
 *     fake-verify apply the same internal SHA-256 — the loop closes. With a REAL
 *     Trezor + real circuit verifier, the layering may produce a mismatch.
 *     Codex review specifically asks this question (Q5).
 *
 * Both gaps are tracked in `docs/roadmap.md` Phase A.
 */

import { Ecdsa } from '@aztec/foundation/crypto/ecdsa';
import { TrezorEcdsaKAuthWitnessProvider } from '@aztec-hwwallet-poc/adapter-trezor';
import { ecdsaPreimage, Fr, normalizeLowS, packEcdsaSignature } from '@aztec-hwwallet-poc/core';
import { FakeTrezorTransport } from './fake-transport.ts';

const ACCOUNT_INDEX = 0;

async function main() {
  console.log('Aztec HW-wallet PoC — Phase A demo (fake transport)\n');

  const transport = new FakeTrezorTransport();
  const provider = new TrezorEcdsaKAuthWitnessProvider(transport, {
    accountIndex: ACCOUNT_INDEX,
  });

  // 1) Fetch device pubkey (deploy-time input to EcdsaKAccount constructor).
  const { x, y } = await provider.getPublicKeyXY();
  console.log('Device public key (secp256k1, for EcdsaKAccount constructor):');
  console.log(`  x = 0x${Buffer.from(x).toString('hex')}`);
  console.log(`  y = 0x${Buffer.from(y).toString('hex')}\n`);

  // 2) Synthesize a deterministic outer_hash (in production this comes from the
  //    Aztec entrypoint after Poseidon-hashing the tx call stack).
  const outerHash = Fr.fromBuffer(Buffer.from('0'.repeat(60) + '00000539', 'hex')); // 0x539 = 1337
  console.log(`Synthetic outer_hash: 0x${outerHash.toString()}`);

  // 3) Adapter computes preimage (SHA-256 of outer_hash bytes), asks transport to sign.
  const aw = await provider.createAuthWit(outerHash);
  // Each witness Fr was constructed from a small number 0-255 (one signature byte).
  // Extract back via toBigInt → Number safe-cast.
  const sigBytes = Uint8Array.from(aw.witness.map((fr) => Number(fr.toBigInt())));
  console.log(`AuthWitness signature (r||s, 64B): 0x${Buffer.from(sigBytes).toString('hex')}`);
  console.log(`AuthWitness requestHash: 0x${aw.requestHash.toString()}\n`);

  // 4) Verify the signature locally via Aztec's own ECDSA verifier.
  //    This is the "TS-level" M0a-equivalent — full Noir-circuit verification is M0b.
  const ecdsa = new Ecdsa();
  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  // EcdsaSignature exposes a constructor `(r, s, v)` — we don't have v back from the
  // adapter (Aztec doesn't use it). The verifier doesn't need v. Pad with 0.
  const sigForVerify = new (await import('@aztec/foundation/crypto/ecdsa')).EcdsaSignature(
    Buffer.from(r),
    Buffer.from(s),
    Buffer.from([0]),
  );
  const preimage = ecdsaPreimage(outerHash);
  const pubBytes = Buffer.concat([Buffer.from(x), Buffer.from(y)]); // 64B uncompressed (no 0x04)
  const ok = await ecdsa.verifySignature(Buffer.from(preimage), pubBytes, sigForVerify);
  console.log(`Local Aztec-K1 verify: ${ok ? 'OK ✓' : 'FAIL ✗'}`);

  if (!ok) {
    console.error('Signature did NOT verify. This is a real bug in the adapter pipeline.');
    process.exit(1);
  }

  // 5) Show how the (s) normalization handles the high-s case (defensive sanity check).
  const halfNplus1 = new Uint8Array(32);
  halfNplus1[31] = 1;
  // Manufactured high-s comes from outside the demo flow — just show normalize doesn't crash.
  void normalizeLowS(halfNplus1, 'secp256k1');
  void packEcdsaSignature(r, s);

  console.log('\n--- Phase A demo passed ---');
  console.log("Adapter logic verified against Aztec's own TS verifier.");
  console.log(
    'Next: swap FakeTrezorTransport for real @trezor/connect + emulator. (Awaiting codex review.)',
  );
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});
