/**
 * Phase A CLI demo — TrezorEcdsaKAuthWitnessProvider round-trip with a Trezor-faithful
 * fake transport. Architecture per codex review (see lessons/phase-A-codex-review-1.md).
 *
 * Usage: `bun run start`
 *
 * What this proves:
 *   - The adapter pipeline (Trezor SignIdentity wire format → Aztec AuthWitness) is correct.
 *   - The signature produced by signing `sha256(outer_hash.to_be_bytes())` directly (Trezor
 *     `proto='gpg'` semantics) verifies under Aztec's `Ecdsa.verifySignature` when the
 *     raw `outer_hash.to_be_bytes()` is passed as the message (Aztec hashes internally).
 *   - Compressed 33B pubkey → decompressed to 64B (x || y) matches Aztec's `EcdsaKAccount`
 *     constructor input shape.
 *
 * What this does NOT prove:
 *   - Real Trezor emulator wire compatibility (next step: replace FakeTrezorTransport with
 *     either @trezor/transport + @trezor/protobuf OR trezorlib bridge).
 *   - Noir-circuit acceptance (M0a + M0b harness — separate Phase 0 work).
 */

import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import {
  buildAztecIdentity,
  serializeIdentity,
  TrezorEcdsaKAuthWitnessProvider,
} from '@aztec-hwwallet-poc/adapter-trezor';
import { Fr } from '@aztec-hwwallet-poc/core';
import { FakeTrezorTransport } from './fake-transport.ts';

const ACCOUNT_INDEX = 0;

async function main() {
  console.log('Aztec HW-wallet PoC — Phase A demo (Trezor-faithful fake transport)\n');

  const transport = new FakeTrezorTransport();
  const provider = new TrezorEcdsaKAuthWitnessProvider(transport, {
    accountIndex: ACCOUNT_INDEX,
  });

  const identity = buildAztecIdentity({ accountIndex: ACCOUNT_INDEX });
  console.log(`Identity wire form: ${serializeIdentity(identity)}\n`);

  // 1) Probe-sign to fetch the device's pubkey (no separate GetPublicKey API exists
  //    for SLIP-0013; codex finding #3).
  const { x, y } = await provider.getPublicKeyXY();
  console.log('Device public key (64B for EcdsaKAccount constructor):');
  console.log(`  x = 0x${Buffer.from(x).toString('hex')}`);
  console.log(`  y = 0x${Buffer.from(y).toString('hex')}\n`);

  // 2) Synthesize a deterministic outer_hash (in production: comes from Aztec entrypoint
  //    after Poseidon-hashing the tx call stack).
  const outerHashBytes = Buffer.from('00'.repeat(28) + '00000539', 'hex'); // 0x539 = 1337
  const outerHash = Fr.fromBuffer(outerHashBytes);
  console.log(`Synthetic outer_hash: 0x${Buffer.from(outerHash.toBuffer()).toString('hex')}\n`);

  // 3) Adapter computes preimage (sha256(outer_hash.to_be_bytes())), signs via transport,
  //    strips the 0x00 marker, low-s normalizes, packs as AuthWitness.
  const aw = await provider.createAuthWit(outerHash);
  const sigBytes = Uint8Array.from(aw.witness.map((fr) => Number(fr.toBigInt())));
  console.log(`AuthWitness signature (r||s, 64B): 0x${Buffer.from(sigBytes).toString('hex')}\n`);

  // 4) Verify via Aztec's own ECDSA verifier — the TS-equivalent of what the Noir
  //    `EcdsaKAccount` circuit verifies. Pass the RAW outer_hash bytes; Aztec's verifier
  //    internally SHA-256s, producing the same digest the fake transport signed.
  //    v is ignored by the verifier (codex finding #7).
  const ecdsa = new Ecdsa();
  const r = Buffer.from(sigBytes.slice(0, 32));
  const s = Buffer.from(sigBytes.slice(32, 64));
  const pubBytes = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
  const sig = new EcdsaSignature(r, s, Buffer.from([0]));
  const ok = await ecdsa.verifySignature(outerHashBytes, pubBytes, sig);

  console.log(`Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): ${ok ? 'OK ✓' : 'FAIL ✗'}`);

  if (!ok) {
    console.error('\n❌ Signature did NOT verify. This is a real correctness bug.');
    process.exit(1);
  }

  console.log('\n--- Phase A demo passed ---');
  console.log("Adapter pipeline verified against Aztec's own TS verifier.");
  console.log('Round-trip: Trezor-faithful wire → adapter → AuthWitness → Aztec verifier.');
  console.log(
    '\nNext: swap FakeTrezorTransport for a real transport against trezor-firmware emulator',
  );
  console.log('(via trezorlib bridge OR @trezor/transport + @trezor/protobuf JS client).');
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});
