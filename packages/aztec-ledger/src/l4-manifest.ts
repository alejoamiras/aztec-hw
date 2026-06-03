/**
 * L4 manifest builder — turns a `CallIntent` into the DEVICE WIRE bytes the Aztec
 * Ledger app's BEGIN_AUTHWIT + APPEND_CALL stream expect.
 *
 * P1 (entrypoint-seam-refactor): the outer_hash shipped in FINALIZE_AND_SIGN is the
 * CANONICAL `EncodedAppEntrypointCalls` hash, computed by `LedgerClearSigningEntrypoint`
 * via `@aztec/entrypoints/encoding` — there is no host replica pinned to an
 * aztec-packages commit anymore. `deviceOuterHashForIntent` (below) is a TEST-ONLY
 * mirror of the device's `l4/parity.c` algorithm, verified against the installed
 * canonical (4.2.1) by `l4-manifest-parity.test.ts`. The device independently
 * recomputes the outer_hash from this stream and rejects on mismatch (SW_HASH_MISMATCH).
 */

import type { CallIntent, StructuredFunctionCall } from '@alejoamiras/aztec-ledger-core';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { type Fr as AztecFr, Fr } from '@aztec/foundation/curves/bn254';
import { computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';

import {
  APP_MAX_ARGS,
  APP_MAX_CALLS,
  type AzCall,
  type AzKeyPath,
  type AzManifestHeader,
  assertCanonicalAztecPath,
  CALL_FLAG,
  CURVE_ID,
  type CurveId,
  FR_BYTES,
  MANIFEST_VERSION,
  PATH_SCHEME,
} from './apdu.ts';

/** Aztec domain separators — must equal the device-side constants in `l4/wire.h`. */
const SIGNATURE_PAYLOAD = 463525807;
const _AUTHWIT_OUTER = 3283595782;
const PUBLIC_CALLDATA = 2760353947;
const FUNCTION_ARGS = 3576554347; /* private-call args_hash separator */

const ZERO_FIELD: Uint8Array = new Uint8Array(FR_BYTES);

function frToBytes(f: AztecFr): Uint8Array {
  return new Uint8Array(f.toBuffer());
}

function bigintToFrBytes(v: bigint): Uint8Array {
  return frToBytes(new Fr(v));
}

function addressToFrBytes(addr: AztecAddress): Uint8Array {
  return frToBytes(addr.toField());
}

/** Compute the canonical `FunctionCall.empty()` args_hash. Pure function — pre-derivable. */
async function paddingArgsHash(): Promise<AztecFr> {
  return poseidon2HashWithSeparator([new Fr(0n)], PUBLIC_CALLDATA);
}

/** Lower a `StructuredFunctionCall` to the on-wire `AzCall`.
 *
 * M5.1: implements both public (`computeCalldataHash([selector, ...args],
 * PUBLIC_CALLDATA)`) and private (`computeVarArgsHash(args)` with
 * FUNCTION_ARGS=3576554347, empty-args → Fr.ZERO) paths. Raw args are
 * streamed alongside args_hash so the device can recompute & verify (M5.2). */
async function encodeRealCall(call: StructuredFunctionCall): Promise<AzCall> {
  const isPublic = call.isPublic ?? true;

  let argsHash: AztecFr;
  if (isPublic) {
    argsHash = await poseidon2HashWithSeparator([call.selector, ...call.args], PUBLIC_CALLDATA);
  } else if (call.args.length === 0) {
    /* hash.ts:computeVarArgsHash short-circuit. */
    argsHash = Fr.ZERO;
  } else {
    argsHash = await poseidon2HashWithSeparator([...call.args], FUNCTION_ARGS);
  }

  let flags = 0;
  if (isPublic) flags |= CALL_FLAG.PUBLIC;
  if (call.hideMsgSender) flags |= CALL_FLAG.HIDE_MSG_SENDER;
  if (call.isStatic) flags |= CALL_FLAG.STATIC;

  if (call.args.length > APP_MAX_ARGS) {
    throw new Error(
      `call has ${call.args.length} args; APP_MAX_ARGS=${APP_MAX_ARGS}. ` +
        `Clear-signing v0 covers only the aztec-standards FT verb set.`,
    );
  }

  return {
    argsHash: frToBytes(argsHash),
    functionSelectorField: frToBytes(call.selector),
    targetAddressField: addressToFrBytes(call.contractAddress),
    flags,
    args: call.args.map((f) => frToBytes(f)),
  };
}

/** Synthesize the canonical padding `AzCall`. Same shape as device-side. */
async function encodePaddingCall(): Promise<AzCall> {
  /* Padding's args = [Fr(0)] per `FunctionCall.empty()` in the Aztec stdlib.
   * Device synthesizes padding internally and never sees these bytes on the
   * wire (host-only); we keep the field populated for type consistency and
   * for the inner_hash payload construction below. */
  return {
    argsHash: frToBytes(await paddingArgsHash()),
    functionSelectorField: ZERO_FIELD,
    targetAddressField: ZERO_FIELD,
    flags: CALL_FLAG.PUBLIC,
    args: [frToBytes(new Fr(0n))],
  };
}

export interface L4ManifestInputs {
  readonly intent: CallIntent;
  readonly bip32Path: readonly number[];
  /** Optional. Defaults to zero. */
  readonly txNonce?: Uint8Array | bigint;
  /** M10 — signature scheme: CURVE_ID.SECP256K1 (default, ECDSA-K) or
   * CURVE_ID.GRUMPKIN (Schnorr). Sets the BEGIN_AUTHWIT header.key.curveId the
   * device dispatches its signing primitive on. */
  readonly curveId?: CurveId;
  /** AHW-018 (wire v3): the account-deploy salt the device re-derives the address for.
   * Defaults to Fr.ZERO (the demo's DEFAULT_ACCOUNT_SALT); thread the ACTUAL account
   * salt for non-default accounts. */
  readonly salt?: Uint8Array | bigint;
  /** AHW-018 (wire v3): the allowlisted account-template id (0 = EcdsaKAccount/K1,
   * 1 = SchnorrAccount/GRUMPKIN). An explicit account property — deliberately NOT
   * inferred from curveId in this builder (codex). Defaults to 0. */
  readonly profileId?: number;
}

export interface L4Manifest {
  /** The BEGIN_AUTHWIT header. */
  readonly header: AzManifestHeader;
  /** ONLY the non-padding calls; the device synthesizes padding internally. */
  readonly calls: readonly AzCall[];
  /** Useful for logging / UI; matches what's in the header. */
  readonly txNonce: Uint8Array;
}

function normalizeTxNonce(txNonce: Uint8Array | bigint | undefined): Uint8Array {
  if (txNonce === undefined) return new Uint8Array(FR_BYTES);
  if (txNonce instanceof Uint8Array) {
    if (txNonce.length !== FR_BYTES) {
      throw new Error(`txNonce must be 32 bytes, got ${txNonce.length}`);
    }
    return txNonce;
  }
  return bigintToFrBytes(txNonce);
}

/**
 * P1 — host MIRROR of the device's `l4/parity.c` outer_hash algorithm. Used ONLY by
 * the parity test (`l4-manifest-parity.test.ts`) to prove the device's independent
 * recompute equals the CANONICAL `EncodedAppEntrypointCalls` of the installed
 * `@aztec/*` (4.2.1). NOT on the production signing path: `LedgerClearSigningEntrypoint`
 * computes + signs the canonical hash directly (via `@aztec/entrypoints/encoding`), and
 * the device recomputes + rejects on mismatch — so this mirror never gates a signature.
 * (Replaces the old in-line replica that was pinned to an aztec-packages commit.)
 */
export async function deviceOuterHashForIntent(inputs: L4ManifestInputs): Promise<Uint8Array> {
  const { intent } = inputs;
  const realEncoded: AzCall[] = [];
  for (const c of intent.calls.filter((x) => !x.isPadding)) {
    realEncoded.push(await encodeRealCall(c));
  }
  const padding = await encodePaddingCall();
  const padded: AzCall[] = [...realEncoded];
  while (padded.length < APP_MAX_CALLS) padded.push(padding);

  /* The 31-field payload exactly as the device builds it (parity.c). */
  const payloadFields: AztecFr[] = [];
  for (const c of padded) {
    payloadFields.push(Fr.fromBuffer(Buffer.from(c.argsHash)));
    payloadFields.push(Fr.fromBuffer(Buffer.from(c.functionSelectorField)));
    payloadFields.push(Fr.fromBuffer(Buffer.from(c.targetAddressField)));
    payloadFields.push(new Fr(c.flags & CALL_FLAG.PUBLIC ? 1n : 0n));
    payloadFields.push(new Fr(c.flags & CALL_FLAG.HIDE_MSG_SENDER ? 1n : 0n));
    payloadFields.push(new Fr(c.flags & CALL_FLAG.STATIC ? 1n : 0n));
  }
  payloadFields.push(Fr.fromBuffer(Buffer.from(normalizeTxNonce(inputs.txNonce))));

  const innerHash = await poseidon2HashWithSeparator(payloadFields, SIGNATURE_PAYLOAD);
  const outerHash = await computeOuterAuthWitHash(
    intent.consumer,
    intent.chainInfo.chainId,
    intent.chainInfo.version,
    innerHash,
  );
  return frToBytes(outerHash);
}

/**
 * Build the DEVICE WIRE bytes the L4 streaming flow needs from a CallIntent + path +
 * nonce. The signer streams BEGIN_AUTHWIT(header) → APPEND_CALL(calls[i]) → FINALIZE,
 * passing the CANONICAL outer_hash (computed by the entrypoint via
 * `@aztec/entrypoints/encoding`) — NOT a host replica. The device recomputes from this
 * stream and rejects (SW_HASH_MISMATCH) if it disagrees.
 */
export async function buildL4Manifest(inputs: L4ManifestInputs): Promise<L4Manifest> {
  const { intent, bip32Path } = inputs;

  const realCalls = intent.calls.filter((c) => !c.isPadding);
  if (realCalls.length > APP_MAX_CALLS) {
    throw new Error(`too many real calls: ${realCalls.length} > ${APP_MAX_CALLS}`);
  }

  const realEncoded: AzCall[] = [];
  for (const c of realCalls) {
    realEncoded.push(await encodeRealCall(c));
  }
  const txNonceBytes = normalizeTxNonce(inputs.txNonce);

  const key: AzKeyPath = {
    curveId: inputs.curveId ?? CURVE_ID.SECP256K1,
    pathScheme: PATH_SCHEME.DEFAULT,
    path: bip32Path,
  };

  const header: AzManifestHeader = {
    manifestVersion: MANIFEST_VERSION,
    key,
    profileId: inputs.profileId ?? 0,
    salt: normalizeTxNonce(inputs.salt), // same shape: Uint8Array|bigint|undefined → 32 B, default 0
    consumer: addressToFrBytes(intent.consumer),
    chainId: frToBytes(intent.chainInfo.chainId),
    protocolVersion: frToBytes(intent.chainInfo.version),
    txNonce: txNonceBytes,
    callCount: realCalls.length,
  };

  return { header, calls: realEncoded, txNonce: txNonceBytes };
}

/** Serialize an `AzManifestHeader` to the wire bytes BEGIN_AUTHWIT expects. */
export function encodeBeginAuthwitBody(header: AzManifestHeader): Uint8Array {
  const { key } = header;
  /* M9 B3 (codex post-impl LOW): the device's BEGIN_AUTHWIT now requires the
   * exact canonical path; match it host-side so a bad path fails fast here
   * rather than as an opaque 0x6F03 from the device. */
  assertCanonicalAztecPath(key.path);
  /* v3 layout: version|curve|scheme|len|path | profile_id|salt | consumer|chain_id|
   * protocol_version|tx_nonce | call_count. profile_id+salt are inserted after the
   * path, matching begin_authwit.c's parse order (AHW-018). */
  const out = new Uint8Array(1 + 1 + 1 + 1 + key.path.length * 4 + 1 + FR_BYTES + FR_BYTES * 4 + 1);
  let off = 0;
  out[off++] = header.manifestVersion;
  out[off++] = key.curveId;
  out[off++] = key.pathScheme;
  out[off++] = key.path.length;
  for (const p of key.path) {
    if (!Number.isInteger(p) || p < 0 || p > 0xffff_ffff) {
      throw new Error(`bip32 path component out of uint32 range: ${p}`);
    }
    out[off++] = (p >>> 24) & 0xff;
    out[off++] = (p >>> 16) & 0xff;
    out[off++] = (p >>> 8) & 0xff;
    out[off++] = p & 0xff;
  }
  if (!Number.isInteger(header.profileId) || header.profileId < 0 || header.profileId > 0xff) {
    throw new Error(`profileId out of u8 range: ${header.profileId}`);
  }
  out[off++] = header.profileId;
  if (header.salt.length !== FR_BYTES)
    throw new Error(`salt must be 32 bytes, got ${header.salt.length}`);
  out.set(header.salt, off);
  off += FR_BYTES;
  for (const f of [header.consumer, header.chainId, header.protocolVersion, header.txNonce]) {
    if (f.length !== FR_BYTES) throw new Error(`field must be 32 bytes, got ${f.length}`);
    out.set(f, off);
    off += FR_BYTES;
  }
  out[off++] = header.callCount;
  if (off !== out.length) throw new Error(`encoder offset mismatch: ${off} != ${out.length}`);
  return out;
}

/** Serialize one `AzCall` to the wire bytes APPEND_CALL v2 expects
 * (98 + args_count * 32 bytes; max 226 with APP_MAX_ARGS=4). */
export function encodeAppendCallBody(call: AzCall): Uint8Array {
  if (call.argsHash.length !== FR_BYTES) throw new Error('argsHash must be 32 bytes');
  if (call.functionSelectorField.length !== FR_BYTES) throw new Error('selector must be 32 bytes');
  if (call.targetAddressField.length !== FR_BYTES) throw new Error('target must be 32 bytes');
  if (call.args.length > APP_MAX_ARGS) {
    throw new Error(`call has ${call.args.length} args; APP_MAX_ARGS=${APP_MAX_ARGS}`);
  }
  for (const a of call.args) {
    if (a.length !== FR_BYTES) throw new Error('each arg must be 32 bytes');
  }
  const out = new Uint8Array(3 * FR_BYTES + 2 + call.args.length * FR_BYTES);
  let off = 0;
  out.set(call.argsHash, off);
  off += FR_BYTES;
  out.set(call.functionSelectorField, off);
  off += FR_BYTES;
  out.set(call.targetAddressField, off);
  off += FR_BYTES;
  out[off++] = call.flags & 0xff;
  out[off++] = call.args.length & 0xff;
  for (const a of call.args) {
    out.set(a, off);
    off += FR_BYTES;
  }
  if (off !== out.length) throw new Error(`encoder size mismatch: ${off} != ${out.length}`);
  return out;
}
