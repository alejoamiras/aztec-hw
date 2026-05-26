# L4.1 — Poseidon2 C port lessons

## Verdict
Pure-C Montgomery 4×u64 BN254 Fr backend + Poseidon2 permutation + sponge ported
cleanly. Host parity 14/14 against aztec-packages `2770bcb…`; both nanosp + nanox
device targets compile.

## Key gotchas (would have cost hours if not surfaced early)

### 1. BOLOS clang on 32-bit ARM does NOT expose `__uint128_t`

```c
typedef __uint128_t u128_t; /* host: OK ; nanos+/nanox: clang: unknown type name */
```

The first cut of `fr.c` used `__uint128_t` as the schoolbook product type for the
64×64 → 128 multiplication that drives Montgomery CIOS. It compiled fine on
macOS host (`cc -std=c11`) and the host parity sweep was green. **First device
build failed instantly** at the first `__uint128_t` reference.

`__uint128_t` is a GCC/Clang extension; the BOLOS clang ships configured for the
32-bit ARM target and the header providing it is gated off. Even though libgcc
helpers for 128-bit math (`__udivti3` etc.) exist, the **type** itself isn't
exposed to user code on this target.

**Fix**: replace the type with a portable schoolbook helper that decomposes
`a * b` into four `(uint32_t × uint32_t → uint64_t)` sub-multiplications. Same
algorithm, no extension needed, and the BOLOS toolchain can fold the
sub-products into hardware instructions on Cortex-M0+ where MUL exists.

```c
static void mul64(uint64_t a, uint64_t b, uint64_t *hi, uint64_t *lo) {
    uint64_t al = a & 0xffffffffULL, ah = a >> 32;
    uint64_t bl = b & 0xffffffffULL, bh = b >> 32;
    uint64_t p00 = al * bl, p01 = al * bh, p10 = ah * bl, p11 = ah * bh;
    uint64_t mid = p01 + p10;
    uint64_t mid_overflow = (mid < p01) ? 1ULL : 0;
    uint64_t lo_v = p00 + (mid << 32);
    uint64_t lo_carry = (lo_v < p00) ? 1ULL : 0;
    *lo = lo_v;
    *hi = p11 + (mid >> 32) + (mid_overflow << 32) + lo_carry;
}
```

This is portable C99; works on every target. Performance hit on x86_64 vs the
intrinsic is real but doesn't matter for our test loop. On Cortex-M0+ this *is*
what the libgcc helper would have generated anyway.

**Lesson**: any C extension marked "GCC/Clang" is suspect on the BOLOS toolchain.
Default to portable C99 for crypto primitives. Test with `make BOLOS_SDK=$NANOSP_SDK`
**before** declaring a port done, even if host tests are green.

### 2. Round constants in Montgomery form at codegen, not runtime

Pre-Montgomerizing the 88 round constants + 4 internal-matrix-diagonal scalars
at codegen avoids a runtime conversion per hash. Total table size: 92 × 32 B
= 2944 B of flash. RAM hit: zero (everything is `extern const`).

The naive alternative — store constants in normal form, convert at sponge init —
costs one Montgomery multiplication per round (~80 instructions on Cortex-M0+)
× 64 rounds × N permutations per hash = ~30K extra instructions per hash for
no functional benefit.

**Lesson**: hash codegen should bake the form of constants into the binary. The
generator script (`packages/adapter-ledger/scripts/gen-poseidon2-constants.ts`)
emits `{0x... ULL, 0x... ULL, 0x... ULL, 0x... ULL}` literals so the linker just
places the data segment.

### 3. Partial-round lane 1/2/3 constants ARE all zero

Verified by structural assertion in the generator: for rounds in the partial
phase, `round_constants[i][1]`, `[2]`, `[3]` must equal exactly zero in the
source. If the upstream sage script ever drifts, the assertion fires and the
codegen output won't be tainted silently.

This is what unlocks the "92 elements ≈ 2944 bytes" compression — we only emit
lane-0 for the 56 partial rounds (one fr_t each, not four).

```typescript
// generator
for (let j = 1; j < T; j++) {
  if (rc[j] !== 0n) {
    throw new Error(`partial round ${i} lane ${j} non-zero (${rc[j].toString(16)})`);
  }
}
```

**Lesson**: always pair codegen output with a structural assertion against the
upstream. Future-you (or a junior with rebase rights) will thank you when the
assertion fails loudly before bad constants ship.

