# L4 spec freeze — verified-calls signing on the Aztec Ledger app

Codex L4 deep plan: `l4-deep-plan.md` (xhigh session `019e64f4-9fd1-7902-8cf0-a8231d61f790`).

## Pinned source of truth
- Aztec commit: `2770bcb82d40323060c2f9c71aaf293b640efbef`
- Local Aztec clone: `/Users/alejoamiras/Projects/aztec-packages`

## Domain separators (from `yarn-project/constants/src/constants.gen.ts`)
- `SIGNATURE_PAYLOAD = 463525807`
- `AUTHWIT_OUTER = 3283595782`
- `PUBLIC_CALLDATA = 2760353947`

## Poseidon2 invariants (from `barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_permutation.hpp` + `sponge/sponge.hpp`)
- BN254 Fr field
- State size `t = 4`
- S-box `x^5`
- `8` full rounds, `56` partial rounds (split: 4 leading full + 56 partial + 4 trailing full)
- Hardcoded external 4×4 MDS step
- Internal diagonal-minus-one matrix
- Sponge IV = `(input_len << 64)`
- `poseidon2HashWithSeparator(fields, sep)` prepends `sep` as the first field

## L4 APDU spec

### Wire types (big-endian, canonical Fr)

```c
typedef struct __attribute__((packed)) {
  uint8_t  curve_id;          // 1=k1 only on L4 (r1 deferred to L4.1+)
  uint8_t  path_scheme;
  uint8_t  path_len;
  uint32_t path[10];          // BE u32, existing L2 semantics
} az_key_path_t;

typedef struct __attribute__((packed)) {
  uint8_t manifest_version;     // 1
  az_key_path_t key;
  uint8_t consumer[32];         // canonical Fr BE
  uint8_t chain_id[32];         // canonical Fr BE
  uint8_t protocol_version[32]; // canonical Fr BE — chainInfo.version (NOT auth_version)
  uint8_t tx_nonce[32];         // canonical Fr BE
  uint8_t call_count;           // real calls only, 0..5
} az_manifest_header_v1_t;

typedef struct __attribute__((packed)) {
  uint8_t args_hash[32];               // canonical Fr
  uint8_t function_selector_field[32]; // canonical Fr, must fit in u32 — high 28 bytes zero
  uint8_t target_address_field[32];    // canonical Fr
  uint8_t flags;                       // bit0 public, bit1 hide_msg_sender, bit2 static
} az_call_v1_t;

typedef struct __attribute__((packed)) {
  uint8_t claimed_outer_hash[32];
} az_finalize_v1_t;
```

### INS bytes
| INS  | Name                 | Body                       | Returns                       |
|------|----------------------|----------------------------|-------------------------------|
| 0x05 | `BEGIN_AUTHWIT`      | `az_manifest_header_v1_t`  | ack                           |
| 0x06 | `APPEND_CALL`        | `az_call_v1_t`             | ack                           |
| 0x07 | `FINALIZE_AND_SIGN`  | `az_finalize_v1_t`         | `r ‖ s` (64 B) after approval |
| 0x08 | `ABORT`              | —                          | ack (zeros session)           |

### State machine
- `BEGIN_AUTHWIT` always zeroes prior session, parses + validates the header, enters `BEGIN` state.
- `APPEND_CALL` permitted only after `BEGIN` and before reaching `call_count` real calls. Validates canonical Fr and selector ≤ `u32`.
- `FINALIZE_AND_SIGN` permitted only when exactly `call_count` calls have been appended. Synthesizes the remaining `5 - call_count` canonical padding calls, computes `inner_hash` then `outer_hash`, compares to `claimed_outer_hash`, displays summary, on approval signs `sha256(outer_hash_be32)`.
- `ABORT` is idempotent and zeroes session state.
- Any non-`0x9000` exit zeroes session state (mirrors L2 discipline).

### Outer-hash recomputation (must match `yarn-project/entrypoints/src/encoding.ts`)
1. Parse `call_count` real calls.
2. Synthesize the remaining `5 - call_count` canonical padding calls (`FunctionCall.empty()`):
   - `args_hash = computeCalldataHash([0], PUBLIC_CALLDATA)`
   - `function_selector = 0`, `target_address = 0`, `is_public = true`, `hide_msg_sender = false`, `is_static = false`
3. Build the 31-field payload: per call `[args_hash, function_selector, target_address, is_public, hide_msg_sender, is_static]` × 5, then `tx_nonce`.
4. `inner_hash = poseidon2HashWithSeparator(payload, SIGNATURE_PAYLOAD)`.
5. `outer_hash = poseidon2HashWithSeparator([consumer, chain_id, protocol_version, inner_hash], AUTHWIT_OUTER)`.
6. Compare to `claimed_outer_hash` — refuse to display anything if mismatch.
7. Display verified-calls summary, on approval `sign sha256(outer_hash_be32)` via existing K1 path.

### Fault-injection redundancy
- Recompute the manifest hash twice in independent passes; compare both to `claimed_outer_hash`.
- Recompute again immediately before signing from stored normalized state.
- Cost is acceptable at `N ≤ 5`; redundancy is the new critical invariant.

## UI labelling
- Title flow `Verified calls` (NOT `Clear sign`).
- Summary page: `Chain`, `Account/Consumer`, `Calls` (real-call count).
- Per-call page: `Target` (truncated hex), `Selector` (low 4 bytes hex), `Mode` (public/private/static/hide_msg_sender as a compact 3-letter glyph).
- Single global warning: `Addresses and selectors are unverified raw values`.
- No allowlist, no symbolic chain-id names in L4.

## Things explicitly NOT in L4 scope
- ABI-decoded function arguments.
- Contract / selector allowlist.
- Truncated `args_hash` display (optional, larger-screen-only).
- L5 Schnorr-Grumpkin.
- Final auditor review.

## L4 implementation cut for this session (codex's recommendation)
- L4.0: spec doc + vector generator (this file + `scripts/gen-l4-vectors.ts`).
- L4.1: standalone Poseidon2 C port + host-native unit tests (deferred to a focused session — `+30–70KB` flash, significant Fr field work).
- L4.2: APDU INS stubs returning `SW_NOT_IMPLEMENTED` instead of `SW_INVALID_INS` — disambiguates "reserved-and-coming" from "wrong INS byte".
- TS adapter scaffolding for L4 wire types (without enabling the new code path).

Acceptance for the full L4: device signs only when the streamed manifest, the claimed outer hash, and the displayed summary all bind to the same `outer_hash`; vectors from the pinned commit pass on host tests + Speculos; the EcdsaKAccount integration test passes via the new provider path.
