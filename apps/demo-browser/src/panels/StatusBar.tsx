/**
 * Top-of-page status bar — a single banner that summarizes session +
 * active action state. Replaces the inline-only step log that's easy
 * to miss. Shows:
 *
 *   - state.kind (idle | connecting | ready | submitting | error)
 *   - action label (deploy / drip / transfer X)
 *   - latest step from the active submission
 *   - last tx hash (with an aztecscan link) when in ready state after
 *     a successful submission
 *   - error message when in error state
 */
import type { DemoState } from '../state.ts';

interface Props {
  state: DemoState;
}

export function StatusBar({ state }: Props) {
  let badge: string;
  let badgeClass: 'idle' | 'connecting' | 'ready' | 'submitting' | 'error';
  let primary = '';
  let secondary = '';
  let txHash: string | undefined;

  switch (state.kind) {
    case 'idle':
      badge = 'Idle';
      badgeClass = 'idle';
      primary = 'Not connected.';
      secondary = 'Click Connect to spin up the session against testnet.';
      break;
    case 'connecting':
      badge = 'Connecting';
      badgeClass = 'connecting';
      primary = 'Spinning up PXE + WASM prover + Ledger…';
      secondary = `${state.transport} → ${state.nodeUrl}`;
      break;
    case 'ready':
      badge = 'Ready';
      badgeClass = 'ready';
      primary = state.lastTxHash ? 'Last tx submitted.' : 'Session live.';
      secondary = state.lastSteps?.length
        ? state.lastSteps[state.lastSteps.length - 1]!.label
        : 'Use panels 2 + 3 to deploy, drip, or transfer.';
      txHash = state.lastTxHash;
      break;
    case 'submitting': {
      badge = state.action;
      badgeClass = 'submitting';
      const last = state.steps[state.steps.length - 1];
      primary = last ? last.label : 'Working…';
      secondary = `${state.steps.length} step${state.steps.length === 1 ? '' : 's'} so far. See panel for details.`;
      break;
    }
    case 'error':
      badge = 'Error';
      badgeClass = 'error';
      primary = state.message;
      secondary = state.steps?.length
        ? `Failed after: ${state.steps[state.steps.length - 1]!.label}`
        : '';
      break;
  }

  return (
    <div className={`status-bar status-bar-${badgeClass}`}>
      <div className="status-bar-row">
        <span className={`status-bar-badge status-bar-badge-${badgeClass}`}>{badge}</span>
        <span className="status-bar-primary">{primary}</span>
      </div>
      {secondary && <div className="status-bar-secondary">{secondary}</div>}
      {txHash && (
        <div className="status-bar-secondary">
          <a
            href={`https://testnet.aztecscan.xyz/tx-effects/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View tx {txHash.slice(0, 14)}… on aztecscan ↗
          </a>
        </div>
      )}
    </div>
  );
}
