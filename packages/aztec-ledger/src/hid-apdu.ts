/**
 * Shared APDU wire-encoding for the USB-HID transports (WebHID + node-hid).
 *
 * Both raw-USB-HID transports send the canonical short-form APDU; only Speculos
 * uses a different (hex/JSON) framing. Kept here so the two HID transports can't
 * drift apart.
 */
import { CLA, type Ins } from './apdu.ts';
import type { ApduRequest } from './transport.ts';

/**
 * Build the canonical 5+ byte APDU header + body. HID transports want raw bytes
 * (the underlying USB HID layer handles fragmentation).
 *
 *   CLA(1) | INS(1) | P1(1) | P2(1) | LC(1) | DATA(LC)
 */
export function encodeApduBytes(req: ApduRequest): Uint8Array {
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
