# Round 4 (depth) — per-primitive crypto mathematical correctness vs spec

Red-team angle: verify the CONSTANTS + algorithm details of every device crypto primitive
against the Aztec source-of-truth (installed `@aztec/foundation@4.2.1` / `@aztec/constants@4.2.1`
+ the barretenberg C++ in `/Users/alejoamiras/Projects/aztec-packages`), not merely "a happy-path
parity test passes." Method: independent numeric recomputation in Python/Node, decode of the
device's Montgomery-form constants back to normal form, and direct execution of the repo's own
host CLIs (`blake2s_cli`, `grumpkin_cli`) — which compile the EXACT shipped `src/crypto/*.c` — on
edge inputs the parity suites do not cover ([n]G, [n-1]G, [n+1]G, P+(-P), ∞+Q, in-place add,
wide-reduce at the modulus boundary, blake2s block boundaries).

**Verdict: the crypto layer is mathematically correct.** Every constant, matrix, round count,
domain separator, field assignment, sign convention, byte order, and exceptional-case path I
checked matched the Aztec stack exactly. Net-new yield is two LOW documentation/provenance nits;
the bulk is high-assurance NEGATIVE results recorded below so the external auditor does not
re-chase them. This is the expected (and valuable) outcome of a depth round on a layer the
firmware round already flagged as "parity-tested" (AHW-029 / the point-doubling-aliasing fix).

---

## NET-NEW findings (2 — both LOW)

### NEW-R4-C-01 · LOW · TEST/APP · OURS — Poseidon2 smoke-vector labels are misleading (`zero_hex` is hash-of-EMPTY, not hash-of-Fr(0))
**OURS vs LEDGER:** OURS.
**File:** `ledger-app/tests/golden_vectors/l4_outer_hashes.json:18-22`; generator
`packages/adapter-ledger/scripts/gen-l4-vectors.ts:240-244`; parity test
`packages/adapter-ledger/src/poseidon2-parity.test.ts:139-151`.
**The exact detail:** the `_meta.poseidon2_separator_smoke` block labels four vectors
`zero_hex / one_hex / domain_zero_hex / domain_sigpayload_zero_hex`. I reproduced each against
bb.js 4.2.1:
- `zero_hex = 0x18dfb8dc…6732e` is **`poseidon2Hash([])`** (EMPTY input, IV count = 0) — the
  generator emits it as `frHex(await poseidon2Hash([]))` and the C side is checked with
  `runCli(['hash'])` (no field args). It is NOT `poseidon2Hash([Fr(0)])`.
- `poseidon2Hash([Fr(0)])` actually equals `0x2710…db11`, which the file labels `domain_zero_hex`
  (and which the C `hash-sep 0` over empty input also produces).
- `one_hex = 0x16875833…a373` IS `poseidon2Hash([Fr(1)])` (a single field of value 1).

So `zero`/`one` are inconsistent ("zero/empty inputs" vs "one field = value 1"), and a reader
diffing these against `poseidon2Hash([0])` will see a spurious "mismatch" (I did, before tracing
it to the empty-input semantics). **The values themselves are all correct and the parity
assertions are sound** — this is a label-clarity defect, not a math bug. Flag for the auditor so
they don't burn time on the same false lead.
**Impact:** auditor-confusion / wasted review time; risk that a future maintainer "fixes" a
correct vector to match a mislabeled expectation. No signing-path consequence.
**Fix:** rename to `empty_hex` / `field_one_hex` / `sep0_empty_hex` / `sep_sigpayload_empty_hex`,
or add a one-line `_meta` note that `zero`/`domain_zero` are over the EMPTY input set.

### NEW-R4-C-02 · LOW · APP · OURS — `schnorr_grumpkin_pubkey` has a dead/confusing canonical-priv pre-check (`gk_fq_zero` immediately discards the parsed value)
**OURS vs LEDGER:** OURS.
**File:** `ledger-app/src/crypto/schnorr.c:14-20`.
**The exact detail:**
```c
bool schnorr_grumpkin_pubkey(...) {
    gk_fq_t tmp;
    if (!gk_fq_from_bytes_be(&tmp, priv_be)) return false; /* Reject non-canonical priv */
    gk_fq_zero(&tmp);                                       /* <-- immediately zeroes it */
    return grumpkin_scalar_mul_generator(out_px, out_py, priv_be); /* uses RAW priv_be */
}
```
The intent (canonical-`priv` rejection: reject `priv >= n_grumpkin`) is correct and the
`gk_fq_zero` is a hygiene scrub of the secret-derived `tmp`. But it reads as a no-op/bug at a
glance because the parsed Montgomery value is never used — `mul_generator` consumes the raw
`priv_be` bytes directly (correctly, since `[k]G == [k mod n]G`). The real subtlety worth a
comment: the canonical check here rejects `priv ∈ [n, 2^256)` but `mul_generator` would have
silently reduced it mod the group order anyway, so the check is a *policy* guard
(reject non-canonical encodings), not a *correctness* requirement. Same pattern, but cleaner, in
`sign_once` (`:33-34`) where the parsed `priv_fq`/`k_fq` ARE used (for `s = k − priv·e`).
**Impact:** none functional (verified: pubkey derivation is correct for all canonical inputs).
Pure readability/audit-clarity — an auditor will pause on the discarded value.
**Fix:** add a comment that `gk_fq_zero(&tmp)` is a secret-scrub and the canonical check is a
policy guard (mul_generator reduces mod n regardless); or restructure so the parsed value's role
is obvious.

