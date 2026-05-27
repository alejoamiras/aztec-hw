/**
 * Speculos panel — live screen text (polled every 500ms) + REST API
 * buttons. The iframe approach was flaky across Chrome versions + COEP
 * modes (often surfaced as "localhost refused to connect" even when
 * Speculos was up). The polled-screen alternative is rock-solid and
 * lets the user see exactly what's on the device without alt-tabbing.
 *
 * Buttons hit Speculos's REST API via Vite's /speculos proxy
 * (same-origin from the page's POV, no CORS pain). Same mechanism the
 * existing M5 test infra uses successfully — proven by 6/6
 * `bun test packages/adapter-ledger/src/provider.test.ts`.
 */
import { useEffect, useState } from 'react';

const SPECULOS_PROXY = '/speculos';
const SPECULOS_DIRECT = 'http://localhost:5001';

async function pressButton(button: 'left' | 'right' | 'both', delaySeconds = 0): Promise<void> {
  const body: Record<string, unknown> = { action: 'press-and-release' };
  if (delaySeconds > 0) body.delay = delaySeconds;
  try {
    await fetch(`${SPECULOS_PROXY}/button/${button}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* Speculos down — bigger problem than a button press. */
  }
}

interface ScreenEvent {
  text: string;
}

async function fetchScreen(): Promise<string> {
  try {
    const res = await fetch(`${SPECULOS_PROXY}/events?currentscreenonly=true`);
    if (!res.ok) return '<no response>';
    const json = (await res.json()) as { events: ScreenEvent[] };
    return json.events
      .map((e) => e.text)
      .join(' | ')
      .trim();
  } catch {
    return '<speculos unreachable>';
  }
}

interface Props {
  /** Invoked when the docker restart succeeds. Lets the parent drop
   * back to idle since the existing transport handle is now pointing
   * at a dead Speculos container. */
  onReset?: () => void;
}

export function SpeculosPanel({ onReset }: Props = {}) {
  const [screen, setScreen] = useState('<polling…>');
  const [pressing, setPressing] = useState(false);
  const [pressLog, setPressLog] = useState<{ id: number; label: string }[]>([]);

  /* Poll the device screen every 500ms. Cheap (one HTTP call) and gives
   * the user instant feedback on whether button presses are landing. */
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      const s = await fetchScreen();
      if (!cancelled) setScreen(s);
      timeout = setTimeout(tick, 500);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  async function go(
    label: string,
    button: 'left' | 'right' | 'both',
    delaySeconds = 0,
  ): Promise<void> {
    if (pressing) return;
    setPressing(true);
    setPressLog((log) => [...log.slice(-9), { id: Date.now(), label: `▶ ${label}` }]);
    await pressButton(button, delaySeconds);
    const s = await fetchScreen();
    setScreen(s);
    setPressing(false);
  }

  async function reset(): Promise<void> {
    setPressing(true);
    setPressLog((log) => [...log.slice(-9), { id: Date.now(), label: '↻ Reset (docker restart)' }]);
    try {
      await fetch('/api/speculos/restart', { method: 'POST' });
      setScreen('<restarting…>');
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await fetchScreen();
        if (s && !s.includes('unreachable') && !s.includes('no response')) {
          setScreen(s);
          break;
        }
      }
      /* The old transport in AztecLedgerSession is pointing at a dead
       * Speculos container; the session has to be torn down and rebuilt. */
      onReset?.();
    } catch {
      setScreen('<reset failed — Speculos may need manual restart>');
    } finally {
      setPressing(false);
    }
  }

  return (
    <section className="panel speculos-panel">
      <h2>Speculos device</h2>
      <div className="screen-readout">
        <span className="screen-label">Screen</span>
        <span className="screen-text">{screen || '<idle>'}</span>
      </div>
      <div className="speculos-buttons">
        <button type="button" onClick={() => go('Left', 'left')} disabled={pressing}>
          ◀ Left
        </button>
        <button type="button" onClick={() => go('Both', 'both')} disabled={pressing}>
          Both ◉
        </button>
        <button type="button" onClick={() => go('Both (hold 2s)', 'both', 2)} disabled={pressing}>
          Both (hold 2s)
        </button>
        <button type="button" onClick={() => go('Right', 'right')} disabled={pressing}>
          Right ▶
        </button>
      </div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          className="secondary"
          onClick={reset}
          disabled={pressing}
          style={{ width: '100%' }}
        >
          ↻ Reset device (restart Speculos)
        </button>
      </div>
      <div className="press-log">
        {pressLog.length === 0 ? (
          <span className="status muted">No presses yet.</span>
        ) : (
          pressLog.map((p) => (
            <div key={p.id} className="press-log-item">
              {p.label}
            </div>
          ))
        )}
      </div>
      <div className="status muted">
        Screen polls 2×/s. Buttons hit the REST API directly. If you want to see the rendered
        device,{' '}
        <a href={SPECULOS_DIRECT} target="_blank" rel="noreferrer">
          open Speculos in a new tab
        </a>
        .
      </div>
    </section>
  );
}
