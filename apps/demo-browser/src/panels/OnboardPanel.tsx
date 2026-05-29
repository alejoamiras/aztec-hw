/**
 * Onboard panel (M8 P7.3) — the sovereignty moment.
 *
 * After Connect opens + verifies the transport, this explicit step reveals the
 * device's Aztec viewing keys (one on-device approval) and uses them as the
 * session secret. That makes the account the browser derives the SAME one the
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
  cacheSecret,
  defaultAztecPath,
  revealMasterSecret,
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

  const isOnboarding = state.kind === 'onboarding';
  const isOnboarded = state.kind === 'ready' || state.kind === 'submitting';

  async function onDerive() {
    if (state.kind !== 'onboarding') return;
    const { transport, nodeUrl, ledger } = state;
    try {
      /* 1. Reveal the device's Aztec master secret (1 on-device approval). The
       *    user approves on the device / Speculos UI — same as a deploy. */
      setBusy('Approve the reveal on your device…');
      const reveal = await revealMasterSecret(ledger, defaultAztecPath());
      setChecksum(reveal.checksum);
      /* 2. Cache in-session (in-memory / sessionStorage only — never disk). */
      cacheSecret(reveal.secret);
      /* 3. Recompute the pinned demo contract instances (PXE rejects
       *    address-only overrides — full instances required). */
      setBusy('Building session (PXE + WASM prover)…');
      const [usdc, dripper, fpc] = await Promise.all([
        usdcInstance(),
        dripperInstance(),
        sponsoredFpcInstance(),
      ]);
      /* 4. Build the session WITH the device secret. Deterministic salt is the
       *    default, so this exact account reproduces on every reconnect. */
      const session = await AztecLedgerSession.connect({
        nodeUrl,
        transport: ledger,
        secret: reveal.secret,
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
            <button type="button" onClick={onDerive} disabled={busy !== null}>
              {busy ? 'Working…' : 'Derive Aztec viewing keys (1 approval)'}
            </button>
            <span className="status muted">
              {busy ?? 'One on-device approval. Discloses viewing, not spending.'}
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
