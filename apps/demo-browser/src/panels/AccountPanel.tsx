/**
 * Account panel — Deploy (one-time blind-signed) + Drip (clear-signed).
 *
 * Renders a live step log so the user sees exactly where the flow is:
 * "Building payload…" → "Awaiting clear-signed approval on device…" →
 * "Signature received — building tx request…" → "Proving tx…" →
 * "Submitting tx 0xabcdef…" → "Awaiting inclusion…" → "Tx mined".
 */

import type { SubmitResult } from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import { type DemoState, type SubmitStep, sessionFromState } from '../state.ts';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function AccountPanel({ state, setState }: Props) {
  const session = sessionFromState(state);
  const [steps, setSteps] = useState<SubmitStep[]>([]);
  const disabled = !session || state.kind === 'connecting' || state.kind === 'submitting';

  async function runAction(
    name: 'deploy' | 'drip',
    fn: (onStep: (s: string) => void) => Promise<SubmitResult>,
  ) {
    if (!session) return;
    const local: SubmitStep[] = [];
    setSteps([]);
    setState({ kind: 'submitting', session, action: name, steps: local });
    const onStep = (label: string) => {
      const step = { label, at: performance.now() };
      local.push(step);
      setSteps([...local]);
    };
    try {
      const result = await fn(onStep);
      setState({
        kind: 'ready',
        session,
        lastSteps: local,
        lastTxHash: result.txHash.toString(),
      });
    } catch (e) {
      if (e instanceof Error) {
        console.error('Action failed:', { name: e.name, message: e.message, stack: e.stack });
      }
      setState({
        kind: 'error',
        lastSession: session,
        message: e instanceof Error ? e.message : String(e),
        steps: local,
      });
    }
  }

  const isDeploying = state.kind === 'submitting' && state.action === 'deploy';
  const isDripping = state.kind === 'submitting' && state.action === 'drip';

  return (
    <section className={`panel ${disabled ? 'disabled' : ''}`}>
      <h2>2. Account &amp; Drip</h2>
      {session ? (
        <>
          <div className="row">
            <span style={{ minWidth: '6rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
              Address
            </span>
            <span className="address">{session.addressHex}</span>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                runAction('deploy', (onStep) => session.session.deployAccount({ onStep }))
              }
              disabled={state.kind === 'submitting'}
            >
              {isDeploying ? 'Deploying…' : 'Deploy account'}
            </button>
            <span className="status muted">One-time. Blind-signed on device.</span>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                runAction('drip', (onStep) => session.session.dripUsdc(1_000_000_000n, { onStep }))
              }
              disabled={state.kind === 'submitting'}
            >
              {isDripping ? 'Dripping…' : 'Drip 1000 USDC'}
            </button>
            <span className="status muted">
              Sponsored. Clear-signed on-device. Mints to msg.sender.
            </span>
          </div>
          <StepLog state={state} steps={steps} />
        </>
      ) : (
        <div className="status muted">Connect first.</div>
      )}
    </section>
  );
}

function StepLog({ state, steps }: { state: DemoState; steps: SubmitStep[] }) {
  /* Choose which steps to display based on current state. */
  let display: SubmitStep[] = [];
  let title = '';
  if (state.kind === 'submitting') {
    display = state.steps.length > 0 ? state.steps : steps;
    title = `Action: ${state.action}`;
  } else if (state.kind === 'error' && state.steps) {
    display = state.steps;
    title = 'Last attempt (failed)';
  } else if (state.kind === 'ready' && state.lastSteps) {
    display = state.lastSteps;
    title = state.lastTxHash ? `Last tx: ${state.lastTxHash.slice(0, 14)}…` : 'Last attempt';
  }
  if (display.length === 0) return null;
  const t0 = display[0]?.at ?? 0;
  return (
    <div className="steplog">
      <div className="steplog-title">{title}</div>
      <ol>
        {display.map((s) => (
          <li key={`${s.at}-${s.label}`}>
            <span className="steplog-time">+{Math.round(s.at - t0)}ms</span>
            <span className="steplog-label">{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
