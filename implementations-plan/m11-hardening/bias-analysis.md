# M11 P2 — modular-reduction bias of the Schnorr scalar/nonce derivation

## What's derived this way
`l4/aztec_secret.c` derives, as `reduce_n(SHA-512(domain ‖ …))`:
- the Schnorr **signing scalar** = `SHA-512("aztec-schnorr-signing-v1\0" ‖ secp256k1_child_priv) mod n_grumpkin`
- the per-signature **nonce** `k` = `SHA-512("aztec-schnorr-nonce-v1\0" ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg) mod n_grumpkin`

(The viewing scalars use the same `reduce_n(SHA-512(…))` shape — `gk_fq_from_bytes_wide_be`.)

`n_grumpkin` = the Grumpkin scalar field order ≈ 2²⁵⁴ (BN254 base field Fq). The SHA-512 digest is **512 bits** (`L = 512`).

## The bias bound
Reducing a uniform `L`-bit integer mod `n` yields a distribution whose statistical distance from uniform over `Z_n` is

  Δ ≤ n / 2^L

(each residue gets either ⌊2^L/n⌋ or ⌈2^L/n⌉ pre-images; the imbalance is bounded by `n/2^L`).

With `L = 512` and `n ≈ 2²⁵⁴`:

  **Δ ≤ 2^(254 − 512) = 2⁻²⁵⁸**

— i.e. the derived scalar/nonce is indistinguishable from uniform-over-`Z_n` to within 2⁻²⁵⁸. Cryptographically negligible (a signer would need ~2²⁵⁸ signatures to exploit it; the field has ~2²⁵⁴ elements).

## Why NOT rejection sampling
Rejection sampling (RFC 6979 `bits2octets` + retry) exists to remove this bias when the input width is **close to** the modulus width (e.g. reducing a 256-bit value mod a 256-bit `n`, where Δ can be ~2⁻¹). Here the input is **258 bits wider** than the modulus, so the bias is already ~2⁻²⁵⁸ and rejection sampling would remove a negligible quantity at the cost of a data-dependent retry loop (itself a timing side-channel). It buys nothing and would *hurt* constant-timeness. The same wide-reduce (512→~254) is used by Zcash's Jubjub `to_scalar` and the Mina Ledger app — neither rejection-samples here.

## Regression guard
`grumpkin-fq-wide-parity.test.ts` (describe "M11 P2"):
1. asserts `512 − bitlen(n) ≥ 200` (bias ≤ 2⁻²⁰⁰) — trips if the input is ever narrowed (e.g. someone swaps SHA-512 → a 256-bit hash, or feeds a 256-bit pre-reduced value).
2. asserts the device reduce is a **plain `mod`** (q→0, q+1→1, 2q→0), not a rejection-sampling variant.

## Verdict
**No code change.** The derivation is already correct; this phase documents the bound and pins the parameters so a future change can't silently introduce bias.
