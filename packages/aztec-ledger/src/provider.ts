/**
 * High-level driver for the Aztec Ledger app. Translates device operations (get
 * public key, reveal master secret, stream + clear-sign authwits/deploys, blind-sign
 * outer_hash) into APDU exchanges over a `LedgerTransport`.
 *
 * Scope has grown well past the original L2 K1 baseline: SECP256K1 + Grumpkin-Schnorr,
 * the L4 clear-signing streaming path (BEGIN_AUTHWIT/APPEND_CALL/FINALIZE) and the
 * deploy flow are all live. Blind-sign (SIGN_OUTER_HASH) is the LEGACY raw-hash path,
 * now OFF by default behind the device blind_signing toggle. `AuthWitnessProvider` /
 * entrypoint wrapping lives in auth-witness-provider.ts + clear-signing-entrypoint.ts.
 */
import { type AzCall, type AzManifestHeader, type CurveId, FR_BYTES, INS, SW } from './apdu.ts';
import {
  type DeployContext,
  encodeBeginDeployAccountBody,
  encodeGetAztecAddressBody,
} from './deploy-context.ts';
import { encodeAppendCallBody, encodeBeginAuthwitBody } from './l4-manifest.ts';
import type { AutoConfirmContext, LedgerTransport } from './transport.ts';

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
    // `>>> 0` coerces back to unsigned uint32 — JS bitwise OR yields signed int32,
    // so if a future build sets bit 31 (e.g. CAPS_GRUMPKIN at high bit), the result
    // would otherwise be negative. Same family of bug as AZTEC_COIN_TYPE_HARDENED.
    return ((r.data[0]! << 24) | (r.data[1]! << 16) | (r.data[2]! << 8) | r.data[3]!) >>> 0;
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

  /**
   * M10 — GET_SCHNORR_PUBKEY. The device's Grumpkin Schnorr signing public key
   * P = priv·G for the path, as 64B (X||Y). Non-sensitive (like getPublicKey);
   * the host feeds (x, y) to the SchnorrAccount constructor. The signing scalar
   * is derived + held device-side and never leaves.
   */
  async getSchnorrPublicKey(bip32Path: readonly number[]): Promise<LedgerPublicKey> {
    const body = this.encodePath(bip32Path);
    const r = await this.transport.send({ ins: INS.GET_SCHNORR_PUBKEY, data: body });
    this.requireOk(r.sw, 'GET_SCHNORR_PUBKEY');
    if (r.data.length !== 64) {
      throw new Error(`GET_SCHNORR_PUBKEY: expected 64 bytes (X||Y), got ${r.data.length}`);
    }
    return { x: r.data.slice(0, 32), y: r.data.slice(32, 64) };
  }

  /**
   * M8 P4 — GET_AZTEC_MASTER_SECRET. Reveals the 32-byte Aztec master secret
   * (an `Fr`) for the given BIP-32 path, AFTER a high-friction on-device
   * confirmation (this discloses permanent note-VIEWING capability, though
   * not spend authority). The host feeds the result to Aztec's `deriveKeys()`.
   *
   * Wire layout mirrors GET_PUBLIC_KEY (path-only: `[len, path…]`); the device
   * enforces path canonicality (m/44'/AZTEC'/…) just like the deploy handler.
   * Takes an autoConfirm hook because — unlike GET_PUBLIC_KEY — the reveal
   * gates on user approval (Speculos drives it in tests).
   *
   * Derivation (see master-secret.ts for the host reference + spec). The device
   * hashes the PRIVATE child key, not the pubkey — hashing the pubkey would let
   * a host read the reveal input via GET_PUBLIC_KEY and bypass the gate:
   *   secret = SHA-512("aztec-master-secret-v1\0" ‖ privkey_d(32)) mod Fr
   */
  async getAztecMasterSecret(
    bip32Path: readonly number[],
    opts: SignOuterHashOptions = {},
  ): Promise<Uint8Array> {
    const body = this.encodePath(bip32Path);
    const r = await this.transport.send(
      { ins: INS.GET_AZTEC_MASTER_SECRET, data: body },
      opts.autoConfirm,
    );
    this.requireOk(r.sw, 'GET_AZTEC_MASTER_SECRET');
    if (r.data.length !== FR_BYTES) {
      throw new Error(`GET_AZTEC_MASTER_SECRET: expected 32 bytes, got ${r.data.length}`);
    }
    return r.data.slice(0, 32);
  }

  /**
   * W4 (AHW-098) — GET_AZTEC_ADDRESS. The device DERIVES the Aztec account address
   * for (profileId, curveId, path, salt) on-device — the SAME partial→pkh→address
   * chain the deploy uses — shows it for confirmation, and returns the 32-byte
   * address after approval. NO signed blob, NO host fallback.
   *
   * The caller MUST equality-check this against its OWN host derivation (connect()
   * does, fail-closed) so a malicious host cannot substitute a receive address it
   * controls. Gated behind CAPS.ATTEST_ADDRESS — callers should refuse to onboard a
   * device lacking the bit rather than fall back to a host-derived address.
   */
  async attestReceiveAddress(
    params: {
      readonly bip32Path: readonly number[];
      readonly salt: Uint8Array; // 32 B
      readonly profileId?: number;
      readonly curveId?: CurveId;
    },
    opts: SignOuterHashOptions = {},
  ): Promise<Uint8Array> {
    const body = encodeGetAztecAddressBody({
      profileId: params.profileId ?? 0,
      curveId: params.curveId,
      bip32Path: params.bip32Path,
      salt: params.salt,
    });
    const r = await this.transport.send(
      { ins: INS.GET_AZTEC_ADDRESS, data: body },
      opts.autoConfirm,
    );
    this.requireOk(r.sw, 'GET_AZTEC_ADDRESS');
    if (r.data.length !== FR_BYTES) {
      throw new Error(`GET_AZTEC_ADDRESS: expected 32 bytes, got ${r.data.length}`);
    }
    return r.data.slice(0, 32);
  }

  /**
   * L4 BEGIN_AUTHWIT — start a verified-calls session on the device.
   * Returns when the device has acknowledged the manifest header.
   */
  async beginAuthwit(header: AzManifestHeader): Promise<void> {
    const body = encodeBeginAuthwitBody(header);
    const r = await this.transport.send({ ins: INS.BEGIN_AUTHWIT, data: body });
    this.requireOk(r.sw, 'BEGIN_AUTHWIT');
  }

  /** L4 APPEND_CALL — buffer one real call into the active session. */
  async appendCall(call: AzCall): Promise<void> {
    const body = encodeAppendCallBody(call);
    const r = await this.transport.send({ ins: INS.APPEND_CALL, data: body });
    this.requireOk(r.sw, 'APPEND_CALL');
  }

  /**
   * L4 FINALIZE_AND_SIGN — submit the host-claimed outer_hash, prompt the user
   * with the verified-calls review UI on-device, and return r ‖ s on approval.
   *
   * The host MUST have just called BEGIN_AUTHWIT + N × APPEND_CALL for this
   * to succeed. Device rejects with `SW_HASH_MISMATCH` if its recompute
   * doesn't agree with `claimedOuterHash`.
   */
  async finalizeAndSign(
    claimedOuterHash: Uint8Array,
    opts: SignOuterHashOptions = {},
  ): Promise<LedgerSignature> {
    if (claimedOuterHash.length !== FR_BYTES) {
      throw new Error(`claimedOuterHash must be 32 bytes, got ${claimedOuterHash.length}`);
    }
    const r = await this.transport.send(
      { ins: INS.FINALIZE_AND_SIGN, data: claimedOuterHash },
      opts.autoConfirm,
    );
    this.requireOk(r.sw, 'FINALIZE_AND_SIGN');
    if (r.data.length !== 64) {
      throw new Error(`FINALIZE_AND_SIGN: expected 64 bytes (r||s), got ${r.data.length}`);
    }
    return { r: r.data.slice(0, 32), s: r.data.slice(32, 64) };
  }

  /** L4 ABORT — wipe any in-flight session on the device. Idempotent. */
  async abortAuthwit(): Promise<void> {
    const r = await this.transport.send({ ins: INS.ABORT });
    this.requireOk(r.sw, 'ABORT');
  }

  /**
   * M7 P3 — clear-signed deploy. BEGIN_DEPLOY_ACCOUNT commits ALL deploy
   * semantics (profile, salt, public_keys_hash, expected_address); the
   * device runs its 3-pass partial-address parity recompute, stores the
   * context, returns SUCCESS. The host then calls finalizeDeployAndSign.
   */
  async beginDeployAccount(ctx: DeployContext): Promise<void> {
    const body = encodeBeginDeployAccountBody(ctx);
    const r = await this.transport.send({ ins: INS.BEGIN_DEPLOY_ACCOUNT, data: body });
    this.requireOk(r.sw, 'BEGIN_DEPLOY_ACCOUNT');
  }

  /**
   * M7 P3 — finalize a clear-signed deploy. Submits the host-claimed
   * outer_hash, prompts the on-device review UI (address + path + fee
   * payer), and returns r||s on approval. Device rejects with
   * SW_HASH_MISMATCH if its recompute doesn't agree.
   *
   * Codex audit MAJOR #1: this APDU adds NO new deploy semantics beyond
   * `claimedOuterHash` — everything else came from BEGIN_DEPLOY_ACCOUNT.
   */
  async finalizeDeployAndSign(
    claimedOuterHash: Uint8Array,
    opts: SignOuterHashOptions = {},
  ): Promise<LedgerSignature> {
    if (claimedOuterHash.length !== FR_BYTES) {
      throw new Error(`claimedOuterHash must be 32 bytes, got ${claimedOuterHash.length}`);
    }
    const r = await this.transport.send(
      { ins: INS.FINALIZE_DEPLOY_AND_SIGN, data: claimedOuterHash },
      opts.autoConfirm,
    );
    this.requireOk(r.sw, 'FINALIZE_DEPLOY_AND_SIGN');
    if (r.data.length !== 64) {
      throw new Error(`FINALIZE_DEPLOY_AND_SIGN: expected 64 bytes (r||s), got ${r.data.length}`);
    }
    return { r: r.data.slice(0, 32), s: r.data.slice(32, 64) };
  }

  // AHW-097: the raw blind-sign primitive (`signOuterHash`) was moved OFF this
  // public driver to `unsafe.ts` (`@aztec/adapter-ledger/unsafe`) — it signs an
  // arbitrary digest with no manifest review, so it must be a deliberate opt-in
  // import, not a method every root consumer gets. Clear-signing goes through
  // `LedgerClearSigningEntrypoint`; `finalize{,Deploy}AndSign` above are the
  // reviewed paths (device recomputes + compares before signing).

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
