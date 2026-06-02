# Firmware Red-Team — Pre-External-Audit Review (BOLOS C, `ledger-app/src/`)

**Scope:** APDU parsing memory safety, handler state machine, device-side
security invariants (3× fault-hardened outer-hash, B3 consumer binding, M8-P6
sovereignty), crypto-primitive correctness (Grumpkin/BN254, Schnorr, Pedersen,
Poseidon2, Blake2s, ECDSA), secret hygiene + side-channel. ~7,616 LOC of C.
TS host adapter is out of scope (different reviewer). Source review only (no
build / BOLOS SDK absent).

---

## VERDICT: AUDITOR-READY (with documentation cleanups)

This firmware is in unusually good shape for a PoC heading to external audit. The
high-value invariants (sign-what-the-device-computed, B3 consumer binding, M8-P6
sovereignty re-derivation, 3-pass fault-hardened hash recompute, point-doubling
aliasing fix) are **actually enforced in code**, not merely asserted in comments —
and each is backed by a host-parity or edge-case test. I found **zero CRITICAL and
zero HIGH** memory-safety or crypto-correctness defects. Findings are confined to
MEDIUM/LOW: one genuine residual (no rate-limiting on the secret-reveal /
key-derivation surface — EM-probe amplification), one fail-open gap on the
malformed-APDU path that is **not** independently exploitable, and a cluster of
**stale comments that UNDERSTATE the hardening** (the code is better than its own
documentation claims) which will waste the external auditor's time if left.

Severity counts: **CRITICAL 0 / HIGH 0 / MEDIUM 3 / LOW 5.**

The honest framing the team already adopted holds up: the portable C field/EC
layer is **not** certified constant-time, and the residual is correctly
characterized (operand-dependent `fr_mul`/`gk_fq_mul` timing + the documented
single-pass-vs-dual-pass nuance), with a `dudect` gate that proves the *control-flow*
leak (leading-zero count) is closed and reports the value-dependent residual as
non-gating. Do not represent this build as side-channel-resistant; the code does
not.

---

## CRITICAL

None.

---

## HIGH

None.

---

## MEDIUM

### M-1. No rate-limiting / throttle on `GET_AZTEC_MASTER_SECRET` or any seed-derivation INS (EM-probe amplification)
**Files:** `handler/get_aztec_master_secret.c:82-164`, `l4/aztec_secret.c` (whole),
`l4/account_derive.c:70-84`, `handler/get_schnorr_pubkey.c:22-56`.
**Evidence:** `grep -rni "rate.limit|throttle|counter|attempt|nvm_|N_storage|cooldown"`
over `src/` returns **only** Blake2s's internal length counter. There is no NVM
attempt counter, no cooldown, no escalating delay anywhere in the app.
**Impact:** The reveal path is gated behind a high-friction NBGL confirmation
(good — it cannot be silently triggered by a dApp; see Solid list), but the
underlying derivations (`az_derive_master_secret`, `az_derive_schnorr_signing_scalar`,
the four `derive_viewing_pubkey` calls in `az_account_derive_from_path`) run on
every authwit FINALIZE, every deploy BEGIN+FINALIZE, and every pubkey query — with
**no cap on repetition rate**. For a *physically present* attacker doing
EM/power side-channel collection, unlimited fast re-derivation of the same
secret-dependent SHA-512 + Montgomery-reduce + `[k]G` is exactly the amplification
primitive that turns a marginal leak into a key extraction. This is a residual the
opus M8 plan implicitly conceded (portable C not certified constant-time); making
it explicit: with no rate limit, the side-channel attacker gets unlimited traces.
**Recommended fix:** For production (not PoC): an NVM-backed monotonic throttle on
the reveal INS specifically (it is the only INS that exports secret-derived bytes),
plus a global derivation-rate ceiling. At minimum, document in the audit hand-off
that no anti-amplification control exists and that the constant-time deficiency
therefore has no compensating control. Cite the Donjon side-channel pass as the
gating dependency (already named in `point.h:30-36`).

