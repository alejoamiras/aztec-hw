# Poseidon2 on Aztec Ledger app — L4.1 complete

## Status
**Host-parity OK.** Pure-C portable Montgomery 4×u64 backend matches barretenberg
byte-for-byte against the golden vectors. Code is ARM-portable; device-side build
verified once the ragger CI runs the next push.

Pinned to barretenberg / aztec-packages commit `2770bcb82d40323060c2f9c71aaf293b640efbef`.

## Files

```
poseidon2.h              Public API ( az_poseidon2_hash, az_poseidon2_hash_with_separator )
poseidon2_internal.h     Sponge primitives + raw permutation (used by manifest state machine + tests)
poseidon2.c              MDS, S-box, sponge, public API
fr.h / fr.c              BN254 Fr arithmetic — Montgomery 4×u64, CIOS reduction
fr_params.h / fr_params.c  Generated: p, R², mu
constants.h / constants.c  Generated: round constants in Montgomery form
README.md                this file
```

Generator script: `packages/adapter-ledger/scripts/gen-poseidon2-constants.ts` — re-run if
the local `aztec-packages` clone moves past the pin.

## Host parity tests

```bash
# Build + run the standalone CLI (cc, no BOLOS SDK):
make -C ledger-app/tests/poseidon2_host smoke

# Full sweep (raw perm + sponge smoke + 4 scenarios × inner/outer):
bun test packages/adapter-ledger/src/poseidon2-parity.test.ts
```

What it verifies:

1. **Raw permutation** — `AZ_POSEIDON2_TEST_INPUT` permutes to `AZ_POSEIDON2_TEST_OUTPUT`
   (the canonical test vector embedded in `poseidon2_params.hpp:447-458`). This is the
   strongest single check that round constants + MDS + S-box + internal-matrix are all
   correct.
2. **Sponge smoke values** — `poseidon2Hash([])`, `poseidon2Hash([Fr(1)])`,
   `poseidon2HashWithSeparator([], 0)`, `…([], SIGNATURE_PAYLOAD)`.
3. **Canonical padding** — `computeCalldataHash([0])` matches the embedded padding-call
   `args_hash`.
4. **Every golden scenario** — for each of the 4 scenarios in `l4_outer_hashes.json`:
   - 31-field `inner_hash` (5 padded calls × 6 fields + tx_nonce, with `SIGNATURE_PAYLOAD`).
   - 4-field `outer_hash` (consumer + chain_id + protocol_version + inner_hash, with `AUTHWIT_OUTER`).

## Memory footprint (estimate)

- Code: ~6 KB flash for `fr.c` + `poseidon2.c` (compiled `-O2` for Cortex-M0+).
- Constants: 2944 bytes flash for `constants.c` (88 RC + 4 diag + 8 test = 100 × 32 B,
  rounded by alignment).
- Field params: ~80 bytes flash for `fr_params.c`.
- RAM per hash: ~280 bytes (sponge state + cache + ~6 fr_t temporaries during a
  permutation step).

Total flash overhead vs the L2 baseline: **≤ 10 KB**. Well within the 60-90 KB budget
sized in the L4 plan §1.

## Adversarial notes

- **Constant-time discipline**: not required here — Poseidon2 operates on PUBLIC
  manifest data only (calls, target addresses, args_hashes). The signing key is never
  touched through this code path. Audit bar: same as L2 ECDSA.
- **Input validation**: `fr_from_bytes_be` rejects any input ≥ `p`. Hash callers
  propagate that as a negative return; the L4 state machine will translate that to
  `SW_INVALID_DATA` rather than crash.
- **Constants integrity**: regeneration via the script is reproducible and pinned by
  aztec-packages HEAD + the barretenberg AUDIT STATUS commit. If the upstream constants
  ever change, the generator's structural assertions fail loudly.

## What L4.1 did NOT do (deferred to L4.3-L4.7)

- Device-side APDU stubs that exercise this code (currently `SW_NOT_IMPLEMENTED`).
- Streaming sponge state across multiple APDU calls (the manifest state machine).
- Outer-hash parity check between host-claimed and device-recomputed values.
- Double recompute for fault hardening.
- "Verified calls" NBGL review UI.

## What this unlocks

The device now has a Poseidon2 oracle that matches Aztec byte-for-byte. L4.3 plumbs it
into a state machine where the host streams a manifest, the device hashes lane-by-lane,
and `FINALIZE_AND_SIGN(claimed_outer_hash)` verifies the host's claim before signing.
That makes the host untrusted on the outer_hash — the device authors it.
