/**
 * Node.js USB transport for the Aztec Ledger app — talks to a real Ledger over
 * USB from Node (CLIs, servers, scripts). Wraps `@ledgerhq/hw-transport-node-hid`
 * behind our `LedgerTransport` interface so `LedgerProvider` sees the same shape
 * as Speculos / WebHID.
 *
 * `@ledgerhq/hw-transport-node-hid` is an OPTIONAL peer (a native module). It is
 * resolved with a DYNAMIC import so the SDK builds and runs without it — only a
 * consumer that calls `createNodeHidTransport()` needs it installed. A missing
 * module surfaces as a typed `NodeHidNotAvailableError`.
 *
 * Like WebHID: `autoConfirm` is ignored (a human approves on the physical device),
 * APDUs are raw bytes, and device-disconnect raises a typed error.
 */
import { encodeApduBytes } from './hid-apdu.ts';
import type {
  ApduRequest,
  ApduResponse,
  AutoConfirmContext,
  LedgerTransport,
} from './transport.ts';

export class NodeHidNotAvailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'Could not load @ledgerhq/hw-transport-node-hid. It is an optional peer ' +
        'dependency (a native module); install it (e.g. `bun add @ledgerhq/hw-transport-node-hid`) ' +
        'to use the Node USB transport.',
    );
    this.name = 'NodeHidNotAvailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export class NodeHidDeviceDisconnectedError extends Error {
  constructor(cause?: unknown) {
    super('Ledger device disconnected from node-hid');
    this.name = 'NodeHidDeviceDisconnectedError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Minimal shape of the inner `@ledgerhq/hw-transport-node-hid` instance we use. */
interface InnerNodeHidTransport {
  exchange(apdu: Uint8Array | Buffer): Promise<Uint8Array | Buffer>;
  close(): Promise<void>;
  on(event: 'disconnect', cb: () => void): void;
}

interface TransportNodeHidStatic {
  create(): Promise<InnerNodeHidTransport>;
}

/**
 * Resolve the optional peer at runtime. The `specifier` parameter (string-typed,
 * not a literal) keeps the bundler/tsc from trying to resolve the module at build
 * time — it stays a runtime import the consumer satisfies.
 */
async function loadTransportNodeHid(
  specifier = '@ledgerhq/hw-transport-node-hid',
): Promise<TransportNodeHidStatic> {
  try {
    const mod = (await import(specifier)) as { default: TransportNodeHidStatic };
    return mod.default;
  } catch (err) {
    throw new NodeHidNotAvailableError(err);
  }
}

/**
 * Open a Node USB connection to the first attached Ledger. Throws
 * `NodeHidNotAvailableError` if the optional peer isn't installed.
 */
export async function createNodeHidTransport(): Promise<NodeHidLedgerTransport> {
  const TransportNodeHid = await loadTransportNodeHid();
  const inner = await TransportNodeHid.create();
  return new NodeHidLedgerTransport(inner);
}

export class NodeHidLedgerTransport implements LedgerTransport {
  private disconnected = false;

  constructor(private readonly inner: InnerNodeHidTransport) {
    inner.on('disconnect', () => {
      this.disconnected = true;
    });
  }

  /**
   * @param autoConfirm  Accepted for interface compatibility. Silently ignored —
   *                     a human operates the physical device.
   */
  async send(
    req: ApduRequest,
    _autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>,
  ): Promise<ApduResponse> {
    if (this.disconnected) {
      throw new NodeHidDeviceDisconnectedError();
    }
    const apdu = encodeApduBytes(req);
    let response: Uint8Array;
    try {
      const raw = await this.inner.exchange(apdu);
      response = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    } catch (err) {
      if (this.disconnected) throw new NodeHidDeviceDisconnectedError(err);
      throw err;
    }
    if (response.length < 2) {
      throw new Error(
        `node-hid exchange returned ${response.length} bytes; minimum 2 (status word)`,
      );
    }
    const sw = (response[response.length - 2]! << 8) | response[response.length - 1]!;
    return { data: response.slice(0, response.length - 2), sw: sw as ApduResponse['sw'] };
  }

  async close(): Promise<void> {
    if (this.disconnected) return;
    await this.inner.close();
    this.disconnected = true;
  }
}
