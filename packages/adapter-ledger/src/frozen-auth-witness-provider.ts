/**
 * One-shot, hash-asserted AuthWitnessProvider.
 *
 * The framework's account-entrypoint path (account_entrypoint.ts:131) calls
 * `provider.createAuthWit(messageHash)` where `messageHash` is the framework-
 * computed outer_hash. When we pre-sign on the Ledger ahead of `sendTx`, we
 * already have a witness in hand — but we need to USE it from inside the
 * framework's pipeline, which only knows how to call `createAuthWit(...)`.
 *
 * This provider:
 *  1. Holds the pre-signed AuthWitness.
 *  2. On `createAuthWit(framework_hash)`, asserts `framework_hash` matches
 *     the hash we pre-signed for; throws loudly on mismatch.
 *  3. Returns the frozen witness, then marks itself used. Any second call
 *     throws.
 *
 * The hash-match assertion is the safety net. If the framework computes a
 * different outer_hash than what we pre-signed (e.g. because of a regression
 * in account_entrypoint or because the caller passed a different
 * ExecutionPayload than what was hashed during pre-sign), this provider
 * REFUSES to hand over the witness — the alternative would be to silently
 * sign a tx the user didn't approve.
 *
 * codex M5 finding: account_entrypoint.ts:80 does `salt: Fr.random()` on the
 * TxExecutionRequest itself but does NOT include that salt in
 * `payloadHash` (line 139 uses `encodedCalls.hash()` only). So as of v4.2.x
 * the request-level salt is invisible to the witness; should that change,
 * this provider's mismatch check is the canary.
 */

import type { AuthWitnessProvider } from '@aztec/aztec.js/account';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';
import type { Fr } from '@aztec-hwwallet-poc/core';

export class FrozenWitnessUsedError extends Error {
  constructor() {
    super('FrozenAuthWitnessProvider already consumed; one-shot only');
    this.name = 'FrozenWitnessUsedError';
  }
}

export class FrozenWitnessMismatchError extends Error {
  constructor(
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(
      `FrozenAuthWitnessProvider: framework requested hash ${actualHash} but ` +
        `pre-signed witness is for ${expectedHash}. Refusing to hand over the ` +
        `witness. This usually means the ExecutionPayload changed between ` +
        `pre-sign and submission, or the framework's outer_hash computation ` +
        `drifted from our buildL4Manifest (check ` +
        `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts).`,
    );
    this.name = 'FrozenWitnessMismatchError';
  }
}

export class FrozenAuthWitnessProvider implements AuthWitnessProvider {
  private used = false;

  /**
   * @param frozen          The pre-signed AuthWitness from the Ledger.
   * @param expectedHashFr  The Fr we pre-signed FOR. The framework's
   *                        eventual `createAuthWit(messageHash)` MUST match.
   */
  constructor(
    private readonly frozen: AuthWitness,
    private readonly expectedHashFr: Fr,
  ) {}

  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    if (this.used) throw new FrozenWitnessUsedError();
    const actualHex = fmtHash(messageHash);
    const expectedHex = fmtHash(this.expectedHashFr);
    if (actualHex !== expectedHex) {
      throw new FrozenWitnessMismatchError(expectedHex, actualHex);
    }
    this.used = true;
    return this.frozen;
  }
}

/** Normalize Fr | Buffer → 0x-prefixed 64-hex string for byte-equal comparison. */
function fmtHash(h: Fr | Buffer): string {
  if (Buffer.isBuffer(h)) {
    return `0x${h.toString('hex').padStart(64, '0')}`;
  }
  return `0x${h.toBuffer().toString('hex').padStart(64, '0')}`;
}
