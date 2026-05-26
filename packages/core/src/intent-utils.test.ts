import { describe, expect, test } from 'bun:test';
import { AztecAddress, type CallIntent, Fr } from '@aztec-hwwallet-poc/core';
import { computeOuterHashForIntent, formatIntentForDevice } from './intent-utils.ts';

function makeUsdcTransferIntent(): CallIntent {
  const usdc = AztecAddress.fromBigInt(0xaabbccddee001122n);
  const recipient = AztecAddress.fromBigInt(0xdeadbeef_dead1234n);
  return {
    consumer: AztecAddress.fromBigInt(0xacc0_1234_5678n),
    chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
    calls: [
      {
        contractAddress: usdc,
        selector: new Fr(0xa9059cbbn),
        args: [new Fr(recipient.toBigInt()), new Fr(1_000_000n)],
        isPadding: false,
      },
    ],
    labels: {
      actionClass: 'transfer',
      amount: 1_000_000n,
      amountDecimals: 6,
      tokenSymbol: 'USDC',
      recipient: '0xdeadbeef…1234',
      contractLabel: 'USDC',
    },
  };
}

describe('formatIntentForDevice', () => {
  test('renders a transfer intent with all labels', () => {
    const intent = makeUsdcTransferIntent();
    const display = formatIntentForDevice(intent);
    expect(display).toContain('Transfer 1.0 USDC');
    expect(display).toContain('To: 0xdeadbeef…1234');
    expect(display).toContain('On: USDC');
    expect(display).toContain('Chain ');
    expect(display).toContain('v1');
  });

  test('falls back to "N call(s)" when no actionClass label is supplied', () => {
    const intent = makeUsdcTransferIntent();
    const noLabels: CallIntent = { ...intent, labels: {} };
    const display = formatIntentForDevice(noLabels);
    expect(display).toContain('1 call');
    expect(display).not.toContain('Transfer');
  });

  test('counts non-padding calls only (defends against hidden-call padding attack)', () => {
    const intent = makeUsdcTransferIntent();
    const padded: CallIntent = {
      ...intent,
      labels: {},
      calls: [
        intent.calls[0]!,
        { ...intent.calls[0]!, isPadding: true },
        { ...intent.calls[0]!, isPadding: true },
      ],
    };
    expect(formatIntentForDevice(padded)).toContain('1 call');
  });

  test('appends warnings on their own lines', () => {
    const intent = makeUsdcTransferIntent();
    const withWarnings: CallIntent = {
      ...intent,
      labels: { ...intent.labels, warnings: ['Unverified token', 'Large amount'] },
    };
    const display = formatIntentForDevice(withWarnings);
    expect(display).toContain('! Unverified token');
    expect(display).toContain('! Large amount');
  });
});

describe('computeOuterHashForIntent', () => {
  test('produces a deterministic Fr for the same intent', async () => {
    const intent = makeUsdcTransferIntent();
    const a = await computeOuterHashForIntent(intent);
    const b = await computeOuterHashForIntent(intent);
    expect(a.toString()).toBe(b.toString());
  });

  test('returns a different hash when args change', async () => {
    const intent1 = makeUsdcTransferIntent();
    const intent2: CallIntent = {
      ...intent1,
      calls: [
        {
          ...intent1.calls[0]!,
          // Different amount.
          args: [intent1.calls[0]!.args[0]!, new Fr(2_000_000n)],
        },
      ],
    };
    const a = await computeOuterHashForIntent(intent1);
    const b = await computeOuterHashForIntent(intent2);
    expect(a.toString()).not.toBe(b.toString());
  });

  test('ignores padding calls in the hash (consistent with the display)', async () => {
    const intent = makeUsdcTransferIntent();
    const padded: CallIntent = {
      ...intent,
      calls: [intent.calls[0]!, { ...intent.calls[0]!, isPadding: true }],
    };
    const a = await computeOuterHashForIntent(intent);
    const b = await computeOuterHashForIntent(padded);
    expect(a.toString()).toBe(b.toString());
  });
});
