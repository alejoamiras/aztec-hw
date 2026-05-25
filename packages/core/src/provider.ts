/**
 * Proposed Option A extension to `AuthWitnessProvider`.
 *
 * From `../../../aztec-hardware-wallet/architectures/02-clear-signing-interface.md`:
 * "The only design that structurally prevents lazy adapters from shipping blind-signing
 * while keeping legacy adapters intact" (T6 finding).
 *
 * Adapters opt in to clear-signing by implementing `createAuthWitFromIntent`. Adapters
 * that don't yet support clear-signing can delegate to `createAuthWit(messageHash)`
 * after deriving the hash from the intent themselves — or simply throw.
 *
 * Once the Aztec SDK accepts this extension upstream, this file's content can be replaced
 * by a re-export from `@aztec/entrypoints/interfaces`.
 */

import type { AuthWitness, AuthWitnessProvider } from './index.ts';
import type { CallIntent } from './intent.ts';

export interface IntentAuthWitnessProvider extends AuthWitnessProvider {
  /**
   * Compute an auth witness from a structured `CallIntent`. The device receives the
   * intent, recomputes `outer_hash` locally, displays human-meaningful fields,
   * and refuses to sign if the recomputed hash doesn't match the host-supplied one.
   */
  createAuthWitFromIntent(intent: CallIntent): Promise<AuthWitness>;
}

/**
 * Capability check: is this provider intent-aware?
 *
 * Adapters that opt in to clear-signing implement `IntentAuthWitnessProvider`.
 * Callers should prefer `createAuthWitFromIntent` when this returns true,
 * and fall back to the messageHash path when false.
 */
export function isIntentAuthWitnessProvider(
  provider: AuthWitnessProvider,
): provider is IntentAuthWitnessProvider {
  return (
    typeof (provider as Partial<IntentAuthWitnessProvider>).createAuthWitFromIntent === 'function'
  );
}
