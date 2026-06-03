# Validator V3 — MEMORY-SAFETY / MODULARITY-TESTS / SIDE-CHANNEL / PRIVACY + 2 NEGATIVES

Validator **V3**, read-only + source-verified. Cluster: `E` (fw memsafety), `F` (modularity/tests),
`K2` (side-channel), `K8` (privacy/metadata), `K4` (crypto-correctness NEGATIVE), `K5`
(scheme-confusion NEGATIVE). Dedup vs AHW-001..094 + in-flight `_state.md`. **No global AHW numbers
assigned** — local refs `V3-01..` + source F-id. Every cited line was read in the current tree.

## Verdict table

| Local | Source | Title (short) | FINAL Sev | Owned | Verdict |
|-------|--------|---------------|-----------|-------|---------|
| V3-01 | F-K2-1 | Branchy low-S normalize/predicate leaks public `s` magnitude | **LOW** (↓ from HIGH) | OURS | **DOWNGRADE+ACCEPT** (distinct from AHW-029/068/019) |
| V3-02 | F-K2-2 | Short-circuit zero/eq predicates on secret Grumpkin limbs | **INFO** (↓ from HIGH) | MIXED | **FOLD → AHW-029 (+ AHW-019 comment half)** |
| V3-03 | F-K2-3 | ECDSA dup-sig fault check uses short-circuit `memcmp` | **LOW** (↓ from MED) | OURS | **ACCEPT** (novel; pairs with F-F-4) |
| V3-04 | F-K8-1 | APPEND_CALL exposes verb/recipient/amount on local wire | **LOW** (↓ from MED) | MIXED | **ACCEPT** (novel; USB/WebHID-inherent caveat) |
| V3-05 | F-K8-2 | "Forget" leaves account `secretKey` in embedded-wallet DB | **LOW** (↓ from MED) | OURS | **ACCEPT** (2nd retention point; near-fold AHW-038/048) |
| —     | F-K8-3 | Onboarding probes `isDeployed()` → leaks addr to RPC op | — | OURS | **REJECT-SCOPE** (frontend `apps/*`, out of scope; ≈AHW-082) |
| V3-06 | F-K8-4 | BEGIN frames send device-derivable identity in clear | **LOW** | OURS | **ACCEPT** (novel; metadata-only) |
| —     | F-E-* | Firmware in scope is MEMORY-SAFE | — | — | **CONFIRMED-CLEAN (negative)** |
| V3-07 | F-E-1 | `make_buf` trusts `cmd->lc`, no in-app reconcile vs `input_len` | **LOW** | MIXED | **ACCEPT** (novel; defense-in-depth) |
| V3-08 | F-E-2 | `cxmath_spike` skips `l4_session_reset` + uncapped iters loop | **LOW** | OURS | **FOLD → AHW-021** (enrichment) |
| —     | F-E-3 | `fr_as_u32_or_hex` `unsigned` shift portability nit | INFO | OURS | **ACCEPT (INFO)** or fold; trivial |
| V3-09 | F-F-1 | APPEND_CALL allowlist reject arms (6F09/0A/0B/0C) untested | **MED** | OURS | **ACCEPT** (novel; real security boundary) |
| V3-10 | F-F-2 | Device low-S + 0x6F06 dup-sig asserted by NO test | **MED** (low-S half) | OURS | **ACCEPT** (low-S novel; 0x6F06 glitch half folds AHW-025) |
| V3-11 | F-F-3 | `render_call_pairs` 95-line switch untestable off-device | **LOW** | OURS | **ACCEPT** (novel structural) |
| V3-12 | F-F-4 | `ct_memcmp32`×5 + `low_s_normalize`/`s_is_high`/`HALF_N`×3 dup | **LOW** | OURS | **ACCEPT** (novel; distinct from AHW-070/008) |
| V3-13 | F-F-5 | `wire-negative.test.ts` hand-copies SW consts vs `apdu.ts` | **LOW** | OURS | **ACCEPT** (novel) |
| —     | F-F-6 | `wrapExecutionPayload` branch-select untested | LOW | OURS | **FOLD → AHW-093** (test-half of same seam) |
| —     | K4 | crypto-correctness | — | — | **CONFIRMED-CLEAN (negative)** |
| —     | K5 | dual-scheme confusion | — | — | **CONFIRMED-CLEAN (negative)** |

