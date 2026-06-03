import { describe, expect, test } from 'bun:test';
import { Fr } from '@alejoamiras/aztec-ledger-core';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { FunctionCall, FunctionSelector, FunctionType } from '@aztec/stdlib/abi';
import type { ExecutionPayload } from '@aztec/stdlib/tx';

import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';

const CONSUMER = AztecAddress.fromBigInt(0xacc0_dead_beefn);
const USDC =
  AztecAddress.fromBigInt(0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5n);
const SPONSOR =
  AztecAddress.fromBigInt(0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257n);
const CHAIN_INFO = { chainId: new Fr(0xaa36a7n), version: new Fr(1n) };

function mkCall(opts: {
  to: AztecAddress;
  selectorU32: number;
  args: Fr[];
  type: FunctionType;
  hideMsgSender?: boolean;
  isStatic?: boolean;
}): FunctionCall {
  return new FunctionCall(
    'name',
    opts.to,
    new FunctionSelector(opts.selectorU32),
    opts.type,
    opts.hideMsgSender ?? false,
    opts.isStatic ?? false,
    opts.args,
    [],
  );
}

function payload(calls: FunctionCall[]): ExecutionPayload {
  return {
    calls,
    authWitnesses: [],
    capsules: [],
    extraHashedArgs: [],
  } as unknown as ExecutionPayload;
}

describe('projectExecutionPayloadIntoCallIntent', () => {
  test('maps a sponsor (private) + transfer (public) pair', () => {
    const exec = payload([
      mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
      mkCall({
        to: USDC,
        selectorU32: 0xc47adea0,
        args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(1_500_000n), new Fr(0n)],
        type: FunctionType.PUBLIC,
      }),
    ]);
    const intent = projectExecutionPayloadIntoCallIntent(exec, CONSUMER, CHAIN_INFO);

    expect(intent.consumer.toString()).toBe(CONSUMER.toString());
    expect(intent.chainInfo.chainId.toBigInt()).toBe(0xaa36a7n);
    expect(intent.calls.length).toBe(2);

    /* Sponsor call: private, no args. */
    expect(intent.calls[0]!.contractAddress.toString()).toBe(SPONSOR.toString());
    expect(intent.calls[0]!.selector.toBigInt()).toBe(0x23d77f89n);
    expect(intent.calls[0]!.isPublic).toBe(false);
    expect(intent.calls[0]!.args.length).toBe(0);
    expect(intent.calls[0]!.isPadding).toBe(false);

    /* App call: TRANSFER_PUB_PUB selector, 4 args, public. */
    expect(intent.calls[1]!.contractAddress.toString()).toBe(USDC.toString());
    expect(intent.calls[1]!.selector.toBigInt()).toBe(0xc47adea0n);
    expect(intent.calls[1]!.isPublic).toBe(true);
    expect(intent.calls[1]!.args.length).toBe(4);
  });

  test('private app call (transfer_private_to_private) is mapped as isPublic=false', () => {
    const exec = payload([
      mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
      mkCall({
        to: USDC,
        selectorU32: 0xfe438afc, // TRANSFER_PRIV_PRIV
        args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(1n), new Fr(0n)],
        type: FunctionType.PRIVATE,
      }),
    ]);
    const intent = projectExecutionPayloadIntoCallIntent(exec, CONSUMER, CHAIN_INFO);
    expect(intent.calls[1]!.isPublic).toBe(false);
  });

  test('propagates hideMsgSender and isStatic flags', () => {
    const exec = payload([
      mkCall({
        to: USDC,
        selectorU32: 1,
        args: [],
        type: FunctionType.PUBLIC,
        hideMsgSender: true,
        isStatic: true,
      }),
    ]);
    const intent = projectExecutionPayloadIntoCallIntent(exec, CONSUMER, CHAIN_INFO);
    expect(intent.calls[0]!.hideMsgSender).toBe(true);
    expect(intent.calls[0]!.isStatic).toBe(true);
  });

  test('empty exec.calls projects to empty intent.calls', () => {
    const exec = payload([]);
    const intent = projectExecutionPayloadIntoCallIntent(exec, CONSUMER, CHAIN_INFO);
    expect(intent.calls.length).toBe(0);
  });
});
