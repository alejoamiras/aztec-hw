/**
 * Deterministic in-process `TrezorTransport` — faithfully mimics Trezor's
 * `SignIdentity(proto='gpg', curve='secp256k1')` semantics:
 *
 *   - Signs `challenge_hidden` DIRECTLY via `@noble/secp256k1` with `prehash:false`
 *     (no internal SHA-256 wrapping) — matches `data = challenge_hidden;
 *     secp256k1.sign(seckey, data)` in trezor-firmware/core/src/apps/misc/sign_identity.py.
 *   - Returns a 33-byte compressed public key (matching `HDNode.public_key()`).
 *   - Returns a 65-byte signature with byte 0 set to `0x00` (matching the gpg/ssh
 *     overwrite in `sign_identity.py` per codex finding #5).
 *
 * Single SignIdentity probe call yields both pubkey and signature, so this is the
 * "happy path" surface the real `@trezor/connect-node`-backed transport will mirror.
 *
 * NOT for production: the "device key" lives in JS process memory.
 */

import { randomBytes } from 'node:crypto';
import type {
  IdentityType,
  TrezorSignedIdentity,
  TrezorTransport,
} from '@aztec-hwwallet-poc/adapter-trezor';
import { serializeIdentity } from '@aztec-hwwallet-poc/adapter-trezor';
import * as secp from '@noble/secp256k1';

export class FakeTrezorTransport implements TrezorTransport {
  private readonly identityKeys = new Map<string, Uint8Array>();
  private readonly seedOverride?: Uint8Array;

  constructor(opts: { seed?: Uint8Array } = {}) {
    if (opts.seed) {
      if (opts.seed.length !== 32) {
        throw new Error(`seed must be 32 bytes, got ${opts.seed.length}`);
      }
      this.seedOverride = opts.seed;
    }
  }

  private privateKeyFor(identity: IdentityType): Uint8Array {
    if (this.seedOverride) return this.seedOverride;
    const key = serializeIdentity(identity);
    let sk = this.identityKeys.get(key);
    if (!sk) {
      // Independent per-identity key. Real Trezor derives via SLIP-0013; this is just
      // "deterministic per identity within one process run" for demo purposes.
      sk = new Uint8Array(randomBytes(32));
      this.identityKeys.set(key, sk);
    }
    return sk;
  }

  async signIdentity(args: {
    identity: IdentityType;
    ecdsaCurve: 'secp256k1' | 'nist256p1';
    challengeHidden: Uint8Array;
    challengeVisual: string;
  }): Promise<TrezorSignedIdentity> {
    if (args.ecdsaCurve !== 'secp256k1') {
      throw new Error(`FakeTrezorTransport only supports secp256k1 (got ${args.ecdsaCurve})`);
    }
    if (args.identity.proto !== 'gpg') {
      // Mirror the real device: non-gpg sigtypes would sign different bytes.
      throw new Error(
        `FakeTrezorTransport requires identity.proto='gpg' (got '${args.identity.proto}')`,
      );
    }
    if (args.challengeHidden.length !== 32) {
      throw new Error(`challenge_hidden must be 32 bytes, got ${args.challengeHidden.length}`);
    }
    const sk = this.privateKeyFor(args.identity);

    // Sign the digest DIRECTLY — prehash:false. Matches Trezor's secp256k1.sign(seckey, data).
    const sigCompact = await secp.signAsync(args.challengeHidden, sk, {
      prehash: false,
      lowS: true,
    });
    if (sigCompact.length !== 64) {
      throw new Error(`noble returned ${sigCompact.length}B signature, expected 64`);
    }

    // Wrap in Trezor wire format: header(1, set to 0x00 per gpg/ssh overwrite) || r(32) || s(32).
    const wire = new Uint8Array(65);
    wire[0] = 0x00;
    wire.set(sigCompact, 1);

    const compressedPk = secp.getPublicKey(sk, true); // 33B compressed
    return {
      compressedPublicKey: compressedPk,
      signature: wire,
    };
  }
}
