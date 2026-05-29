/**
 * Connect panel — pick a transport, choose the Aztec node URL, build the
 * AztecLedgerSession. After this resolves, the rest of the UI unlocks.
 */

import {
  createWebHidTransport,
  LedgerProvider,
  SpeculosTransport,
  WebHidNotSupportedError,
} from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import type { DemoState, Transport } from '../state.ts';

/* Route through Vite's /aztec proxy so the browser doesn't block the
 * cross-origin fetch under COEP=require-corp (the testnet RPC doesn't
 * set Cross-Origin-Resource-Policy). Path is rewritten to the real RPC
 * in vite.config.ts. */
const DEFAULT_NODE_URL = '/aztec';
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
    state.kind === 'onboarding' ||
    state.kind === 'ready' ||
    state.kind === 'submitting' ||
    state.kind === 'error';

  async function onConnect() {
    setState({ kind: 'connecting', transport, nodeUrl });
    try {
      /* Open the transport and verify the device is alive + running the
       * Aztec app (fail fast with a clear error before the user is asked to
       * approve anything). The heavy session build + the device-secret reveal
       * happen in the explicit "Derive viewing keys" step (OnboardPanel) —
       * M8 P7.3: onboarding is a deliberate step, never folded into Connect. */
      const txp =
        transport === 'speculos'
          ? new SpeculosTransport({ baseUrl: SPECULOS_PROXY_URL })
          : await createWebHidTransport();
      await new LedgerProvider(txp).getVersion();
      setState({ kind: 'onboarding', transport, nodeUrl, ledger: txp });
    } catch (e) {
      /* Surface the full stack to the browser console so Playwright /
       * devtools picks it up — the on-screen banner only carries the
       * top-line message. Stack is stringified so newlines survive
       * Playwright's console.text() concatenation. */
      if (e instanceof Error) {
        console.error(
          'Connect failed JSON: ' +
            JSON.stringify({ name: e.name, message: e.message, stack: e.stack }, null, 2),
        );
      } else {
        console.error('Connect failed (non-Error):', e);
      }
      const msg =
        e instanceof WebHidNotSupportedError
          ? 'WebHID is unavailable. Use Chromium-based browser over HTTPS (or localhost), or pick the Speculos transport.'
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', lastSession: null, message: msg });
    }
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
          Vite proxies <code>{SPECULOS_PROXY_URL}</code> → <code>localhost:5001</code>. Start the
          emulator (web UI also at{' '}
          <a href="http://localhost:5001/" target="_blank" rel="noreferrer">
            localhost:5001
          </a>
          ) before clicking Connect.
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
          {isConnecting ? 'Connecting…' : isConnected ? '✓ Connected' : 'Connect'}
        </button>
        <span className="status muted">
          {isConnecting
            ? 'Opening transport, verifying device…'
            : state.kind === 'onboarding'
              ? 'Device verified. Derive your viewing keys in panel 1.5.'
              : isConnected
                ? 'Session live. Account shown in panel 2.'
                : 'Connects + verifies your device. Onboarding is the next step.'}
        </span>
      </div>
      {state.kind === 'error' && <div className="status err">{state.message}</div>}
    </section>
  );
}
