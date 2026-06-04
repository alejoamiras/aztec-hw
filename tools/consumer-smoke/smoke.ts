/**
 * Standalone consumer-smoke (P6) — imports the BUILT `dist/` of the SDK as an
 * outside consumer would, and drives the real public API with a mock transport
 * that answers only the handshake APDUs. Proves: the built ESM is importable, the
 * `exports`/dist mapping is correct, the connect handshake passes, and
 * `createAccount` mints the right account contract — all without a device.
 *
 * (Deriving a REAL on-chain address additionally needs a device pubkey + the
 * framework AccountManager; that's the manual Speculos QA, not this offline smoke.)
 *
 * Run from the repo root: `bun tools/consumer-smoke/smoke.ts` (build the SDK first).
 */

import { INS, SW } from '../../packages/aztec-ledger/dist/advanced.js';
import {
  connectLedger,
  LedgerEcdsaKAccountContract,
  LedgerSchnorrAccountContract,
} from '../../packages/aztec-ledger/dist/index.js';

/** A transport that answers only GET_VERSION (0.1.0) + GET_CAPS (0x1D). */
const mockTransport = {
  async send(req: { ins: number }) {
    if (req.ins === INS.GET_VERSION) return { data: new Uint8Array([0, 1, 0]), sw: SW.OK };
    if (req.ins === INS.GET_CAPS) return { data: new Uint8Array([0, 0, 0, 0x1d]), sw: SW.OK };
    throw new Error(`mock transport: unexpected ins 0x${req.ins.toString(16)}`);
  },
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`consumer-smoke FAILED: ${msg}`);
}

// biome-ignore lint/suspicious/noExplicitAny: the mock is a structural LedgerTransport
const conn = await connectLedger({ transport: mockTransport as any });
assert(conn.version.major === 0 && conn.version.minor === 1, 'handshake version');
assert(conn.caps === 0x1d, 'handshake caps');

const ecdsa = conn.createAccount({ scheme: 'ecdsa' });
assert(ecdsa instanceof LedgerEcdsaKAccountContract, 'ecdsa → LedgerEcdsaKAccountContract');

const schnorr = conn.createAccount({ scheme: 'schnorr' });
assert(schnorr instanceof LedgerSchnorrAccountContract, 'schnorr → LedgerSchnorrAccountContract');

console.log(
  `consumer-smoke OK — built dist/ is consumable; handshake passed (v${conn.version.major}.${conn.version.minor}.${conn.version.patch}, caps 0x${conn.caps.toString(16)}); createAccount mints both schemes.`,
);
