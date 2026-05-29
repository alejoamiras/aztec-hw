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
import type {
  AztecLedgerSession,
  LedgerTransport,
  PhaseId,
} from '@aztec-hwwallet-poc/adapter-ledger';

export type Transport = 'speculos' | 'webhid';

/** Canonical phase order — single source of truth for both the UI
 * timeline AND the dev-mode monotonic assertion. Re-exported from the
 * adapter package so adapter + UI agree by construction. */
export const PHASE_ORDER: readonly PhaseId[] = [
  'build',
  'sign',
  'prove',
  'submit',
  'include',
  'done',
] as const;

/** Codex audit MINOR #1: phase regression is a state-machine bug, not
 * a soft warning. Throws in dev/test; logs in production. The unit
 * test at apps/demo-browser/src/state.test.ts asserts the throw fires.
 *
 * Env detection is portable across bun:test (no Vite globals) and the
 * Vite browser build: throws unless explicitly production. */
function isProduction(): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: cross-runtime env probe
  const meta = import.meta as any;
  if (meta?.env?.PROD === true) return true;
  if (meta?.env?.MODE === 'production') return true;
  // biome-ignore lint/suspicious/noExplicitAny: cross-runtime env probe
  const proc = (globalThis as any).process;
  if (proc?.env?.NODE_ENV === 'production') return true;
  return false;
}

export function assertMonotonicPhase(next: PhaseId, steps: readonly { phase: PhaseId }[]): void {
  if (steps.length === 0) return;
  const prev = steps[steps.length - 1]!.phase;
  const prevIdx = PHASE_ORDER.indexOf(prev);
  const nextIdx = PHASE_ORDER.indexOf(next);
  if (nextIdx < prevIdx) {
    const msg = `[m7] backwards phase transition: ${prev} (idx=${prevIdx}) → ${next} (idx=${nextIdx})`;
    if (!isProduction()) throw new Error(msg);
    console.error(msg);
  }
}

export interface SessionRef {
  readonly transport: Transport;
  readonly nodeUrl: string;
  readonly addressHex: string;
  readonly session: AztecLedgerSession;
  /** Set to a tx hash once deployAccount has run successfully. The
   * Deploy button reads this to disable itself — accounts deploy once. */
  deployedTxHash?: string;
  /** M9 A3: true if the account was already initialized on-chain at onboard
   * time (detected via the wallet init-status — e.g. a prior session deployed
   * it, since the deterministic salt makes the address stable). Disables Deploy. */
  alreadyDeployed?: boolean;
}

export interface SubmitStep {
  readonly phase: PhaseId;
  readonly label: string;
  readonly at: number; // performance.now() timestamp
}

export type DemoState =
  | { kind: 'idle' }
  | { kind: 'connecting'; transport: Transport; nodeUrl: string }
  /* M8 P7.3 — transport open + device verified; awaiting the explicit
   * "Derive viewing keys" reveal that yields the session secret. Holds the
   * open LedgerTransport so OnboardPanel can reveal + build the session. */
  | { kind: 'onboarding'; transport: Transport; nodeUrl: string; ledger: LedgerTransport }
  | { kind: 'ready'; session: SessionRef; lastSteps?: SubmitStep[]; lastTxHash?: string }
  | {
      kind: 'submitting';
      session: SessionRef;
      action: string;
      steps: SubmitStep[];
      /** Populated once the proven tx hash is known (between prove +
       * submit). Lets the status bar render an aztecscan link mid-flight
       * — useful when testnet inclusion drags. */
      currentTxHash?: string;
    }
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
