import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec-hwwallet-poc/core';
import * as secp from '@noble/secp256k1';
import type { IdentityType, TrezorSignedIdentity, TrezorTransport } from './index.ts';
import { TrezorEcdsaKAuthWitnessProvider } from './provider.ts';

/**
 * Mock transport that records calls and returns a deterministic Trezor-shaped response.
 * Lets us unit-test the adapter logic (preimage, marker-strip, decompress pubkey, low-s,
 * AuthWitness assembly) without a Trezor emulator running.
 */
function makeMockTransport(opts: {
  privateKey?: Uint8Array;
  /** Override the signature bytes returned by signIdentity (for negative tests). */
  signatureOverride?: Uint8Array;
}): TrezorTransport & {
  calls: Array<{
    identity: IdentityType;
    ecdsaCurve: string;
    challengeHidden: Uint8Array;
    challengeVisual: string;
  }>;
} {
  const calls: Array<{
    identity: IdentityType;
    ecdsaCurve: string;
    challengeHidden: Uint8Array;
    challengeVisual: string;
  }> = [];
  const sk = opts.privateKey ?? Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  return {
    calls,
    async signIdentity(args): Promise<TrezorSignedIdentity> {
      calls.push(args);
      let sigBytes: Uint8Array;
      if (opts.signatureOverride) {
        sigBytes = opts.signatureOverride;
      } else {
        const sigCompact = await secp.signAsync(args.challengeHidden, sk, {
          prehash: false,
          lowS: true,
        });
        sigBytes = new Uint8Array(65);
        sigBytes[0] = 0x00;
        sigBytes.set(sigCompact, 1);
      }
      return {
        compressedPublicKey: secp.getPublicKey(sk, true),
        signature: sigBytes,
      };
    },
  };
}

describe('TrezorEcdsaKAuthWitnessProvider — public key', () => {
  test('decompresses 33B compressed pubkey to (x, y) 32+32', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const { x, y } = await provider.getPublicKeyXY();
    expect(x.length).toBe(32);
    expect(y.length).toBe(32);
    // Compare against noble's own uncompressed form.
    const sk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const uncompressed = secp.getPublicKey(sk, false);
    expect(Array.from(x)).toEqual(Array.from(uncompressed.slice(1, 33)));
    expect(Array.from(y)).toEqual(Array.from(uncompressed.slice(33, 65)));
  });

  test('caches pubkey across calls (probe sign + createAuthWit share it)', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const a = await provider.getPublicKeyXY();
    const b = await provider.getPublicKeyXY();
    expect(a).toBe(b); // same reference — cached
    expect(transport.calls.length).toBe(1); // only the probe-sign hit the transport
  });
});

describe('TrezorEcdsaKAuthWitnessProvider — createAuthWit', () => {
  test('passes the SHA-256 digest of outer_hash bytes as challenge_hidden', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await provider.createAuthWit(Fr.ZERO);
    const realCall = transport.calls.find((c) => !c.challengeVisual.includes('initial public-key'));
    if (!realCall) throw new Error('did not find the real (non-probe) sign call');
    // SHA-256 of 32 zero bytes
    expect(Buffer.from(realCall.challengeHidden).toString('hex')).toBe(
      '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  test('uses gpg protocol and aztec host', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 5 });
    await provider.createAuthWit(Fr.ZERO);
    const realCall = transport.calls.find((c) => !c.challengeVisual.includes('initial public-key'));
    if (!realCall) throw new Error('did not find the real (non-probe) sign call');
    expect(realCall.identity.proto).toBe('gpg');
    expect(realCall.identity.host).toBe('aztec');
    expect(realCall.identity.path).toBe('/account/5');
  });

  test('flags blind-sign banner as INTERNAL', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await provider.createAuthWit(Fr.ZERO);
    const realCall = transport.calls.find((c) => !c.challengeVisual.includes('initial public-key'));
    if (!realCall) throw new Error('did not find the real (non-probe) sign call');
    expect(realCall.challengeVisual).toContain('INTERNAL');
    expect(realCall.challengeVisual).toContain('DO NOT SHIP');
  });

  test('emits 64-byte r||s in the AuthWitness (no marker, no v)', async () => {
    const transport = makeMockTransport({});
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    const aw = await provider.createAuthWit(Fr.ZERO);
    expect(aw.witness.length).toBe(64);
  });

  test('rejects wrong-length signature from transport', async () => {
    const tooShort = new Uint8Array(64);
    const transport = makeMockTransport({ signatureOverride: tooShort });
    const provider = new TrezorEcdsaKAuthWitnessProvider(transport, { accountIndex: 0 });
    await expect(provider.createAuthWit(Fr.ZERO)).rejects.toThrow(/Unexpected Trezor signature/);
  });
});
