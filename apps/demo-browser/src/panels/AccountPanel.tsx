/**
 * Account panel — visible once Connect succeeds. Shows the account address
 * and exposes Deploy (one-time, blind-signed on device) + Drip (recurring,
 * clear-signed) buttons.
 *
 * The account contract MUST be deployed before any other tx — its private
 * state (signing pubkey as SinglePrivateImmutable) needs to exist on chain,
 * otherwise the entrypoint asserts `self.is_some()` inside Noir.
 */
import { type DemoState, sessionFromState } from '../state.ts';

interface Props {
  state: DemoState;
  setState: (next: DemoState) => void;
}

export function AccountPanel({ state, setState }: Props) {
  const session = sessionFromState(state);
  const disabled = !session || state.kind === 'connecting' || state.kind === 'submitting';

  async function runAction(name: 'deploy' | 'drip', fn: () => Promise<unknown>) {
    if (!session) return;
    setState({ kind: 'submitting', session, action: name });
    try {
      await fn();
      setState({ kind: 'ready', session });
    } catch (e) {
      if (e instanceof Error) {
        console.error(
          'Action failed JSON: ' +
            JSON.stringify({ name: e.name, message: e.message, stack: e.stack }, null, 2),
        );
      }
      setState({
        kind: 'error',
        lastSession: session,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const isDeploying = state.kind === 'submitting' && state.action === 'deploy';
  const isDripping = state.kind === 'submitting' && state.action === 'drip';

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
            <button
              type="button"
              onClick={() => runAction('deploy', () => session.session.deployAccount())}
              disabled={state.kind === 'submitting'}
            >
              {isDeploying ? 'Deploying…' : 'Deploy account'}
            </button>
            <span className="status muted">One-time. Blind-signed on device.</span>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => runAction('drip', () => session.session.dripUsdc(1_000_000_000n))}
              disabled={state.kind === 'submitting'}
            >
              {isDripping ? 'Dripping…' : 'Drip 1000 USDC'}
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
