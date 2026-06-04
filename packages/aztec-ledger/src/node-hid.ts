/**
 * `aztec-ledger/node-hid` — Node.js USB transport for a real Ledger device.
 *
 * Requires the OPTIONAL peer `@ledgerhq/hw-transport-node-hid` (a native module).
 * Install it to use this subpath: `bun add @ledgerhq/hw-transport-node-hid`.
 * For browsers use `./webhid`; for the emulator use `./speculos`.
 */

export {
  createNodeHidTransport,
  NodeHidDeviceDisconnectedError,
  NodeHidLedgerTransport,
  NodeHidNotAvailableError,
} from './node-hid-transport.ts';