### M-2. Malformed-length APDU mid-L4-stream does not reset the L4 session (fail-open against the dispatcher's own invariant)
**File:** `app_main.c:39-45`.
**Evidence:** When `apdu_parser()` fails (bad Lc framing), the loop does
`io_send_sw(SWO_WRONG_DATA_LENGTH); explicit_bzero(&G_context, …); continue;` — it
zeroes `G_context` (L2 state) but **not** `G_l4_session` / `G_l4_deploy_session`.
The dispatcher's stated invariant (`dispatcher.c:1-13`) is "any non-0x9000 path
zeroes the L4 session", and `reject_dispatch()` upholds it for every path *inside*
the dispatcher — but a parse failure short-circuits *before* the dispatcher runs,
so this one byte-level reject path violates the invariant.
**Impact:** LOW-to-MEDIUM, and **not independently exploitable for an unauthorized
signature.** An attacker who interleaves a bad-length frame between two valid
APPEND_CALLs leaves the session parked in `L4_HEADER_PARSED`/`L4_CALLS_COMPLETE`.
But to do anything with it they must send further *well-formed* APDUs, which then
flow through the dispatcher whose state-machine gates (`finalize` requires
`L4_CALLS_COMPLETE`, `append` requires `L4_HEADER_PARSED` and
`calls_received < call_count`) and per-call parity recompute remain fully intact. So
this cannot skip BEGIN, forge a count, or sign without confirmation — it only
extends a session's liveness across a junk frame. The risk is purely
"stale-session lifetime" (the exact class codex flagged for the L2-boundary case),
applied to the parse-error path the dispatcher can't see.
**Recommended fix:** Call `l4_session_reset()` alongside the `explicit_bzero(&G_context, …)`
in the `apdu_parser` failure branch (`app_main.c:43`). One line; closes the
invariant uniformly. Add a Speculos test: BEGIN_AUTHWIT(count=1) → raw bad-Lc frame
→ APPEND_CALL must return wrong-state, not accept.

### M-3. B3 / authwit consumer binding silently conflates "wrong account" with "unsupported template/salt" — a fail-closed scope cliff the auditor will probe
**Files:** `handler/finalize_and_sign.c:98-183` (`b3_verify_consumer_is_this_account`),
`sw.h:30-40` (the `SW_AUTHWIT_CONSUMER_MISMATCH 0x6F12` note).
**Evidence:** The recompute hard-codes `salt = Fr.ZERO` (`B3_ZERO`, line 113) and
profile 0 (ECDSA-K) / SchnorrAccount class for the two curves. The header comment
(`sw.h:33-39`) is admirably honest that 0x6F12 means *either* "consumer ≠ this key's
account" *or* "account uses a non-default template/salt this build can't verify",
and the device cannot distinguish them.
**Impact:** This is **fail-closed and therefore not a security hole** — a
non-default-salt account simply can't authwit-sign on this build. But it is a
correctness/availability cliff and a likely auditor question: any user who
deployed with a non-zero salt (a perfectly legal Aztec deploy) is permanently
locked out of clear-signed authwits with a misleading error, and the *security*
guarantee ("from == consumer == this account") only holds for the salt/profile the
device assumes. If the demo ever ships a non-zero-salt account the binding check
will reject every legitimate signature.
**Recommended fix:** No code change required for PoC correctness, but (a) make the
salt an explicit, displayed, BEGIN-committed field that the recompute consumes (so
the binding is salt-agnostic), or (b) document the zero-salt/profile-0 assumption
as a hard precondition in the audit scope and assert it at BEGIN_AUTHWIT (reject
any flow that could imply a different salt) so the guarantee is stated, not
implied. Currently the salt is never on the authwit wire at all — the device
*assumes* it.

---

## LOW

