/**
 * Project an Aztec `ExecutionPayload` (post fee-merge) into a `CallIntent` —
 * the device-wire shape `LedgerClearSigningEntrypoint` streams to the device.
 *
 * The two shapes are isomorphic for the M5 manifest's verbs — the only
 * shape difference is that ExecutionPayload uses `FunctionCall` (with
 * `to`, `selector`, `args`, `type` enum) while CallIntent uses
 * `StructuredFunctionCall` (with `contractAddress`, `selector` as Fr,
 * `args`, `isPublic` bool).
 *
 * The projection is byte-deterministic — the device-recomputed outer_hash from
 * this CallIntent equals the CANONICAL `EncodedAppEntrypointCalls` /
 * `computeOuterAuthWitHash` over the same calls (proven by l4-manifest-parity.test.ts).
 *
 * For DRIP_PUB the second arg (`amount: u64`) is already an Fr-encoded
 * payload by the time it gets here — the contract interaction encoder
 * handles the u64-into-Fr widening.
 */

import type { CallIntent, ChainInfo, StructuredFunctionCall } from '@alejoamiras/aztec-ledger-core';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { FunctionType } from '@aztec/stdlib/abi';
import type { ExecutionPayload } from '@aztec/stdlib/tx';

export function projectExecutionPayloadIntoCallIntent(
  exec: ExecutionPayload,
  consumer: AztecAddress,
  chainInfo: ChainInfo,
): CallIntent {
  const calls: StructuredFunctionCall[] = exec.calls.map((c) => ({
    contractAddress: c.to,
    selector: c.selector.toField(),
    args: c.args,
    isPadding: false,
    isPublic: c.type === FunctionType.PUBLIC,
    hideMsgSender: c.hideMsgSender,
    isStatic: c.isStatic,
  }));
  return { consumer, chainInfo, calls };
}
