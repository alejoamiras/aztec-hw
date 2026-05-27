/**
 * Connect panel — pick a transport, choose the Aztec node URL, build the
 * session. The actual session-construction wiring (LedgerEcdsaKAccount
 * + SessionEmbeddedWallet + AccountManager) lands at M6.5; right now this
 * panel exercises the state machine and validates the transport pick.
 */
import { useState } from 'react';
import type { DemoState, Transport } from '../state.ts';

const DEFAULT_NODE_URL = 'https://rpc.testnet.aztec-labs.com';
const SPECULOS_PROXY_URL = '/speculos';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function ConnectPanel({ state, setState }: Props) {
  const [transport, setTransport] = useState<Transport>('speculos');
  const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE_URL);

  const isConnecting = state.kind === 'connecting';
  const isConnected =
    state.kind === 'ready' || state.kind === 'submitting' || state.kind === 'error';

  async function onConnect() {
    setState({ kind: 'connecting', transport, nodeUrl });
    /* Wiring lives in M6.5 — instantiating SessionEmbeddedWallet + the
     * Ledger transport + the LedgerEcdsaKAccountContract + AccountManager
     * takes several blocking steps (PXE init, prover WASM load, sync to
     * tip, getNodeInfo). All gated to the next phase. */
    setState({
      kind: 'error',
      lastSession: null,
      message:
        'Connect flow is wired to the AztecLedgerSession scaffold but not yet ' +
        'producing a live PXE session — lands in M6.5 alongside the alpha-' +
        'testnet e2e tests.',
    });
  }

  return (
    <section className="panel">
      <h2>1. Connect</h2>
      <div className="row">
        <label htmlFor="transport">Transport</label>
        <select
          id="transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as Transport)}
          disabled={isConnecting || isConnected}
        >
          <option value="speculos">Speculos (dev only)</option>
          <option value="webhid">WebHID (real Ledger)</option>
        </select>
      </div>
      {transport === 'speculos' && (
        <div className="status muted">
          Vite proxies <code>{SPECULOS_PROXY_URL}</code> → <code>localhost:5000</code>. Start the
          emulator before clicking Connect.
        </div>
      )}
      <div className="row">
        <label htmlFor="node-url">Node URL</label>
        <input
          id="node-url"
          value={nodeUrl}
          onChange={(e) => setNodeUrl(e.target.value)}
          disabled={isConnecting || isConnected}
        />
      </div>
      <div className="row">
        <button type="button" onClick={onConnect} disabled={isConnecting || isConnected}>
          {isConnecting ? 'Connecting…' : isConnected ? 'Connected' : 'Connect'}
        </button>
        {isConnected && state.kind !== 'error' && (
          <span className="status ok">
            Account: <span className="address">{state.session.addressHex}</span>
          </span>
        )}
      </div>
      {state.kind === 'error' && <div className="status err">{state.message}</div>}
    </section>
  );
}
