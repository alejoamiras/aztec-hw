/**
 * AHW-064 — the canonical-path gate now covers the dangerous key-using surfaces.
 *
 * The raw-hash blind sign + the pubkey exports used to accept ANY 1..10-component
 * path while only the L4 handlers enforced m/44'/AZTEC'/account'/0/0. A shared
 * az_bip32_path_is_canonical() now gates all of them. This proves the two
 * host-reachable weak surfaces (GET_PUBLIC_KEY, SIGN_OUTER_HASH) reject a
 * non-canonical path with SW_INVALID_PATH_SCHEME (0x6F03). The Schnorr pubkey
 * surface uses the same shared helper (build-verified). For SIGN_OUTER_HASH the
 * path check runs BEFORE the blind_signing gate, so it rejects regardless of toggle.
 *
 *   SPECULOS_URL=http://localhost:5005 bun test packages/adapter-ledger/src/canonical-path.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { AZTEC_COIN_TYPE_HARDENED, hardened } from './apdu.ts';
import { LedgerProvider } from './provider.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;

/* Length-5 but NON-canonical: the account component is NOT hardened (would let a
 * caller derive under an unintended account index). Fails az_bip32_path_is_canonical. */
const NON_CANONICAL = [hardened(44), AZTEC_COIN_TYPE_HARDENED, 0x0000_0000, 0, 0];

describe.skipIf(!SPECULOS_URL)('AHW-064 — canonical-path gate on key-using surfaces', () => {
  const transport = new SpeculosTransport({
    baseUrl: SPECULOS_URL ?? 'http://localhost:5005',
    timeoutMs: 30_000,
  });
  const provider = new LedgerProvider(transport);

  test('GET_PUBLIC_KEY rejects a non-canonical path with SW_INVALID_PATH_SCHEME', async () => {
    await expect(provider.getPublicKey(NON_CANONICAL)).rejects.toThrow('SW=0x6f03');
  });

  test('SIGN_OUTER_HASH rejects a non-canonical path (before the blind-signing gate)', async () => {
    await expect(
      provider.signOuterHash(NON_CANONICAL, new Uint8Array(32).fill(0x42), {
        autoConfirm: async () => {},
      }),
    ).rejects.toThrow('SW=0x6f03');
  });
});
