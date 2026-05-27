/**
 * Top-of-page status bar with a real PHASE TIMELINE.
 *
 * Replaces the prior "latest step label" surface that lived under
 * panel 2 — the user complained that the two status surfaces (header
 * + under-step-2 console) were redundant AND not clearly communicating
 * what phase the tx was in. The action's name (deploy / drip / transfer
 * pub→pub) sits on the badge. The 6 ordered phases sit below as a
 * horizontal timeline; each phase lights up (done/active/pending) as
 * the step labels from the adapter come through. Single source of
 * truth — the under-step-2 console is gone.
 *
 * Phase inference: parses step-label keywords ("Building…", "Awaiting
 * clear-signed…", "Proving…", "Submitting…", "Awaiting inclusion…",
 * "Tx mined / deployed"). Cheap heuristic; resilient enough for the
 * demo. If a label doesn't match any keyword, the active-phase
 * pointer just sticks where it was.
 */
import type { DemoState, SubmitStep } from '../state.ts';

interface Props {
  state: DemoState;
}

type PhaseId = 'build' | 'sign' | 'prove' | 'submit' | 'include' | 'done';

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
  { id: 'done', label: 'Done', hint: 'Tx checkpointed' },
] as const;

/** Map an adapter step label to a phase index (0..5). Returns -1 if unknown. */
function inferPhaseIndex(label: string): number {
  const l = label.toLowerCase();
  if (l.includes('building') || l.includes('payload')) return 0;
  if (l.includes('awaiting') && (l.includes('approval') || l.includes('signed'))) return 1;
  if (l.includes('signature received') || l.includes('proving') || l.includes('ivc')) return 2;
  if (l.includes('submitting')) return 3;
  if (l.includes('awaiting inclusion') || l.includes('inclusion')) return 4;
  if (l.includes('mined') || l.includes('deployed') || l.includes('done')) return 5;
  return -1;
}

function activePhase(steps: readonly SubmitStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const idx = inferPhaseIndex(steps[i]!.label);
    if (idx >= 0) return idx;
  }
  return 0;
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
          <li key={phase.id} className={`phase phase-${state}`} title={phase.hint}>
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
      primary = state.lastTxHash ? 'Last tx checkpointed.' : 'Session live.';
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
      activeIdx = activePhase(state.steps);
      secondary = PHASES[activeIdx]?.hint ?? '';
      break;
    }
    case 'error':
      badge = 'Error';
      badgeClass = 'error';
      primary = state.message;
      if (state.steps?.length) {
        showTimeline = true;
        failed = true;
        activeIdx = activePhase(state.steps);
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
