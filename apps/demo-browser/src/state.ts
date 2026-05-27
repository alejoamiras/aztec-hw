/**
 * State machine for the demo UI.
 *
 * idle           — page just loaded; no Ledger connected, no session.
 * connecting     — waiting for transport open + account derive.
 * ready          — session is built; account address known; idle UI.
 * submitting     — a tx is in flight; UI disabled.
 * error          — last action failed; banner shown, falls back to prior state.
 *
 * The `session` field is a reference to the AztecLedgerSession object; we
 * keep it opaque here (typed `unknown`) so this file doesn't transitively
 * pull in @aztec/* into every renderer. Concrete callers narrow it.
 */
import type { AztecLedgerSession } from '@aztec-hwwallet-poc/adapter-ledger';

export type Transport = 'speculos' | 'webhid';

export interface SessionRef {
  readonly transport: Transport;
  readonly nodeUrl: string;
  readonly addressHex: string;
  readonly session: AztecLedgerSession;
}

export interface SubmitStep {
  readonly label: string;
  readonly at: number; // performance.now() timestamp
}

export type DemoState =
  | { kind: 'idle' }
  | { kind: 'connecting'; transport: Transport; nodeUrl: string }
  | { kind: 'ready'; session: SessionRef; lastSteps?: SubmitStep[]; lastTxHash?: string }
  | { kind: 'submitting'; session: SessionRef; action: string; steps: SubmitStep[] }
  | {
      kind: 'error';
      lastSession: SessionRef | null;
      message: string;
      steps?: SubmitStep[];
    };

/**
 * Helper: extract the "stable" SessionRef for a given state (the one we
 * should restore to after an error or after a submission). Returns null
 * if no session has ever been established.
 */
export function sessionFromState(s: DemoState): SessionRef | null {
  switch (s.kind) {
    case 'ready':
      return s.session;
    case 'submitting':
      return s.session;
    case 'error':
      return s.lastSession;
    default:
      return null;
  }
}