---

## CONFIRMED-CORRECT — negative results (checked numerically against the Aztec stack)

Each item was verified by independent recomputation and/or by running the repo's host CLI
(compiled from the shipped `src/crypto/*.c`) against a from-scratch reference — NOT by trusting an
existing parity assertion.

### Montgomery field arithmetic (both fields)
- **`fr.c` (BN254 scalar = Aztec `Fr` = `0x…f0000001`) params are exact.** Independently computed
  `R² mod p` and `μ = −p⁻¹ mod 2^64`; both match `AZ_FR_R2` (`fr_params.c:6`) and
  `AZ_FR_MU = 0xc2e1f593efffffff` (`:8`) bit-for-bit. `AZ_FR_P` limbs (`:4`) match the modulus.
- **`fq.c` (Grumpkin scalar = BN254 base = `0x…d87cfd47`) params are exact.** `AZ_FQ_R2`
  (`fq_params.c:6`) and `AZ_FQ_MU = 0x87d20782e4866389` (`:8`) match my independent computation;
  `AZ_FQ_P` (`:4`) matches the BN254 base prime.
- **The field SEPARATION is correct (the make-or-break Grumpkin/BN254 duality).** Confirmed against
  barretenberg `grumpkin.hpp:18-19` (`using fq = bb::fr; using fr = bb::fq;`): point coordinates
  live in `fr_t` (`f0000001`), the scalar multiplier reduces in `gk_fq` (`d87cfd47`). `gk_fq_t` is
  a DISTINCT type from `fr_t` (not a typedef alias) — the codex BLOCKER-#1 fix held.
- **CIOS final conditional subtraction is correct at the boundary.** Verified end-to-end via
  `grumpkin_cli`: `[n]G = (0,0)` (infinity), `[n−1]G = (1, p−g_y) = −G`, `[n+1]G = G`,
  `[n+2]G = [2]G`. A wrong/missing final subtract or `t[n]` carry handling would corrupt these;
  all matched ground truth.
- **Canonical-input rejection (`>= p`).** `fr_from_bytes_be` / `gk_fq_from_bytes_be` reject inputs
  ≥ modulus (`fr.c:230`, `fq.c:248`); `point-add` rejects non-canonical coords; `pedersen_hash3`
  rejects non-canonical Fr inputs at entry (`pedersen.c:73-78`).
- **`gk_fq_from_bytes_wide_be` (SHA-512 → Grumpkin scalar, the viewing-key derivation).** Ran
  `fq-wide-reduce` on `{0, n−1, n, n+1, 2^256, 2^512−1, 0xAB…AB}`; every output equals the Python
  `value mod n`. Horner-over-64-bytes reduction is correct for arbitrary input, no boundary bug.
- **Important non-bug — unreduced-scalar safety:** `n_grumpkin (…d87cfd47) > p_fr (…f0000001)`, so
  every canonical `Fr` Pedersen/Schnorr input (< p_fr) is automatically < n, i.e. already a
  canonical Grumpkin scalar. `mul_affine_core` iterating all 256 raw bits without an explicit
  mod-n is correct because `[k]G == [k mod n]G`; verified via `[n+1]G = G`.

### Grumpkin curve + EC point ops
- **Curve params exact.** `a = 0`, `b = −17 mod Fr` (matches barretenberg `grumpkin.hpp` Montgomery
  `b` decoded to `0x…effffff0` = `(−17) mod p_fr`); `on_curve` uses `y² = x³ − 17` (`point.c:252-263`).
- **Generator exact.** `G = (1, 17631683881184975370165255887551781615748388533673675138860)`
  (`g1_generator.c`); confirmed on-curve, and equals barretenberg's `one_y` Montgomery constant
  decoded to normal form (`0x…823f272c`).
- **Branch-free mixed-add exceptional cases all correct** (`point.c:138-228`), via `grumpkin_cli`:
  `G+G = 2G` (P==Q doubling cmov), `G+(−G) = INF` (h_zero & ¬r_zero cmov), `∞+G = G` (z_zero cmov,
  selected last), `2G+G = 3G` (generic). In-place `add_affine(&p,&p,…)` (the Pedersen accumulator
  alias) returns the correct `2G` — the M11-P7 aliasing fix (already AHW-019-adjacent) is sound.
