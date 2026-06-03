/**
 * AHW-108 (W7) — each APPEND_CALL strict-allowlist reject arm asserts its EXACT
 * status word on the real app.elf (Speculos). The fuzzer (`fuzz_append_call.c`)
 * only checked SW ∈ known-set, so a gate degrading to accept (0x9000) — e.g. the
 * delegated-spend gate — would ship GREEN. These pin the exact reject per arm.
 *
 * Each case perturbs exactly ONE thing and keeps the rest valid, so it isolates
 * one arm. The reject fires at APPEND_CALL parse (before the review + B3), so the
 * consumer is a dummy and no UI navigation / blind-sign toggle is needed.
 *
 *   SPECULOS_URL=http://localhost:5005 bun test packages/adapter-ledger/src/wire-reject-arms.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { CallIntent, StructuredFunctionCall } from '@aztec-hwwallet-poc/core';
import { CURVE_ID, defaultAztecPath } from './apdu.ts';
import { buildL4Manifest } from './l4-manifest.ts';
import { LedgerProvider } from './provider.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const PATH = defaultAztecPath(0);
const USDC = '0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5'; // TOKEN (registry.gen)
const SEL_TRANSFER_PUB_PUB = 0xc47adea0n; // public verb, 4 args (from,to,amount,nonce)

describe.skipIf(!SPECULOS_URL)('AHW-108 — APPEND_CALL reject arms (exact SW, real elf)', () => {
  const transport = new SpeculosTransport({
    baseUrl: SPECULOS_URL ?? 'http://localhost:5005',
    timeoutMs: 30_000,
  });
  const provider = new LedgerProvider(transport);
  const DUMMY_CONSUMER = AztecAddress.fromField(new Fr(1n));

  /** begin a fresh authwit session for `call` and return the appendCall promise. */
  async function appendOf(call: StructuredFunctionCall): Promise<unknown> {
    const intent: CallIntent = {
      consumer: DUMMY_CONSUMER,
      chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
      calls: [call],
    };
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: PATH,
      curveId: CURVE_ID.SECP256K1,
    });
    await provider.abortAuthwit();
    await provider.beginAuthwit(manifest.header);
    return provider.appendCall(manifest.calls[0]!);
  }

  test('unknown (kind,selector) → SW_DECODER_MISS 0x6F09', async () => {
    const usdc = await AztecAddress.fromString(USDC);
    await expect(
      appendOf({
        contractAddress: usdc, // TOKEN in registry, but the selector is not a TOKEN verb
        selector: new Fr(0xdeadbeefn),
        args: [new Fr(1n), new Fr(2n)],
        isPadding: false,
        isPublic: true,
      }),
    ).rejects.toThrow('SW=0x6f09');
  });

  test('wrong arg_count for a known verb → SW_DECODER_DESYNC 0x6F0A', async () => {
    const usdc = await AztecAddress.fromString(USDC);
    await expect(
      appendOf({
        contractAddress: usdc,
        selector: new Fr(SEL_TRANSFER_PUB_PUB), // expects 4 args
        args: [DUMMY_CONSUMER.toField(), new Fr(2n), new Fr(3n)], // only 3
        isPadding: false,
        isPublic: true,
      }),
    ).rejects.toThrow('SW=0x6f0a');
  });

  test('visibility flip on a public verb → SW_VISIBILITY_MISMATCH 0x6F0B', async () => {
    const usdc = await AztecAddress.fromString(USDC);
    await expect(
      appendOf({
        contractAddress: usdc,
        selector: new Fr(SEL_TRANSFER_PUB_PUB),
        args: [DUMMY_CONSUMER.toField(), new Fr(2n), new Fr(3n), new Fr(0n)], // correct count
        isPadding: false,
        isPublic: false, // verb is public → mismatch
      }),
    ).rejects.toThrow('SW=0x6f0b');
  });

  test('4-arg transfer with from != consumer → SW_DELEGATED_SPEND_UNSUPPORTED 0x6F0C', async () => {
    const usdc = await AztecAddress.fromString(USDC);
    await expect(
      appendOf({
        contractAddress: usdc,
        selector: new Fr(SEL_TRANSFER_PUB_PUB),
        args: [new Fr(999n), new Fr(2n), new Fr(3n), new Fr(0n)], // from=999 != consumer=1
        isPadding: false,
        isPublic: true,
      }),
    ).rejects.toThrow('SW=0x6f0c');
  });
});
