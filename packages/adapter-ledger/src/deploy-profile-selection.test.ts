/**
 * M12 P1 — pins the generated deploy-profile metadata that the host's scheme →
 * profile-id resolution depends on (aztec-ledger-session.ts: DEPLOY_PROFILE_BY_SCHEME
 * + csDeployProfileLookup, fail-closed on a miss). If the codegen ever renumbers
 * `profile_index`, this fails — the regression guard that replaced the hardcoded
 * `isSchnorr ? 1 : 0` (which would have silently signed the wrong template).
 *
 * The scheme → id map itself is a typed string-union (a codegen rename is a COMPILE
 * error), so the runtime risk is purely the id → index contract pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { csDeployProfileLookup } from './clear_signing_v0/deploy_profiles.generated.ts';

describe('M12 P1 — deploy profile-id from generated metadata', () => {
  test('ECDSA-K profile resolves to index 0', () => {
    expect(csDeployProfileLookup('DEPLOY_ACCOUNT_ECDSAK_V1')?.profile_index).toBe(0);
  });

  test('Schnorr profile resolves to index 1', () => {
    expect(csDeployProfileLookup('DEPLOY_ACCOUNT_SCHNORR_V1')?.profile_index).toBe(1);
  });

  test('unknown id fails closed (undefined → host throws pre-flight)', () => {
    // @ts-expect-error — intentionally invalid id; the lookup must not match.
    expect(csDeployProfileLookup('DEPLOY_ACCOUNT_NONEXISTENT')).toBeUndefined();
  });
});
