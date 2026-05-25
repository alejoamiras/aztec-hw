import { describe, expect, test } from 'bun:test';
import type { AuthWitnessProvider } from '@aztec/entrypoints/interfaces';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AuthWitness } from '@aztec/stdlib/auth-witness';
import type { CallIntent, IntentAuthWitnessProvider } from './index.ts';
import { isIntentAuthWitnessProvider } from './provider.ts';

const stubAuthWit = (msg: Fr) => new AuthWitness(msg, []);

class LegacyOnlyProvider implements AuthWitnessProvider {
  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const fr = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(messageHash);
    return stubAuthWit(fr);
  }
}

class IntentAwareProvider implements IntentAuthWitnessProvider {
  async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
    const fr = messageHash instanceof Fr ? messageHash : Fr.fromBuffer(messageHash);
    return stubAuthWit(fr);
  }
  async createAuthWitFromIntent(_intent: CallIntent): Promise<AuthWitness> {
    return stubAuthWit(Fr.ZERO);
  }
}

describe('isIntentAuthWitnessProvider', () => {
  test('detects intent-aware providers', () => {
    const p = new IntentAwareProvider();
    expect(isIntentAuthWitnessProvider(p)).toBe(true);
  });

  test('rejects legacy-only providers', () => {
    const p = new LegacyOnlyProvider();
    expect(isIntentAuthWitnessProvider(p)).toBe(false);
  });
});
