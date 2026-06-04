/**
 * node-hid transport — the two node-hid-specific behaviors, hardware-free:
 *  1. the OPTIONAL peer fails CLOSED with a typed error when absent, and
 *  2. the disconnect guard rejects a send after a USB unplug.
 * The APDU wire-encoding itself is the shared `encodeApduBytes` (hid-apdu.ts),
 * exercised by the WebHID + device suites — not re-tested here.
 */
import { describe, expect, test } from 'bun:test';
import {
  createNodeHidTransport,
  NodeHidDeviceDisconnectedError,
  NodeHidLedgerTransport,
  NodeHidNotAvailableError,
} from './node-hid-transport.ts';

describe('NodeHidTransport (optional peer)', () => {
  test('createNodeHidTransport fails closed when @ledgerhq/hw-transport-node-hid is absent', async () => {
    // It's an optional peer, NOT installed in this workspace — the dynamic
    // import must surface as the typed NodeHidNotAvailableError, not a raw throw.
    await expect(createNodeHidTransport()).rejects.toBeInstanceOf(NodeHidNotAvailableError);
  });

  test('send() after a device disconnect throws NodeHidDeviceDisconnectedError', async () => {
    let fireDisconnect: () => void = () => {};
    const inner = {
      exchange: async () => new Uint8Array([0x90, 0x00]),
      close: async () => {},
      on: (_event: 'disconnect', cb: () => void) => {
        fireDisconnect = cb;
      },
    };
    const transport = new NodeHidLedgerTransport(inner);
    fireDisconnect(); // simulate USB unplug
    // `send` checks the disconnect flag before touching the request, so the
    // request shape is irrelevant here.
    await expect(transport.send({} as never)).rejects.toBeInstanceOf(
      NodeHidDeviceDisconnectedError,
    );
  });
});
