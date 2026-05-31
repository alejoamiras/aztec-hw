/**
 * M11 P5 — B3 fail-closed consumer binding (the security property P5's decision rests on).
 *
 * The device refuses to sign an authwit whose `consumer` is not the account THIS
 * key controls: B3 recomputes the address from the session path + firmware-pinned
 * salt/profile and cross-checks it against `consumer`
 * (`finalize_and_sign.c:180` → `SW_AUTHWIT_CONSUMER_MISMATCH 0x6F12`). Until now
 * only the address-RECOMPUTE half was covered (the grumpkin/deploy parity tests);
 * this exercises the REJECT path on the real app.elf via Speculos.
 *
 * Construction: build a SELF-CONSISTENT authwit (header + matching outer_hash, via
 * the proven `buildL4Manifest`) for a BOGUS consumer — `Fr(1)`, a canonical field
 * element that is not any address account #0 derives to — using account #0's path.
 * Zero calls keeps it artifact-free (no token contract needed). The device passes
 * the outer_hash gate (self-consistent), then B3 recomputes #0's real address,
 * finds `consumer != addr`, and rejects BEFORE any UI or signing.
 *
 * This is exactly the attack B3 defends: a malicious host asking the device to
 * authorize spending from an account this key does not control. P5 chose NOT to
 * add the salt/profile wire-bump that would let the host pick the bound account
 * (see lessons/phase-5.md); this test pins the guarantee that decision preserves.
 *
 *   SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/b3-consumer-binding.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { CallIntent } from '@aztec-hwwallet-poc/core';
import { CURVE_ID, defaultAztecPath, INS } from './apdu.ts';
import { buildL4Manifest, encodeBeginAuthwitBody } from './l4-manifest.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const SW_OK = 0x9000;
const SW_HASH_MISMATCH = 0x6f01;
const SW_AUTHWIT_CONSUMER_MISMATCH = 0x6f12;

describe.skipIf(!SPECULOS_URL)('M11 P5 — B3 fail-closed consumer binding (real app.elf)', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5001' });

  test('authwit for a consumer this key does NOT control → SW_AUTHWIT_CONSUMER_MISMATCH', async () => {
    /* Fr(1): canonical, but not any account address the device's #0 key derives. */
    const bogusConsumer = AztecAddress.fromField(new Fr(1n));
    const intent: CallIntent = {
      consumer: bogusConsumer,
      chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
      calls: [],
    };
    const manifest = await buildL4Manifest({
      intent,
      bip32Path: defaultAztecPath(0),
      curveId: CURVE_ID.SECP256K1,
    });

    /* Header accepted: zero calls → session goes straight to CALLS_COMPLETE. */
    const begin = await transport.send({
      ins: INS.BEGIN_AUTHWIT as never,
      p1: 0,
      p2: 0,
      data: encodeBeginAuthwitBody(manifest.header),
    });
    expect(Number(begin.sw)).toBe(SW_OK);

    /* FINALIZE: device recomputes outer_hash (matches — self-consistent), passes
     * the hash gate, then B3 recomputes #0's address ≠ Fr(1) → reject, no sign.
     * (A SW_HASH_MISMATCH would mean zero-call outer_hash padding diverged
     * host/device — a test-construction issue, not a binding failure.) */
    const fin = await transport.send({
      ins: INS.FINALIZE_AND_SIGN as never,
      p1: 0,
      p2: 0,
      data: manifest.claimedOuterHash,
    });
    expect(Number(fin.sw)).not.toBe(SW_HASH_MISMATCH);
    expect(Number(fin.sw)).toBe(SW_AUTHWIT_CONSUMER_MISMATCH);
  });
});
