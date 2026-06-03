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
 * the proven `buildL4Manifest`) for a BOGUS consumer using account #0's path. Zero
 * calls keeps it artifact-free (no token contract needed). The device passes the
 * outer_hash gate (self-consistent), then B3 recomputes #0's real address, finds
 * `consumer != addr`, and rejects BEFORE any UI or signing. (codex confirmed the
 * isolation: `begin_authwit.c:106` sends call_count==0 straight to CALLS_COMPLETE;
 * 0x6F12 is emitted ONLY at `finalize_and_sign.c:182`; and without autoConfirm a
 * UI-reaching FINALIZE would HANG, not return — so a returned 0x6F12 is provably
 * the pre-UI B3 reject, not an earlier lookalike.)
 *
 * This is exactly the attack B3 defends: a malicious host asking the device to
 * authorize spending from an account this key does not control. P5 chose NOT to
 * add the salt/profile wire-bump that would let the host pick the bound account
 * (see lessons/phase-5.md); this test pins the guarantee that decision preserves.
 *
 *   SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/b3-consumer-binding.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { CallIntent } from '@alejoamiras/aztec-ledger-core';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { CURVE_ID, defaultAztecPath, INS, SW } from './apdu.ts';
import {
  buildL4Manifest,
  deviceOuterHashForIntent,
  encodeBeginAuthwitBody,
} from './l4-manifest.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;

describe.skipIf(!SPECULOS_URL)('M11 P5 — B3 fail-closed consumer binding (real app.elf)', () => {
  const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5001' });

  test('authwit for a consumer this key does NOT control → AUTHWIT_CONSUMER_MISMATCH', async () => {
    /* Fr(1) as the claimed consumer. Account addresses are ~254-bit Poseidon2
     * outputs, so Fr(1) colliding with #0's derived address is cryptographically
     * negligible (~2^-254) — the 0x6F12 below confirms B3 recomputed an address
     * that does not equal Fr(1), i.e. the device rejected an account it controls
     * the key for only in the attacker's claim, not in fact. */
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
    /* The self-consistent outer_hash the device will recompute from this stream.
     * P1: claimedOuterHash left buildL4Manifest (production path signs the canonical
     * hash); deviceOuterHashForIntent is the device's parity.c mirror — exactly what
     * the device recomputes — so it passes the outer_hash gate, isolating the B3 reject. */
    const claimedOuterHash = await deviceOuterHashForIntent({
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
    expect(Number(begin.sw)).toBe(SW.OK);

    /* FINALIZE: device recomputes outer_hash (matches — self-consistent), passes
     * the hash gate, then B3 recomputes #0's address ≠ Fr(1) → reject, no sign.
     * (A HASH_MISMATCH here would mean zero-call outer_hash padding diverged
     * host/device — a test-construction issue, not a binding failure.) */
    const fin = await transport.send({
      ins: INS.FINALIZE_AND_SIGN as never,
      p1: 0,
      p2: 0,
      data: claimedOuterHash,
    });
    expect(Number(fin.sw)).not.toBe(SW.HASH_MISMATCH);
    expect(Number(fin.sw)).toBe(SW.AUTHWIT_CONSUMER_MISMATCH);
  });
});
