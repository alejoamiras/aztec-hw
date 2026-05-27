/**
 * Project an Aztec `ExecutionPayload` (post fee-merge) into a `CallIntent`
 * that our `createAuthWitFromIntent` accepts.
 *
 * The two shapes are isomorphic for the M5 manifest's verbs — the only
 * shape difference is that ExecutionPayload uses `FunctionCall` (with
 * `to`, `selector`, `args`, `type` enum) while CallIntent uses
 * `StructuredFunctionCall` (with `contractAddress`, `selector` as Fr,
 * `args`, `isPublic` bool).
 *
 * The projection is byte-deterministic — i.e. the device-recomputed
 * outer_hash from this CallIntent equals Aztec's
 * `computeOuterAuthWitHash(...)` over the same calls. M5's L4.1 14/14
 * host-parity tests cover this end-to-end.
 *
 * For DRIP_PUB the second arg (`amount: u64`) is already an Fr-encoded
 * payload by the time it gets here — the contract interaction encoder
 * handles the u64-into-Fr widening.
 */

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { FunctionType } from '@aztec/stdlib/abi';
import type { ExecutionPayload } from '@aztec/stdlib/tx';
import type { CallIntent, ChainInfo, StructuredFunctionCall } from '@aztec-hwwallet-poc/core';

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
  /* Diagnostic: dump every call's address + selector so the host log
   * gives us the exact bytes when the device's strict-allowlist rejects.
   * Surfaced during transfer-mode debugging — the framework occasionally
   * routes calls through wrapper functions we haven't pinned. */
  if (typeof globalThis !== 'undefined' && (globalThis as { console?: Console }).console) {
    const lines = calls
      .map(
        (c, i) =>
          `  [${i}] ${c.contractAddress.toString()} sel=${c.selector.toString()} args=${c.args.length} pub=${c.isPublic}`,
      )
      .join('\n');
    console.log(`[projectCallIntent] consumer=${consumer.toString()} calls:\n${lines}`);
  }
  return { consumer, chainInfo, calls };
}
