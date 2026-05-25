/**
 * SLIP-0013 identity strings for Aztec.
 *
 * Trezor derives a deterministic per-identity key via `m/13' / sha256(identity)` (SLIP-0013).
 * Aztec's identity string is the de-facto derivation path for the Aztec signing key on
 * the device. Format choice:
 *
 *     aztec://account/{accountIndex}
 *
 * - `accountIndex` is a non-negative integer chosen by the user (0, 1, 2, …) — multiple
 *   Aztec signing keys per device, mirroring BIP-44 account indices.
 * - The Aztec ADDRESS is intentionally NOT included: the address is a function of
 *   `(protocol_secret, signing_pubkey, contract_class)` and is host-side. Including it
 *   would create a chicken-and-egg (pubkey depends on identity, address depends on pubkey).
 * - No chainId in the identity — chainId is in `outer_hash` already (domain separation
 *   at the protocol layer), and binding signing keys to a chain would prevent multi-chain
 *   accounts.
 *
 * The identity string is privacy-leaky on the device (Trezor displays/logs it). The
 * leading `aztec://` discloses the network — accept this for v0; revisit for production.
 */

const SCHEME = 'aztec://';
const PATH_PREFIX = 'account/';

export interface AztecIdentity {
  readonly accountIndex: number;
}

export function buildAztecIdentity(accountIndex: number): string {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`accountIndex must be a non-negative integer, got: ${accountIndex}`);
  }
  if (accountIndex > 2 ** 31 - 1) {
    throw new Error(`accountIndex out of range: ${accountIndex} > 2^31 - 1`);
  }
  return `${SCHEME}${PATH_PREFIX}${accountIndex}`;
}

export function parseAztecIdentity(identity: string): AztecIdentity {
  if (!identity.startsWith(SCHEME)) {
    throw new Error(`Identity does not start with ${SCHEME}: ${identity}`);
  }
  const path = identity.slice(SCHEME.length);
  if (!path.startsWith(PATH_PREFIX)) {
    throw new Error(`Identity path does not start with ${PATH_PREFIX}: ${path}`);
  }
  const indexStr = path.slice(PATH_PREFIX.length);
  const accountIndex = Number(indexStr);
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || String(accountIndex) !== indexStr) {
    throw new Error(`Invalid accountIndex in identity: ${indexStr}`);
  }
  return { accountIndex };
}
