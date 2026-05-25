/**
 * Abstract Ledger transport — implemented by Speculos for testing or by
 * `@ledgerhq/hw-transport-*` for real devices.
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

export interface LedgerTransport {
  /** Send a single APDU and wait for the response. */
  send(req: ApduRequest): Promise<ApduResponse>;
  close?(): Promise<void>;
}
