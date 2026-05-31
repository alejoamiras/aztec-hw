# M11 Phase 7 — post-impl codex review + fix loop

codex post-impl ADVERSARIAL review of P0–P4 (diff `safe-v8..HEAD`). Session
`019e7fb1-9190-7611-9b99-4228f89e2001`. Verdict: **blocker** (1 blocker, 1 major,
1 minor) — exactly what a post-impl review is for: it found a real regression the
parity + edge tests structurally could not catch.

## BLOCKER — in-place aliasing in the constant-time point add (FIXED, commit 4cf594b)

`grumpkin_point_add_affine` (P3 branch-free rewrite) stored the generic madd
result into `out` *before* computing `grumpkin_point_double(&dbl, p)`. When `out`
aliases `p` — which **Pedersen does** on every accumulation step:
`grumpkin_point_add_affine(acc, acc, …)` at `pedersen.c:67` — the `dbl` candidate
for the P==Q select doubled the *already-overwritten* generic result instead of
the original `p`. So whenever an accumulator equalled the term being added (the
P==Q / `h_zero & r_zero` path), the device silently produced a wrong Pedersen
hash → wrong outer_hash → wrong address/signature. The branchy safe-v8 code
doubled `p` before any write, so this was a genuine regression introduced by the
constant-time surgery, not a pre-existing bug.

Why the tests missed it: the edge vectors
(`grumpkin-point-add-edge.test.ts`) and the host `point-add` mode used **separate**
`out`/`p` buffers, never exercising the alias. The bb.js parity tests use random
inputs that essentially never hit `acc == term`.

**Fix:** build the `dbl`/`qj`/`inf` exceptional candidates from the original `p`
*before* writing `out`. The generic path was already alias-safe (its last read of
`p` — the Z3 step — precedes the out-write). Surgical reorder, no formula change.

**Validation (all green):**
- New in-place edge vector (out aliases p): `G+G == [2]G` byte-exact. Added an
  `ip` flag to the host `point-add` CLI to reach the path.
- Full crypto parity **46/46, 1474 asserts** — incl. `pedersen-parity`
  end-to-end vs bb.js `pedersenHash` (the on-chain Pedersen). This is the real
  proof: the device's in-place accumulation now matches bb.js exactly.
- dudect constant-time gate still PASS (leading-zero ratio 1.161).

## MAJOR — extra unconditional `point_double` per mixed-add (ACCEPTED, documented)

The branch-free approach computes the doubling candidate on *every* `add_affine`,
so `[k]G` and Pedersen each pay an extra double per step. codex: "material latency
regression with no benchmark." Disposition: this is the **intentional
constant-time tax** — the alternative is the data-dependent `P==Q` branch we
deliberately removed (the timing leak). A complete/unified short-Weierstrass
formula (Renes–Costello–Batina) avoids the separate double but costs *more*
multiplications, so it's not a win. The on-chain deploy+transfer flows complete
through Speculos without timeout, so latency is within working bounds. A real
Nano S+ wall-clock benchmark is **deferred to the hardware phase** (no physical
device in the PoC loop; Speculos is functional, not cycle-accurate). dudect's
host timings (~209–243 µs/[k]G) are the only current numbers.

## MINOR — `Y==0` guard removal → non-canonical infinity (ACCEPTED, documented)

Removing the `Y==0` early-return in `point_double` means doubling a 2-torsion
point now yields `Z==0` with arbitrary `X/Y` rather than canonical `(0,0,0)`.
Disposition: Grumpkin has **prime order**, so its prime-order subgroup contains
no 2-torsion (no `Y==0`) points; this never occurs for valid in-subgroup inputs.
The "byte-identical to safe-v8" claim therefore holds for all *valid* inputs;
the divergence is only on inputs the protocol never produces. No caller depends
on canonical infinity representation.

## codex confirmed correct (genuine attempts to break, failed)

- `point.c` select order (`inf`, then `dbl`, then `qj` last): correct — `qj` last
  means `O + Q = Q` wins even when `H/r` flags are nonsense for `p == O`.
- No UB running generic madd/double on `p == O` or `H == 0`: all stays in reduced
  `fr_*` arithmetic, no inversion / divide-by-zero.
- `aztec_secret.c` dual-derive: `dd_eq32_dir` is `noinline` + volatile, so the
  optimizer cannot legally CSE the two compares away. Helps vs single transient
  faults (not common-mode) — as designed.
- P4 `account_binding` dedup is byte-equivalent to the 3 originals, and the
  session/deploy-session delegation is correct.

## Takeaway

In-place aliasing is the canonical trap when converting branchy EC code to
compute-all-candidates-then-select: any candidate that reads an input must be
computed before the first write to a possibly-aliased output. Add an explicit
in-place test whenever a function documents `out may alias p`.

## Closing audit (P7-final, codex session `019e…`/`yqwEC710`) — verdict CLEAN

Ran a second adversarial pass over `safe-v11..HEAD` pointed specifically at
hunting **sibling** aliasing bugs (the highest-value remaining risk). Result: no
blocker, no major.
- **No sibling aliasing bug.** codex confirmed `point.c` is the only place with the
  hazard and the fix is complete: `dbl/qj/inf` are built before the first `out`
  store, the selects only read those temps (not `p`/`qx`/`qy`), so both `out==p`
  and `qx/qy` aliasing are covered; `pedersen.c:67` remains the sole in-place caller.
- **B3 test independently validated.** codex traced that a returned `0x6F12` is
  provably the pre-UI B3 reject: `call_count==0 → CALLS_COMPLETE`, `0x6F12` is
  emitted only at `finalize_and_sign.c:182`, and without `autoConfirm` a UI-reaching
  FINALIZE would *hang* (not return) — so no earlier lookalike can produce it.
- **P5 decision sound** for the PoC; the only deliberate cliff is the documented
  fail-closed `0x6F12` on non-zero-salt / non-default-template accounts.

Two MINORs folded (fix loop closed):
1. `b3-consumer-binding.test.ts` no longer overclaims that `Fr(1)` differs from the
   real account — reframed as the cryptographically-negligible (~2^-254) collision
   it is.
2. Added `AUTHWIT_CONSUMER_MISMATCH: 0x6f12` to the host `SW` map (`apdu.ts`) and
   imported it in the test instead of a hardcoded literal — removes host/device
   status-word drift on the new path.
