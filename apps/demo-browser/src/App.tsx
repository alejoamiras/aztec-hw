/**
 * Top-level demo UI. Three panels:
 *
 *   1. Connect — pick Speculos (dev) or WebHID (real device), choose the
 *      Aztec node URL (defaults to alpha-testnet), open the session.
 *   2. Account & Drip — show the deployed account address, drip 1000 USDC.
 *   3. Transfer — 4 transfer modes (pub→pub, priv→pub, pub→priv, priv→priv)
 *      + a recipient/amount form.
 *
 * The state machine: idle → connecting → ready → submitting → ready (loop).
 * Errors return to the previous good state with a banner.
 *
 * For M6.4 this is a skeleton — wiring against a live PXE happens at M6.5.
 * Most "Run" buttons currently surface a `not-yet-wired` message so the user
 * can see the flow shape during the deep-plan handoff.
 */
import { useState } from 'react';
import { AccountPanel } from './panels/AccountPanel.tsx';
import { ConnectPanel } from './panels/ConnectPanel.tsx';
import { TransferPanel } from './panels/TransferPanel.tsx';
import type { DemoState } from './state.ts';

export function App() {
  const [state, setState] = useState<DemoState>({ kind: 'idle' });

  return (
    <main>
      <h1>Aztec Ledger Demo</h1>
      <p className="subtitle">In-browser PXE + Ledger clear-signing on testnet. M6 deliverable.</p>
      <ConnectPanel state={state} setState={setState} />
      <AccountPanel state={state} setState={setState} />
      <TransferPanel state={state} setState={setState} />
    </main>
  );
}
