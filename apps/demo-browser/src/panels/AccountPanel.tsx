/**
 * Account & drip panel — visible once Connect succeeds. Shows the account
 * address and exposes a "Drip 1000 USDC" button that calls
 * `session.dripUsdc(1000_000_000n)`. The full wrapper lands at M6.5;
 * today this just exercises the in-flight mutex + state transitions.
 */
import { type DemoState, sessionFromState } from '../state.ts';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function AccountPanel({ state, setState }: Props) {
  const session = sessionFromState(state);
  const disabled = !session || state.kind === 'connecting' || state.kind === 'submitting';

  async function onDrip() {
    if (!session) return;
    setState({ kind: 'submitting', session, action: 'drip' });
    try {
      await session.session.dripUsdc(1_000_000_000n);
      setState({ kind: 'ready', session });
    } catch (e) {
      setState({
        kind: 'error',
        lastSession: session,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <section className={`panel ${disabled ? 'disabled' : ''}`}>
      <h2>2. Account &amp; Drip</h2>
      {session ? (
        <>
          <div className="row">
            <span style={{ minWidth: '6rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
              Address
            </span>
            <span className="address">{session.addressHex}</span>
          </div>
          <div className="row">
            <button type="button" onClick={onDrip} disabled={state.kind === 'submitting'}>
              {state.kind === 'submitting' && state.action === 'drip'
                ? 'Dripping…'
                : 'Drip 1000 USDC'}
            </button>
            <span className="status muted">
              Sponsored. Clear-signed on-device. Mints to msg.sender.
            </span>
          </div>
        </>
      ) : (
        <div className="status muted">Connect first.</div>
      )}
    </section>
  );
}
