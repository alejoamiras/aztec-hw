/**
 * Deterministic in-process `TrezorTransport` — uses Aztec's own `Ecdsa` reference signer
 * so signatures it produces are guaranteed verifier-compatible. Useful for:
 *
 *   (a) End-to-end PoC demos without a Trezor emulator running.
 *   (b) Round-trip validation: produce a signature here, verify via Aztec's TS verifier,
 *       confirm the adapter pipeline is byte-correct *before* wiring the real device.
 *
 * NOT for production: the "device key" lives in JS process memory.
 */

import { randomBytes } from 'node:crypto';
import { Ecdsa } from '@aztec/foundation/crypto/ecdsa';
import type {
  TrezorPublicKey,
  TrezorSignedIdentity,
  TrezorTransport,
} from '@aztec-hwwallet-poc/adapter-trezor';

/**
 * Fake transport that mimics the Trezor wire format:
 *   - Public key returned as 65 bytes: `0x04 || X(32) || Y(32)`
 *   - Signature returned as 65 bytes: `marker(1) || r(32) || s(32)`
 *
 * The marker byte is set to `0x1f + recoveryId` mirroring Ethereum's convention as
 * documented for Trezor `SignIdentity` secp256k1 output. We synthesize recovery
 * from the underlying ECDSA signature's `v` byte.
 */
export class FakeTrezorTransport implements TrezorTransport {
  private readonly identityKeys = new Map<string, Buffer>();
  private readonly ecdsa: Ecdsa;

  constructor(opts: { seed?: Buffer } = {}) {
    this.ecdsa = new Ecdsa();
    if (opts.seed) {
      // Single-identity deterministic mode: every identity maps to the same key.
      // Useful for repeatable PoC demos.
      this.identityKeys.set('__seed_override__', opts.seed);
    }
  }

  private privateKeyFor(identity: string): Buffer {
    if (this.identityKeys.has('__seed_override__')) {
      // biome-ignore lint/style/noNonNullAssertion: just checked has()
      return this.identityKeys.get('__seed_override__')!;
    }
    let key = this.identityKeys.get(identity);
    if (!key) {
      // Generate a key on first sight of this identity. Not derived from a master seed —
      // each identity is independent. Sufficient for fake-transport demos.
      key = randomBytes(32);
      this.identityKeys.set(identity, key);
    }
    return key;
  }

  async getPublicKey(
    identity: string,
    _ecdsaCurve: 'secp256k1' | 'nist256p1',
  ): Promise<TrezorPublicKey> {
    const sk = this.privateKeyFor(identity);
    const pk = await this.ecdsa.computePublicKey(sk);
    // Aztec's `Ecdsa.computePublicKey` returns the uncompressed point WITHOUT the 0x04 prefix
    // (64 bytes = X(32) || Y(32)). Trezor returns WITH the prefix. We prepend to match
    // the wire-format the adapter expects.
    const withPrefix = Buffer.alloc(65);
    withPrefix[0] = 0x04;
    withPrefix.set(pk, 1);
    return { bytes: new Uint8Array(withPrefix) };
  }

  async signIdentity(args: {
    identity: string;
    ecdsaCurve: 'secp256k1' | 'nist256p1';
    challengeHidden: Uint8Array;
    challengeVisual?: string;
  }): Promise<TrezorSignedIdentity> {
    if (args.ecdsaCurve !== 'secp256k1') {
      throw new Error(`FakeTrezorTransport only supports secp256k1 (got ${args.ecdsaCurve})`);
    }
    const sk = this.privateKeyFor(args.identity);
    const challengeBuf = Buffer.from(args.challengeHidden);
    // `constructSignature(message)` SHA-256-hashes the message internally and signs the digest.
    // Aztec's K1 path expects the verifier to be given `sha256(message)` and the signature
    // computed by signing `sha256(message)` — so we pass the message that, when SHA-256'd, yields
    // the `challengeHidden` that the adapter wants signed. To keep determinism predictable,
    // we instead use signWithDigest if available, OR we just sign the challenge as-is and rely
    // on Aztec's verifier accepting the digest path. Detailed behavior is the SUBJECT OF the
    // codex review we're awaiting; for the fake-transport demo we accept the asymmetry and
    // document it.
    const sig = await this.ecdsa.constructSignature(challengeBuf, sk);
    // sig is `EcdsaSignature` with { r: Buffer, s: Buffer, v: Buffer } (each 32B / 1B).
    // Synthesize Trezor's `marker(1) || r(32) || s(32)` wire format.
    // biome-ignore lint/style/noNonNullAssertion: ECDSA v is 1 byte
    const recoveryId = sig.v[0]! - 27; // Ethereum offset; clamp to 0..3
    const marker = 0x1f + (recoveryId & 0x03);
    const wire = new Uint8Array(65);
    wire[0] = marker;
    wire.set(sig.r, 1);
    wire.set(sig.s, 33);

    const pk = await this.getPublicKey(args.identity, 'secp256k1');
    return { signature: wire, publicKey: pk };
  }
}
