/**
 * WebHID transport unit tests. Mocks the inner `@ledgerhq/hw-transport-webhid`
 * exchange to verify our wrapper handles APDU encoding, status-word splitting,
 * and disconnect signalling without needing a physical Ledger.
 *
 * Real-device coverage lives at M6.5 (alpha-testnet e2e) where a Ledger Nano S+
 * is on USB. These tests cover the wire-shape contract only.
 */
import { describe, expect, mock, test } from 'bun:test';
import { CLA, INS } from './apdu.ts';
import { WebHidDeviceDisconnectedError, WebHidLedgerTransport } from './webhid-transport.ts';

interface MockHidOpts {
  reply: Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
  recordApdu?: (apdu: Uint8Array) => void;
}

function mockHid(opts: MockHidOpts): {
  inner: {
    exchange: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
    on: (event: 'disconnect', cb: () => void) => void;
    emitDisconnect: () => void;
  };
} {
  let disconnectCb: (() => void) | null = null;
  return {
    inner: {
      exchange: mock(async (apdu: Uint8Array) => {
        opts.recordApdu?.(apdu);
        return typeof opts.reply === 'function' ? await opts.reply() : opts.reply;
      }),
      close: mock(async () => {}),
      on: (event, cb) => {
        if (event === 'disconnect') disconnectCb = cb;
      },
      emitDisconnect: () => disconnectCb?.(),
    },
  };
}

describe('WebHidLedgerTransport', () => {
  test('encodes a GET_VERSION APDU as CLA INS 00 00 00 (no body)', async () => {
    const apdus: Uint8Array[] = [];
    const { inner } = mockHid({
      reply: new Uint8Array([0x01, 0x02, 0x03, 0x90, 0x00]),
      recordApdu: (a) => apdus.push(a),
    });
    const t = new WebHidLedgerTransport(inner);
    const res = await t.send({ ins: INS.GET_VERSION });

    expect(apdus.length).toBe(1);
    expect(apdus[0]).toEqual(new Uint8Array([CLA, INS.GET_VERSION, 0x00, 0x00, 0x00]));
    expect(res.sw).toBe(0x9000);
    expect(Array.from(res.data)).toEqual([0x01, 0x02, 0x03]);
  });

  test('encodes APDU body length in Lc + appends data', async () => {
    const apdus: Uint8Array[] = [];
    const { inner } = mockHid({
      reply: new Uint8Array([0x90, 0x00]),
      recordApdu: (a) => apdus.push(a),
    });
    const t = new WebHidLedgerTransport(inner);
    const body = new Uint8Array([0xaa, 0xbb, 0xcc]);
    await t.send({ ins: INS.SIGN_OUTER_HASH, data: body });

    expect(apdus[0]).toEqual(
      new Uint8Array([CLA, INS.SIGN_OUTER_HASH, 0x00, 0x00, 0x03, 0xaa, 0xbb, 0xcc]),
    );
  });

  test('splits trailing 2-byte status word', async () => {
    /* Use a SW that's actually in the typed enum. 0x6985 is
     * CONDITIONS_NOT_SATISFIED, emitted on user rejection. */
    const { inner } = mockHid({
      reply: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x69, 0x85]),
    });
    const t = new WebHidLedgerTransport(inner);
    const res = await t.send({ ins: INS.APPEND_CALL });
    expect(res.sw).toBe(0x6985);
    expect(Array.from(res.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test('ignores autoConfirm silently (no exchange args change)', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90, 0x00]) });
    const t = new WebHidLedgerTransport(inner);
    let autoConfirmCalled = false;
    await t.send({ ins: INS.GET_VERSION }, async () => {
      autoConfirmCalled = true;
    });
    expect(autoConfirmCalled).toBe(false);
    expect(inner.exchange).toHaveBeenCalledTimes(1);
  });

  test('throws WebHidDeviceDisconnectedError after disconnect event', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90, 0x00]) });
    const t = new WebHidLedgerTransport(inner);
    inner.emitDisconnect();
    await expect(t.send({ ins: INS.GET_VERSION })).rejects.toBeInstanceOf(
      WebHidDeviceDisconnectedError,
    );
  });

  test('close() is a no-op after disconnect (idempotent)', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90, 0x00]) });
    const t = new WebHidLedgerTransport(inner);
    inner.emitDisconnect();
    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(0);
  });

  test('close() forwards to inner when still connected', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90, 0x00]) });
    const t = new WebHidLedgerTransport(inner);
    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  test('rejects APDU body > 255 bytes (short-form Lc only)', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90, 0x00]) });
    const t = new WebHidLedgerTransport(inner);
    await expect(t.send({ ins: INS.APPEND_CALL, data: new Uint8Array(256) })).rejects.toThrow(
      /APDU data too long/,
    );
  });

  test('throws on responses shorter than 2 bytes (must have SW)', async () => {
    const { inner } = mockHid({ reply: new Uint8Array([0x90]) });
    const t = new WebHidLedgerTransport(inner);
    await expect(t.send({ ins: INS.GET_VERSION })).rejects.toThrow(/minimum 2 \(status word\)/);
  });
});
