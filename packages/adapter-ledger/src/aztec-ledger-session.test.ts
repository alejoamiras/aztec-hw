/**
 * AztecLedgerSession structural/contract tests. The full submission recipe
 * needs a real PXE and a deployed Ledger account — those land at M6.5
 * (alpha-testnet e2e). What we CAN cover here:
 *
 *   - The in-flight mutex serializes submissions.
 *   - The `exec.calls.length === 2` shape guard fires on malformed payloads.
 *   - Public address getters return what was passed in.
 *
 * Uses minimal stub objects so the tests don't transitively pull in PXE
 * setup, prover WASM, or device transport.
 */
import { describe, expect, test } from 'bun:test';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ExecutionPayload } from '@aztec/stdlib/tx';

import { AztecLedgerSession, type AztecLedgerSessionDeps } from './aztec-ledger-session.ts';

const ADDR = AztecAddress.fromBigInt(0x1234_5678n);

function stubExec(callCount: number): ExecutionPayload {
  return { calls: Array.from({ length: callCount }, () => ({})) } as unknown as ExecutionPayload;
}

function makeSession(): AztecLedgerSession {
  const deps = {} as AztecLedgerSessionDeps;
  /* Stub the constructor params: CompleteAddress + AccountManager need
   * more setup than this shape-only test deserves. */
  return new AztecLedgerSession(
    deps,
    ADDR,
    ADDR as unknown as ConstructorParameters<typeof AztecLedgerSession>[2],
    {} as unknown as ConstructorParameters<typeof AztecLedgerSession>[3],
  );
}

describe('AztecLedgerSession (shape + mutex)', () => {
  test('address getter returns the address from the constructor', () => {
    const sess = makeSession();
    expect(sess.address.toString()).toBe(ADDR.toString());
  });

  test('rejects payloads with calls.length !== 2', async () => {
    const sess = makeSession();
    await expect(sess.submitClearSignedIntent(stubExec(1))).rejects.toThrow(
      /expects \[sponsor, app\] \(2 calls\); got 1/,
    );
    await expect(sess.submitClearSignedIntent(stubExec(3))).rejects.toThrow(
      /expects \[sponsor, app\] \(2 calls\); got 3/,
    );
  });

  test('in-flight mutex rejects concurrent submissions', async () => {
    const sess = makeSession();
    /* With an empty `deps` stub, the wired runRecipe will throw when it
     * tries to call `deps.session.nodeClient.getNodeInfo()` — that error
     * surfaces asynchronously, which is exactly what we want for the mutex
     * check: it gives us a window where `this.inflight !== null` is true. */
    const first = sess.submitClearSignedIntent(stubExec(2));
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.toThrow(
      /another submission in flight/,
    );
    /* Drain the first promise so the test completes cleanly. */
    await expect(first).rejects.toThrow();
  });

  test('mutex clears after a failed submission (so next call is accepted)', async () => {
    const sess = makeSession();
    /* First call fails inside runRecipe (no real session deps). The mutex
     * must clear so the second call can proceed past the in-flight guard
     * and hit the SAME failure (proves mutex released, not stuck). */
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.toThrow();
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.not.toThrow(
      /another submission in flight/,
    );
  });
});