### L-1. Stale comments DRAMATICALLY understate the side-channel hardening (auditor time-sink)
**Files:** `crypto/grumpkin/mul_generator.c:11-29`, `crypto/grumpkin/point.h:30-36`,
`crypto/grumpkin/point.c:77` (`grumpkin_point_double` header doc says "Handles p =
infinity" implying a branch).
**Evidence:** Both `mul_generator.c` and `point.h` describe the **old branchy**
behavior in present tense — "both `grumpkin_point_double` and
`grumpkin_point_add_affine` take their infinity fast-path early returns", "leading-
zero bits hit the infinity fast-paths", "the rare `H==0` data branches in
add_affine are also data-dependent". But `point.c` is the **M11 P3 branch-free
rewrite**: `point_double` has "NO data-dependent early return" (line 80), and
`add_affine` computes the generic result plus all three exceptional candidates and
`cmov`-selects them (lines 138-228) with no data-dependent control flow. The code
is *more* constant-time than its own headers claim.
**Impact:** None to security. But an external auditor reading the headers first will
flag a leak that no longer exists, burn time confirming, and lose trust in the
comments. Misleading documentation on a crypto-core file is itself an audit finding.
**Recommended fix:** Rewrite the `mul_generator.c` and `point.h` threat-model
paragraphs to describe the branch-free reality: control flow is now scalar-
independent; the *remaining* residual is operand-dependent `fr_mul` timing (the
final conditional subtract + schoolbook multiply), which the `dudect` harness
measures and reports as the deferred `cx_math` item. Keep "NOT side-channel-
resistant" — that is still true at the µarch level — but stop describing deleted
branches.

### L-2. Stale comments in both FINALIZE handlers claim the Schnorr scalar/nonce derivation is "single-pass"
**Files:** `handler/finalize_and_sign.c:268-278`,
`handler/finalize_deploy_and_sign.c:226-234`.
**Evidence:** Both say "The scalar/nonce derivation here is single-pass — but a
glitch there yields a sig for a different key…". As of M11 P1 this is false:
`az_derive_schnorr_signing_scalar` (`aztec_secret.c:172-196`) and
`az_derive_schnorr_nonce` (`aztec_secret.c:199-224`) each derive **twice** into
independent buffers and gate on a two-direction fault-hard compare
(`dd_eq32_dir` forward + reverse, two reject sites) before returning. The fault
posture is stronger than the comment admits.
**Impact:** None to security (the comment understates the defense). Same auditor-
confusion cost as L-1.
**Recommended fix:** Update both comments to state the scalar and nonce are now
dual-derived with a fault-hard compare, and the sign helper additionally dual-runs
the construction.

### L-3. `INS_CXMATH_SPIKE` throwaway INS is flag-gated but present in source
**Files:** `apdu/dispatcher.c:180-187`, `types.h:42-46` (`INS_CXMATH_SPIKE = 0x70`),
`handler/cxmath_spike.c`.
**Evidence:** The spike INS and handler are compiled only under `#ifdef CX_MATH_SPIKE`
and the comments repeatedly state "never in the shipped build."
**Impact:** Low, contingent on build hygiene. If `CX_MATH_SPIKE` is ever defined in
a release Makefile by accident, it exposes an unreviewed field-arithmetic INS to
the attacker-controlled APDU stream.
**Recommended fix:** Confirm the release Makefile cannot define `CX_MATH_SPIKE`
(grep the build config), and add a `_Static_assert`/`#error` guard that fails the
build if `CX_MATH_SPIKE` is set together with a release/production flag. Delete the
spike before submission if it has served its purpose.

### L-4. `get_aztec_master_secret` reveal UI wording is generic ("Transaction signed") on the success-dismiss
**Files:** `handler/get_aztec_master_secret.c:175-182`,
`ui/master_secret_reveal_ui.c:79-86`.
**Evidence:** The reveal confirm screen itself is correctly worded ("Reveal Aztec
viewing key", "Lets this computer see your notes. Not spending.") — that is the
security-relevant gate and it is good. But the post-approval status page reuses
`STATUS_TYPE_TRANSACTION_SIGNED` ("Transaction signed"), which the code itself flags
as "mildly off for a reveal."
**Impact:** Minimal — the binding confirmation already happened. But for a screen
whose entire purpose is to make the user understand they exported viewing
capability, "Transaction signed" is a UX/clarity regression that could let a user
misremember what they approved.
**Recommended fix:** Custom status string ("Viewing key revealed") for the reveal
dismiss. Already noted as a Speculos-pass polish item in the code; track it so it
isn't lost.

### L-5. `claimed_outer_hash` canonical check is present but the deploy "received" bit and the authwit path differ in shape (minor consistency)
**Files:** `handler/finalize_and_sign.c:188-196`,
`handler/finalize_deploy_and_sign.c:94-101`.
**Evidence:** The deploy path uses an explicit `claimed_outer_hash_received` bool
(correctly avoiding the "Fr(0) is a valid hash" zero-scan pitfall — good, codex
P6d). The authwit path instead relies on the `L4_CALLS_COMPLETE` state gate to know
a claim is present. Both are correct, but the asymmetry means a reader must verify
two different "is the claim present" mechanisms.
**Impact:** None — both are sound. Pure consistency / reviewability nit.
**Recommended fix:** Optional: note in a comment on the authwit FINALIZE that the
state machine (not a bool) is the "claim present" guard, mirroring the deploy
rationale, so the two are obviously-equivalent to a reviewer.

---

## Solid / well-done (defenses that ARE enforced, verified in code + tests)

1. **The device signs ONLY what it recomputed, never the host claim.** Both
   `finalize_after_approval` (`finalize_and_sign.c:240-385`) and
   `finalize_deploy_after_approval` (`finalize_deploy_and_sign.c:114-340`) sign a
   *local* (`recheck_outer` / `recomputed_outer` → `outer_hash_local`) that was just
   proven equal to the claim. `grep` confirms `claimed_outer_hash` is used **only**
   in `ct_memcmp32` equality checks, never as a hash input or signing input. This
   defeats the TOCTOU class (a glitch on the mutable session field after the compare
   cannot change what is signed) — explicitly the codex L4 BLOCKER #1 / P9 BLOCKER.

2. **3-pass fault-hardened outer-hash is real, not cosmetic.** `finalize_and_sign.c`
   runs `l4_compute_outer_hash` twice before UI (both vs claim, and vs each other,
   inner+outer) and a third time in `finalize_after_approval` (vs stored AND vs
   claim). The independent recompute (`l4/parity.c`) consumes only device-authored
   `slot->args_hash` (overwritten in `append_call.c:171` after the double-recompute
   cross-check). No host-claimed args_hash survives into parity.

3. **B3 consumer binding is enforced at two distinct sites (pre-UI and pre-sign)**
   with constant-pattern `ct_memcmp32`, and the pre-sign re-check re-derives the
   account from the *signer path* so the signing key is bound to the verified
   consumer (`finalize_and_sign.c:254-266`). Fail-closed: any derivation error or
   mismatch → reject, never a false accept. Covered by `b3-consumer-binding.test.ts`.

4. **M8-P6 sovereignty is enforced.** `begin_deploy_account.c:255-316` derives the
   device's own viewing keys from its seed, computes publicKeysHash + address in two
   independent passes (self-consistency = fault gate; then host-equality = sovereignty
   gate, `0x6F0F`/`0x6F0E`), and `finalize_deploy_and_sign.c:165-189` re-derives a
   third time before signing. The UI displays `address_local` (device-derived), not
   the host's `expected_address` (`deploy_review_ui.c:104-105`). A hostile host
   cannot get the device to sign a deploy carrying host-controlled protocol keys.

5. **Point-doubling aliasing bug is fixed AND regression-tested.**
   `grumpkin_point_add_affine` computes the `dbl` candidate from the *original* `p`
   before writing `out` (`point.c:189-209`), so the in-place
   `add_affine(acc, acc, …)` Pedersen accumulation (`pedersen.c:67`) is safe on the
   P==Q path. `grumpkin-point-add-edge.test.ts` has a dedicated
   `out-aliases-p` vector verified non-circularly (value computed two ways).

6. **APDU parsing is disciplined.** Field-by-field `buffer_read_*` (BOLOS SDK,
   bounds-checked), `args_count > L4_MAX_ARGS` checked **before** the read loop
   (`append_call.c:114`), `memset(slot->args,0,…)` before partial fill, explicit
   trailing-byte rejection (`cdata->size != cdata->offset`) on every parser, full
   canonical-path enforcement (`m/44'/AZTEC'/<acct>'/0/0`, exactly 5 components) on
   every signing/derivation path. **No VLAs, no `alloca`, no variable-length
   `memcpy` except Blake2s's `remaining<=64` into `block[64]`.** No integer-overflow
   surface in offset math (counts capped at tiny constants: 5 calls, 4 args).

7. **State machine is single-in-flight and reset-on-reject everywhere inside the
   dispatcher.** Mutual exclusion between authwit and deploy paths
   (`L4_DEPLOY_CONTEXT` requires `L4_IDLE` entry), BEGIN zeroes, ABORT zeroes,
   every `reject()` zeroes, every L2-boundary INS zeroes. Skip-BEGIN→FINALIZE is
   blocked by the `state != L4_CALLS_COMPLETE`/`!= L4_DEPLOY_CONTEXT` gates; replay-
   APPEND is blocked by `calls_received >= call_count`.

8. **Crypto primitives match the real Aztec stack, proven by parity tests against
   `@aztec/foundation` and the on-chain barretenberg verifier.** Schnorr sigs
   verify under `@aztec/foundation Schnorr` across 64 random vectors + a byte-exact
   vector (`schnorr-parity.test.ts`); deploy outer-hash is byte-exact vs the genuine
   `DefaultAccountEntrypoint.wrapExecutionPayload` (`deploy-outer-hash-parity.test.ts`);
   Poseidon2/Pedersen/Blake2s/Fq-wide/account-derivation all have parity suites.
   Field arithmetic is standard CIOS Montgomery with correct final conditional
   subtraction; `fr_from_bytes_be`/`gk_fq_from_bytes_be` reject non-canonical input
   (`>= p`); `l4_fr_is_canonical` correctly rejects exactly-`p`.

9. **Schnorr nonce is deterministic and well-bound.** `k = reduce_Fq(SHA-512(DOMAIN
   ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg))` (`aztec_secret.c:109-151`). Binds
   curve_id + pubkey + priv + msg, so no cross-scheme/cross-account (k,msg) repeat
   and no RNG-failure reuse. Zero-`k`/zero-`e`/zero-`s` all rejected
   (`schnorr.c:39,58,64`). **Modular bias is negligible:** a 512-bit SHA-512 output
   reduced mod the ~254-bit Grumpkin order has bias ≤ 2^-258. Signing scalar rooted
   in the BIP-32 child priv (not the host-exportable master secret), keeping spend
   authority off the reveal surface (codex CRITICAL, enforced at `aztec_secret.c:90-97`).

10. **Secret hygiene is dense and consistent.** `explicit_bzero` /
    `grumpkin_secure_wipe` (a `volatile` loop the compiler can't DSE) on every
    secret-derived stack temporary across all 10 secret-touching files; scalar-mult
    and field-inversion temporaries scrubbed (`point.c`, M8 P7.0); reveal secret
    armed/disarmed/wiped, response buffer wiped after send. `ct_memcmp32` /
    `ct_diff64` constant-pattern compares (no early exit) for all secret/hash
    equality.

11. **The reveal path cannot be silently triggered by a dApp.**
    `GET_AZTEC_MASTER_SECRET` is single-shot, derives+arms, then **defers to an NBGL
    confirmation** (`ui_display_master_secret_reveal`) with explicit "viewing key, not
    spending" wording and a host-mirrorable 4-hex checksum; the secret is emitted
    only from the user-confirm callback. Derives twice + fault-compares before arming.
    (See M-1 for the missing rate-limit — that is the only gap on this surface.)

---

## Test-coverage gaps for these invariants

1. **No on-device test for M-2 (malformed-frame mid-stream).** `wire-negative.test.ts`
   covers malformed *bodies* parsed by the handlers, but not a transport-level
   bad-Lc frame injected between APPENDs to probe `app_main.c`'s parse-failure reset.
   Add: BEGIN_AUTHWIT(count=1) → raw under/over-length frame → APPEND_CALL must
   return wrong-state. (Will also regression-guard the M-2 fix.)

2. **The fault-injection ("3× recompute", dual-derive, dup-sig) defenses have no
   negative test that simulates a glitch.** Every parity test confirms the *happy*
   path agrees byte-exact; none injects a corrupted intermediate (e.g. flip one byte
   of `G_l4_session.outer_hash` between pass-2 and pass-3, or make `sign_once` return
   a differing second pass) to prove the mismatch branch actually rejects. The fuzz
   harness (`wire_host`) exercises the *parser* seam with ASan/UBSan + known-SW, and
   the bidirectional differential-replay proves device-faithfulness — but the
   fault-comparison reject *arms* are unexercised. A host-compiled unit test that
   stubs the second derivation to differ would close this. (Acknowledged hard to do
   without a fault-injection rig; a software stub is the pragmatic substitute.)

3. **B3 non-default-salt rejection (M-3) is untested for the lock-out behavior.**
   `b3-consumer-binding.test.ts` should add a vector asserting that an account
   deployed with a non-zero salt produces `0x6F12` (documenting the scope cliff as
   intended behavior), so a future change that silently breaks zero-salt accounts is
   caught.

4. **No rate-limit / amplification test (M-1).** Inherent — there is nothing to test
   until a control exists. Track as a production gate alongside the Donjon
   side-channel pass.

5. **`cs_format_amount` is parity-light on adversarial inputs.** The routine is
   bounds-safe (verified: `digits[40]` holds the 39-digit u128 max; `need_room ≤ 42 ≤
   CS_FORMAT_MAX_LEN=48`; high-16-bytes-nonzero and `decimals>30` both rejected; the
   trailing-zero-trim `dot_pos` math cannot underflow because `pos` always passed the
   dot+1 digit). But there is no explicit fuzz/parity vector for amount-rendering
   edge cases (u128 max, all-9s, decimals=30, amount with high bytes set → reject).
   Add a small table-driven host test. (No defect found — this is hardening the proof,
   not fixing a bug.)
