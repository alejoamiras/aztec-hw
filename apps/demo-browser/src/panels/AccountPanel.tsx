/**
 * Account panel — Deploy (one-time blind-signed) + Drip (clear-signed).
 *
 * Renders a live step log so the user sees exactly where the flow is:
 * "Building payload…" → "Awaiting clear-signed approval on device…" →
 * "Signature received — building tx request…" → "Proving tx…" →
 * "Submitting tx 0xabcdef…" → "Awaiting inclusion…" → "Tx mined".
 *
 * Deploy disables itself once it succeeds — account deployment is
 * one-shot per session.
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
  const alreadyDeployed = Boolean(session?.deployedTxHash);

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
      /* Mirror the active step into the global state so the top status
       * bar updates in real time. */
      setState({ kind: 'submitting', session, action: name, steps: [...local] });
    };
    try {
      const result = await fn(onStep);
      const txHash = result.txHash.toString();
      /* Persist deploy completion onto the session ref so the button
       * stays disabled across re-renders. */
      if (name === 'deploy') session.deployedTxHash = txHash;
      setState({
        kind: 'ready',
        session,
        lastSteps: local,
        lastTxHash: txHash,
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
              disabled={state.kind === 'submitting' || alreadyDeployed}
            >
              {alreadyDeployed
                ? '✓ Account deployed'
                : isDeploying
                  ? 'Deploying…'
                  : 'Deploy account'}
            </button>
            <span className="status muted">
              One-time. Blind-signed on device (hash review, not decoded — that's a future arc).
            </span>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                runAction('drip', (onStep) => session.session.dripUsdc(1_000_000_000n, { onStep }))
              }
              disabled={state.kind === 'submitting' || !alreadyDeployed}
            >
              {isDripping ? 'Dripping…' : 'Drip 1000 USDC (public)'}
            </button>
            <span className="status muted">
              {alreadyDeployed
                ? 'Sponsored. Clear-signed on-device. Mints USDC publicly to your address.'
                : 'Deploy the account first.'}
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
  let display: SubmitStep[] = [];
  let title = '';
  if (state.kind === 'submitting') {
    display = state.steps.length > 0 ? state.steps : steps;
    title = `Active: ${state.action}`;
  } else if (state.kind === 'error' && state.steps) {
    display = state.steps;
    title = 'Last attempt (failed)';
  } else if (state.kind === 'ready' && state.lastSteps) {
    display = state.lastSteps;
    title = state.lastTxHash ? `Last tx: ${state.lastTxHash.slice(0, 14)}…` : 'Last attempt';
  }
  if (display.length === 0) return null;
  const t0 = display[0]?.at ?? 0;
  const last = display[display.length - 1];
  const totalMs = last ? Math.round(last.at - t0) : 0;
  return (
    <div className="steplog">
      <div className="steplog-title">
        {title}
        {totalMs > 0 && <span className="steplog-total"> · {totalMs}ms total</span>}
      </div>
      <ol>
        {display.map((s, idx) => {
          const dur = idx > 0 ? Math.round(s.at - (display[idx - 1]?.at ?? s.at)) : 0;
          const isLast = idx === display.length - 1 && state.kind === 'submitting';
          return (
            <li key={`${s.at}-${s.label}`} className={isLast ? 'steplog-current' : ''}>
              <span className="steplog-time">+{Math.round(s.at - t0)}ms</span>
              <span className="steplog-label">
                {isLast ? '⏳ ' : '✓ '}
                {s.label}
              </span>
              {idx > 0 && dur > 100 && <span className="steplog-delta"> (+{dur}ms)</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
