/**
 * Pure unit tests for the Speculos transport — no Speculos required.
 *
 * Covers the host-side APDU encoding/decoding logic so a regression there
 * (e.g. wrong length byte, wrong hex casing) surfaces without spinning up
 * the emulator container.
 */
import { describe, expect, test } from 'bun:test';
import { INS, SW } from './apdu.ts';
import { SpeculosTransport } from './speculos-transport.ts';

interface CapturedRequest {
  url: string;
  body: { data: string };
}

type FetchFn = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function makeFetchStub(response: { data?: string; error?: string }): {
  fetch: FetchFn;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchStub: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as { data: string }) : { data: '' };
    captured.push({ url, body });
    return new Response(JSON.stringify(response), { status: 200 });
  };
  return { fetch: fetchStub, captured };
}

describe('SpeculosTransport — APDU encoding', () => {
  test('encodes an empty-body APDU as 5 bytes (CLA INS P1 P2 Lc=00)', async () => {
    const { fetch, captured } = makeFetchStub({ data: '9000' });
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: FetchFn }).fetch = fetch;
    try {
      const transport = new SpeculosTransport({ baseUrl: 'http://example' });
      await transport.send({ ins: INS.GET_VERSION });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe('http://example/apdu');
      expect(captured[0]!.body.data).toBe('e001000000');
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });

  test('encodes a body APDU with the right Lc and data', async () => {
    const { fetch, captured } = makeFetchStub({ data: '9000' });
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: FetchFn }).fetch = fetch;
    try {
      const transport = new SpeculosTransport({ baseUrl: 'http://example' });
      await transport.send({
        ins: INS.GET_PUBLIC_KEY,
        p1: 0,
        p2: 0,
        data: new Uint8Array([0x01, 0xab, 0xcd]),
      });
      expect(captured[0]!.body.data).toBe('e0030000030' + '1abcd');
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });

  test('rejects bodies longer than 255 bytes (no extended-length APDUs)', async () => {
    const transport = new SpeculosTransport({ baseUrl: 'http://example' });
    const tooLong = new Uint8Array(256);
    await expect(transport.send({ ins: INS.SIGN_OUTER_HASH, data: tooLong })).rejects.toThrow(
      /APDU data too long/,
    );
  });
});

describe('SpeculosTransport — APDU decoding', () => {
  test('splits payload and SW correctly for a 4-byte response', async () => {
    const { fetch } = makeFetchStub({ data: '000000019000' });
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: FetchFn }).fetch = fetch;
    try {
      const transport = new SpeculosTransport({ baseUrl: 'http://example' });
      const r = await transport.send({ ins: INS.GET_CAPS });
      expect(r.sw).toBe(SW.OK);
      expect(Array.from(r.data)).toEqual([0, 0, 0, 1]);
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });

  test('propagates a non-OK status word in the response', async () => {
    const { fetch } = makeFetchStub({ data: '6985' });
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: FetchFn }).fetch = fetch;
    try {
      const transport = new SpeculosTransport({ baseUrl: 'http://example' });
      const r = await transport.send({ ins: INS.SIGN_OUTER_HASH });
      expect(r.sw).toBe(SW.CONDITIONS_NOT_SATISFIED);
      expect(r.data.length).toBe(0);
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });

  test('throws on Speculos-side error envelope', async () => {
    const { fetch } = makeFetchStub({ error: 'bad pattern' });
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: FetchFn }).fetch = fetch;
    try {
      const transport = new SpeculosTransport({ baseUrl: 'http://example' });
      await expect(transport.send({ ins: INS.GET_VERSION })).rejects.toThrow(/bad pattern/);
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });
});
