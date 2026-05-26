/**
 * Speculos REST transport for the Aztec Ledger app.
 *
 * Talks to the Speculos emulator's HTTP API (default port 5000). The same
 * `LedgerTransport` shape works against `@ledgerhq/hw-transport-node-hid` for
 * real hardware — only the wire layer differs.
 *
 * On UI-blocking instructions (notably SIGN_OUTER_HASH), the APDU does not
 * resolve until the user confirms on-device. The transport accepts an optional
 * `autoConfirm` callback that is invoked after the APDU is posted, giving the
 * caller a chance to drive button-press events so the device review screen
 * completes. Without that callback, blocking instructions hang forever.
 */
import { CLA, type Ins } from './apdu.ts';
import type { ApduRequest, ApduResponse, LedgerTransport } from './transport.ts';

export type ButtonId = 'left' | 'right' | 'both';
export type FingerAction = 'press-and-release' | 'press' | 'release';

export interface SpeculosTransportOptions {
  /** Base URL of the Speculos REST API. Defaults to `http://localhost:5000`. */
  readonly baseUrl?: string;
  /** Per-request timeout in ms (does NOT apply during autoConfirm). */
  readonly timeoutMs?: number;
}

export interface AutoConfirmContext {
  /** Press a Nano button. */
  press(button: ButtonId): Promise<void>;
  /** Convenience: small async sleep. */
  sleep(ms: number): Promise<void>;
  /** Drain Speculos's screen-text event queue. Useful before a sequence of presses. */
  clearEvents(): Promise<void>;
  /** Fetch all event-stream entries currently buffered on the emulator. */
  getEvents(): Promise<readonly { text: string }[]>;
}

export class SpeculosTransport implements LedgerTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: SpeculosTransportOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'http://localhost:5000';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Send an APDU. If `autoConfirm` is supplied, it runs concurrently with the
   * APDU request so the caller can drive button presses while the device is
   * blocked on a confirmation screen.
   */
  async send(
    req: ApduRequest,
    autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>,
  ): Promise<ApduResponse> {
    const apduHex = encodeApdu(req);
    const apduPromise = this.postApdu(apduHex);

    if (autoConfirm) {
      const ctx: AutoConfirmContext = {
        press: (b) => this.pressButton(b),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        clearEvents: () => this.clearEvents(),
        getEvents: () => this.getEvents(),
      };
      // Fire-and-forget the confirm driver — errors here should not mask the
      // APDU response. Swallow + log if the API rejects (e.g. button endpoint
      // returns 4xx mid-flight when the device transitions back to the home
      // screen).
      autoConfirm(ctx).catch((err) => {
        // Use console.warn so test runners surface it; this is diagnostic only.
        console.warn('[SpeculosTransport] autoConfirm threw:', err);
      });
    }

    return apduPromise;
  }

  private async postApdu(hex: string): Promise<ApduResponse> {
    const res = await fetch(`${this.baseUrl}/apdu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: hex }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Speculos /apdu HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: string; error?: string };
    if (body.error) throw new Error(`Speculos /apdu error: ${body.error}`);
    if (!body.data) throw new Error('Speculos /apdu missing data field');
    return decodeApdu(body.data);
  }

  async pressButton(button: ButtonId): Promise<void> {
    const res = await fetch(`${this.baseUrl}/button/${button}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Speculos /button/${button} HTTP ${res.status}`);
    }
  }

  async clearEvents(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/events`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Speculos DELETE /events HTTP ${res.status}`);
  }

  async getEvents(): Promise<readonly { text: string }[]> {
    const res = await fetch(`${this.baseUrl}/events`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Speculos GET /events HTTP ${res.status}`);
    const body = (await res.json()) as { events: { text: string }[] };
    return body.events;
  }
}

function encodeApdu(req: ApduRequest): string {
  const ins = req.ins as Ins;
  const p1 = req.p1 ?? 0;
  const p2 = req.p2 ?? 0;
  const data = req.data ?? new Uint8Array(0);
  if (data.length > 0xff) {
    throw new Error(`APDU data too long: ${data.length} > 255 (no extended-length APDUs)`);
  }
  const header = new Uint8Array([CLA, ins, p1, p2, data.length]);
  const total = new Uint8Array(header.length + data.length);
  total.set(header, 0);
  total.set(data, header.length);
  return toHex(total);
}

function decodeApdu(hex: string): ApduResponse {
  if (hex.length < 4 || hex.length % 2 !== 0) {
    throw new Error(`Bad APDU response hex: ${hex}`);
  }
  const all = fromHex(hex);
  const sw = (all[all.length - 2]! << 8) | all[all.length - 1]!;
  const data = all.slice(0, all.length - 2);
  return { data, sw: sw as ApduResponse['sw'] };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}
