/**
 * SLIP-0013 identity for Aztec — `IdentityType` protobuf, NOT a URL string.
 *
 * From codex review of Trezor `sign_identity.py` + `messages-crypto.proto`:
 *
 * Trezor's `IdentityType` protobuf is serialized to:
 *     `proto://user@host:port/path`
 * (only non-empty fields included). Then the device derives the auth-key path as:
 *     `m/13'/h0/h1/h2/h3`
 * where `h0..h3` are the first 16 bytes of
 *     `sha256(pack("<I", index) || serialized_identity)`
 * split into four 4-byte little-endian hardened indices.
 *
 * IMPORTANT: only `proto='gpg'` makes the device sign `challenge_hidden` **directly**.
 * Any other `proto` value (e.g. `aztec`, `https`) drops into the Bitcoin-style
 * message-signing path that signs `sha256(challenge_hidden) || sha256(challenge_visual)`
 * — which Aztec's verifier won't accept. We HARDCODE proto='gpg' for the K1 path.
 *
 * Aztec's convention (chosen here):
 *   `proto = 'gpg'`
 *   `host = 'aztec'`
 *   `path = '/account/{accountIndex}'`
 *   `index = 0`  (the protobuf `index` field, always 0 for our PoC)
 *   `user, port` = empty
 *
 * Serialized: `gpg://aztec/account/{accountIndex}` (no user/port).
 *
 * Multiple Aztec accounts → multiple values of `accountIndex` → distinct derivation
 * paths via the path field, while keeping protobuf `index=0`.
 */

export interface IdentityType {
  /** Hardcoded to `'gpg'` for Aztec K1 — required to make Trezor sign challenge_hidden directly. */
  readonly proto: 'gpg';
  /** Empty (no user component). */
  readonly user?: string;
  readonly host: 'aztec';
  /** Empty (no port). */
  readonly port?: string;
  /** `/account/{accountIndex}`. */
  readonly path: string;
  /** Protobuf-level `index` field. Always 0 for the PoC. */
  readonly index: number;
}

export interface AztecIdentityOptions {
  readonly accountIndex: number;
}

export function buildAztecIdentity(opts: AztecIdentityOptions): IdentityType {
  if (!Number.isInteger(opts.accountIndex) || opts.accountIndex < 0) {
    throw new Error(`accountIndex must be a non-negative integer, got: ${opts.accountIndex}`);
  }
  if (opts.accountIndex > 2 ** 31 - 1) {
    throw new Error(`accountIndex out of range: ${opts.accountIndex} > 2^31 - 1`);
  }
  return {
    proto: 'gpg',
    host: 'aztec',
    path: `/account/${opts.accountIndex}`,
    index: 0,
  };
}

/**
 * Serialize an `IdentityType` to the on-the-wire string Trezor firmware constructs
 * before SHA-256-hashing for path derivation. Format:
 *     `proto://[user@]host[:port][path]`
 * (per `serialize_identity` in `trezor-firmware/core/src/apps/misc/sign_identity.py`).
 */
export function serializeIdentity(identity: IdentityType): string {
  const userPart = identity.user ? `${identity.user}@` : '';
  const portPart = identity.port ? `:${identity.port}` : '';
  const pathPart = identity.path ?? '';
  return `${identity.proto}://${userPart}${identity.host}${portPart}${pathPart}`;
}

/**
 * Extract the `accountIndex` from a previously-built Aztec `IdentityType`.
 * Useful for tests and logging.
 */
export function parseAccountIndex(identity: IdentityType): number {
  const match = identity.path.match(/^\/account\/(\d+)$/);
  if (!match || !match[1]) {
    throw new Error(`Identity path is not in Aztec form /account/{i}: ${identity.path}`);
  }
  return Number(match[1]);
}
