# cx_math migrate-vs-accept decision (M12 P3)

**Verdict: ACCEPT THE RESIDUAL now (Outcome C). Gate any future migration on a real-silicon eval (M13).**
Confidence: **high** that `cx_bn` handles *our two specific moduli* correctly (the narrow thing the spike tested); **moderate** on broad `cx_bn` correctness (only 4 vectors × 2 fields — see caveat below); **moderate-high** on the recommendation. The perf + CT axes are *explicitly unresolved* — Speculos cannot settle them.

## The question

The M11 dudect work isolated the device's residual side-channel concern to the **value-dependence of our hand-rolled Montgomery field multiply** (`fr_mul` / `gk_fq_mul`): the conditional final subtraction (and `fr_add`/`fr_sub`'s conditional reductions) branch on secret-derived values. M11 P3 made the *control flow* of the point layer constant-time (cmov), but field-mul value-dependence is a **power/EM** concern that constant-time C cannot close. The candidate fix: route field multiplication through Ledger's `cx_bn_mod_mul` (the secure-element bignum unit), inheriting the SE's side-channel posture.

This spike answers, with **real numbers from Speculos**, whether that migration is justified.

## The spike (throwaway, flag-gated `CX_MATH_SPIKE`)

`ledger-app/src/handler/cxmath_spike.c` — a flag-gated INS (`0x70`, never in the shipped build) that computes `acc = a·bⁿ mod p` four ways: `cx_bn_mod_mul` and native `fr_mul`/`gk_fq_mul`, for **both** of our custom 254-bit moduli:

- BN254 **Fr** = `0x3064…2833e848…f0000001` (scalar field — Poseidon2 / Pedersen / note hashing)
- Grumpkin **Fq** = `0x3064…97816a91…d87cfd47` (BN254 base field — Grumpkin point coordinates)

Driven by `ledger-app/tests/cxmath_spike/measure.ts` against Speculos (Nano S+, nanosp).

## Raw numbers

### 1. Correctness — the one thing Speculos settles (for the moduli tested)

`iters=1`, result vs a BigInt `(a·b) mod p` reference, **4 vectors × 2 fields = 8/8 MATCH** (`cx_bn === native === reference`). This is a targeted spot-check (incl. the `(p−1)²` reduction edge), **not** an exhaustive correctness proof — 4 vectors per field:

| vector | Fr (cx_bn / native) | Fq (cx_bn / native) |
|---|---|---|
| `2·3` | OK / OK | OK / OK |
| `(p−1)²` (max; exercises full reduction → 1) | OK / OK | OK / OK |
| `mid·mid` | OK / OK | OK / OK |
| pseudo-random | OK / OK | OK / OK |

**Finding:** `cx_bn_mod_mul` correctly handles **both of our custom 254-bit moduli** (Fr and Fq) across these vectors — including the full-reduction edge. This is **strong evidence against** the codex+opus "named-curve-only support / silent wrong-field reduction" failure mode for the moduli we actually use (it accepts an arbitrary modulus argument and reduces in the right field), though it is not an exhaustive proof. ⟹ there is **no correctness block** for our use, so Outcome B (hand-roll a CT Montgomery) is *not* forced.

### 2. Latency — CRUDE, EMULATED, **NOT silicon** (4096 chained muls, best of 5)

| op | total | per-mul (incl. APDU overhead) |
|---|---|---|
| `cx_bn` Fr | 51.7 ms | 0.0126 ms |
| native Fr | 5.8 ms | 0.0014 ms |
| `cx_bn` Fq | 51.4 ms | 0.0126 ms |
| native Fq | 5.8 ms | 0.0014 ms |

On Speculos (QEMU emulating the `cx_bn` *syscall* + its software bignum), `cx_bn` is **~9× slower** than our native limb code. **This number does not predict real-device latency** (caveat 2): on physical silicon `cx_bn` dispatches to the SE's hardware bignum coprocessor, whose performance profile (HW-accelerated multiply vs syscall-crossing overhead) is *not* what QEMU models. So this is, at best, weak-and-not-encouraging evidence for the perf case — and it cannot be trusted either way.

### 3. RAM / stack

`cx_bn` shifts working operands into the OS-managed locked BN store (`cx_bn_lock(32,…)` + 4 allocations of 32 B), reducing app-stack pressure vs the native four-`uint64_t` structs — a minor qualitative plus for `cx_bn`, not quantified on Speculos. Spike code size: `cxmath_spike.o` adds ~0.7 KB to the *flagged* build; the default build's `.text` is unchanged (additions are `#ifdef`'d out; the B3 binding files are untouched — empty-diff gate holds).

## The three generalization caveats (why the spike's reach is bounded)

1. **One op ≠ the field+curve layer** — `fr_add`/`fr_sub` conditional reductions, point add/double, `from_bytes` R²-fold all have their own value-dependence; the spike's CT win is *local* to the multiply.
2. **Speculos ≠ silicon** — QEMU on x86; it models *functional* CT (does it branch on secrets) NOT physical power/EM leakage, which needs a real device + scope, out of scope this arc.
3. **`cx_bn` = trust transfer** — migrating *inherits* Ledger's CT posture; it's a reasonable trust, not a proof.

## The three outcomes + recommendation

- **(A) Full `cx_bn` migration (→ M13).** Recommended *only if* `cx_bn` is correct for both moduli **AND materially faster** (a perf+CT twofer worth the cost). Correctness: ✅ proven. Materially faster: **unprovable on Speculos**, and the only emulated data point is *9× slower*. CT benefit: a trust transfer (caveat 3) that Speculos can't verify on silicon (caveat 2). ⟹ the twofer that justifies A's cost is **not demonstrated**.
- **(B) Hand-rolled CT Montgomery.** The "roll your own crypto" footgun — recommend only if (A) is correctness-blocked. It is **not** blocked. ⟹ rejected.
- **(C) Documented acceptance** — matching the **Mina** and **Zcash** Ledger apps, which ship hand-rolled field arithmetic and accept the field-mul value-dependence as a known residual (it's a power/EM concern that Speculos can't measure and constant-time software can't fully close). ⟹ **RECOMMENDED.**

### Recommendation

**Adopt Outcome C: accept the residual for the PoC.** The migration (A) cannot be justified on the available evidence — its perf benefit is unmeasured (and weakly contraindicated) and its CT benefit is unverifiable without hardware. Migrating now would trade audited, parity-locked native code for an SE dependency on *faith* in an unmeasured win. "Accept the residual" is a complete, defensible outcome and the industry-peer norm.

### Explicit M13 gate (what would reopen Outcome A)

A future `cx_bn` migration (the M13 arc, out of scope here) is gated on a **real-silicon evaluation that Speculos fundamentally cannot provide**:

1. **Latency on a physical Nano S+** — `cx_bn_mod_mul` vs native, measured on-device (not QEMU). Migration needs a *material* win on real hardware, where the SE bignum unit's true cost (HW multiply vs syscall crossing) is visible.
2. **Power/EM CT on real silicon** — a scope-based leakage assessment of `cx_bn` vs native (the caveat-2 measurement this arc cannot make). This is the *actual* security question the migration claims to answer.
3. Re-confirm correctness across the **full field+curve layer** (caveat 1), not one multiply.

Absent (1)+(2) showing a real win, Outcome C stands.
