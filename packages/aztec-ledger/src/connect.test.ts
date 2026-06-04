/**
 * connectLedger / LedgerConnection — the handshake-gated entry point + the
 * scheme→contract-class selection. Hardware-free via a mock transport that answers
 * only GET_VERSION / GET_CAPS. The handshake internals are covered by
 * connect-handshake.test.ts; this proves the wiring.
 */
import { describe, expect, test } from 'bun:test';
import { LedgerEcdsaKAccountContract } from './account-contract.ts';
import { INS, SW } from './apdu.ts';
import { connectLedger, LedgerConnection } from './connect.ts';
import { LedgerIncompatibleVersionError } from './connect-handshake.ts';
import { LedgerSchnorrAccountContract } from './schnorr-account-contract.ts';
import type { LedgerTransport } from './transport.ts';

/** A transport that answers only the handshake APDUs. */
const handshakeTransport = (version: number[], capsLowByte: number): LedgerTransport => ({
  async send(req) {
    if (req.ins === INS.GET_VERSION) return { data: new Uint8Array(version), sw: SW.OK };
    if (req.ins === INS.GET_CAPS)
      return { data: new Uint8Array([0, 0, 0, capsLowByte]), sw: SW.OK };
    throw new Error(`mock transport: unexpected ins 0x${(req.ins as number).toString(16)}`);
  },
});

describe('connectLedger', () => {
  test('runs the handshake and returns the probed version + caps', async () => {
    const conn = await connectLedger({ transport: handshakeTransport([0, 1, 0], 0x1d) });
    expect(conn.version).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(conn.caps).toBe(0x1d);
  });

  test('fails closed when the device app version is incompatible', async () => {
    await expect(
      connectLedger({ transport: handshakeTransport([0, 0, 9], 0x1d) }),
    ).rejects.toBeInstanceOf(LedgerIncompatibleVersionError);
  });
});

describe('LedgerConnection.createAccount', () => {
  // A stub transport: createAccount only CONSTRUCTS the contract (no device I/O
  // until getPublicKeyXY), so `send` is never reached here.
  const stub: LedgerTransport = {
    async send() {
      throw new Error('createAccount should not touch the device');
    },
  };
  const conn = new LedgerConnection(stub, { major: 0, minor: 1, patch: 0 }, 0x1d);

  test('defaults to ECDSA-K', () => {
    expect(conn.createAccount()).toBeInstanceOf(LedgerEcdsaKAccountContract);
  });
  test('scheme "ecdsa" → ECDSA-K contract', () => {
    expect(conn.createAccount({ scheme: 'ecdsa' })).toBeInstanceOf(LedgerEcdsaKAccountContract);
  });
  test('scheme "schnorr" → Schnorr contract', () => {
    expect(conn.createAccount({ scheme: 'schnorr' })).toBeInstanceOf(LedgerSchnorrAccountContract);
  });
});
