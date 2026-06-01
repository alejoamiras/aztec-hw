/**
 * Transfer panel — 4 modes, each clear-signed on device with step-by-step
 * status visible to the user.
 */
import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecLedgerSession, PhaseId, SubmitResult } from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import {
  assertMonotonicPhase,
  type DemoState,
  type SubmitStep,
  sessionFromState,
} from '../state.ts';

type Mode = 'pub-pub' | 'priv-pub' | 'pub-priv' | 'priv-priv';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

const MODE_LABELS: Record<Mode, string> = {
  'pub-pub': 'public → public',
  'priv-pub': 'private → public',
  'pub-priv': 'public → private',
  'priv-priv': 'private → private',
};

/** Short per-mode caption shown beneath the dropdown so the user (and the
 * demo audience) knows what each mode actually does. M7 P5. */
const MODE_HINTS: Record<Mode, string> = {
  'pub-pub': 'Public balance → public balance. Visible on-chain. Cheapest gas, no proving.',
  'priv-pub': 'Spend a private note → credit recipient publicly. Sender stays anonymous.',
  'pub-priv': 'Debit your public balance → mint a private note for the recipient.',
  'priv-priv': 'Private note → private note. Fully shielded; only sender + recipient know.',
};

function callWrapper(
  s: AztecLedgerSession,
  mode: Mode,
  to: AztecAddress,
  amount: bigint,
  onStep: (phase: PhaseId, label: string) => void,
  onTxHash: (hash: string) => void,
): Promise<SubmitResult> {
  const opts = { onStep, onTxHash };
  switch (mode) {
    case 'pub-pub':
      return s.transferUsdcPubToPub(to, amount, opts);
    case 'priv-pub':
      return s.transferUsdcPrivToPub(to, amount, opts);
    case 'pub-priv':
      return s.transferUsdcPubToPriv(to, amount, opts);
    case 'priv-priv':
      return s.transferUsdcPrivToPriv(to, amount, opts);
  }
}

export function TransferPanel({ state, setState }: Props) {
  const sessionRef = sessionFromState(state);
  const [mode, setMode] = useState<Mode>('pub-pub');
  const [toHex, setToHex] = useState('');
  const [amount, setAmount] = useState('100000000');

  const disabled = !sessionRef || state.kind === 'connecting' || state.kind === 'submitting';

  async function onSubmit() {
    if (!sessionRef) return;
    let to: AztecAddress;
    try {
      to = AztecAddress.fromString(toHex.trim());
    } catch {
      setState({
        kind: 'error',
        lastSession: sessionRef,
        message: `Recipient is not a valid Aztec address: ${toHex}`,
      });
      return;
    }
    const atomic = BigInt(amount);
    const localSteps: SubmitStep[] = [];
    let txHashSoFar: string | undefined;
    setState({
      kind: 'submitting',
      session: sessionRef,
      action: `transfer ${mode}`,
      steps: localSteps,
    });
    const onStep = (phase: PhaseId, label: string) => {
      assertMonotonicPhase(phase, localSteps);
      localSteps.push({ phase, label, at: performance.now() });
      /* Force a state re-render by re-issuing the submitting state. */
      setState({
        kind: 'submitting',
        session: sessionRef,
        action: `transfer ${mode}`,
        steps: [...localSteps],
        currentTxHash: txHashSoFar,
      });
    };
    const onTxHash = (hash: string) => {
      txHashSoFar = hash;
      setState({
        kind: 'submitting',
        session: sessionRef,
        action: `transfer ${mode}`,
        steps: [...localSteps],
        currentTxHash: hash,
      });
    };
    try {
      const result = await callWrapper(sessionRef.session, mode, to, atomic, onStep, onTxHash);
      setState({
        kind: 'ready',
        session: sessionRef,
        lastSteps: localSteps,
        lastTxHash: result.txHash.toString(),
      });
    } catch (e) {
      if (e instanceof Error) {
        console.error('Transfer failed:', { name: e.name, message: e.message, stack: e.stack });
      }
      setState({
        kind: 'error',
        lastSession: sessionRef,
        message: e instanceof Error ? e.message : String(e),
        steps: localSteps,
      });
    }
  }

  return (
    <section className={`panel ${disabled ? 'disabled' : ''}`}>
      <h2>3. Transfer USDC</h2>
      <div className="row">
        <label htmlFor="mode">Mode</label>
        <select
          id="mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          disabled={state.kind === 'submitting'}
        >
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span style={{ minWidth: '6rem' }} />
        <span className="status muted">{MODE_HINTS[mode]}</span>
      </div>
      <div className="row">
        <label htmlFor="to">To</label>
        <input
          id="to"
          placeholder="0x… (Aztec address)"
          value={toHex}
          onChange={(e) => setToHex(e.target.value)}
          disabled={state.kind === 'submitting'}
        />
        {sessionRef && state.kind !== 'submitting' && (
          <button
            type="button"
            className="button-ghost"
            onClick={() => setToHex(sessionRef.addressHex)}
            title="Self-transfer for demo: useful when there's no other testnet account handy"
          >
            Use my address
          </button>
        )}
      </div>
      <div className="row">
        <label htmlFor="amount">Amount</label>
        <input
          id="amount"
          inputMode="numeric"
          placeholder="atomic (1 USDC = 1000000)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={state.kind === 'submitting'}
        />
      </div>
      <div className="row">
        <button type="button" onClick={onSubmit} disabled={state.kind === 'submitting' || !toHex}>
          {state.kind === 'submitting' && state.action.startsWith('transfer')
            ? 'Submitting…'
            : 'Transfer'}
        </button>
        <span className="status muted">
          Sponsored. Clear-signed on-device (recipient + amount visible).
        </span>
      </div>
    </section>
  );
}
