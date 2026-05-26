/**
 * L2 sharpened acceptance test (plan-final.md §223 / codex L2 BLOCKER #2).
 *
 * Reproduces the `EcdsaKBaseAccountContract.getAuthWitnessProvider()` flow from
 * `aztec-packages/yarn-project/accounts/src/ecdsa/ecdsa_k/account_contract.ts`
 * but swaps the in-memory private key for the Ledger device. Verifies that:
 *
 *   1. The constructor args we'd emit for `EcdsaKAccount`'s Noir constructor
 *      (`[[...x], [...y]]`) match the shape the contract expects.
 *   2. The `AuthWitness` our provider produces has the exact `(outer_hash,
 *      [...r, ...s])` layout the contract's `verify_signature` Noir circuit
 *      reads.
 *   3. The sig verifies under `Ecdsa.verifySignature` — same barretenberg code
 *      path the Noir circuit uses, executed against the same byte-for-byte
 *      witness the contract would receive.
 *
 * What this DOESN'T cover (deferred — needs PXE + deployed account):
 *   - Running the actual Noir circuit against the witness.
 *   - The entrypoint's `inner_hash` → `outer_hash` derivation in a real tx.
 *   These land with L3 (golden vectors against a pinned aztec-packages commit).
 */
import { describe, expect, test } from 'bun:test';
import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import { Fr } from '@aztec-hwwallet-poc/core';

import { LedgerEcdsaKAuthWitnessProvider } from './auth-witness-provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const AZTEC_PATH = [0x8000_002c, 0x8000_0682, 0x8000_0000, 0x0000_0000, 0x0000_0000] as const;

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

/**
 * Reproduce `EcdsaKBaseAccountContract.getInitializationFunctionAndArgs`.
 * Returns the Noir constructor args the deployed contract would receive.
 */
async function buildEcdsaKAccountConstructorArgs(
  provider: LedgerEcdsaKAuthWitnessProvider,
): Promise<{
  constructorName: string;
  constructorArgs: [number[], number[]];
}> {
  const { x, y } = await provider.getPublicKeyXY();
  return {
    constructorName: 'constructor',
    constructorArgs: [Array.from(x), Array.from(y)],
  };
}

describe.skipIf(!SPECULOS_URL)('EcdsaKAccount flow — Ledger device replaces in-memory key', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5000' });
  const provider = new LedgerEcdsaKAuthWitnessProvider(transport, {
    bip32Path: AZTEC_PATH,
    signOptions: { autoConfirm: approveReview },
  });

  test('constructor args match the EcdsaKAccount Noir contract shape ([[...x], [...y]])', async () => {
    const init = await buildEcdsaKAccountConstructorArgs(provider);
    expect(init.constructorName).toBe('constructor');
    expect(init.constructorArgs).toHaveLength(2);
    const [xArr, yArr] = init.constructorArgs;
    expect(xArr).toHaveLength(32);
    expect(yArr).toHaveLength(32);
    for (const b of xArr) expect(Number.isInteger(b) && b >= 0 && b <= 255).toBe(true);
    for (const b of yArr) expect(Number.isInteger(b) && b >= 0 && b <= 255).toBe(true);
  });

  test('createAuthWit(messageHash) returns AuthWitness in the exact shape the contract reads', async () => {
    // Pick a 31-byte messageHash so it always fits in BN254's field modulus.
    const messageHash = new Fr(
      0x73_6967_6e64_656d_6f31_3233_3435_3637_3839_3061_6263_6465_6630_3132_3334_5556n,
    );
    const aw = await provider.createAuthWit(messageHash);

    // Exact shape contract reads: `AuthWitness(messageHash, [...r, ...s])`.
    expect(aw.requestHash.toString()).toBe(messageHash.toString());
    expect(aw.witness).toHaveLength(64);
    for (const fr of aw.witness) {
      // Each witness entry must be a `Field` carrying a u8 (Noir constructor expects [u8; 64]).
      const v = fr.toBigInt();
      expect(v >= 0n && v <= 255n).toBe(true);
    }
  });

  test('AuthWitness sig verifies via Aztec barretenberg Ecdsa — same as the in-circuit verifier', async () => {
    const messageHash = new Fr(
      0x73_6967_6e64_656d_6f31_3233_3435_3637_3839_3061_6263_6465_6630_3132_3334_5556n,
    );
    const aw = await provider.createAuthWit(messageHash);
    const { x, y } = await provider.getPublicKeyXY();

    // Extract r||s exactly as EcdsaKAccount Noir would.
    const sigBytes = Uint8Array.from(aw.witness.map((fr) => Number(fr.toBigInt())));
    const sig = new EcdsaSignature(
      Buffer.from(sigBytes.slice(0, 32)),
      Buffer.from(sigBytes.slice(32, 64)),
      Buffer.from([0]), // v unused for verify
    );

    const pubKeyXY = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
    // Aztec's Ecdsa expects the RAW message — it sha256-prehashes internally,
    // mirroring the Noir circuit's `sha256_to_bytes(outer_hash.to_be_bytes::<32>())`.
    const verifier = new Ecdsa('secp256k1');
    const ok = await verifier.verifySignature(messageHash.toBuffer(), pubKeyXY, sig);
    expect(ok).toBe(true);
  });
});
