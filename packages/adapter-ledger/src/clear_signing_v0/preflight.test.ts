/**
 * Host-side preflight unit tests. No Speculos needed — verifies the adapter
 * rejects badly-shaped intents before APDU round-trips.
 *
 * Each test exercises one of the 5 rejection rules the device enforces in
 * M5.2's strict-allowlist gates.
 */
import { describe, expect, test } from 'bun:test';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { type CallIntent, Fr, type StructuredFunctionCall } from '@aztec-hwwallet-poc/core';

import { PreflightError, preflightIntent } from './preflight.ts';

const USDC =
  AztecAddress.fromBigInt(0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5n);
const CONSUMER = AztecAddress.fromBigInt(0xacc0_dead_beefn);
const RECIPIENT = AztecAddress.fromBigInt(0xabcd_ef12_3456n);
const SEL_TRANSFER_PUB_PUB = new Fr(0xc47adea0n);
const SEL_MINT_PUB = new Fr(0x451b5fae);

function callIntent(call: StructuredFunctionCall): CallIntent {
  return {
    consumer: CONSUMER,
    chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
    calls: [call],
  };
}

describe('preflightIntent', () => {
  test('accepts a registered USDC transfer with from == consumer', () => {
    const decoded = preflightIntent(
      callIntent({
        contractAddress: USDC,
        selector: SEL_TRANSFER_PUB_PUB,
        args: [CONSUMER.toField(), RECIPIENT.toField(), new Fr(1_500_000n), new Fr(0n)],
        isPadding: false,
        isPublic: true,
      }),
    );
    expect(decoded.length).toBe(1);
    expect(decoded[0]!.verbEntry.verb).toBe('TRANSFER_PUB_PUB');
    expect(decoded[0]!.registryEntry.symbol).toBe('USDC');
  });

  test('rejects unregistered contract (SW_REGISTRY_MISS)', () => {
    expect(() =>
      preflightIntent(
        callIntent({
          contractAddress: AztecAddress.fromBigInt(0xdeadbeefn),
          selector: SEL_TRANSFER_PUB_PUB,
          args: [CONSUMER.toField(), RECIPIENT.toField(), new Fr(1n), new Fr(0n)],
          isPadding: false,
          isPublic: true,
        }),
      ),
    ).toThrow(/SW_REGISTRY_MISS|not in clear-signing registry/);
  });

  test('rejects unregistered selector on a known contract (SW_DECODER_MISS)', () => {
    expect(() =>
      preflightIntent(
        callIntent({
          contractAddress: USDC,
          selector: new Fr(0xdeadbeefn),
          args: [CONSUMER.toField(), RECIPIENT.toField(), new Fr(1n), new Fr(0n)],
          isPadding: false,
          isPublic: true,
        }),
      ),
    ).toThrow(/SW_DECODER_MISS|not in CS_VERBS/);
  });

  test('rejects arg_count mismatch (SW_DECODER_DESYNC)', () => {
    expect(() =>
      preflightIntent(
        callIntent({
          contractAddress: USDC,
          selector: SEL_TRANSFER_PUB_PUB,
          args: [CONSUMER.toField(), RECIPIENT.toField()], // 2 instead of 4
          isPadding: false,
          isPublic: true,
        }),
      ),
    ).toThrow(/SW_DECODER_DESYNC|arg count/);
  });

  test('rejects visibility mismatch (SW_VISIBILITY_MISMATCH)', () => {
    expect(() =>
      preflightIntent(
        callIntent({
          contractAddress: USDC,
          selector: SEL_TRANSFER_PUB_PUB, // public verb
          args: [CONSUMER.toField(), RECIPIENT.toField(), new Fr(1n), new Fr(0n)],
          isPadding: false,
          isPublic: false, // claimed private — mismatch
        }),
      ),
    ).toThrow(/SW_VISIBILITY_MISMATCH/);
  });

  test('rejects 4-arg transfer where from != consumer (SW_DELEGATED_SPEND_UNSUPPORTED)', () => {
    expect(() =>
      preflightIntent(
        callIntent({
          contractAddress: USDC,
          selector: SEL_TRANSFER_PUB_PUB,
          /* args[0] = some other address, NOT consumer */
          args: [
            AztecAddress.fromBigInt(0xdeadn).toField(),
            RECIPIENT.toField(),
            new Fr(1n),
            new Fr(0n),
          ],
          isPadding: false,
          isPublic: true,
        }),
      ),
    ).toThrow(/SW_DELEGATED_SPEND_UNSUPPORTED|delegated spend/);
  });

  test('accepts a MINT_PUB without from-check (only 2 args)', () => {
    const decoded = preflightIntent(
      callIntent({
        contractAddress: USDC,
        selector: SEL_MINT_PUB,
        args: [RECIPIENT.toField(), new Fr(1_000_000n)],
        isPadding: false,
        isPublic: true,
      }),
    );
    expect(decoded.length).toBe(1);
    expect(decoded[0]!.verbEntry.verb).toBe('MINT_PUB');
  });

  test('typed PreflightError carries deviceSwCode + callIndex', () => {
    try {
      preflightIntent(
        callIntent({
          contractAddress: AztecAddress.fromBigInt(0xdead_beefn),
          selector: SEL_TRANSFER_PUB_PUB,
          args: [CONSUMER.toField(), RECIPIENT.toField(), new Fr(1n), new Fr(0n)],
          isPadding: false,
          isPublic: true,
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PreflightError);
      expect((e as PreflightError).deviceSwCode).toBe('SW_REGISTRY_MISS');
      expect((e as PreflightError).callIndex).toBe(0);
    }
  });
});
