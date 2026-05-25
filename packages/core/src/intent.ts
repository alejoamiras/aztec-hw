/**
 * Structured Aztec transaction intent that a hardware-wallet signer can clear-sign.
 *
 * The shape is the proposed Option A input from
 * `../../../aztec-hardware-wallet/architectures/02-clear-signing-interface.md`.
 *
 * Adapters consuming this:
 * 1. Send the intent to the device.
 * 2. The device recomputes the Aztec `outer_hash` (Poseidon-based) from the intent.
 * 3. The device compares the recomputed hash against the host-supplied one.
 * 4. The device displays the human-meaningful fields (action class, amount, recipient).
 * 5. The device refuses to sign if hashes don't match.
 *
 * Until Aztec ships the upstream interface extension, adapters that don't yet
 * support clear-signing fall back to `createAuthWit(messageHash)`.
 */

import type { AztecAddress, ChainInfo, Fr } from './index.ts';

export interface CallIntent {
  /** Account contract address that will consume this auth witness. */
  readonly consumer: AztecAddress;
  /** Chain id + protocol version (replay protection). */
  readonly chainInfo: ChainInfo;
  /** Calls being authorized. Padding slots have `isPadding=true`; device MUST count non-padding. */
  readonly calls: readonly StructuredFunctionCall[];
  /** Optional human-meaningful labels for on-device display. */
  readonly labels?: IntentLabels;
}

export interface StructuredFunctionCall {
  readonly contractAddress: AztecAddress;
  /** 4-byte function selector packed as an Fr field element. */
  readonly selector: Fr;
  /** Encoded args (already field-encoded by the entrypoint). */
  readonly args: readonly Fr[];
  /**
   * `true` if this slot is `FunctionCall.empty()` padding (per Aztec's APP_MAX_CALLS=5 convention).
   * Devices MUST count non-padding entries instead of just trusting the displayed list,
   * to defend against a host hiding extra calls behind padding (T6 adversarial finding).
   */
  readonly isPadding: boolean;
}

/** Pre-resolved human-readable fields for on-device display. Host-provided, device-verified. */
export interface IntentLabels {
  readonly actionClass?: ActionClass;
  /** Asset amount in the smallest unit (e.g. atomic, no decimals applied). */
  readonly amount?: bigint;
  /** Number of decimals for `amount` display. */
  readonly amountDecimals?: number;
  readonly tokenSymbol?: string;
  /** Pre-resolved recipient label (ENS-equivalent / contact-book entry). */
  readonly recipient?: string;
  /** Pre-resolved contract label (from a canonical registry, if available). */
  readonly contractLabel?: string;
  /** Free-form risk warnings shown verbatim on-device. Keep short. */
  readonly warnings?: readonly string[];
}

export type ActionClass = 'transfer' | 'approve' | 'mint' | 'burn' | 'deploy-account' | 'arbitrary';