- **`dbl-2009-l` doubling + `madd-2007-bl` mixed-add formulae** transcribed correctly (re-derived
  the temp sequences); outputs byte-identical to a textbook Jacobian reference across the above.

### Poseidon2 (BN254, t=4)
- **Round counts exact:** RF = 8 (4 leading + 4 trailing full), RP = 56 partial
  (`constants.h:16-17`, `poseidon2.c:106-124`). Rate = 3, capacity = 1 (`poseidon2.c:21-22`).
- **External MDS matrix correct.** Symbolically verified the hand-translated `mds_external`
  (`poseidon2.c:33-60`) computes exactly `[[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]·state`.
- **Internal/diagonal layer correct.** `mds_internal` computes `(D_i−1)·s_i + Σs_j`; the stored
  `AZ_POSEIDON2_DIAG_MINUS_ONE` (`constants.c:77-82`) decodes (D_i−1)+1 to the canonical Poseidon2
  internal diagonal (`0x10dc6e9c…`, `0x0c28145b…`, `0x00544b83…`, `0x222c0117…`).
- **Round constants correct.** Decoded the Montgomery-form `RC_LEADING[0][0]` →
  `0x19b849f6…23e5` and `RC_PARTIAL[0]` → `0x0c6f8f95…61cf` — the canonical first full / first
  internal Poseidon2-BN254 constants. Full set pinned to aztec-packages `2770bcb…`.
- **Permutation parity:** ran bb.js `poseidon2Permutation([0,1,2,3])`; output equals the device's
  `AZ_POSEIDON2_TEST_OUTPUT` (`constants.c:91-96`) decoded to normal form, AND device `TEST_INPUT`
  decodes to `[0,1,2,3]`. S-box `x→x⁵` (`apply_single_sbox`) confirmed.
- **Sponge IV / domain separation correct.** `state[3] = input_count << 64` (`poseidon2.c:156-157`),
  rate-3 absorb, squeeze `state[0]`. Reconstructed this sponge from the raw permutation and matched
  bb.js `poseidon2Hash` for `[0]` and `[1]`. `poseidon2HashWithSeparator` prepends the separator as
  field 0 and uses IV = count+1 (`poseidon2.c:202-203`) — matches foundation
  `poseidon2HashWithSeparator`.

### Pedersen (3-input, over Grumpkin)
- **Generators exact, byte-for-byte vs source.** `GEN_LEN`, `GEN0`, `GEN1`, `GEN2`
  (`pedersen.c:21-29`) match barretenberg
  `ecc/groups/precomputed_generators_grumpkin_impl.hpp` — `pedersen_hash_length` + indices 0/1/2 of
  `DEFAULT_DOMAIN_SEPARATOR`. Correct generator INDICES (0,1,2) for a 3-input hash.
- **Hash-to-point formula correct.** Device computes `[3]·g_len + Σ[v_i]·gen_i → affine x`
  (`pedersen.c:71-98`); matches barretenberg `pedersen.cpp:hash()` =
  `length_generator·size + commit_native(inputs)` then `.normalize().x`. Length term `= 3`
  (input count) always present — the documented collision-resistance length inclusion.
- **Zero-skip is safe** (`accumulate_term` skips scalar==0 as identity, `pedersen.c:60`) — matches
  noble/barretenberg (`[0]·gen = O`).

### Blake2s-256 (Schnorr challenge hash)
- **Param block exact:** `h[0] ^= 0x01010020` = digest_len 32 | key 0 | fanout 1 | depth 1
  (`blake2s.c:82`). IV (`:9-12`), SIGMA (`:14-25`), rotation constants 16/12/8/7 (`:42-53`) all
  RFC-7693 standard.
- **Counter + last-block handling correct, including boundaries.** Ran the repo's `blake2s_cli`
  (the shipped `blake2s.c`) on empty, "abc", and 64/65/128/129-byte inputs vs `node:crypto
  blake2s256` — **byte-identical on all six.** The 64-byte single-final-block path (the only one
  the Schnorr 64-byte preimage uses) is exactly right; the >64 multi-block + finalization flag path
  is also correct. `t0/t1` 64-bit counter split (`:91,100`) handles the >4 GiB case (irrelevant at
  these sizes but correct).

### Schnorr-over-Grumpkin
- **Challenge preimage byte order EXACT** vs barretenberg `schnorr.tcc:schnorr_generate_challenge`:
  `compressed = pedersen([R.x, pubkey.x, pubkey.y])`, then `e_raw = Blake2s(compressed ‖ message)`.
  Device `schnorr.c:42-48`: `pedersen_hash3(compressed, rx, px, py)` then `blake2s256(compressed ‖
  msg)`. Order of both the pedersen inputs `(R.x,P.x,P.y)` and the hash preimage `(compressed,msg)`
  matches.
