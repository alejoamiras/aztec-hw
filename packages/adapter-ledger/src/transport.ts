/**
 * Abstract Ledger transport — implemented by Speculos for testing, WebHID for
 * in-browser real devices, or `@ledgerhq/hw-transport-*` for desktop.
 *
 * APDU send/recv only; APDU encoding/decoding lives in `provider.ts`.
 */

import type { Ins, StatusWord } from './apdu.ts';

export interface ApduRequest {
  readonly ins: Ins;
  readonly p1?: number;
  readonly p2?: number;
  readonly data?: Uint8Array;
}

export interface ApduResponse {
  readonly data: Uint8Array;
  readonly sw: StatusWord;
}

/**
 * Context object passed to an `autoConfirm` callback. Only the SpeculosTransport
 * actually drives device buttons; other transports (WebHID, hw-transport-node-hid)
 * receive the callback but ignore it, since a human is operating the device.
 *
 * Kept here (and not in speculos-transport.ts) so `LedgerTransport.send`
 * doesn't have to import a concrete transport's types — provider.ts and any
 * caller can name the parameter type without coupling to Speculos.
 */
export interface AutoConfirmContext {
  /** Press a Nano button. */
  press(button: 'left' | 'right' | 'both'): Promise<void>;
  /** Convenience: small async sleep. */
  sleep(ms: number): Promise<void>;
  /** Drain Speculos's screen-text event queue. Useful before a sequence of presses. */
  clearEvents(): Promise<void>;
  /** Fetch all event-stream entries currently buffered on the emulator. */
  getEvents(): Promise<readonly { text: string }[]>;
}

export interface LedgerTransport {
  /**
   * Send a single APDU and wait for the response.
   *
   * `autoConfirm` is optional. Transports that have no automated way to
   * confirm an on-device prompt (WebHID, hw-transport-node-hid) ignore it
   * — a human approves on the device. Speculos consumes it to drive button
   * presses while the APDU is blocked on the review screen.
   */
  send(
    req: ApduRequest,
    autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>,
  ): Promise<ApduResponse>;
  close?(): Promise<void>;
}
