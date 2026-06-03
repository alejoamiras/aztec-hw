/**
 * `aztec-ledger/webhid` — WebHID transport for browsers.
 *
 * Pass the transport to an account contract / connection. WebHID requires a
 * secure context (https/localhost) and a user gesture to open the device.
 */

export {
  createWebHidTransport,
  WebHidDeviceDisconnectedError,
  WebHidLedgerTransport,
  WebHidNotSupportedError,
} from './webhid-transport.ts';
