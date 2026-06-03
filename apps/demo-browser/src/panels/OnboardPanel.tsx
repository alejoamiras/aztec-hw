/**
 * Onboard panel (M8 P7.3) — the sovereignty moment.
 *
 * After Connect opens + verifies the transport, this explicit step reveals the
 * device's Aztec viewing keys (one approval) and confirms the device-attested
 * receive address (a second approval — AHW-098, so the browser can't show an
 * address the device didn't author), using the keys as the session secret. That makes the account the browser derives the SAME one the
 * device verifies at deploy time (a random secret would be rejected with
 * 0x6F0F). The signing key never leaves the device; reconnecting later
 * re-derives the identical keys — the Ledger IS the wallet, and is its own
 * backup.
 *
 * The reveal path is `defaultAztecPath()`, which is byte-identical to the
 * deploy path the device verifies against (see adapter `defaultDeployPath`).
 */
import {
  AztecLedgerSession,
  defaultAztecPath,
  revealOrReuseMasterSecret,
} from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import {
  DRIPPER_ARTIFACT,
  dripperInstance,
  SPONSORED_FPC_ADDRESS,
  SPONSORED_FPC_ARTIFACT,
  sponsoredFpcInstance,
  TOKEN_ARTIFACT,
  usdcInstance,
} from '../deployments.ts';
import type { DemoState, SessionRef } from '../state.ts';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function OnboardPanel({ state, setState }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [checksum, setChecksum] = useState<string | null>(null);
  const [accountIndex, setAccountIndex] = useState(0);
  /* M10: signature scheme. The SAME Ledger seed backs both — only the signing
   * key family + account contract differ, so each scheme is a distinct account. */
  const [scheme, setScheme] = useState<'ecdsa' | 'schnorr'>('ecdsa');

  const isOnboarding = state.kind === 'onboarding';
  const isOnboarded = state.kind === 'ready' || state.kind === 'submitting';

  async function onDerive() {
    if (state.kind !== 'onboarding') return;
    const { transport, nodeUrl, ledger } = state;
    try {
      /* M9 A2: the account index is the single source — the SAME path threads to
       * the reveal, the cache key, AND connect()'s bip32Path. */
      const path = defaultAztecPath(accountIndex);
      /* M9 A1: cache keyed by the DEVICE signing pubkey (per path) — a different
       * device OR account index is a miss → a fresh reveal, never a reuse of
       * another context's viewing root (codex MAJOR 1). "Forget session" clears
       * the cache, so the next onboard re-reveals — the re-derivation that makes
       * reconnect == recovery. */
      setBusy('Reading device…');
      /* AHW-103: reveal-or-reuse is owned by the adapter's onboarding layer now —
       * the panel no longer touches the raw secret cache (no public loadCachedSecret/
       * cacheSecret). One device approval on a cache miss; the secret lives only in
       * that layer's memory-only cache and is handed back just for this connect(). */
      const { secret, checksum, fromCache } = await revealOrReuseMasterSecret(ledger, path, {
        onReveal: () => setBusy('Approve the reveal on your device…'),
      });
      setChecksum(fromCache ? 'cached' : checksum);
      /* 2. Recompute the pinned demo contract instances (PXE rejects
       *    address-only overrides — full instances required). */
      setBusy('Building session (PXE + WASM prover)…');
      const [usdc, dripper, fpc] = await Promise.all([
        usdcInstance(),
        dripperInstance(),
        sponsoredFpcInstance(),
      ]);
      /* 3. Build the session WITH the device secret. Deterministic salt is the
       *    default, so this exact account reproduces on every reconnect. */
      const session = await AztecLedgerSession.connect({
        nodeUrl,
        transport: ledger,
        secret,
        bip32Path: path, // M9 A2: same path as the reveal + cache key
        scheme, // M10: 'ecdsa' (EcdsaKAccount) or 'schnorr' (SchnorrAccount)

        tokenArtifact: TOKEN_ARTIFACT,
        dripperArtifact: DRIPPER_ARTIFACT,
        sponsoredFpcArtifact: SPONSORED_FPC_ARTIFACT,
        usdcInstance: usdc,
        dripperInstance: dripper,
        sponsoredFpcInstance: fpc,
        sponsoredFpcAddress: SPONSORED_FPC_ADDRESS,
      });
      const ref: SessionRef = {
        transport,
        nodeUrl,
        addressHex: session.address.toString(),
        session,
      };
      /* M9 A3: detect whether this account is already on-chain (best-effort —
       * a node round-trip; never fail onboarding on it). Drives the UI to skip
       * Deploy for an account that already exists. */
      setBusy('Checking on-chain status…');
      /* codex MINOR: cap the RPC so a sick node can't pin onboarding here —
       * an 8s timeout falls back to "not detected" (just shows Deploy, harmless). */
      ref.alreadyDeployed = await Promise.race([
        session.isDeployed(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
      ]).catch(() => false);
      setBusy(null);
      setState({ kind: 'ready', session: ref });
    } catch (e) {
      setBusy(null);
      if (e instanceof Error) {
        console.error(
          'Onboard failed JSON: ' +
            JSON.stringify({ name: e.name, message: e.message, stack: e.stack }, null, 2),
        );
      } else {
        console.error('Onboard failed (non-Error):', e);
      }
      setState({
        kind: 'error',
        lastSession: null,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!isOnboarding && !isOnboarded) {
    return (
      <section className="panel disabled">
        <h2>1.5 Derive viewing keys</h2>
        <div className="status muted">Connect + verify a device first.</div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>1.5 Derive viewing keys</h2>
      {isOnboarding ? (
        <>
          <div className="status muted">
            Your Ledger holds the keys. Approve below to let this browser <strong>see</strong> your
            private balance (your viewing keys). Your <strong>signing</strong> key never leaves the
            device — reconnect any time to re-derive the same account.
          </div>
          <div className="row">
            <label htmlFor="account-index">Account</label>
            <select
              id="account-index"
              value={accountIndex}
              onChange={(e) => setAccountIndex(Number(e.target.value))}
              disabled={busy !== null}
            >
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  Account #{n}
                </option>
              ))}
            </select>
            <span className="status muted">Each index is a separate account on your Ledger.</span>
          </div>
          <div className="row">
            <label htmlFor="scheme">Signature</label>
            <select
              id="scheme"
              value={scheme}
              onChange={(e) => setScheme(e.target.value as 'ecdsa' | 'schnorr')}
              disabled={busy !== null}
            >
              <option value="ecdsa">ECDSA (secp256k1)</option>
              <option value="schnorr">Schnorr (Grumpkin)</option>
            </select>
            <span className="status muted">
              Same Ledger seed — the device signs with the chosen scheme. Each scheme is its own
              account.
            </span>
          </div>
          <div className="row">
            <button type="button" onClick={onDerive} disabled={busy !== null}>
              {busy ? 'Working…' : `Derive Account #${accountIndex} viewing keys (2 approvals)`}
            </button>
            <span className="status muted">
              {busy ??
                'Two device approvals: reveal viewing keys (discloses viewing, not spending), then confirm your receive address (AHW-098).'}
            </span>
          </div>
        </>
      ) : (
        <div className="status">
          ✓ Viewing keys derived on-device.
          {checksum && (
            <>
              {' '}
              Device checksum <code>{checksum}</code> — should match the device screen.
            </>
          )}
        </div>
      )}
    </section>
  );
}
