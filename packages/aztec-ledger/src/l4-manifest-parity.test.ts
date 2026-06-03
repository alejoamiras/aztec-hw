/**
 * P1 parity test — host-vs-device outer_hash parity against the INSTALLED @aztec (4.2.1).
 *
 * The production signing path (`LedgerClearSigningEntrypoint`) signs the CANONICAL
 * outer_hash derived from `@aztec/entrypoints/encoding`'s `EncodedAppEntrypointCalls`;
 * the device independently recomputes the outer_hash from the wire stream and rejects on
 * mismatch (SW_HASH_MISMATCH). This test proves the device's algorithm — mirrored
 * host-side by `deviceOuterHashForIntent` (the `l4/parity.c` 31-field payload) — equals
 * that canonical hash. It is the CI-time replacement for the old runtime assert that
 * compared an in-line replica pinned to an aztec-packages commit; now there is no pin —
 * we verify against whatever `@aztec/*` is installed (4.2.1).
 */
import { describe, expect, test } from 'bun:test';
import { Fr } from '@alejoamiras/aztec-ledger-core';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EncodedAppEntrypointCalls } from '@aztec/entrypoints/encoding';
import { FunctionCall, FunctionSelector, FunctionType } from '@aztec/stdlib/abi';
import { computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
import type { ExecutionPayload } from '@aztec/stdlib/tx';

import { defaultAztecPath } from './apdu.ts';
import { deviceOuterHashForIntent } from './l4-manifest.ts';
import { projectExecutionPayloadIntoCallIntent } from './project-call-intent.ts';

const CONSUMER = AztecAddress.fromBigInt(0xacc0_dead_beefn);
const USDC =
  AztecAddress.fromBigInt(0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5n);
const SPONSOR =
  AztecAddress.fromBigInt(0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257n);
const CHAIN_INFO = { chainId: new Fr(0xaa36a7n), version: new Fr(1n) };
const PATH = defaultAztecPath(0);

function mkCall(opts: {
  to: AztecAddress;
  selectorU32: number;
  args: Fr[];
  type: FunctionType;
}): FunctionCall {
  return new FunctionCall(
    'name',
    opts.to,
    new FunctionSelector(opts.selectorU32),
    opts.type,
    false,
    false,
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

/** Canonical outer_hash exactly as `LedgerClearSigningEntrypoint` derives it. */
async function canonicalOuterHash(exec: ExecutionPayload, txNonce: Fr): Promise<Fr> {
  const encoded = await EncodedAppEntrypointCalls.create(exec.calls, txNonce);
  const payloadHash = await encoded.hash();
  return computeOuterAuthWitHash(CONSUMER, CHAIN_INFO.chainId, CHAIN_INFO.version, payloadHash);
}

describe('l4-manifest parity — device algorithm == canonical EncodedAppEntrypointCalls (4.2.1)', () => {
  /* The two real fee-merged shapes: [sponsor(private), app-call]. */
  const cases: Array<{ name: string; exec: ExecutionPayload }> = [
    {
      name: 'sponsor(private) + transfer_public_to_public (public, 4 args)',
      exec: payload([
        mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
        mkCall({
          to: USDC,
          selectorU32: 0xc47adea0,
          args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(1_500_000n), new Fr(0n)],
          type: FunctionType.PUBLIC,
        }),
      ]),
    },
    {
      name: 'sponsor(private) + transfer_private_to_private (private, 4 args)',
      exec: payload([
        mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
        mkCall({
          to: USDC,
          selectorU32: 0xfe438afc,
          args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(1n), new Fr(0n)],
          type: FunctionType.PRIVATE,
        }),
      ]),
    },
    {
      name: 'sponsor(private) + transfer_public_to_private (public, 4 args)',
      exec: payload([
        mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
        mkCall({
          to: USDC,
          selectorU32: 0x1f3b2c4d,
          args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(7n), new Fr(0n)],
          type: FunctionType.PUBLIC,
        }),
      ]),
    },
    {
      name: 'sponsor(private) + transfer_private_to_public (private, 4 args)',
      exec: payload([
        mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
        mkCall({
          to: USDC,
          selectorU32: 0x9a8b7c6d,
          args: [CONSUMER.toField(), new Fr(0xabcdn), new Fr(3n), new Fr(0n)],
          type: FunctionType.PRIVATE,
        }),
      ]),
    },
    {
      name: 'sponsor(private) + drip_to_public (public, 2 args)',
      exec: payload([
        mkCall({ to: SPONSOR, selectorU32: 0x23d77f89, args: [], type: FunctionType.PRIVATE }),
        mkCall({
          to: USDC,
          selectorU32: 0x5e6f7081,
          args: [USDC.toField(), new Fr(1_000_000_000n)],
          type: FunctionType.PUBLIC,
        }),
      ]),
    },
    {
      /* B3 shape: zero real calls (all padding) — the consumer-binding test's payload. */
      name: 'zero-call (B3 shape, all padding)',
      exec: payload([]),
    },
  ];

  for (const { name, exec } of cases) {
    test(name, async () => {
      const txNonce = new Fr(0x1234_5678_9abcn);
      const intent = projectExecutionPayloadIntoCallIntent(exec, CONSUMER, CHAIN_INFO);
      const device = await deviceOuterHashForIntent({
        intent,
        bip32Path: PATH,
        txNonce: txNonce.toBuffer(),
      });
      const canonical = await canonicalOuterHash(exec, txNonce);
      expect(Buffer.from(device).toString('hex')).toBe(canonical.toBuffer().toString('hex'));
    });
  }
});
