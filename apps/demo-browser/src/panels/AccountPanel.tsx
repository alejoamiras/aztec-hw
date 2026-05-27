/**
 * Account panel — Deploy (one-time blind-signed) + Drip (clear-signed).
 *
 * Step-log moved up to the StatusBar (single source of truth, M6.14).
 * This panel only renders the two action buttons + their disable rules:
 * Deploy is one-shot and self-disables; Drip is gated on Deploy.
 */

import type { SubmitResult } from '@aztec-hwwallet-poc/adapter-ledger';
import { type DemoState, type SubmitStep, sessionFromState } from '../state.ts';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function AccountPanel({ state, setState }: Props) {
  const session = sessionFromState(state);
  const disabled = !session || state.kind === 'connecting' || state.kind === 'submitting';
  const alreadyDeployed = Boolean(session?.deployedTxHash);

  async function runAction(
    name: 'deploy' | 'drip',
    fn: (onStep: (s: string) => void) => Promise<SubmitResult>,
  ) {
    if (!session) return;
    const local: SubmitStep[] = [];
    setState({ kind: 'submitting', session, action: name, steps: local });
    const onStep = (label: string) => {
      local.push({ label, at: performance.now() });
      setState({ kind: 'submitting', session, action: name, steps: [...local] });
    };
    try {
      const result = await fn(onStep);
      const txHash = result.txHash.toString();
      if (name === 'deploy') session.deployedTxHash = txHash;
      setState({ kind: 'ready', session, lastSteps: local, lastTxHash: txHash });
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
        </>
      ) : (
        <div className="status muted">Connect first.</div>
      )}
    </section>
  );
}
