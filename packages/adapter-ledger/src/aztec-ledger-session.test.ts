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
  /* CompleteAddress requires more setup than worth here; use ADDR twice. */
  return new AztecLedgerSession(
    deps,
    ADDR,
    ADDR as unknown as Parameters<typeof AztecLedgerSession>[2],
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
    /* runRecipe stub throws "wired in M6.3.next" — that resolves the mutex,
     * so we need to start the first submission and check the second BEFORE
     * the first rejects. Use a fresh promise we control via the call-count
     * branch: kick off the first submission (it will hang briefly because
     * await chains through Promise.resolve), then race a second submission
     * against the mutex check.
     *
     * Cleaner alternative: monkey-patch runRecipe to pause. Skip that and
     * just rely on microtask ordering: an immediate second call after the
     * first IS inside the same tick, so this.inflight is set. */
    const first = sess.submitClearSignedIntent(stubExec(2));
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.toThrow(
      /another submission in flight/,
    );
    /* Drain the first to clean state; the stubbed runRecipe rejects. */
    await expect(first).rejects.toThrow(/wired in M6.3.next/);
  });

  test('mutex clears after a failed submission (so next call is accepted)', async () => {
    const sess = makeSession();
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.toThrow(/wired in M6.3.next/);
    /* Second call should not see "in flight" — it should hit the runRecipe
     * stub error, proving the mutex was released. */
    await expect(sess.submitClearSignedIntent(stubExec(2))).rejects.toThrow(/wired in M6.3.next/);
  });
});
