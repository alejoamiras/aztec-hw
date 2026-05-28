/**
 * M8 Phase 0 — Oracle module barrel.
 *
 * All parity tests (Phase 3 Grumpkin, Phase 6 publicKeysHash + address) and the
 * golden-vector generator import from here. The oracle wraps `@aztec/*`
 * unchanged; device-side C implementations must byte-match this output.
 *
 * See `public-keys-hash-encoding.md` for the explicit byte-encoding invariant
 * Phase 6 depends on.
 */

export * from './aztec-address.js';
export * from './aztec-derivation.js';
export * from './aztec-grumpkin.js';
