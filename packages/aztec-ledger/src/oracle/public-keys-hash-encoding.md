# `PublicKeys.hash()` byte-encoding — concrete invariant for M8 Phase 6

**Codex final audit MAJOR #2 deliverable.** Pins the exact poseidon2 input layout
that `PublicKeys.hash()` consumes. The Phase 6 device-side implementation MUST
replicate this byte-exactly.

## Source-of-truth references

- TS: `aztec-packages/yarn-project/stdlib/src/keys/public_keys.ts:75-87`
- Constant: `aztec-packages/yarn-project/constants/src/constants.gen.ts:521` —
  `DomainSeparator.PUBLIC_KEYS_HASH = 777457226`
- Poseidon2 entry point:
  `aztec-packages/yarn-project/foundation/src/crypto/poseidon/index.ts:41` —
  `poseidon2HashWithSeparator(input: Fieldable[], separator: number) → Fr`
- Generator: `aztec-packages/yarn-project/constants/src/constants.gen.ts:495-496` —
  `GRUMPKIN_ONE_X = 1`, `GRUMPKIN_ONE_Y = 17631683881184975370165255887551781615748388533673675138860`

## Algorithm

```
publicKeysHash = poseidon2HashWithSeparator(
  [npk_m, ivpk_m, ovpk_m, tpk_m],   // 4 Point objects
  DomainSeparator.PUBLIC_KEYS_HASH  // = 777457226 (constant numeric)
)
```

## How a `Point` flattens into the hash input

`poseidon2HashWithSeparator` walks the `Fieldable[]` input. Each `Point`
contributes its `toFields()` output, which is exactly:

```
[ x: Fr, y: Fr, isInfinite: Fr ]   // 3 field elements per Point
```

Where `isInfinite = Fr.ZERO` for finite points (the case M8 always cares about —
master pubkeys are never the point at infinity) and `Fr.ONE` for the point at
infinity.

## Total hash input

For four non-infinite Points:

```
inputs = [
  npk_m.x,  npk_m.y,  Fr.ZERO,    // 3 fields
  ivpk_m.x, ivpk_m.y, Fr.ZERO,    // 3 fields
  ovpk_m.x, ovpk_m.y, Fr.ZERO,    // 3 fields
  tpk_m.x,  tpk_m.y,  Fr.ZERO,    // 3 fields
]
// length = 12 Fr elements

publicKeysHash = poseidon2_sponge_with_domain(
  separator = 777457226,
  inputs    = inputs
)
```

## Implications for Phase 6 (device side)

The device-side function `recompute_public_keys_hash()` must:

1. Hold the four derived `(x, y)` pairs in canonical Fr byte-encoding
   (big-endian, `< Fr.MODULUS`).
2. Append `Fr.ZERO` (32 zero bytes) after each `(x, y)` pair — even though our
   derived points are guaranteed finite, the serialization shape REQUIRES the
   `is_infinite` flag.
3. Run the poseidon2 sponge with domain separator `777457226` over the
   resulting 12-element field array. (The existing
   `ledger-app/src/crypto/poseidon2/` implements this sponge — Phase 6 reuses
   it.)
4. Return the resulting 32-byte Fr as `publicKeysHash`.

## Empty-PublicKeys edge case (not relevant for M8 deploys)

`PublicKeys.hash()` short-circuits to `Fr.ZERO` when all four points are zero
(`isEmpty()`). M8 device code never derives an empty PublicKeys (the four
viewing scalars are non-zero with overwhelming probability), so this branch
need not be implemented on-device. If the device sees a host-supplied
`publicKeysHash = 0`, it MUST reject as a malformed input regardless.

## Invariant test (Phase 0)

`packages/adapter-ledger/src/oracle/aztec-derivation.test.ts` includes
golden-vector tests asserting:

- For 8 hardcoded `(secretKey)` values, `deriveAztecKeysFromMasterSecret(sk).publicKeysHash`
  matches the committed bytes in `golden-vectors.json`.
- For 256 random `(secretKey)` values, the `publicKeysHash` is consistent across
  two invocations (Aztec deriveKeys path is deterministic).

If either test fails after an `@aztec/*` version bump, the M8 device-side C
code MUST be re-verified against the new encoding before any release ships.
