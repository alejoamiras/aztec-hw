import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec-hwwallet-poc/core';
import { TrezorEcdsaKAuthWitnessProvider } from './provider.ts';
import type { TrezorTransport } from './transport.ts';

/**
 * Mock transport that records calls and returns canned values.
 * Lets us unit-test the adapter logic (preimage, signature unpacking, low-s normalize,
 * AuthWitness assembly) without a Trezor emulator running.
 */
function makeMockTransport(opts: {
  publicKey?: Uint8Array;
  signature?: Uint8Array;
}): TrezorTransport & {
  calls: {
    getPublicKey: Array<{ identity: string; ecdsaCurve: string }>;
    signIdentity: Array<{
      identity: string;
      ecdsaCurve: string;
      challengeHidden: Uint8Array;
      challengeVisual?: string;
    }>;
  };
} {
  const calls = {
    getPublicKey: [] as Array<{ identity: string; ecdsaCurve: string }>,
    signIdentity: [] as Array<{
      identity: string;
      ecdsaCurve: string;
      challengeHidden: Uint8Array;
      challengeVisual?: string;
    }>,
  };
  const pkBytes =
    opts.publicKey ??
    (() => {
      const b = new Uint8Array(65);
      b[0] = 0x04;
      b[1] = 0xaa;
      b[33] = 0xbb;
      return b;
    })();
  const sigBytes =
    opts.signature ??
    (() => {
      // marker (1) || r (32) || s (32). Synthetic low-s value.
      const b = new Uint8Array(65);
      b[0] = 0x20; // recovery marker
      b[1] = 0xaa; // r start
      b[33] = 0x01; // s start (low-s)
      return b;
    })();
  return {
    calls,
    async getPublicKey(identity, ecdsaCurve) {
      calls.getPublicKey.push({ identity, ecdsaCurve });
      return { bytes: pkBytes };
    },
    async signIdentity(args) {
      calls.signIdentity.push(args);
      return { signature: sigBytes, publicKey: { bytes: pkBytes } };
    },
  };
}

describe('TrezorEcdsaKAuthWitnessProvider — public key', () => {
  test('caches the device pubkey across calls', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const a = await provider.getPublicKey();
    const b = await provider.getPublicKey();
    expect(a).toBe(b); // same reference — cached
    expect(transport.calls.getPublicKey.length).toBe(1);
  });

  test('rejects non-uncompressed public key formats', async () => {
    const compressed = new Uint8Array(33);
    compressed[0] = 0x02;
    const transport = makeMockTransport({ publicKey: compressed });
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await expect(provider.getPublicKey()).rejects.toThrow(/Unexpected public-key format/);
  });

  test('splits pubkey into (x, y) without the 0x04 prefix', async () => {
    const pk = new Uint8Array(65);
    pk[0] = 0x04;
    for (let i = 1; i < 33; i++) pk[i] = i; // X = 01,02,…,32
    for (let i = 33; i < 65; i++) pk[i] = i; // Y = 33,…,64
    const transport = makeMockTransport({ publicKey: pk });
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 7 });
    const { x, y } = await provider.getPublicKeyXY();
    expect(x.length).toBe(32);
    expect(y.length).toBe(32);
    expect(x[0]).toBe(1);
    expect(x[31]).toBe(32);
    expect(y[0]).toBe(33);
    expect(y[31]).toBe(64);
  });
});

describe('TrezorEcdsaKAuthWitnessProvider — createAuthWit', () => {
  test('passes the SHA-256 digest as challenge_hidden (not the raw outer_hash)', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const outerHash = Fr.ZERO;
    await provider.createAuthWit(outerHash);
    expect(transport.calls.signIdentity.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: just asserted length=1
    const call = transport.calls.signIdentity[0]!;
    // SHA-256 of 32 zero bytes
    expect(Buffer.from(call.challengeHidden).toString('hex')).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  test('uses the right identity string for the account index', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 5 });
    await provider.createAuthWit(Fr.ZERO);
    // biome-ignore lint/style/noNonNullAssertion: tested above
    expect(transport.calls.signIdentity[0]!.identity).toBe('aztec://account/5');
  });

  test('strips the marker byte and emits 64-byte r||s in the AuthWitness', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const aw = await provider.createAuthWit(Fr.ZERO);
    // AuthWitness.witness is `(Fr | number)[]` — 64 entries (one per byte) for our wrapped signature.
    expect(aw.witness.length).toBe(64);
  });

  test('flags blind-sign banner as INTERNAL', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await provider.createAuthWit(Fr.ZERO);
    // biome-ignore lint/style/noNonNullAssertion: tested above
    const visual = transport.calls.signIdentity[0]!.challengeVisual;
    expect(visual).toContain('INTERNAL');
    expect(visual).toContain('DO NOT SHIP');
  });

  test('rejects wrong-length Trezor signature (defends against vendor wire-format changes)', async () => {
    const badSig = new Uint8Array(64); // missing marker byte
    const transport = makeMockTransport({ signature: badSig });
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await expect(provider.createAuthWit(Fr.ZERO)).rejects.toThrow(/Unexpected Trezor signature/);
  });
});
