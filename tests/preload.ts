/**
 * bun:test preload. Polyfills the Jest-specific `expect.addEqualityTesters`
 * method that `@aztec/foundation` invokes at module load (its `Fr.areFieldsEqual`
 * tester registration). Without this, importing anything that transitively pulls
 * `@aztec/foundation/curves/bn254` from a `bun:test` file throws at evaluation.
 *
 * Polyfill is a no-op: bun:test's `expect` doesn't honor extra equality testers,
 * but deep equality already handles `Fr` instances correctly via their `value` field.
 */

import { expect } from 'bun:test';

type PartialExpect = { addEqualityTesters?: (testers: unknown[]) => void };
const e = expect as unknown as PartialExpect;
if (typeof e.addEqualityTesters !== 'function') {
  e.addEqualityTesters = () => {
    /* no-op shim */
  };
}