### 4. Convert in / out of Montgomery via Mont-mul, not a separate routine

To take an Fr in Montgomery form back to normal form, we Mont-mul it by
`{1, 0, 0, 0}` — the literal "1" in *normal* form. Why this works:

- `fr_mul(a, b) = a · b · R^{-1} mod p` (Mont-mul semantics)
- If `a` is in Montgomery (`a_mont = x · R`) and `b = 1` (normal):
  - `result = a_mont · 1 · R^{-1} = x · R · R^{-1} = x` (normal form)

This avoids a special "leave-Montgomery" routine that would duplicate
~80 lines of CIOS reduction logic.

Similarly, to enter Montgomery form from raw bytes: Mont-mul by `R²` (in
normal form). Result: `x · R² · R^{-1} = x · R = Montgomery`. One `fr_mul`
covers both directions.

**Lesson**: Montgomery's algebra is symmetric. The "in" and "out" conversions
are both single mults; don't write specialized routines.

### 5. IV = `input_len << 64` encodes as limb[1] = len in little-endian

The Aztec sponge IV (from `sponge/sponge.hpp:60`) is a `uint256` constructed as
`static_cast<uint256_t>(in_len) << 64`. In little-endian 4×u64 limb storage,
this is `{0, in_len, 0, 0}`. We then convert to Montgomery via `fr_mul(_, _, R²)`.

I almost wrote `limb[0] = in_len, limb[1..3] = 0` (forgetting the `<< 64` part).
The parity test would have caught it (empty-hash output would mismatch), but
catching it visually saves a debug session.

**Lesson**: `len << 64` in a multi-limb little-endian representation means
`limb[1] = len`, not `limb[0]`. Re-read the IV construction in
`sponge/sponge.hpp` whenever you touch this code.

### 6. Host CLI is a good unit boundary for parity testing

Building a small `poseidon2_cli` binary with three modes (`perm`, `hash`,
`hash-sep`) made the bun test trivial: load the golden JSON, spawn the binary,
compare hex output line-by-line. No FFI dance, no shared library, no glue.

Same binary is useful for ad-hoc debugging:

```bash
$ ./poseidon2_cli hash-sep 463525807 0x...field1 0x...field2
13fd947b4274...
```

**Lesson**: when implementing crypto primitives that the rest of the system
will call, build the smallest possible CLI surface first. It's the fastest
parity oracle and doubles as a debug REPL.

## Test scope (14/14 green)

| Test | What it proves |
|---|---|
| `raw permutation smoke` | Round constants + MDS + S-box + internal matrix all correct (uses TEST_VECTOR from `poseidon2_params.hpp:447-458`) |
| `poseidon2Hash([])` | Sponge IV + duplex + squeeze correct for empty input |
| `poseidon2Hash([Fr(1)])` | Single-field absorb + cache + permute |
| `poseidon2HashWithSeparator([], 0)` | Domain separator prepending works |
| `poseidon2HashWithSeparator([], SIGNATURE_PAYLOAD)` | Non-zero separator value works |
| `computeCalldataHash([0])` | Padding-call `args_hash` matches |
| `zero-calls × {inner, outer}` | Empty manifest produces canonical hash |
| `one-private-call × {inner, outer}` | Single real call + 4 padding |
| `two-public-calls-static-mode × {inner, outer}` | Multiple calls, flag bits exercised |
| `five-calls-max × {inner, outer}` | APP_MAX_CALLS=5 fully populated |

## What L4.1 deliberately did NOT do

- No constant-time discipline. The Poseidon2 path operates on PUBLIC manifest
  data only — the signing key is never touched here. Same audit bar as L2.
- No BOLOS bignum / `<ox_bn.h>` integration. Codex's L4 plan §1 recommended
  it; we deferred for now because the portable backend is correct, audit-able,
  and probably fast enough. Swap is a future perf task if Speculos timing
  shows it's needed.
- No dedicated `fr_sqr` implementation. Plain `fr_mul(a, a)` works; ~25% perf
  win available if we want it later.
- No device-side parity test (e.g. APDU that asks the device to hash and
  returns the result). The host parity test proves the C code matches Aztec;
  the device-side build proves the same C compiles for ARM. Wiring a
  debug-only APDU to exercise it inside Speculos is L4.3 work.
