/**
 * `aztec-ledger/speculos` — Speculos emulator transport (TESTING ONLY).
 *
 * Drives the app under the Ledger Speculos emulator over its HTTP API, with
 * scriptable button presses (`autoConfirm`). Never use against funds; the
 * emulator runs a known test seed.
 */

export {
  type ButtonId,
  SpeculosTransport,
  type SpeculosTransportOptions,
} from './speculos-transport.ts';