- **`e` reduced over the Grumpkin SCALAR field.** `e = e_raw mod n_grumpkin` via `gk_fq`
  wide-reduce (`schnorr.c:50-58`); barretenberg reduces `e_raw` into `Fr = grumpkin::fr` (the
  scalar field). Same field. The "biased field element" is expected per the spec comment.
- **`s = k − priv·e` sign convention EXACT** (`schnorr.c:60-63`) — matches barretenberg
  `Fr s = k - (private_key * e)`. NOT `k + e·priv`.
- **Signature serialization EXACT:** `out_sig = s ‖ e_raw` with `s` big-endian and `e_raw` the RAW
  256-bit Blake output (NOT the reduced `e`) — matches barretenberg `sig = (s, e_raw)`, the
  documented "serialize e_raw so verification needs no binary conversion." 64 bytes, (s,e) order.
- **Zero rejects present:** sign rejects `e≡0` (`:58`) and `s≡0` (`:64`); barretenberg verify
  rejects `s==0 || e==0`. Nonce k≡0 / R=∞ rejected (`:39`). Dual-pass fault check (`:79-92`)
  requires both deterministic passes byte-identical.

### ECDSA-secp256k1 (L2 baseline + clear-sign signing)
- **Preimage EXACT:** `digest = sha256(outer_hash[32])` (`sign_outer_hash.c:110`) — matches
  CLAUDE.md / Aztec `EcdsaKAccount` (`sha256(outer_hash.to_be_bytes())`). NOT double-SHA, EIP-191,
  or keccak.
- **Deterministic nonce:** `CX_RND_RFC6979` + `CX_SHA256` (`:126-127`).
- **Low-s EXACT.** `SECP256K1_N` (`:29-34`) = the secp256k1 order, and `SECP256K1_HALF_N`
  (`:36-41`) = `floor(n/2)` — both verified bit-for-bit. `s_is_high`/`low_s_normalize`
  (`s := n − s`) correct.
- **Packing EXACT:** response = `r ‖ s`, 64 bytes (`ECDSA_K1_SIG_LEN`), no `v`, no DER — matches
  Aztec `AuthWitness` 64-byte `r(32)‖s(32)`.
- **Fault defense:** re-signs and byte-compares r,s (deterministic ⇒ identical), rejects on
  mismatch (`:144-177`).

### L4 / deploy outer-hash recompute (the "device signs only what it recomputed" core)
- **Domain separators EXACT** vs installed `@aztec/constants@4.2.1`: `SIGNATURE_PAYLOAD=463525807`,
  `AUTHWIT_OUTER=3283595782`, `PUBLIC_CALLDATA=2760353947` (device `wire.h:59-61`).
- **Inner-hash field order EXACT** vs `@aztec/entrypoints` `encoding.js:functionCallsToFields()`:
  per call `[args_hash, function_selector, target_address, is_public, hide_msg_sender, is_static]`,
  then `tx_nonce`, 5 calls padded → 31 fields, `SIGNATURE_PAYLOAD` (device `parity.c:57-121`).
- **Canonical padding call EXACT** vs `FunctionCall.empty()`: `args_hash =
  poseidon2HashWithSeparator([0], PUBLIC_CALLDATA)`, selector/target = 0, **is_public = true**
  (the counterintuitive `true`), hide_msg_sender/is_static = false (device `parity.c:74-83`).
- **Outer-hash field order EXACT** vs `@aztec/stdlib` `computeOuterAuthWitHash`:
  `[consumer, chainId, version, innerHash]` + `AUTHWIT_OUTER` (device `parity.c:124-133`).
- Booleans serialized as `Fr(0)/Fr(1)` (`fr_zero_bytes`/`fr_one_bytes`). Deploy path
  (`deploy_outer_hash.c`) reuses the same verified separators + canonical-padding construction.

---

## Suspected overlaps with existing index entries (for the validator)
- The blanket "matches the Aztec stack, parity-tested" + point-doubling-aliasing-fix +
  constant-time framing are **AHW-029 / the firmware negatives** — I did NOT re-report those; my
  results are the *constant-by-constant proof* behind that blanket claim (assurance depth), plus
  the two LOW nits which are net-new.
- NEW-R4-C-01 (smoke-vector labels) is adjacent to **AHW-015** (oracle-anchor comment) only in
  spirit (both are "make the parity fixtures legible to a future maintainer"); it is a distinct
  artifact (the golden-vector JSON labels, not the `deviceOuterHashForIntent` anchor comment).
- No overlap with the side-channel items (AHW-016/019/020/029): this round is *value-correctness*,
  explicitly orthogonal to timing/EM.
