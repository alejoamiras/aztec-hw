/**
 * Connect panel — pick a transport, choose the Aztec node URL, build the
 * AztecLedgerSession. After this resolves, the rest of the UI unlocks.
 */

import {
  AztecLedgerSession,
  createWebHidTransport,
  SpeculosTransport,
  WebHidNotSupportedError,
} from '@aztec-hwwallet-poc/adapter-ledger';
import { useState } from 'react';
import {
  DRIPPER_ARTIFACT,
  dripperInstance,
  SPONSORED_FPC_ADDRESS,
  TOKEN_ARTIFACT,
  usdcInstance,
} from '../deployments.ts';
import type { DemoState, SessionRef, Transport } from '../state.ts';

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
    try {
      /* 1. Open the transport. */
      const txp =
        transport === 'speculos'
          ? new SpeculosTransport({ baseUrl: SPECULOS_PROXY_URL })
          : await createWebHidTransport();

      /* 2. Recompute the deployed contract instances from nulo's
       *    pinned salt+constructor args. PXE rejects address-only
       *    overrides (codex BLOCKER 1), so we have to derive the
       *    FULL ContractInstanceWithAddress here. */
      const [usdc, dripper] = await Promise.all([usdcInstance(), dripperInstance()]);

      /* 3. Spin up the session. Heavy — first call pays ~3-5s WASM-prover
       *    init cost and an initial PXE sync against the node. */
      const session = await AztecLedgerSession.connect({
        nodeUrl,
        transport: txp,
        tokenArtifact: TOKEN_ARTIFACT,
        dripperArtifact: DRIPPER_ARTIFACT,
        usdcInstance: usdc,
        dripperInstance: dripper,
        sponsoredFpcAddress: SPONSORED_FPC_ADDRESS,
      });

      const ref: SessionRef = {
        transport,
        nodeUrl,
        addressHex: session.address.toString(),
        session,
      };
      setState({ kind: 'ready', session: ref });
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
