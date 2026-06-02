/**
 * AHW-046 — per-verb review-CONTENT assertions on the real app.elf (Speculos).
 *
 * The python/e2e suites auto-confirm by a generic prompt regex; NOTHING asserted
 * WHAT the clear-sign review screen displays per verb — which is exactly why
 * AHW-040 (DRIP rendered with ZERO value pairs) stayed invisible. This drives ONE
 * multi-verb authwit (transfer + mint + drip + sponsor) through the verified-calls
 * review on the ACCEPT path, scrolls every page capturing Speculos screen text, and
 * asserts the decoded per-verb content the user actually signs:
 *   - action labels (Transfer pub->pub USDC / Drip / MINTER warning / Testnet FPC)
 *   - 8+8 truncated recipient with ASCII ".." (AHW-050/052)
 *   - raw-alongside-scaled amounts (AHW-051) — the magnitude can't be hidden
 *   - DRIP token/recipient render (AHW-040) + salient MINTER warning (AHW-055)
 *   - the FULL outer_hash on the tail (AHW-053)
 *
 * Reaching the review requires `consumer` == THIS key's real device-derived account
 * address (else B3 rejects pre-UI, finalize_and_sign.c:180). We derive the identical
 * address the way the device does: signing pubkey + master-secret viewing keys, with
 * salt = Fr.ZERO and profile 0 (DEFAULT_ACCOUNT_SALT). We then drive the review and
 * REJECT — this asserts RENDER, not signature (provider.m8 covers signing).
 *
 * Nav is scroll-until-marker (NBGL paginates wrapped values into many pages, so a
 * fixed press count is brittle); assertions are space-insensitive (line wraps inject
 * spaces mid-value).
 *
 *   SPECULOS_URL=http://localhost:5005 bun test packages/adapter-ledger/src/verified-calls-content.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { EcdsaKAccountContractArtifact } from '@aztec/accounts/ecdsa';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { CallIntent, StructuredFunctionCall } from '@aztec-hwwallet-poc/core';
import { CURVE_ID, defaultAztecPath, INS, SW } from './apdu.ts';
import { buildL4Manifest, deviceOuterHashForIntent } from './l4-manifest.ts';
import { deriveAztecKeysFromMasterSecret } from './oracle/index.ts';
import { LedgerProvider } from './provider.ts';
import type { AutoConfirmContext } from './speculos-transport.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const PATH = defaultAztecPath(0);

/* Registered contracts (registry.gen.c) — APPEND_CALL requires an exact match. */
const USDC = '0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5'; // TOKEN, 6 dec
const FPC = '0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257'; // SPONSOR
const DRIP = '0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070'; // DRIPPER

/* Verb selectors (selectors.gen.c). */
const SEL_TRANSFER_PUB_PUB = 0xc47adea0n;
const SEL_MINT_PUB = 0x451b5faen;
const SEL_SPONSOR = 0x23d77f89n;
const SEL_DRIP_PUB = 0xbe46ea53n;

/** Press 'right' (clearing+reading each page) until `marker` shows on the current
 * page, then 'both'. Pushes each page's text into `sink` DURING the scroll — not via
 * the return value — because 'both' is what unblocks the host APDU, so anything
 * captured only after 'both' races the test body that reads it. Robust to NBGL
 * pagination (wrapped values span many pages). */
async function driveUntil(
  ctx: AutoConfirmContext,
  marker: string,
  cap: number,
  sink: string[] = [],
): Promise<void> {
  await ctx.sleep(700);
  for (let i = 0; i < cap; i++) {
    /* Read the CURRENT page before advancing — so the intro page (which carries the
     * review title) is captured rather than cleared away on the first iteration. */
    const cur = (await ctx.getEvents()).map((e) => e.text).join(' ');
    sink.push(cur);
    if (cur.includes(marker)) break;
    await ctx.clearEvents();
    await ctx.press('right');
    await ctx.sleep(130);
  }
  await ctx.press('both');
}

