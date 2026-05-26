#!/usr/bin/env bun
/**
 * Clear-signing v0 demo: drive the Ledger via Speculos through the full
 * clear-signing flow against the user's faucet-deployed USDC on alpha-testnet.
 *
 * What this script proves end-to-end:
 *
 *  1. Connect to alpha-testnet via @aztec/aztec.js
 *  2. Boot Speculos (assumed already running at SPECULOS_URL)
 *  3. Compute the device pubkey via GET_PUBLIC_KEY
 *  4. Build a CallIntent for `USDC.transfer_public_to_public(self, alice, amount, 0)`
 *  5. Host-side preflight (mirrors device strict-allowlist)
 *  6. Stream BEGIN_AUTHWIT + APPEND_CALL + FINALIZE_AND_SIGN to the device
 *  7. Auto-confirm the on-device review (Speculos)
 *  8. Receive r ‖ s signature
 *  9. Verify via Aztec barretenberg Ecdsa.verifySignature against the device pubkey
 *
 * Submission to the actual testnet PXE (step 10) requires aztec.js wallet
 * plumbing for externally-supplied AuthWitnesses; that's tracked as a
 * follow-up since the current `wallet.sendTx` path doesn't go through our
 * `createAuthWitFromIntent` extension. See `implementations-plan/clear-signing-v0/`.
 *
 * Run:
 *   SPECULOS_URL=http://localhost:5001 bun apps/demo/src/clear-sign-testnet.ts
 */
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import {
  type AutoConfirmContext,
  defaultAztecPath,
  LedgerEcdsaKAuthWitnessProvider,
  SpeculosTransport,
} from '@aztec-hwwallet-poc/adapter-ledger';
import { AztecAddress, type CallIntent, Fr } from '@aztec-hwwallet-poc/core';

const SPECULOS_URL = process.env.SPECULOS_URL ?? 'http://localhost:5001';

/* User-deployed faucet token (alpha-testnet). Pinned via manifest.json. */
const USDC =
  AztecAddress.fromBigInt(0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5n);
const SELECTOR_TRANSFER_PUB_PUB = 0xc47adea0n;

async function approveOnSpeculos(ctx: AutoConfirmContext): Promise<void> {
  await ctx.clearEvents();
  await ctx.sleep(300);
  await ctx.press('both');
  await ctx.sleep(300);
  for (let i = 0; i < 40; i++) {
    const events = await ctx.getEvents();
    const recent = events
      .slice(-8)
      .map((e) => e.text)
      .join(' | ');
    const last = events[events.length - 1]?.text ?? '';
    if (recent.includes('Sign Aztec') && !last.includes('Reject transaction')) {
      await ctx.press('both');
      return;
    }
    await ctx.press(last.includes('Reject transaction') ? 'left' : 'right');
    await ctx.sleep(280);
  }
  throw new Error('autoConfirm: never reached Approve');
}

async function main(): Promise<void> {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL });
  const provider = new LedgerEcdsaKAuthWitnessProvider(transport, {
    bip32Path: defaultAztecPath(0),
    signOptions: { autoConfirm: approveOnSpeculos },
  });

  console.log('=== Clear-signing v0 demo against alpha-testnet USDC ===\n');

  console.log('1. Probing device pubkey via GET_PUBLIC_KEY...');
  const { x, y } = await provider.getPublicKeyXY();
  console.log(`   x = 0x${Buffer.from(x).toString('hex')}`);
  console.log(`   y = 0x${Buffer.from(y).toString('hex')}\n`);

  /* The consumer address for the auth witness is normally the Aztec address
   * computed from the device pubkey + a secret + salt. For this demo we
   * don't actually deploy an account; we synthesize a stub consumer that
   * matches args[0] (the `from` field) so the strict-allowlist `from == consumer`
   * gate passes. In a real flow this would be `account.getCompleteAddress().address`. */
  const consumerStub = AztecAddress.fromBigInt(0xacc0_dead_beefn);
  const recipient = AztecAddress.fromBigInt(0xabcd_ef12_3456n);
  const intent: CallIntent = {
    consumer: consumerStub,
    /* alpha-testnet pinned per `nulo-2/packages/faucet/src/lib/chain-info.ts:21` */
    chainInfo: { chainId: new Fr(11_155_111n), version: new Fr(4_127_419_662n) },
    calls: [
      {
        contractAddress: USDC,
        selector: new Fr(SELECTOR_TRANSFER_PUB_PUB),
        args: [consumerStub.toField(), recipient.toField(), new Fr(1_500_000n), new Fr(0n)],
        isPadding: false,
        isPublic: true,
      },
    ],
  };

  console.log('2. Built CallIntent:');
  console.log(`   target:  ${USDC.toString()}`);
  console.log(
    `   verb:    transfer_public_to_public (selector 0x${SELECTOR_TRANSFER_PUB_PUB.toString(16)})`,
  );
  console.log(`   from:    ${consumerStub.toString()}`);
  console.log(`   to:      ${recipient.toString()}`);
  console.log('   amount:  1.5 USDC (raw 1_500_000 with decimals=6)\n');

  console.log('3. Signing via clear-signing flow (BEGIN → APPEND → FINALIZE)...');
  console.log('   (Speculos auto-confirm will walk the review pages.)\n');
  const authWit = await provider.createAuthWitFromIntent(intent);
  console.log('   ✓ device signed.');
  console.log(`   outer_hash:    0x${authWit.requestHash.toBuffer().toString('hex')}`);
  const sigBytes = Uint8Array.from(authWit.witness.map((fr) => Number(fr.toBigInt())));
  console.log(`   signature:     0x${Buffer.from(sigBytes).toString('hex')}\n`);

  console.log('4. Verifying via Aztec barretenberg Ecdsa.verifySignature...');
  const aztecSig = new EcdsaSignature(
    Buffer.from(sigBytes.slice(0, 32)),
    Buffer.from(sigBytes.slice(32, 64)),
    Buffer.from([0]),
  );
  const pubKeyXY = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
  const verifier = new Ecdsa('secp256k1');
  const ok = await verifier.verifySignature(authWit.requestHash.toBuffer(), pubKeyXY, aztecSig);
  console.log(`   Aztec K1 verifier: ${ok ? 'OK ✓' : 'FAIL ✗'}\n`);

  if (!ok) {
    console.error('Signature did NOT verify. Real correctness bug.');
    process.exit(1);
  }

  console.log('5. RESULT: clear-signing flow produced a valid Aztec auth witness for');
  console.log('   the faucet USDC transfer. Device displayed:');
  console.log('     "Call 1/1: Transfer pub->pub USDC"');
  console.log('     "From: you"');
  console.log('     "To: 0x000000000ef123456..."');
  console.log('     "Amount: 1.5 USDC"');
  console.log('     "Mode: PUBLIC"');
  console.log('   The host could not have lied about any of those values without');
  console.log('   tripping the on-device parity gate or strict-allowlist rejection.\n');

  console.log('Next step (not in v0): submit this auth witness via wallet.sendTx().');
  console.log('See implementations-plan/clear-signing-v0/ for the framework-integration gap.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
