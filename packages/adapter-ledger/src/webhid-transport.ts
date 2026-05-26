/**
 * WebHID transport for the Aztec Ledger app — talks to a real Ledger device
 * connected via USB in a browser. Wraps `@ledgerhq/hw-transport-webhid`'s
 * APDU exchange behind our `LedgerTransport` interface so `LedgerProvider`
 * sees the same shape as Speculos.
 *
 * Differences from SpeculosTransport:
 *  - `autoConfirm` is silently ignored. WebHID can't drive button presses
 *    on a physical device; the user approves on-device. The parameter is
 *    accepted for interface compatibility.
 *  - APDU is sent as raw bytes (no hex encoding, no JSON wrapping).
 *  - Device-disconnect raises a typed error so the UI can react.
 *
 * The hw-transport-webhid `exchange()` returns a Buffer/Uint8Array containing
 * the response data with a trailing 2-byte status word. We slice them apart
 * to match our `ApduResponse` shape.
 */
import TransportWebHID from '@ledgerhq/hw-transport-webhid';

import { CLA, type Ins } from './apdu.ts';
import type {
  ApduRequest,
  ApduResponse,
  AutoConfirmContext,
  LedgerTransport,
} from './transport.ts';

export class WebHidNotSupportedError extends Error {
  constructor() {
    super(
      'WebHID is not supported in this environment. Requires a Chromium-based ' +
        'browser served over HTTPS (or localhost), with the user having approved ' +
        'navigator.hid access for the Ledger device.',
    );
    this.name = 'WebHidNotSupportedError';
  }
}

export class WebHidDeviceDisconnectedError extends Error {
  constructor(cause?: unknown) {
    super('Ledger device disconnected from WebHID');
    this.name = 'WebHidDeviceDisconnectedError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Open a WebHID connection to a Ledger device. Pops the browser-native
 * device picker if the user hasn't authorized one yet. Throws
 * WebHidNotSupportedError synchronously if navigator.hid is unavailable
 * (Safari, Firefox, non-secure contexts).
 */
export async function createWebHidTransport(): Promise<WebHidLedgerTransport> {
  if (typeof navigator === 'undefined' || !('hid' in navigator)) {
    throw new WebHidNotSupportedError();
  }
  const supported = await TransportWebHID.isSupported();
  if (!supported) {
    throw new WebHidNotSupportedError();
  }
  const inner = await TransportWebHID.create();
  return new WebHidLedgerTransport(inner);
}

interface InnerWebHidTransport {
  exchange(apdu: Uint8Array | Buffer): Promise<Uint8Array | Buffer>;
  close(): Promise<void>;
  on(event: 'disconnect', cb: () => void): void;
}

export class WebHidLedgerTransport implements LedgerTransport {
  private disconnected = false;

  constructor(private readonly inner: InnerWebHidTransport) {
    inner.on('disconnect', () => {
      this.disconnected = true;
    });
  }

  /**
   * @param autoConfirm  Accepted for interface compatibility. Silently
   *                     ignored — a human operates the physical device.
   */
  async send(
    req: ApduRequest,
    _autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>,
  ): Promise<ApduResponse> {
    if (this.disconnected) {
      throw new WebHidDeviceDisconnectedError();
    }
    const apdu = encodeApduBytes(req);
    let response: Uint8Array;
    try {
      const raw = await this.inner.exchange(apdu);
      response = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    } catch (err) {
      if (this.disconnected) throw new WebHidDeviceDisconnectedError(err);
      throw err;
    }
    if (response.length < 2) {
      throw new Error(`WebHID exchange returned ${response.length} bytes; minimum 2 (status word)`);
    }
    const sw = (response[response.length - 2]! << 8) | response[response.length - 1]!;
    return { data: response.slice(0, response.length - 2), sw };
  }

  async close(): Promise<void> {
    if (this.disconnected) return;
    await this.inner.close();
    this.disconnected = true;
  }
}

/**
 * Build the canonical 5+ byte APDU header + body. WebHID transports want raw
 * bytes (the underlying USB HID layer handles fragmentation).
 *
 *   CLA(1) | INS(1) | P1(1) | P2(1) | LC(1) | DATA(LC)
 */
function encodeApduBytes(req: ApduRequest): Uint8Array {
  const data = req.data ?? new Uint8Array();
  if (data.length > 255) {
    throw new Error(`APDU data too long for short-form Lc: ${data.length} bytes`);
  }
  const out = new Uint8Array(5 + data.length);
  out[0] = CLA;
  out[1] = req.ins as Ins as number;
  out[2] = req.p1 ?? 0;
  out[3] = req.p2 ?? 0;
  out[4] = data.length;
  out.set(data, 5);
  return out;
}
