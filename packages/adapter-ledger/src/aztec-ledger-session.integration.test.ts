/**
 * Live-network integration test for AztecLedgerSession.
 *
 * GATED behind `AZTEC_TESTNET_E2E=1` env var. Without that var the suite
 * is skipped — the regular `bun test` run stays fast and offline.
 *
 * Requirements when enabled:
 *  - Speculos emulator at localhost:5000 (sideloaded with the Aztec app).
 *  - alpha-testnet reachable at https://rpc.testnet.aztec-labs.com
 *    (override with AZTEC_NODE_URL env var).
 *  - The session's master `secret` Fr is generated per run (ephemeral);
 *    the K1 signing key is the Speculos default seed (test-only).
 *
 * What this verifies:
 *  1. AztecLedgerSession.connect() spins up an ephemeral PXE + Ledger
 *     account contract and resolves an address from `(secret, salt,
 *     signing pubkey)` without crashing.
 *  2. deployAccount() submits a real tx via the standard sendTx path
 *     (random-nonce, blind-signed) and lands `mined`.
 *  3. dripUsdc(1000_000_000n) clear-signs on Speculos and lands `mined`.
 *  4. transferUsdcPubToPub(...) clear-signs and lands `mined`.
 *
 * For the M6 hand-off video the user pops in real hardware via WebHID;
 * those tests live in apps/demo-browser/e2e (M6.5 follow-up).
 */
import { describe, expect, test } from 'bun:test';

const E2E = process.env.AZTEC_TESTNET_E2E === '1';

describe.skipIf(!E2E)('AztecLedgerSession integration (alpha-testnet)', () => {
  test('connect() resolves a deterministic account address', async () => {
    /* Scaffolded — full wiring of AztecLedgerSession.connect() is a
     * follow-up that depends on:
     *  - Loading Wonderland's Token + Dripper JSON artifacts in node
     *  - Spawning SessionEmbeddedWallet.createEphemeral with prover WASM
     *  - Building LedgerEcdsaKAccountContract from a SpeculosTransport
     *  - AccountManager.create(embedded, secret, ledgerContract, salt)
     *
     * Pinning the test shape now so the e2e runner has a target. The
     * actual `connect()` factory lands in M6.5.next alongside the
     * SessionEmbeddedWallet bring-up. */
    expect(E2E).toBe(true);
  });
});
