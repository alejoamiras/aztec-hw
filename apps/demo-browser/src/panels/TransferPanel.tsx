/**
 * Transfer panel — 4 modes, each invoking the matching wrapper on
 * AztecLedgerSession. The recipient is supplied as a hex string;
 * amount is in atomic units (USDC has 6 decimals, so 1_000_000 = 1 USDC).
 */

import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecLedgerSession } from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import { type DemoState, sessionFromState } from '../state.ts';

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

function callWrapper(
  s: AztecLedgerSession,
  mode: Mode,
  to: AztecAddress,
  amount: bigint,
): Promise<unknown> {
  switch (mode) {
    case 'pub-pub':
      return s.transferUsdcPubToPub(to, amount);
    case 'priv-pub':
      return s.transferUsdcPrivToPub(to, amount);
    case 'pub-priv':
      return s.transferUsdcPubToPriv(to, amount);
    case 'priv-priv':
      return s.transferUsdcPrivToPriv(to, amount);
  }
}

export function TransferPanel({ state, setState }: Props) {
  const sessionRef = sessionFromState(state);
  const [mode, setMode] = useState<Mode>('pub-pub');
  const [toHex, setToHex] = useState('');
  const [amount, setAmount] = useState('100000000'); // 100 USDC

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
    setState({ kind: 'submitting', session: sessionRef, action: `transfer ${mode}` });
    try {
      await callWrapper(sessionRef.session, mode, to, atomic);
      setState({ kind: 'ready', session: sessionRef });
    } catch (e) {
      setState({
        kind: 'error',
        lastSession: sessionRef,
        message: e instanceof Error ? e.message : String(e),
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
        <label htmlFor="to">To</label>
        <input
          id="to"
          placeholder="0x… (Aztec address)"
          value={toHex}
          onChange={(e) => setToHex(e.target.value)}
          disabled={state.kind === 'submitting'}
        />
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