describe.skipIf(!SPECULOS_URL)('AHW-046 — verified-calls review content (real app.elf)', () => {
  /* 90s timeout: the drive completes in ~10s; a navigation miss fails fast. */
  const transport = new SpeculosTransport({
    baseUrl: SPECULOS_URL ?? 'http://localhost:5005',
    timeoutMs: 90_000,
  });
  const provider = new LedgerProvider(transport);

  test('per-verb review renders the decoded content the user signs', async () => {
    /* consumer = this key's REAL device-derived account address (so B3 ACCEPTS).
     * The reveal screen ends with "...privacy root?" — scroll to it, then approve. */
    const pk = await provider.getPublicKey(PATH);
    const secret = await provider.getAztecMasterSecret(PATH, {
      autoConfirm: async (ctx) => {
        await driveUntil(ctx, 'root?', 12);
      },
    });
    const derived = await deriveAztecKeysFromMasterSecret(Fr.fromBuffer(Buffer.from(secret)));
    const instance = await getContractInstanceFromInstantiationParams(
      EcdsaKAccountContractArtifact,
      {
        constructorArgs: [Buffer.from(pk.x), Buffer.from(pk.y)],
        salt: Fr.ZERO,
        publicKeys: derived.publicKeys,
        deployer: AztecAddress.ZERO,
      },
    );
    const consumer = instance.address;

    /* A distinctive recipient so its 8+8 head/tail is unmistakable on screen. */
    const recipient = await AztecAddress.fromString(
      '0x1111111122222222333333334444444455555555666666667777777788888888',
    );
    const usdc = await AztecAddress.fromString(USDC);

    const mkCall = (
      contractAddress: AztecAddress,
      selector: bigint,
      args: Fr[],
      isPublic: boolean,
    ): StructuredFunctionCall => ({
      contractAddress,
      selector: new Fr(selector),
      args,
      isPadding: false,
      isPublic,
    });

    const calls: StructuredFunctionCall[] = [
      /* transfer_public(from=YOU, to=recipient, amount=1.5 USDC, nonce=0) */
      mkCall(
        usdc,
        SEL_TRANSFER_PUB_PUB,
        [consumer.toField(), recipient.toField(), new Fr(1_500_000n), new Fr(0n)],
        true,
      ),
      /* mint_to_public(to=recipient, amount=1.0 USDC) */
      mkCall(usdc, SEL_MINT_PUB, [recipient.toField(), new Fr(1_000_000n)], true),
      /* drip_to_public(token=USDC, amount=5.0 USDC) — recipient = caller (you) */
      mkCall(
        await AztecAddress.fromString(DRIP),
        SEL_DRIP_PUB,
        [usdc.toField(), new Fr(5_000_000n)],
        true,
      ),
      /* sponsor fee (no args, private) */
      mkCall(await AztecAddress.fromString(FPC), SEL_SPONSOR, [], false),
    ];

    const intent: CallIntent = {
      consumer,
      chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
      calls,
    };

    const manifest = await buildL4Manifest({
      intent,
      bip32Path: PATH,
      curveId: CURVE_ID.SECP256K1,
    });
    const claimedOuterHash = await deviceOuterHashForIntent({
      intent,
      bip32Path: PATH,
      curveId: CURVE_ID.SECP256K1,
    });

    await provider.beginAuthwit(manifest.header);
    for (const c of manifest.calls) await provider.appendCall(c);

    /* Drive the verified-calls review to the Reject page, capturing every page. */
    const pages: string[] = [];
    await transport.clearEvents();
    const fin = await transport.send(
      { ins: INS.FINALIZE_AND_SIGN as never, p1: 0, p2: 0, data: claimedOuterHash },
      (ctx) => driveUntil(ctx, 'Reject', 90, pages),
    );

    const flat = pages.join(' ');
    const tight = flat.replace(/\s+/g, '');

    /* Reached the UI (B3 accepted my real device-derived consumer) and rejected —
     * not a pre-UI reject and not an outer_hash-mirror divergence. */
    expect(Number(fin.sw)).not.toBe(Number(SW.HASH_MISMATCH));
    expect(Number(fin.sw)).toBe(Number(SW.CONDITIONS_NOT_SATISFIED)); // 0x6985 user reject
    expect(tight).toContain('AuthorizeAzteccalls');
    /* AHW-054: verification scope is stated honestly. */
    expect(tight).toContain('amounts+recipientsarehost-provided');

    /* transfer: action + raw-alongside-scaled amount (AHW-051) */
    expect(tight).toContain('Transferpub->pubUSDC');
    expect(tight).toContain('1.5USDC');
    expect(tight).toContain('raw1500000');
    /* 8+8 recipient with ASCII ".." (AHW-050/052), fully visible (not 4+4 / U+2026,
     * not alias-truncated): 0x + first 8 bytes + ".." + last 8 bytes. */
    expect(tight).toContain('0x1111111122222222..7777777788888888');

    /* mint: salient MINTER warning (AHW-055) + its raw amount */
    expect(tight).toContain('MINTERaction-createsnewsupply');
    expect(tight).toContain('raw1000000');

    /* drip (AHW-040): the original bug rendered "Call DRIP" with no value pairs */
    expect(tight).not.toContain('CallDRIP');
    expect(tight).toContain('you(drip)');
    expect(tight).toContain('raw5000000');

    /* sponsor */
    expect(tight).toContain('TestnetFPC');

    /* FULL outer_hash on the tail (AHW-053): NBGL paginates the long value across
     * "outer_hash (1/2)" / "(2/2)" pages, so strip those interleaved tags and assert
     * the exact 64-hex we claimed appears contiguously (proves all 32 bytes shown,
     * not 8+8). */
    const outerHex = Buffer.from(claimedOuterHash).toString('hex');
    expect(tight.replace(/outer_hash\(\d\/\d\)/g, '')).toContain(outerHex);
  });

  test('AHW-041: DRIP with a non-TOKEN args[0] is rejected at APPEND_CALL (device-side)', async () => {
    /* post-impl codex MED: the device now enforces args[0]=TOKEN for DRIP (was host
     * preflight only). args[0] = the SPONSOR/FPC slot (kind != TOKEN) → SW_REGISTRY_MISS
     * (0x6F08) at APPEND_CALL, before any review. consumer is irrelevant (reject is
     * pre-FINALIZE/B3), so a dummy keeps this reveal-free. */
    const fpc = await AztecAddress.fromString(FPC);
    const intent: CallIntent = {
      consumer: AztecAddress.fromField(new Fr(1n)),
      chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
      calls: [
        {
          contractAddress: await AztecAddress.fromString(DRIP),
          selector: new Fr(SEL_DRIP_PUB),
          args: [fpc.toField(), new Fr(1000n)],
          isPadding: false,
          isPublic: true,
        },
      ],
    };
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: PATH,
      curveId: CURVE_ID.SECP256K1,
    });
    const [dripCall] = manifest.calls;
    await provider.abortAuthwit();
    await provider.beginAuthwit(manifest.header);
    await expect(provider.appendCall(dripCall)).rejects.toThrow('SW=0x6f08');
  });
});
