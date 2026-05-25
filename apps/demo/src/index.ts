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
  formatIntentForDevice,
  serializeIdentity,
  TrezorEcdsaKAuthWitnessProvider,
  TrezorlibSubprocessTransport,
  type TrezorTransport,
} from '@aztec-hwwallet-poc/adapter-trezor';
import { AztecAddress, type CallIntent, Fr } from '@aztec-hwwallet-poc/core';
import { FakeTrezorTransport } from './fake-transport.ts';

const ACCOUNT_INDEX = 0;
const USE_REAL = process.env.AZTEC_HW_TRANSPORT === 'trezorlib';
const TREZOR_PATH = process.env.TREZOR_PATH;

async function main() {
  console.log(
    `Aztec HW-wallet PoC — Phase A demo (${USE_REAL ? 'REAL trezorlib subprocess' : 'fake transport'})\n`,
  );

  // When running via `bun run --cwd apps/demo start`, process.cwd() is apps/demo.
  // Resolve to the repo root so the bridge paths land in the right place.
  const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
  const transport: TrezorTransport = USE_REAL
    ? new TrezorlibSubprocessTransport({
        bridgePath: `${REPO_ROOT}/scripts/trezor-bridge/bridge.py`,
        pythonPath: `${REPO_ROOT}/scripts/trezor-bridge/venv/bin/python`,
        trezorPath: TREZOR_PATH,
      })
    : new FakeTrezorTransport();
  const provider = new TrezorEcdsaKAuthWitnessProvider(transport, {
    accountIndex: ACCOUNT_INDEX,
  });

  const identity = buildAztecIdentity({ accountIndex: ACCOUNT_INDEX });
  console.log(`Identity wire form: ${serializeIdentity(identity)}\n`);

  // 1) Build a structured CallIntent — Phase B's host-side clear-signing input.
  //    The labels feed into the on-device confirmation screen; the calls feed into
  //    the outer_hash computation (computeInnerAuthWitHash → computeOuterAuthWitHash).
  const usdcContract = AztecAddress.fromBigInt(0xaabbccddee001122n);
  const recipient = AztecAddress.fromBigInt(0xabcdabcdabcdabcd_dead1234dead1234n);
  const accountConsumer = AztecAddress.fromBigInt(0xacc0_fac11_be3f_000111n);
  const intent: CallIntent = {
    consumer: accountConsumer,
    chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
    calls: [
      {
        contractAddress: usdcContract,
        selector: new Fr(0xa9059cbbn), // ERC-20 transfer selector for narrative; not load-bearing
        args: [
          new Fr(recipient.toBigInt()),
          new Fr(1_000_000n), // 1.0 USDC (6 decimals)
        ],
        isPadding: false,
      },
    ],
    labels: {
      actionClass: 'transfer',
      amount: 1_000_000n,
      amountDecimals: 6,
      tokenSymbol: 'USDC',
      recipient: '0xabcdabcd…dead1234',
      contractLabel: 'USDC',
    },
  };

  console.log('--- Intent visual (what the device will display) ---');
  console.log(formatIntentForDevice(intent));
  console.log('---');

  // 2) Adapter computes outer_hash from intent, formats the visual, signs via transport.
  //    This is Phase B.1: decorative clear-signing. The device DISPLAYS the intent fields,
  //    but does NOT itself recompute the hash — that's Phase B.2 (Poseidon2 on firmware).
  const aw = await provider.createAuthWitFromIntent(intent);

  const { x, y } = await provider.getPublicKeyXY(); // reads from cache, no second sign
  console.log('\nDevice public key (64B for EcdsaKAccount constructor):');
  console.log(`  x = 0x${Buffer.from(x).toString('hex')}`);
  console.log(`  y = 0x${Buffer.from(y).toString('hex')}\n`);

  const outerHash = aw.requestHash;
  const outerHashBytes = outerHash.toBuffer();
  console.log(`Derived outer_hash: 0x${Buffer.from(outerHashBytes).toString('hex')}`);
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
  console.log(
    `Transport: ${USE_REAL ? 'trezorlib subprocess (real device or emulator)' : 'fake transport (in-process)'}.`,
  );
  if (!USE_REAL) {
    console.log('\nTo run against the real trezor-firmware emulator:');
    console.log('  1. scripts/trezor-bridge/setup.sh    (one-time venv install)');
    console.log('  2. start the emulator on udp:127.0.0.1:21324');
    console.log('  3. AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start');
  }

  // Cleanly close the real transport so the subprocess exits.
  if (typeof (transport as { close?: () => Promise<void> }).close === 'function') {
    await (transport as { close: () => Promise<void> }).close();
  }
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});
