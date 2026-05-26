/**
 * L2 sharpened acceptance test (plan-final.md §223).
 *
 * Wires `LedgerEcdsaKAccountContract` into Aztec's real `DefaultAccountContract`
 * + `BaseAccount` + `DefaultAccountEntrypoint` code path so the test exercises
 * the actual framework, not a hand-rolled facsimile (codex L2 follow-up MAJOR).
 *
 * What this covers:
 *   1. `getInitializationFunctionAndArgs()` returns the same shape Aztec's
 *      `EcdsaKAccount` Noir constructor expects (`[Buffer x32, Buffer y32]`).
 *   2. `getAccount(completeAddress)` returns a real `BaseAccount`, and
 *      `account.createAuthWit(intent, chainInfo)` drives the full path —
 *      Aztec computes `outer_hash` from the intent + chainInfo internally,
 *      then calls our `LedgerEcdsaKAuthWitnessProvider` to sign on the device.
 *   3. The resulting `AuthWitness` carries `[...r, ...s]` exactly as the
 *      contract's `verify_signature` Noir circuit reads, and the sig verifies
 *      under Aztec barretenberg `Ecdsa.verifySignature`.
 *
 * What this DOESN'T cover (deferred — L3 / PXE work):
 *   - Running the actual Noir circuit against the witness.
 *   - Deploying the EcdsaKAccount contract on a sandbox.
 */
import { describe, expect, test } from 'bun:test';
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { CompleteAddress } from '@aztec/stdlib/contract';
import { Fr } from '@aztec-hwwallet-poc/core';

import { LedgerEcdsaKAccountContract } from './account-contract.ts';
import { defaultAztecPath } from './apdu.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = defaultAztecPath(0);

async function approveReview(ctx: AutoConfirmContext): Promise<void> {
  await ctx.sleep(500);
  await ctx.press('both');
  for (let i = 0; i < 5; i++) {
    await ctx.sleep(280);
    await ctx.press('right');
  }
  await ctx.sleep(280);
  await ctx.press('both');
}

describe.skipIf(!SPECULOS_URL)(
  'EcdsaKAccount real Aztec flow — Ledger replaces in-memory key',
  () => {
    const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
    const contract = new LedgerEcdsaKAccountContract(transport, {
      bip32Path: AZTEC_PATH,
      signOptions: { autoConfirm: approveReview },
    });

    test('getContractArtifact returns the Aztec EcdsaKAccount Noir artifact', async () => {
      const artifact = await contract.getContractArtifact();
      expect(artifact.name).toBe('EcdsaKAccount');
      expect(artifact.functions.length).toBeGreaterThan(0);
      // The Noir constructor takes ([u8; 32], [u8; 32]).
      const ctor = artifact.functions.find((f) => f.name === 'constructor');
      expect(ctor).toBeDefined();
    });

    test('getInitializationFunctionAndArgs binds device pubkey to the contract constructor', async () => {
      const init = await contract.getInitializationFunctionAndArgs();
      expect(init.constructorName).toBe('constructor');
      expect(init.constructorArgs).toHaveLength(2);
      const [x, y] = init.constructorArgs;
      expect(Buffer.isBuffer(x)).toBe(true);
      expect(Buffer.isBuffer(y)).toBe(true);
      expect(x!.length).toBe(32);
      expect(y!.length).toBe(32);
    });

    test('getAccount → BaseAccount.createAuthWit drives the real Aztec flow', async () => {
      // CompleteAddress.random() gives a syntactically valid account address +
      // public keys + partial address. Sufficient for the auth-witness path
      // since the entrypoint never derefs the on-chain account contract here.
      const completeAddress = await CompleteAddress.random();
      const account = contract.getAccount(completeAddress);

      // Build an IntentInnerHash: { consumer, innerHash }. Aztec's BaseAccount
      // computes outer_hash = H(consumer, chainId, version, innerHash) before
      // delegating to our provider's createAuthWit(outer_hash).
      const consumer = AztecAddress.fromBigInt(0xacc0_1234n);
      const innerHash = new Fr(0xc0_ffee_c0_ffee_dead_beefn);
      const chainInfo = { chainId: new Fr(1n), version: new Fr(1n) };

      const authWit = await account.createAuthWit({ consumer, innerHash }, chainInfo);

      // The returned witness is r||s — the same shape EcdsaKAccount Noir reads.
      expect(authWit.witness).toHaveLength(64);
      for (const fr of authWit.witness) {
        const v = fr.toBigInt();
        expect(v >= 0n && v <= 255n).toBe(true);
      }

      // Verify against the device's pubkey using Aztec's own Ecdsa class —
      // the message Aztec signed is `authWit.requestHash` (the outer_hash).
      const { x, y } = await contract.getProvider().getPublicKeyXY();
      const pubKeyXY = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
      const sigBytes = Uint8Array.from(authWit.witness.map((fr) => Number(fr.toBigInt())));
      const sig = new EcdsaSignature(
        Buffer.from(sigBytes.slice(0, 32)),
        Buffer.from(sigBytes.slice(32, 64)),
        Buffer.from([0]),
      );
      const verifier = new Ecdsa('secp256k1');
      const ok = await verifier.verifySignature(authWit.requestHash.toBuffer(), pubKeyXY, sig);
      expect(ok).toBe(true);
    });
  },
);
