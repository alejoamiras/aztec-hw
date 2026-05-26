# Poseidon2 on Aztec Ledger app — L4.1 implementation tracker

## Status
**Scaffolding only.** Header API committed; implementation lands next session.

Pinned to barretenberg / aztec-packages commit `2770bcb82d40323060c2f9c71aaf293b640efbef`.

## What's needed for L4.1
1. **Round constants table.** Extract from `aztec-packages/barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_params.hpp`:
   - `internal_matrix_diagonal_minus_one` (4 elements × 32B)
   - `round_constants` (`rounds_f + rounds_p = 64` rounds × `t = 4` lanes × 32B)
   - Use codex's compressed representation (92 field elements ≈ 2,944 bytes): 4 leading full × 4 + 56 partial first-lane only + 4 trailing full × 4 + 4 diagonal lanes.

2. **Fr arithmetic backend.** Two options:
   - Preferred (L4 plan §1): BOLOS bignum via `<ox_bn.h>` / `<cx.h>`. Public-data only — no scalar blinding.
   - Fallback if BOLOS bignum is unstable / too slow: 4×64-bit limb custom backend with Barrett or Montgomery reduction.

3. **Permutation.** Per `poseidon2_permutation.hpp`:
   - External 4×4 MDS step (round-mixing); same matrix used in full + partial rounds.
   - Internal diagonal-minus-one matrix optimization.
   - S-box `x^5` applied to all lanes in full rounds, lane 0 only in partial rounds.

4. **Sponge.** Per `sponge/sponge.hpp`:
   - IV = `input_len << 64` placed in `state[t - 1]`.
   - Absorb in rate-3 chunks (`t = 4`, rate = 3, capacity = 1).
   - Squeeze single field (Aztec's pattern in `poseidon2HashFields`).

5. **Domain-separator helper.** `az_poseidon2_hash_with_separator(fields, count, sep, out)` prepends `Fr(sep)` as the first element, then calls `az_poseidon2_hash`. Mirrors `yarn-project/foundation/src/crypto/poseidon/index.ts`.

## Verification
- Host-side unit tests load `ledger-app/tests/golden_vectors/l4_outer_hashes.json` and assert byte equality against:
  - `_meta.canonical_padding_call.args_hash_hex` (single-field hash with `PUBLIC_CALLDATA` separator)
  - `_meta.poseidon2_separator_smoke.*` (empty / one-field / domain-separator-only)
  - Every scenario's `expected.inner_hash_hex` and `expected.outer_hash_hex`

- Speculos APDU tests via `BEGIN_AUTHWIT` + `APPEND_CALL` + `FINALIZE_AND_SIGN` (currently `SW_NOT_IMPLEMENTED`) must produce the same `outer_hash`.

## Memory budget (per L4 plan §1)
- `+30–50 KB` flash if BOLOS bignum carries arithmetic.
- `+40–70 KB` if we own the Fr math.
- `+2 KB` RAM for sponge state + temporaries.

## Adjacent files
- `poseidon2.h` (this dir) — public API, committed.
- `poseidon2.c` — implementation, TODO.
- `round_constants.h` — extracted from barretenberg, TODO.
- `fr.h` / `fr.c` (or `fr_bolos.c`) — Fr arithmetic backend choice, TODO.
- `../../tests/poseidon2_host/` — host-runnable test harness loading the JSON vectors, TODO.