**Counts:** ACCEPT = **9** (V3-03,04,05,06,07,09,10,11,12,13 minus the INFO = 10 incl. F-E-3 INFO);
FOLD = **4** (F-K2-2→AHW-029, F-E-2→AHW-021, F-F-6→AHW-093, + F-F-2's 0x6F06-half→AHW-025);
REJECT = **1** (F-K8-3, scope); NEGATIVES captured = **3** (F-E memsafety, K4, K5).
**FINAL severity of accepted: 0 CRIT · 0 HIGH · 2 MED (V3-09, V3-10) · 7 LOW · 1 INFO.**
Crit+HIGH contribution this batch = **0**. The three K2 "HIGH"s collapsed to LOW/LOW/INFO-fold — see reasoning.

---

## Side-channel strictness reasoning (the headline calibration)

The codex K2 agent filed **three HIGHs**. None survives as HIGH. Source-verified rationale:

**V3-01 / F-K2-1 — DOWNGRADE HIGH→LOW.** Two sub-claims:
- *The predicate* `s_is_high` (`sign_outer_hash.c:46`, `finalize_and_sign.c:63`, `finalize_deploy_and_sign.c:59`)
  is ALREADY a branchless mask-trick loop: `int already=(cmp!=0)?1:0; cmp = already ? cmp : (...)` —
  no early-exit, documented "comparison loop doesn't early-exit." Codex's premise that the high/low
  *test* branches is **factually wrong** for the predicate. (FALSE-POSITIVE on that half.)
- *The dispatch* `if (s_is_high(s)) low_s_normalize(s)` (`:160`) and `low_s_normalize`'s per-byte
  `if (v<0){...borrow=1}else{borrow=0}` (`:63`) **are** genuine secret-path branches. REAL but:
  **`s` is the public signature output.** Low-S normalization happens AFTER `s` is computed; the
  leaked bit is "was `s > n/2`" + the borrow pattern of `n-s` — i.e. one bit + carries of a value
  the device is about to *emit in cleartext anyway*. This is not a key/nonce leak. The mandate's own
  calibration ("a leak of `s` … is far less severe than a key/nonce leak") forces LOW. It is also
  squarely inside AHW-029's "portable-C not certified-CT" posture, but the explicit data-dependent
  *control flow* (vs AHW-029's value-dependent `fr_mul` residual) + the overstated comment (AHW-019
  class) make it a thin NEW LOW worth recording, not a fold. **Confidence: high.**

**V3-02 / F-K2-2 — DOWNGRADE HIGH→INFO, FOLD → AHW-029.** Source-verified: `fr_is_zero`
(`point.c:19`), `gk_fq_eq` (`fq.c:74`) ARE `&&`-short-circuit chains over 4 limbs of secret-derived
field elements (`H`,`r_orig` in `add_affine`; `Z`,`e_fq`,`s_fq` in schnorr/account_derive). BUT:
(1) at `-Oz` a 4-limb `==…&&…` over a fixed struct very commonly compiles to a branchless OR-reduce —
codex did NOT inspect emitted asm (it explicitly defers that to "audit -Oz like AHW-068 did"), so the
HIGH rests on source-level `&&` semantics, not a proven leak; (2) the `add_affine` flags
(`h_zero/r_zero/z_zero`) are immediately consumed by **cmov** (`point.c:213-215`), so the *selection*
is masked — the only residual is which limb first diverges, which is **exactly the operand-dependent
portable-C residual AHW-029 already owns as a PLATFORM-deferred negative.** The "constant-time
fr_is_zero" comment (`point.c:163`) overstating it is the AHW-019 comment-truth concern. Net:
**no NEW concrete OURS leak beyond AHW-029**; the comment half enriches AHW-019. This is the finding
the mandate warned hardest about ("don't let three timing observations become three HIGHs") — folded.
**Confidence: high** that this is a fold, not a distinct HIGH.

**V3-03 / F-K2-3 — DOWNGRADE MED→LOW, ACCEPT.** Source-verified `sign_outer_hash.c:189`:
`if (memcmp(r,r2,32)!=0 || memcmp(s,s2,32)!=0)` (also `finalize_and_sign.c:330`,
`finalize_deploy_and_sign.c:317`). Genuinely short-circuit + non-CT, and inconsistent with the
Schnorr path which uses `ct_diff64` (`schnorr.c:86`) and all the equality gates which use
`ct_memcmp32` (confirmed clean by codex itself). NEW (no AHW covers this ECDSA dup-sign compare).
BUT severity is LOW not MED: the operands `r,r2,s,s2` are the device's OWN freshly-recomputed
signature halves under a *deterministic* RFC6979 nonce — on the non-fault path they are byte-identical,
so the compare is constant-work in practice; the "prefix oracle" only materializes UNDER an active
fault (the attacker already glitched the SE), and what leaks is the position of divergence in the
about-to-be-public `s`/`r`. A correctness/consistency hardening, not a standing leak. Pairs naturally
with V3-12/F-F-4 (one shared `ct_memcmp32`). **Confidence: high.**

---

## Privacy reasoning (K8)

All four K8 items are real but the severities were inflated to MED; on a local-USB/WebHID trust model
+ scope, they calibrate down. AHW-082 already concedes "the RPC operator sees tx metadata; no secret
leak" as INFO, and AHW-080 concedes WebHID app-presence as LOW MIXED — the bus-observer threat model
is already documented as inherent. Against that baseline:

- **V3-04 / F-K8-1 (MED→LOW, ACCEPT, MIXED).** Verified `l4-manifest.ts:293`
  `new Uint8Array(3*FR_BYTES+2+args*FR_BYTES)` + raw `args[]` copied. A passive USB/WebHID/Speculos-MITM
  observer DOES see selector/target/flags/amount + the 0/2/4-arg shape pre-approval. NEW (AHW-082 is
  RPC-proxy, not APDU-payload). But the threat actor is a local-bus eavesdropper on a transport the
  PoC explicitly trusts (same class AHW-080 deemed LOW); the device shows the same data to the user.
  The OURS part is "we send raw not a padded envelope"; the "true confidentiality needs a different
  transport" part is LEDGER-PLATFORM (raw WebHID/USB has no app-layer encryption). LOW MIXED.
- **V3-05 / F-K8-2 (MED→LOW, ACCEPT, OURS).** Verified: `session-embedded-wallet.ts:67`
  `walletDB.storeAccount(address,{ secretKey: secret, ... })`; `ConnectPanel.onForget` (`:80-83`)
  calls only `clearAllCachedSecrets()` (the reveal-cache, `secret-cache.ts:48`) — the walletDB record
  carrying `secretKey` is NEVER scrubbed. NEW second retention point (AHW-048 = sessionStorage,
  AHW-038 = heap zeroize-on-forget). BUT the wallet is `ephemeral:true` (in-memory KV,
  `session-embedded-wallet.ts:108` + docstring `:14-20`) → the DB dies on reload, so exposure is
  bounded to the page lifetime — the SAME residual AHW-048's memory-only fix accepted and AHW-038
  parked. So it's a near-fold into AHW-038's "forget doesn't zeroize" theme; kept as a distinct LOW
  only because it names a concrete un-scrubbed `secretKey` store, not heap GC. Fold into AHW-038 if
  the orchestrator prefers one entry. **The session-embedded-wallet.ts store IS in scope; the
  ConnectPanel forget trigger is frontend — the finding survives on the in-scope half.**
- **F-K8-3 (REJECT-SCOPE).** Verified `OnboardPanel.tsx:112 session.isDeployed()` — but
  `apps/demo-browser/` is explicitly OUT of the C2 scope (FIRMWARE + WIRE, NOT frontend per
  `_state.md`). Behaviorally it also ≈AHW-082 (RPC operator already sees sims/tx). Not indexed.
- **V3-06 / F-K8-4 (LOW, ACCEPT, OURS).** Verified `clear-signing-entrypoint.ts:145` passes
  `this.address` as `consumer` (device-derivable), and the deploy encoder sends `publicKeysHash` +
  `expectedAddress` the device re-derives (`deploy-context.ts`). Redundant cleartext identity on the
  bus incl. on rejected flows. NEW (AHW-079 = approval-free pubkey pseudonym, different vector).
  LOW — metadata linkability only, same bus-observer model.

---

## Ready-to-index blocks (accepted)

### V3-01 (F-K2-1) · LOW · FW-CRYPTO · OURS
**Branchy low-S dispatch + normalize leak the (public) ECDSA `s` magnitude.** `sign_outer_hash.c:160`
`if (s_is_high(s)) low_s_normalize(s)` is a secret-path branch, and `low_s_normalize` (`:59-69`,
triplicated in `finalize_and_sign.c:73`, `finalize_deploy_and_sign.c:69`) does per-byte
`if (v<0){borrow=1}else{borrow=0}`. A timing/EM observer learns the `s>n/2` bit + the `n-s` borrow
pattern. **Calibrated LOW: `s` is the public signature output (normalized after computation), not a
key/nonce** — far below AHW-029's key-path concern. NOTE codex's claim that the `s_is_high` *predicate*
branches is FALSE — it is already a branchless mask-loop (`:46-55`). Distinct from AHW-029
(value-dependent `fr_mul`, not control flow), AHW-068 (cmov barrier), AHW-019 (comment-only). **Fix
sketch:** branchless cmov-select between `s` and `n-s` from a mask; fold into the shared low-S helper
(V3-12). **Confidence: high.** **Dedup:** novel control-flow instance; do NOT merge into AHW-029.

### V3-03 (F-K2-3) · LOW · FW-CRYPTO · OURS
**ECDSA duplicate-sign fault check uses short-circuit `memcmp`, not CT.** `sign_outer_hash.c:189`,
`finalize_and_sign.c:330`, `finalize_deploy_and_sign.c:317`:
`if (memcmp(r,r2,32)!=0 || memcmp(s,s2,32)!=0) reject(SW_DUP_SIG_MISMATCH)`. Inconsistent with the
Schnorr dup-check (`schnorr.c:86` `ct_diff64`) and all equality gates (`ct_memcmp32`). Under an
induced fault the compare is a prefix oracle over the (about-to-be-public) `s`/`r`. LOW: deterministic
nonce ⇒ constant-work on the non-fault path; only an attacker who already glitched the SE benefits.
**Fix:** one 64-byte CT compare or two `ct_memcmp32` ORed before the branch (use the V3-12 shared
helper). **Confidence: high.** **Dedup:** novel — no AHW covers the ECDSA dup-sign compare surface.

### V3-04 (F-K8-1) · LOW · WIRE · MIXED (raw-encoding OURS; transport-confidentiality LEDGER-PLATFORM)
**APPEND_CALL exposes verb/recipient/amount/shape to a local-bus observer pre-approval.**
`l4-manifest.ts:293` encodes `argsHash‖selector‖target‖flags‖len‖args[]` raw; body size
`98+32*args` also fingerprints the verb family. A USB/WebHID sniffer or Speculos-MITM sees full tx
semantics. **Same trust model AHW-080/082 already deem LOW/INFO** (the local transport is trusted in
the PoC). **Fix:** pad to a constant envelope if local-bus privacy matters; true confidentiality needs
an encrypted transport (platform). **Confidence: high.** **Dedup:** distinct from AHW-082 (RPC proxy),
AHW-040/050/051/081 (UI/log).

### V3-05 (F-K8-2) · LOW · DESIGN · OURS
**"Forget" clears the reveal-cache but leaves the account `secretKey` in the embedded-wallet DB.**
`session-embedded-wallet.ts:67` stores `secretKey: secret`; `ConnectPanel.onForget` only calls
`clearAllCachedSecrets()` (`secret-cache.ts:48`) → the DB record is never scrubbed. **Exposure bounded
to page lifetime** (`ephemeral:true`, in-memory KV — dies on reload), the same residual AHW-048
accepted. **Fix:** add `walletDB.removeAccount`/scrub on forget. **Confidence: high.** **Dedup:**
near-fold of AHW-038 (heap zeroize-on-forget) — kept distinct as a named `secretKey` store; FOLD into
AHW-038 acceptable. In-scope via the `session-embedded-wallet.ts` half (the trigger is frontend).

### V3-06 (F-K8-4) · LOW · WIRE · OURS
**BEGIN frames send device-derivable account identity in clear.** Authwit BEGIN sends `consumer`
(always `this.address`, `clear-signing-entrypoint.ts:145`); deploy BEGIN sends `publicKeysHash` +
`expectedAddress` the device re-derives + verifies (`begin_deploy_account.c`). Redundant cleartext
identity on the bus, incl. rejected flows. **Fix:** device uses its own derived identity; exchange only
a short confirmation digest if a host check is needed. **Confidence: high.** **Dedup:** distinct from
AHW-079 (approval-free pubkey pseudonym).

### V3-07 (F-E-1) · LOW · FW-STATEMACHINE · MIXED (validation in BOLOS `apdu_parser` = LEDGER-PLATFORM; missing in-app assert = OURS)
**`make_buf` trusts `cmd->lc` as the body size with no in-app reconcile vs `input_len`.**
`dispatcher.c:47` `buf.size = cmd->lc`; `app_main.c` feeds `input_len` only to `apdu_parser` then
discards it. NOT exploitable vs the stock SDK (the parser rejects `lc` mismatches — the BAD-LENGTH
path). Exposure is defense-in-depth/supply-chain: an `apdu_parser` regression silently turns every
`buffer_read_*` into an over-read of `G_io_apdu_buffer` and nothing in-repo catches it; the host
fuzz/differential oracle hand-builds `buffer_t`, so it never exercises the real `lc↔input_len`
coupling. **Fix:** `LEDGER_ASSERT(cmd.lc + OFFSET_CDATA <= input_len)` post-parse + a host-shim test
with declared-`lc` > payload. **Confidence: high.** **Dedup:** distinct from AHW-017/059 (session
reset on malformed) + AHW-024 (mid-stream test) — none pin the body-sizing trust. Novel.

### V3-09 (F-F-1) · MED · TEST · OURS
**APPEND_CALL strict-allowlist reject arms (0x6F09/0A/0B/0C) have NO targeted negative test.**
Verified: `fuzz_append_call.c:31-46` `is_known_append_sw` accepts 0x9000 AND every reject arm
(membership-only) — an accept-regression that turns the `from==consumer` **delegated-spend gate**
(`append_call.c:142-146`), the visibility gate, arg-count, or selector gate into a 0x9000 ships GREEN.
Grep confirms 0x6F09/0A/0B/0C appear ONLY in `fuzz_append_call.c` + `apdu.ts`, never in an
input→SW test assertion; `verified-calls-content.test.ts` exercises exactly one arm (0x6F08).
**Real security boundary** (the clear-sign-don't-blind-sign promise) → MED, not LOW. **Fix:** 4
Speculos cases hitting each arm with the exact SW (all reject pre-UI, like the 0x6F08 case). **Confidence:
high.** **Dedup:** distinct from AHW-024/025/046/091. Novel.

### V3-10 (F-F-2) · MED · TEST · OURS
**Device low-S anti-malleability + 0x6F06 dup-sig arm asserted by NO test.** Verified: the host
`normalizeLowS` test (`core/src/ecdsa.test.ts:43`) tests the SEPARATE host `core` impl, not the
device's 3 duplicated C `low_s_normalize` bodies; `test_sign_outer_hash.py` happy-path captures `r‖s`
but never inspects `s`'s magnitude; `0x6F06` appears only as a constant in `aztec_command_sender.py`,
never asserted. The index's "ECDSA-K low-`s` enforced" Confirmed-clean rests on a code read. A
regression dropping the normalize ships green → device emits malleable high-S sigs. MED (malleability
is a named protocol risk). **Fix:** assert `s <= SECP256K1_HALF_N` after the happy-path sign; best a
Speculos test that `secp256k1.verify`s the returned sig AND asserts low-S (also closes AHW-087's
host-verify gap). **Confidence: high.** **Dedup:** the low-S half is NOVEL (not a fault arm; always-on,
zero test). The 0x6F06 *glitch* half FOLDS into AHW-025 (fault-injection arms need glitch-sim) —
index the low-S half here, enrich AHW-025 with the concrete 0x6F06 arm.

### V3-11 (F-F-3) · LOW · MODULARITY · OURS
**`render_call_pairs` is a 95-line per-verb switch the display==signed boundary depends on, untestable
off-device.** `verified_calls_ui.c:232-325` hard-codes per-verb arg→label mapping inline with NBGL
static-pool index bookkeeping → only verifiable by booting Speculos + scraping screen text. Every
render-vs-sign bug found (AHW-040, AHW-050, AHW-086) traces to a missing/asymmetric arm here.
**Bounded** because the accept path is now content-tested (AHW-046). **Fix:** extract a pure
`cs_project_call_pairs(...)` returning plain structs, host-compile + table-test per verb; NBGL caller
copies into the pool. **Confidence: high.** **Dedup:** distinct from AHW-009 (TS monolith), AHW-046
(content test, still through Speculos). Novel structural finding for the C UI.

### V3-12 (F-F-4) · LOW · MODULARITY · OURS
**Security primitives copy-pasted: `ct_memcmp32`×5, `low_s_normalize`/`s_is_high`/`SECP256K1_HALF_N`×3.**
Verified: `ct_memcmp32` byte-identical in `append_call.c:65`, `begin_deploy_account.c:51`,
`finalize_and_sign.c:57`, `finalize_deploy_and_sign.c:53`, `get_aztec_master_secret.c:59`; low-S
triplet in `sign_outer_hash.c`, `finalize_and_sign.c`, `finalize_deploy_and_sign.c` with the half-order
constant hand-hardcoded per copy. Drift risk: one copy "optimized" to early-return `memcmp` →
per-handler timing/short-circuit hole (cf. V3-03); a typo in one `HALF_N` → per-handler malleability
hole with no shared test (V3-10). **Fix:** shared `l4/ct.h` for `ct_memcmp32` + `crypto/ecdsa_lows.{c,h}`
for the low-S normalize + constant. **Confidence: high.** **Dedup:** AHW-070 (canonical-path copies)
and AHW-008 (canonical-hash TS) are different primitives. Novel.

### V3-13 (F-F-5) · LOW · TEST · OURS
**`wire-negative.test.ts` reads an ad-hoc local SW table instead of importing `apdu.ts`.**
`wire-negative.test.ts:18-26` (and `wire-differential-replay.test.ts:52-53`) re-type the firmware
status words by hand. An `sw.h` renumber that updates `apdu.ts` but not these locals desyncs the
negative-test oracle from device reality with green CI. **Fix:** import `SW` from `apdu.ts`; delete the
local tables; consider a test asserting `apdu.ts SW === sw.h`. **Confidence: high.** **Dedup:** distinct
from AHW-058 (dead SW consts) + AHW-011 (untyped Speculos casts). Novel.

### F-E-3 · INFO · FW-UI · OURS  (accept-as-INFO or fold)
**`fr_as_u32_or_hex` uses `unsigned`-typed shifts (`verified_calls_ui.c:131-133`).** Pure portability
nit; on the 32-bit ARM target `unsigned`==`uint32_t` so it is correct today; display-only, bounded
`snprintf`. Sibling `selector_u32_from_be` correctly uses `(uint32_t)`. **Fix:** use `uint32_t`.
**Confidence: high.** Trivial; index as INFO type-hygiene or drop.

---

## Folds & rejects (reasoning)

- **F-K2-2 → AHW-029 (+ AHW-019).** Short-circuit limb predicates are the operand-dependent portable-C
  residual AHW-029 owns (PLATFORM-deferred); the `add_affine` flags are cmov-masked (`point.c:213-215`)
  so the selection doesn't branch; codex did not prove an asm-level leak (defers to an -Oz audit). The
  "constant-time fr_is_zero" comment overstating it is AHW-019's comment-truth concern. No NEW concrete
  OURS leak. **This was the single biggest inflation in the cluster (HIGH→fold).**
- **F-E-2 → AHW-021 (enrichment).** Verified `dispatcher.c:183-186`: the spike case dispatches the
  handler with no `l4_session_reset()`, and `cxmath_spike.c` caps only `iters==0` (≤65535 field-mul
  busy-loop). NOTE codex's "unlike every other INS" is imprecise — the 6 L4 INSes
  (BEGIN/APPEND/FINALIZE/ABORT/deploy×2) also don't reset (they ARE the L4 session); only the 6 L2
  INSes reset. The spike is L2-style and arguably should reset like its peers. Dead in the shipped
  build (B3 empty-diff gate). Both sub-points (missing reset on the spike + uncapped loop) are net-new
  to AHW-021's text but belong to the same dead-spike finding → enrich AHW-021. **Severity LOW.**
- **F-F-6 → AHW-093.** AHW-093 is the missing runtime ASSERT (`kind==='deploy'` ⇔ `ledgerDeployContext`);
  F-F-6 is the missing TEST that `wrapExecutionPayload`'s branch SELECTION is correct. Same seam, test
  vs code — fold the test ask into AHW-093 (or index as the test-companion). LOW.
- **F-F-2's 0x6F06 half → AHW-025.** The glitch-sim for the dup-sig fault arm is exactly AHW-025's
  scope; the low-S half (V3-10) is what's novel.
- **F-K8-3 REJECT-SCOPE.** `OnboardPanel.tsx` is frontend (`apps/*`), explicitly out of the C2 scope;
  behavior also ≈AHW-082. Not indexed.

---

## Confirmed-clean (auditor-facing negatives — NOT findings)

Capture in the index's Confirmed-clean section:

- **[NEG-V3-a] Firmware in scope is MEMORY-SAFE (Agent E).** No OOB/off-by-one/integer-overflow/
  stale-buffer/VLA/recursion across `dispatcher.c`, `app_main.c`, the 5 parse fns, `cxmath_spike.c`,
  `format.c`. Verified invariants: every host count capped at a compile-time constant BEFORE indexing
  (`begin_authwit.c:103` `call_count>L4_MAX_CALLS`→reject; `append_call.c:85`
  `calls_received>=call_count`→reject before `calls[..]`; `args_count` re-checked in `args_hash.c:11`);
  every BIP-32 read doubly bounded (handler `path_len>MAX` reject + SDK `bip32_path_read`); every parser
  rejects trailing bytes (`size!=offset`) and `buffer_read_*` gate on remaining length; `cs_format_amount`
  bounds-safe (`need_room` checked before any `out[pos++]`, `decimals>30` reject); NBGL `g_pairs[32]`
  worst case 30; no VLA/alloca/recursion; `G_context`/L4 session zeroed on every exit. Spot-verified the
  `begin_authwit`/`append_call` count guards directly — sound. (Owner: OURS; the one platform reliance
  is V3-07/F-E-1.)
- **[NEG-V3-b] Crypto-correctness clean (Agent K4).** No signer-vs-canonical-hash divergence,
  collision, or second-preimage in scope. `poseidon2`/`args_hash`/`outer_hash`/padding match the Aztec
  refs; re-ran `poseidon2_cli` (binary present, verified) over separator smoke + canonical-padding
  args_hash + all 4 `l4_outer_hashes.json` scenarios — matched; `fr`/`fr_canonical` fail-closed
  (accept 0 & p-1, reject p & unreduced); `blake2s` matches Node at 9 lengths; grumpkin/pedersen/Schnorr
  match parity suites + CLI edge checks ([0]G,[n]G=∞,[n+1]G=G,∞+Q,P+(-P)=∞,zero/noncanonical reject);
  `deploy_outer_hash` matches the sponsored-deploy authwit shape. Pedersen unreduced-buffer "divergence"
  correctly rejected as a false positive (canonical WASM API rejects ≥p, matching the device).
- **[NEG-V3-c] Dual-scheme (K1 vs Schnorr) confusion clean (Agent K5).** No net-new beyond AHW-018/092.
  Authwit BEGIN+FINALIZE validate `curve_id`/canonical-path/allowlisted `(curve,profile)` + re-derive the
  bound account before AND just before signing; the "Scheme" review line is 1:1 with the signer
  (K1↔profile 0, GRUMPKIN↔1, `wire.h:38`); Schnorr nonce bound to `curve_id+pubkey+priv+msg`
  (`aztec_secret.c:109`); deploy BEGIN validates `curve_id` vs the profile `arg_schema`; deploy FINALIZE
  re-derives everything from device state, signs only the local recompute. Negative tests cover the
  fail-closed cases (curve/profile mismatch, K1+Schnorr-profile, wrong salt → 0x6F12).

---

## Cross-cluster flags (for the orchestrator)

1. **SYSTEMIC "untested security boundary" theme:** V3-09 (allowlist arms), V3-10 (device low-S +
   0x6F06), and the existing AHW-024/025/091 all point at the same root — **the on-device fail-closed
   reject arms + anti-malleability are asserted by the membership-only fuzzer or a code read, not by
   input→SW / output-magnitude tests.** Worth one consolidated test-coverage work-item in the deep-plan,
   not five scattered ones.
2. **SYSTEMIC "duplicated C security primitive" theme:** V3-12 (`ct_memcmp32`×5, low-S×3) + AHW-070
   (canonical-path inline copies) + AHW-008 (canonical-hash TS) — extract-to-shared-module is the same
   fix shape across all three. V3-03 (non-CT dup-sig memcmp) is downstream of V3-12 (a shared
   `ct_memcmp32` would have prevented it).
3. **Side-channel posture is coherent and should NOT be re-opened as HIGH.** AHW-029 (PLATFORM,
   value-dependent residual) + AHW-068 (cmov barrier) + AHW-019 (comment-truth) + the new V3-01/V3-03
   (control-flow on the PUBLIC `s`) form a complete, honestly-scoped picture. The K2 agent's three HIGHs
   were source-overreads (one factually wrong on the `s_is_high` predicate). The deep-plan should fold
   low-S into one branchless shared helper (closes V3-01 + V3-03 + V3-12's low-S half together) and gate
   the Grumpkin-predicate rewrite on the same dudect/-Oz evidence AHW-019/029 already wait on.
4. **F-K8-2 / F-K8-3 touch `apps/demo-browser`** — flagged for whoever owns the (separate) frontend
   audit; the in-scope half of F-K8-2 (`session-embedded-wallet.ts` store) is indexed here.
