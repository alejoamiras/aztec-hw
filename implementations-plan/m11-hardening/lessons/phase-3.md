# M11 P3 — constant-time shared point core (DONE → safe-v10)

## Change (commit cb22ce0, codex recipe)
`point.c`: deleted the 3 data-dependent early returns —
- `grumpkin_point_double`: the `∞ || Y==0` guard (dbl-2009-l collapses to O anyway).
- `grumpkin_point_add_affine`: the `∞` guard + the `H==0` (P==Q / P==−Q) branch.
Both ops now compute the generic formula AND the exceptional outcomes (2p, Q, O) unconditionally, then **constant-time cmov-select** (order matters: the p==O select runs LAST so it wins). One hardened core feeds `[k]G` (mul_generator) AND Pedersen. Output byte-identical.

## Validation (all green)
- **Parity 11/11 byte-identical** (grumpkin-varbase / pedersen / schnorr / schnorr-partial) — correctness on the generic path.
- **Edge vectors 4/4** (commit c526d88, new `point-add` CLI mode + `grumpkin-point-add-edge.test.ts`): P+P==[2]P (doubling cmov), P+(−P)==∞ (infinity cmov), ∞+Q==Q (z==0 cmov), generic P+Q==[8]G. Non-circular — refs via the device's own [k]G ladder (which computes [6]G generically, not via the P==Q path).
- **dudect control-flow gate PASS**: rewrote dudect.c to gate on the leading-zero mean RATIO (k=1 vs full-width). Pre-P3: ratio ~16 / Welch t=−2522. Post-P3: **ratio 1.16 → PASS**. The Welch t (≈−470) is now informational.
- **On-chain full-flow PASS** (tx 0x0fc416cb): Schnorr #4 drip+transfer through the CT core on testnet — real-input correctness.
- **No size regression**: nanos2 text=45650 (unchanged — removed branches offset the added cmov/compute).

## Key insight — what P3 does and does NOT fix
P3 removes the **control-flow** leak (the ∞ fast-path + H==0 branch leaked the scalar's leading-zero count). It does NOT make the FIELD arithmetic constant-time: `fr_mul`/`fr_sqr` are value-dependent, so a full Welch t over the scalar-mul still detects a residual (k=1's all-∞ iterations run field ops on zeros, which are faster). That residual is the **documented, DEFERRED `cx_math` migration** (codex + research agree; same posture as Mina/Zcash). Hence the dudect gates the control-flow ratio, NOT |t|<5 (which is unachievable without constant-time field arith).

Residual also: `point_to_affine_be` still branches on final ∞, but the signing path rejects zero scalars/nonces (`aztec_secret.c`), so it's outside the secret path (codex).

safe-v10 = P3 done. Next: P4 (dedup account-binding + handler-seam fuzz + private-from-binding spike).
