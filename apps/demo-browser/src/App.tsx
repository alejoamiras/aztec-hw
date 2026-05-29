import { useState } from 'react';
import { AccountPanel } from './panels/AccountPanel.tsx';
import { ConnectPanel } from './panels/ConnectPanel.tsx';
import { OnboardPanel } from './panels/OnboardPanel.tsx';
import { SpeculosPanel } from './panels/SpeculosPanel.tsx';
import { StatusBar } from './panels/StatusBar.tsx';
import { TransferPanel } from './panels/TransferPanel.tsx';
import type { DemoState } from './state.ts';

export function App() {
  const [state, setState] = useState<DemoState>({ kind: 'idle' });

  /* Drop back to idle. Used after a device-side reset (docker restart
   * Speculos) since the transport handle becomes invalid. Connect has
   * to run again to pair with the fresh emulator instance. */
  const resetSession = () => setState({ kind: 'idle' });

  return (
    <main>
      <h1>Aztec Ledger Demo</h1>
      <p className="subtitle">In-browser PXE + Ledger clear-signing on testnet. M6 deliverable.</p>
      <StatusBar state={state} />
      <div className="layout">
        <div className="layout-main">
          <ConnectPanel state={state} setState={setState} />
          <OnboardPanel state={state} setState={setState} />
          <AccountPanel state={state} setState={setState} />
          <TransferPanel state={state} setState={setState} />
        </div>
        <aside className="layout-aside">
          <SpeculosPanel onReset={resetSession} />
        </aside>
      </div>
    </main>
  );
}
