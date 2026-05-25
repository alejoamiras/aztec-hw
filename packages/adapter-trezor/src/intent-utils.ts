/**
 * Helpers to take a structured `CallIntent` and turn it into the two bytes the
 * device sees on a `SignIdentity` call:
 *
 *   - `challenge_hidden` (32 B): `sha256(outer_hash.to_be_bytes())` — what's actually signed.
 *     The `outer_hash` is computed host-side via Aztec's own
 *     `computeInnerAuthWitHash` + `computeOuterAuthWitHash`.
 *   - `challenge_visual` (string): human-meaningful summary derived from `intent.labels`
 *     for the device's confirmation screen.
 *
 * **Piece 1 of Phase B is decorative clear-signing**: the device DISPLAYS the human
 * fields, but does NOT itself recompute the hash from those fields. A malicious host
 * could in principle show a benign visual while signing a malicious digest. The full
 * cryptographic binding requires Poseidon2 implemented on-device (Phase B.2 / firmware).
 * Adapter callers MUST treat decorative clear-signing as an INTERNAL-only UX upgrade
 * over blind-signing, not a security-grade authorization channel.
 */

import {
  type AztecAddress,
  type CallIntent,
  computeInnerAuthWitHash,
  computeOuterAuthWitHash,
  Fr,
  type IntentLabels,
  type StructuredFunctionCall,
} from '@aztec-hwwallet-poc/core';

/**
 * Derive Aztec's `outer_hash` from a structured intent.
 *
 * `inner_hash = computeInnerAuthWitHash(flat)` where `flat` is the non-padding calls
 * laid out as `[contractAddress, selector, ...args]` per call. Then
 * `outer_hash = computeOuterAuthWitHash(consumer, chainId, version, inner_hash)`.
 *
 * The exact flattening MUST match what the Aztec entrypoint computes for the same
 * call stack — otherwise the device signs a different hash than the verifier expects.
 * The form used here mirrors `computeInnerAuthWitHash`'s general "hash arbitrary
 * field-element array" use case, which is fine for the PoC demo but DIFFERS from
 * `EncodedAppEntrypointCalls.hash()` used by the real account entrypoint. Closing
 * that gap is a Phase-B-final step (need to import the entrypoint's encoding util).
 */
export async function computeOuterHashForIntent(intent: CallIntent): Promise<Fr> {
  const flat: Fr[] = [];
  for (const call of intent.calls) {
    if (call.isPadding) continue;
    flat.push(addressAsField(call.contractAddress));
    flat.push(call.selector);
    for (const arg of call.args) flat.push(arg);
  }
  const innerHash = await computeInnerAuthWitHash(flat);
  return computeOuterAuthWitHash(
    intent.consumer,
    intent.chainInfo.chainId,
    intent.chainInfo.version,
    innerHash,
  );
}

/**
 * Convert an `AztecAddress` into the `Fr` element representing its scalar value.
 * `AztecAddress` extends Fr (it's a field element under the hood) — we just need a
 * stable conversion path that works with `computeInnerAuthWitHash`'s `Fr[]` input.
 */
function addressAsField(address: AztecAddress): Fr {
  return new Fr(address.toBigInt());
}

/**
 * Format an intent into the multi-line string shown on the Trezor confirmation screen.
 *
 * Trezor's `challenge_visual` is rendered as plain text under the GPG-signing
 * confirmation header. Model T (T2T1) emulator shows ~6 lines comfortably; we stay
 * under that. Bigger screens (Safe 5 / Stax-equivalent) tolerate more.
 *
 * Layout (line by line):
 *   1. Action class + amount + symbol (e.g. "Transfer 1.0 USDC")
 *   2. "To: <recipient>"  (omitted if no label)
 *   3. "On: <contractLabel>"  (omitted if no label)
 *   4. "Chain <chainIdTruncated> v<version>"
 *   5+. warnings, one per line, prefixed "!"
 *
 * The visual banner from the provider (e.g. INTERNAL warning) is prepended by the
 * provider, not here — this function returns just the intent-summary lines.
 */
export function formatIntentForDevice(intent: CallIntent): string {
  const lines: string[] = [];
  const labels: IntentLabels = intent.labels ?? {};

  lines.push(buildActionLine(intent, labels));
  if (labels.recipient) lines.push(`To: ${labels.recipient}`);
  if (labels.contractLabel) lines.push(`On: ${labels.contractLabel}`);
  lines.push(
    `Chain ${truncateFr(intent.chainInfo.chainId)} v${intent.chainInfo.version.toBigInt()}`,
  );
  if (labels.warnings) {
    for (const warning of labels.warnings) lines.push(`! ${warning}`);
  }
  return lines.join('\n');
}

function buildActionLine(intent: CallIntent, labels: IntentLabels): string {
  const realCallCount = intent.calls.filter((c) => !c.isPadding).length;
  if (!labels.actionClass) {
    return `${realCallCount} call${realCallCount === 1 ? '' : 's'}`;
  }
  const action = labels.actionClass.charAt(0).toUpperCase() + labels.actionClass.slice(1);
  if (labels.amount !== undefined) {
    const formatted = formatAmount(labels.amount, labels.amountDecimals ?? 0);
    return labels.tokenSymbol
      ? `${action} ${formatted} ${labels.tokenSymbol}`
      : `${action} ${formatted}`;
  }
  return action;
}

function formatAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const factor = 10n ** BigInt(decimals);
  const whole = amount / factor;
  const frac = amount % factor;
  if (frac === 0n) return `${whole}.0`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}.0`;
}

/** Truncate a Field to "0xab…cd" for compact on-screen display. */
function truncateFr(fr: Fr): string {
  const hex = fr.toString();
  // Fr.toString() begins with "0x"; account for it in slicing.
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** Re-exported for convenience in tests / demo. */
export type { CallIntent, StructuredFunctionCall };
