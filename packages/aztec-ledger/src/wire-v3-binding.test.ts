/**
 * AHW-018 (wire v3) — host-selected (profile_id, salt) binding on the real app.elf.
 *
 * v3 carries profile_id + salt on BEGIN_AUTHWIT; B3 at FINALIZE re-derives the account
 * address for (path, profile, salt) from THIS device's keys and binds `consumer` to it
 * (derive-don't-trust). This proves:
 *   - profile_id is ALLOWLISTED at BEGIN: an unknown profile, or a (curve, profile) the
 *     allowlist doesn't pair, is rejected with SW_UNKNOWN_PROFILE_ID (0x6F0D) — before
 *     any FINALIZE/sign (codex High: a future deploy profile is NOT authwit-signable).
 *   - a NON-ZERO salt account works (v2 hard-coded zero-salt and locked these out): the
 *     matching consumer passes B3 and reaches the review.
 *   - a wire salt that doesn't match the consumer fails closed with
 *     SW_AUTHWIT_CONSUMER_MISMATCH (0x6F12) — derive-don't-trust holds.
 *
 *   SPECULOS_URL=http://localhost:5005 bun test packages/adapter-ledger/src/wire-v3-binding.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { CallIntent } from '@alejoamiras/aztec-ledger-core';
import { EcdsaKAccountContractArtifact } from '@aztec/accounts/ecdsa';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { CURVE_ID, defaultAztecPath, INS, SW } from './apdu.ts';
import {
  buildL4Manifest,
  deviceOuterHashForIntent,
  encodeBeginAuthwitBody,
} from './l4-manifest.ts';
import { deriveAztecKeysFromMasterSecret } from './oracle/index.ts';
import { LedgerProvider } from './provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const PATH = defaultAztecPath(0);
const ACCOUNT_SALT = new Fr(0x5n); // a NON-zero salt — the case v2 could not bind

describe.skipIf(!SPECULOS_URL)(
  'AHW-018 — wire v3 (profile_id, salt) binding (real app.elf)',
  () => {
    const transport = new SpeculosTransport({
      baseUrl: SPECULOS_URL ?? 'http://localhost:5005',
      timeoutMs: 90_000,
    });
    const provider = new LedgerProvider(transport);

    const zeroCallIntent = (consumer: AztecAddress): CallIntent => ({
      consumer,
      chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
      calls: [],
    });

    test('unknown profile_id rejected at BEGIN_AUTHWIT with SW_UNKNOWN_PROFILE_ID (0x6F0D)', async () => {
      const m = await buildL4Manifest({
        intent: zeroCallIntent(AztecAddress.fromField(new Fr(1n))),
        bip32Path: PATH,
        curveId: CURVE_ID.SECP256K1,
        profileId: 7, // not in the allowlist
      });
      const r = await transport.send({
        ins: INS.BEGIN_AUTHWIT as never,
        p1: 0,
        p2: 0,
        data: encodeBeginAuthwitBody(m.header),
      });
      expect(Number(r.sw)).toBe(Number(SW.UNKNOWN_PROFILE_ID));
    });

    test('curve/profile mismatch (K1 + Schnorr profile 1) rejected with 0x6F0D', async () => {
      const m = await buildL4Manifest({
        intent: zeroCallIntent(AztecAddress.fromField(new Fr(1n))),
        bip32Path: PATH,
        curveId: CURVE_ID.SECP256K1, // K1 pairs with profile 0, NOT 1
        profileId: 1,
      });
      const r = await transport.send({
        ins: INS.BEGIN_AUTHWIT as never,
        p1: 0,
        p2: 0,
        data: encodeBeginAuthwitBody(m.header),
      });
      expect(Number(r.sw)).toBe(Number(SW.UNKNOWN_PROFILE_ID));
    });

    describe('non-zero salt B3 binding', () => {
      /* consumer = this key's account address for ACCOUNT_SALT (profile 0). Derived the
       * way the device does: signing pubkey + master-secret viewing keys. */
      async function consumerForSalt(salt: Fr): Promise<AztecAddress> {
        const pk = await provider.getPublicKey(PATH);
        const secret = await provider.getAztecMasterSecret(PATH, {
          autoConfirm: async (ctx) => {
            await ctx.sleep(600);
            for (let i = 0; i < 12; i++) {
              await ctx.clearEvents();
              await ctx.press('right');
              await ctx.sleep(220);
              if (
                (await ctx.getEvents())
                  .map((e) => e.text)
                  .join(' ')
                  .includes('root?')
              )
                break;
            }
            await ctx.press('both');
          },
        });
        const derived = await deriveAztecKeysFromMasterSecret(Fr.fromBuffer(Buffer.from(secret)));
        const instance = await getContractInstanceFromInstantiationParams(
          EcdsaKAccountContractArtifact,
          {
            constructorArgs: [Buffer.from(pk.x), Buffer.from(pk.y)],
            salt,
            publicKeys: derived.publicKeys,
            deployer: AztecAddress.ZERO,
          },
        );
        return instance.address;
      }

      test('matching non-zero salt → B3 accepts (reaches review, NOT 0x6F12)', async () => {
        const consumer = await consumerForSalt(ACCOUNT_SALT);
        const intent = zeroCallIntent(consumer);
        const m = await buildL4Manifest({
          intent,
          bip32Path: PATH,
          curveId: CURVE_ID.SECP256K1,
          salt: ACCOUNT_SALT.toBuffer(),
          profileId: 0,
        });
        const claimed = await deviceOuterHashForIntent({
          intent,
          bip32Path: PATH,
          curveId: CURVE_ID.SECP256K1,
        });
        await transport.clearEvents();
        await provider.beginAuthwit(m.header);
        /* B3 passes → minimal review; scroll to Reject + both → 0x6985. The point is it
         * is NOT 0x6F12 (would mean B3 rejected the non-zero-salt account pre-UI). */
        const reject = async (ctx: AutoConfirmContext): Promise<void> => {
          await ctx.sleep(700);
          for (let i = 0; i < 40; i++) {
            await ctx.clearEvents();
            await ctx.press('right');
            await ctx.sleep(130);
            if (
              (await ctx.getEvents())
                .map((e) => e.text)
                .join(' ')
                .includes('Reject')
            )
              break;
          }
          await ctx.press('both');
        };
        const fin = await transport.send(
          { ins: INS.FINALIZE_AND_SIGN as never, p1: 0, p2: 0, data: claimed },
          reject,
        );
        expect(Number(fin.sw)).not.toBe(Number(SW.AUTHWIT_CONSUMER_MISMATCH));
        expect(Number(fin.sw)).not.toBe(Number(SW.HASH_MISMATCH));
        expect(Number(fin.sw)).toBe(Number(SW.CONDITIONS_NOT_SATISFIED)); // 0x6985 user reject (post-UI)
      });

      test('wire salt != consumer salt → B3 rejects with 0x6F12 (derive-not-trust)', async () => {
        const consumer = await consumerForSalt(ACCOUNT_SALT); // address for salt 5
        const intent = zeroCallIntent(consumer);
        const m = await buildL4Manifest({
          intent,
          bip32Path: PATH,
          curveId: CURVE_ID.SECP256K1,
          salt: new Fr(0x6n).toBuffer(), // WRONG salt on the wire (consumer is salt-5)
          profileId: 0,
        });
        const claimed = await deviceOuterHashForIntent({
          intent,
          bip32Path: PATH,
          curveId: CURVE_ID.SECP256K1,
        });
        await provider.beginAuthwit(m.header);
        const fin = await transport.send({
          ins: INS.FINALIZE_AND_SIGN as never,
          p1: 0,
          p2: 0,
          data: claimed,
        });
        expect(Number(fin.sw)).not.toBe(Number(SW.HASH_MISMATCH));
        expect(Number(fin.sw)).toBe(Number(SW.AUTHWIT_CONSUMER_MISMATCH));
      });
    });
  },
);
