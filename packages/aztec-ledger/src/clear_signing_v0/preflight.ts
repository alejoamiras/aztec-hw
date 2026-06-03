/**
 * Host-side preflight that mirrors the device's M5.2 strict-allowlist gates.
 *
 * Fails fast on obviously-invalid intents BEFORE we burn APDU round-trips on
 * the device. Same set of rejection rules, but with ergonomic JS Error
 * messages instead of opaque 0x6F0x SWs. Device remains the final authority —
 * the adapter never trusts the preflight result; it just surfaces a cleaner
 * developer experience when an intent is structurally wrong.
 */

import type { CallIntent, StructuredFunctionCall } from '@alejoamiras/aztec-ledger-core';
import type { AztecAddress } from '@aztec/aztec.js/addresses';

import { CS_REGISTRY, type CsRegistryEntry, csRegistryLookup } from './registry.generated.ts';
import { CS_VERBS, type CsVerbEntry, csVerbLookup } from './selectors.generated.ts';

export interface PreflightDecodedCall {
  readonly call: StructuredFunctionCall;
  readonly registryEntry: CsRegistryEntry;
  readonly verbEntry: CsVerbEntry;
}

/**
 * Preflight every real call in the intent. Throws a typed error on the first
 * problem; otherwise returns one decoded entry per non-padding call (useful
 * for adapter-side logging and host-rendering, e.g. "about to sign Transfer
 * 1.5 USDC ...").
 */
export function preflightIntent(intent: CallIntent): PreflightDecodedCall[] {
  const out: PreflightDecodedCall[] = [];
  let realIdx = 0;
  for (const call of intent.calls) {
    if (call.isPadding) continue;
    const decoded = preflightCall(call, intent.consumer, realIdx);
    out.push(decoded);
    realIdx++;
  }
  return out;
}

function preflightCall(
  call: StructuredFunctionCall,
  consumer: AztecAddress,
  index: number,
): PreflightDecodedCall {
  /* 1. Registry lookup by contract address. */
  const targetHex = `0x${call.contractAddress.toField().toBuffer().toString('hex')}`;
  const registryEntry = csRegistryLookup(targetHex);
  if (!registryEntry) {
    const known = CS_REGISTRY.filter((e) => e.kind !== 'EMPTY')
      .map((e) => `${e.symbol}=${e.address}`)
      .join(', ');
    throw new PreflightError(
      `call ${index}: contract ${targetHex} not in clear-signing registry (would be rejected as SW_REGISTRY_MISS). ` +
        `Registered: ${known}`,
      'SW_REGISTRY_MISS',
      index,
    );
  }
  if (registryEntry.kind === 'EMPTY') {
    throw new PreflightError(
      `call ${index}: matched an EMPTY registry slot (impossible state)`,
      'SW_REGISTRY_MISS',
      index,
    );
  }

  /* 2. Selector → verb lookup, scoped to the matched contract kind. */
  const selectorU32 = Number(call.selector.toBigInt() & 0xffff_ffffn);
  const verbEntry = csVerbLookup(registryEntry.kind, selectorU32);
  if (!verbEntry) {
    const knownSelectors = CS_VERBS.filter((v) => v.kind === registryEntry.kind)
      .map((v) => `${v.verb}=0x${v.selector_u32.toString(16)}`)
      .join(', ');
    throw new PreflightError(
      `call ${index}: selector 0x${selectorU32.toString(16)} not in CS_VERBS for kind=${registryEntry.kind} (would be SW_DECODER_MISS). ` +
        `Registered verbs: ${knownSelectors}`,
      'SW_DECODER_MISS',
      index,
    );
  }

  /* 3. arg_count check. */
  if (call.args.length !== verbEntry.wire_arg_count) {
    throw new PreflightError(
      `call ${index} (${verbEntry.verb}): wire arg count ${call.args.length} != expected ${verbEntry.wire_arg_count} (would be SW_DECODER_DESYNC)`,
      'SW_DECODER_DESYNC',
      index,
    );
  }

  /* 4. visibility check. */
  const callIsPublic = call.isPublic ?? true;
  if (callIsPublic !== verbEntry.is_public) {
    throw new PreflightError(
      `call ${index} (${verbEntry.verb}): isPublic=${callIsPublic} doesn't match verb is_public=${verbEntry.is_public} (would be SW_VISIBILITY_MISMATCH)`,
      'SW_VISIBILITY_MISMATCH',
      index,
    );
  }

  /* 5. `from == consumer` for 4-arg TRANSFER_* verbs. */
  const is4ArgTransfer =
    verbEntry.verb === 'TRANSFER_PRIV_PUB' ||
    verbEntry.verb === 'TRANSFER_PRIV_PRIV' ||
    verbEntry.verb === 'TRANSFER_PUB_PRIV' ||
    verbEntry.verb === 'TRANSFER_PUB_PUB';
  if (is4ArgTransfer) {
    const fromArg = call.args[0];
    if (!fromArg) {
      throw new PreflightError(
        `call ${index} (${verbEntry.verb}): missing 'from' arg`,
        'SW_DECODER_DESYNC',
        index,
      );
    }
    const consumerField = consumer.toField();
    if (fromArg.toBigInt() !== consumerField.toBigInt()) {
      throw new PreflightError(
        `call ${index} (${verbEntry.verb}): args[0] (from)=0x${fromArg.toBigInt().toString(16)} ` +
          `!= consumer=0x${consumerField.toBigInt().toString(16)} (would be SW_DELEGATED_SPEND_UNSUPPORTED). ` +
          `Clear-signing v0 only supports self-transfers; delegated spend will land in a future arc.`,
        'SW_DELEGATED_SPEND_UNSUPPORTED',
        index,
      );
    }
  }

  /* 6. DRIP_PUB: args[0] (the token address) MUST resolve to a TOKEN-kind registry
   * slot. AHW-041: this is now enforced on BOTH sides — append_call.c rejects a
   * non-TOKEN args[0] with SW_REGISTRY_MISS (post-impl codex MED), and this host
   * preflight rejects it earlier for a clear TS error instead of an opaque device SW.
   * (The device's primary authority is still the outer_hash recompute + B3.) */
  if (verbEntry.verb === 'DRIP_PUB') {
    const tokenArg = call.args[0];
    if (!tokenArg) {
      throw new PreflightError(
        `call ${index} (DRIP_PUB): missing token arg`,
        'SW_DECODER_DESYNC',
        index,
      );
    }
    const tokenHex = `0x${tokenArg.toBuffer().toString('hex').padStart(64, '0')}`;
    const tokenEntry = csRegistryLookup(tokenHex);
    if (!tokenEntry || tokenEntry.kind !== 'TOKEN') {
      const knownTokens = CS_REGISTRY.filter((e) => e.kind === 'TOKEN')
        .map((e) => `${e.symbol}=${e.address}`)
        .join(', ');
      throw new PreflightError(
        `call ${index} (DRIP_PUB): args[0] (token)=${tokenHex} is not a TOKEN-kind ` +
          `registry slot (would be SW_REGISTRY_MISS). Known TOKEN slots: ${knownTokens}`,
        'SW_REGISTRY_MISS',
        index,
      );
    }
  }

  return { call, registryEntry, verbEntry };
}

export class PreflightError extends Error {
  constructor(
    message: string,
    public readonly deviceSwCode:
      | 'SW_REGISTRY_MISS'
      | 'SW_DECODER_MISS'
      | 'SW_DECODER_DESYNC'
      | 'SW_VISIBILITY_MISMATCH'
      | 'SW_DELEGATED_SPEND_UNSUPPORTED',
    public readonly callIndex: number,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}
