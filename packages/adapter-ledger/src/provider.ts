/**
 * High-level driver for the Aztec Ledger app. Translates `AuthWitnessProvider`-style
 * calls (get public key, sign outer_hash) into APDU exchanges over a `LedgerTransport`.
 *
 * L2 K1 baseline scope (plan-final.md §2):
 *   - SECP256K1 only
 *   - Blind sign: device shows path + outer_hash hex; clear-sign UI lands at L4
 *   - Caller is responsible for wrapping `signOuterHash` into the Aztec
 *     `AuthWitnessProvider` interface (mirrors adapter-trezor).
 */
import { INS, SW } from './apdu.ts';
import type { AutoConfirmContext, SpeculosTransport } from './speculos-transport.ts';
import type { LedgerTransport } from './transport.ts';

export interface LedgerPublicKey {
  /** Uncompressed secp256k1 X coordinate, 32 BE bytes. */
  readonly x: Uint8Array;
  /** Uncompressed secp256k1 Y coordinate, 32 BE bytes. */
  readonly y: Uint8Array;
}

export interface LedgerSignature {
  readonly r: Uint8Array; // 32 BE bytes
  readonly s: Uint8Array; // 32 BE bytes (already low-S normalized on-device)
}

export interface SignOuterHashOptions {
  /** Hook for driving on-device confirmation (Speculos-only). */
  readonly autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>;
}

export interface VersionInfo {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export class LedgerProvider {
  constructor(private readonly transport: LedgerTransport) {}

  async getVersion(): Promise<VersionInfo> {
    const r = await this.transport.send({ ins: INS.GET_VERSION });
    this.requireOk(r.sw, 'GET_VERSION');
    if (r.data.length !== 3) {
      throw new Error(`GET_VERSION: expected 3 bytes, got ${r.data.length}`);
    }
    return { major: r.data[0]!, minor: r.data[1]!, patch: r.data[2]! };
  }

  async getCaps(): Promise<number> {
    const r = await this.transport.send({ ins: INS.GET_CAPS });
    this.requireOk(r.sw, 'GET_CAPS');
    if (r.data.length !== 4) {
      throw new Error(`GET_CAPS: expected 4 bytes, got ${r.data.length}`);
    }
    return (r.data[0]! << 24) | (r.data[1]! << 16) | (r.data[2]! << 8) | r.data[3]!;
  }

  async getPublicKey(bip32Path: readonly number[]): Promise<LedgerPublicKey> {
    const body = this.encodePath(bip32Path);
    const r = await this.transport.send({ ins: INS.GET_PUBLIC_KEY, data: body });
    this.requireOk(r.sw, 'GET_PUBLIC_KEY');
    // Plan-final.md §215: K1 pubkey wire shape is 64B x||y (no chain code).
    if (r.data.length !== 64) {
      throw new Error(`GET_PUBLIC_KEY: expected 64 bytes (X||Y), got ${r.data.length}`);
    }
    return {
      x: r.data.slice(0, 32),
      y: r.data.slice(32, 64),
    };
  }

  async signOuterHash(
    bip32Path: readonly number[],
    outerHash: Uint8Array,
    opts: SignOuterHashOptions = {},
  ): Promise<LedgerSignature> {
    if (outerHash.length !== 32) {
      throw new Error(`outerHash must be 32 bytes, got ${outerHash.length}`);
    }
    const pathBytes = this.encodePath(bip32Path);
    const body = new Uint8Array(pathBytes.length + outerHash.length);
    body.set(pathBytes, 0);
    body.set(outerHash, pathBytes.length);

    // Speculos transports accept an autoConfirm callback as a second arg.
    const transport = this.transport as SpeculosTransport;
    const r = await transport.send({ ins: INS.SIGN_OUTER_HASH, data: body }, opts.autoConfirm);
    this.requireOk(r.sw, 'SIGN_OUTER_HASH');
    if (r.data.length !== 64) {
      throw new Error(`SIGN_OUTER_HASH: expected 64 bytes (r||s), got ${r.data.length}`);
    }
    return {
      r: r.data.slice(0, 32),
      s: r.data.slice(32, 64),
    };
  }

  /**
   * Strict BIP-32 path encoder (codex L2 BLOCKER #1).
   * Refuses zero-length, over-long, non-integer, negative, or out-of-range
   * components instead of silently coercing with `>>> 0`.
   */
  private encodePath(path: readonly number[]): Uint8Array {
    if (path.length === 0) {
      throw new Error('BIP-32 path must not be empty');
    }
    if (path.length > 10) {
      throw new Error(`BIP-32 path too long: ${path.length} > 10`);
    }
    const out = new Uint8Array(1 + 4 * path.length);
    out[0] = path.length;
    for (let i = 0; i < path.length; i++) {
      const v = path[i]!;
      if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
        throw new Error(`BIP-32 path component ${i} must be uint32 (got ${String(v)})`);
      }
      out[1 + 4 * i] = (v >>> 24) & 0xff;
      out[2 + 4 * i] = (v >>> 16) & 0xff;
      out[3 + 4 * i] = (v >>> 8) & 0xff;
      out[4 + 4 * i] = v & 0xff;
    }
    return out;
  }

  private requireOk(sw: number, op: string): void {
    if (sw !== SW.OK) {
      throw new Error(`${op} failed: SW=0x${sw.toString(16).padStart(4, '0')}`);
    }
  }
}
