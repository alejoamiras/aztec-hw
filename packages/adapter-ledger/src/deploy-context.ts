/**
 * M7 P3 — encoder for the INS_BEGIN_DEPLOY_ACCOUNT payload.
 *
 * Wire layout (mirrors `ledger-app/src/handler/begin_deploy_account.c`):
 *
 *   manifest_version   :  1 B
 *   profile_id         :  1 B    (index into CS_DEPLOY_PROFILES)
 *   curve_id           :  1 B    (= K1)
 *   path_scheme        :  1 B
 *   path_len           :  1 B
 *   path[]             :  4 * path_len B    (uint32 BE)
 *   chain_id           : 32 B    (Fr BE, canonical)
 *   protocol_version   : 32 B    (Fr BE, canonical)
 *   tx_nonce           : 32 B    (Fr BE, canonical)
 *   salt               : 32 B    (Fr BE, canonical)
 *   public_keys_hash   : 32 B    (Fr BE, canonical — host-supplied; device records only)
 *   expected_address   : 32 B    (Fr BE, canonical — UI displayed)
 *
 * Codex audit MAJOR #1: BEGIN_DEPLOY_ACCOUNT commits ALL deploy semantics.
 * FINALIZE_DEPLOY_AND_SIGN only adds claimed_outer_hash.
 */

import {
  AZTEC_COIN_TYPE_HARDENED,
  CURVE_ID,
  FR_BYTES,
  hardened,
  MANIFEST_VERSION,
  PATH_SCHEME,
} from './apdu.ts';

export interface DeployContext {
  /** Index into CS_DEPLOY_PROFILES — must match the manifest. v0: 0. */
  readonly profileId: number;
  readonly bip32Path: readonly number[];
  readonly chainId: Uint8Array; // 32 B
  readonly protocolVersion: Uint8Array; // 32 B
  readonly txNonce: Uint8Array; // 32 B
  readonly salt: Uint8Array; // 32 B
  readonly publicKeysHash: Uint8Array; // 32 B
  readonly expectedAddress: Uint8Array; // 32 B
}

function assertFr(name: string, b: Uint8Array): void {
  if (b.length !== FR_BYTES) {
    throw new Error(`${name} must be 32 bytes, got ${b.length}`);
  }
}

export function encodeBeginDeployAccountBody(ctx: DeployContext): Uint8Array {
  if (!Number.isInteger(ctx.profileId) || ctx.profileId < 0 || ctx.profileId > 0xff) {
    throw new Error(`profileId must be a uint8, got ${ctx.profileId}`);
  }
  if (ctx.bip32Path.length < 5 || ctx.bip32Path.length > 10) {
    throw new Error(`deploy bip32 path must be 5..10 components, got ${ctx.bip32Path.length}`);
  }
  for (const f of [
    ctx.chainId,
    ctx.protocolVersion,
    ctx.txNonce,
    ctx.salt,
    ctx.publicKeysHash,
    ctx.expectedAddress,
  ]) {
    assertFr('field', f);
  }

  const out = new Uint8Array(
    1 /* manifest_version */ +
      1 /* profile_id */ +
      1 /* curve_id */ +
      1 /* path_scheme */ +
      1 /* path_len */ +
      4 * ctx.bip32Path.length +
      FR_BYTES * 6,
  );
  let off = 0;
  out[off++] = MANIFEST_VERSION;
  out[off++] = ctx.profileId;
  out[off++] = CURVE_ID.SECP256K1;
  out[off++] = PATH_SCHEME.DEFAULT;
  out[off++] = ctx.bip32Path.length;
  for (const p of ctx.bip32Path) {
    if (!Number.isInteger(p) || p < 0 || p > 0xffff_ffff) {
      throw new Error(`bip32 path component out of uint32 range: ${p}`);
    }
    out[off++] = (p >>> 24) & 0xff;
    out[off++] = (p >>> 16) & 0xff;
    out[off++] = (p >>> 8) & 0xff;
    out[off++] = p & 0xff;
  }
  for (const f of [
    ctx.chainId,
    ctx.protocolVersion,
    ctx.txNonce,
    ctx.salt,
    ctx.publicKeysHash,
    ctx.expectedAddress,
  ]) {
    out.set(f, off);
    off += FR_BYTES;
  }
  if (off !== out.length) throw new Error(`encoder offset mismatch: ${off} != ${out.length}`);
  return out;
}

/** Helper: default Aztec deploy path. Matches `defaultAztecPath()` in apdu.ts
 * but exported here for the deploy-flow ergonomics (same shape; v0 uses the
 * exact same BIP-32 schema for sign + deploy). */
export function defaultDeployPath(account = 0): readonly number[] {
  if (!Number.isInteger(account) || account < 0 || account > 0x7fff_ffff) {
    throw new Error(`account must be a uint31, got ${account}`);
  }
  return [hardened(44), AZTEC_COIN_TYPE_HARDENED, hardened(account), 0x0000_0000, 0x0000_0000];
}
