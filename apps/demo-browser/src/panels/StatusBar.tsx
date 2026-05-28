/**
 * Top-of-page status bar with a real PHASE TIMELINE.
 *
 * M7 P1: the active phase is read DIRECTLY from `step.phase` — no string
 * heuristic. The adapter is the source of truth via the structured
 * `onStep(phase, label)` callback. If a step lands with an unexpected
 * phase value, that's a typed enum violation and would have failed
 * at the call site.
 *
 * Single source of truth — only the adapter calls `onStep`. The browser
 * never synthesizes phase callbacks.
 */
import type { PhaseId } from '@aztec-hwwallet-poc/adapter-ledger';
import { type DemoState, PHASE_ORDER, type SubmitStep } from '../state.ts';

interface Props {
  state: DemoState;
}

interface Phase {
  id: PhaseId;
  label: string;
  hint: string;
}

const PHASES: readonly Phase[] = [
  { id: 'build', label: 'Build', hint: 'Composing call payload' },
  { id: 'sign', label: 'Sign', hint: 'Awaiting approval on device' },
  { id: 'prove', label: 'Prove', hint: 'Generating ClientIVC proof (WASM)' },
  { id: 'submit', label: 'Submit', hint: 'Sending tx to the node' },
  { id: 'include', label: 'Include', hint: 'Waiting for L2 block inclusion' },
  { id: 'done', label: 'Done', hint: 'Tx included in a proposed L2 block (finality follows)' },
] as const;

function activePhaseIdx(steps: readonly SubmitStep[]): number {
  if (steps.length === 0) return 0;
  return PHASE_ORDER.indexOf(steps[steps.length - 1]!.phase);
}

interface TimelineProps {
  activeIdx: number;
  finished: boolean;
  failed: boolean;
}

function Timeline({ activeIdx, finished, failed }: TimelineProps) {
  return (
    <ol className="phase-timeline">
      {PHASES.map((phase, idx) => {
        let state: 'done' | 'active' | 'pending' | 'failed' = 'pending';
        if (failed) {
          state = idx < activeIdx ? 'done' : idx === activeIdx ? 'failed' : 'pending';
        } else if (finished) {
          state = 'done';
        } else if (idx < activeIdx) state = 'done';
        else if (idx === activeIdx) state = 'active';
        return (
          <li
            key={phase.id}
            className={`phase phase-${state}`}
            title={phase.hint}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <div className="phase-marker">
              {state === 'done' ? '✓' : state === 'failed' ? '!' : idx + 1}
            </div>
            <div className="phase-label">{phase.label}</div>
          </li>
        );
      })}
    </ol>
  );
}

function actionLabel(state: DemoState): string | undefined {
  if (state.kind === 'submitting') {
    return state.action === 'deploy'
      ? 'Deploy account'
      : state.action === 'drip'
        ? 'Drip 1000 USDC'
        : `Transfer ${state.action.replace('transfer-', '')}`;
  }
  return undefined;
}

export function StatusBar({ state }: Props) {
  let badge: string;
  let badgeClass: 'idle' | 'connecting' | 'ready' | 'submitting' | 'error';
  let primary = '';
  let secondary = '';
  let txHash: string | undefined;
  let showTimeline = false;
  let activeIdx = 0;
  let finished = false;
  let failed = false;
  let currentStep = '';

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
      primary = state.lastTxHash ? 'Last tx included.' : 'Session live.';
      secondary = state.lastTxHash
        ? 'Ready for the next action.'
        : 'Use panels 2 + 3 to deploy, drip, or transfer.';
      txHash = state.lastTxHash;
      if (state.lastSteps?.length) {
        showTimeline = true;
        finished = true;
        activeIdx = PHASES.length - 1;
      }
      break;
    case 'submitting': {
      const action = actionLabel(state);
      badge = action ?? state.action;
      badgeClass = 'submitting';
      const last = state.steps[state.steps.length - 1];
      primary = last ? last.label : 'Working…';
      currentStep = last?.label ?? '';
      showTimeline = true;
      activeIdx = activePhaseIdx(state.steps);
      secondary = PHASES[activeIdx]?.hint ?? '';
      /* Surface the proven tx hash mid-flight so the user can hit
       * aztecscan while we wait for inclusion (testnet can drag). */
      txHash = state.currentTxHash;
      break;
    }
    case 'error':
      badge = 'Error';
      badgeClass = 'error';
      primary = state.message;
      if (state.steps?.length) {
        showTimeline = true;
        failed = true;
        activeIdx = activePhaseIdx(state.steps);
        secondary = `Failed at: ${PHASES[activeIdx]?.label ?? 'unknown phase'}.`;
      }
      break;
  }

  return (
    <div className={`status-bar status-bar-${badgeClass}`}>
      <div className="status-bar-row">
        <span className={`status-bar-badge status-bar-badge-${badgeClass}`}>{badge}</span>
        <span className="status-bar-primary">{primary}</span>
      </div>
      {showTimeline && <Timeline activeIdx={activeIdx} finished={finished} failed={failed} />}
      {currentStep && state.kind === 'submitting' && (
        <div className="status-bar-secondary status-bar-step">{currentStep}</div>
      )}
      {!currentStep && secondary && <div className="status-bar-secondary">{secondary}</div>}
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
