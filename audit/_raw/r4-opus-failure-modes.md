# Round 4 (DEPTH) — Exhaustive failure-mode + error-handling review (opus)

Angle: every error branch / "only-fires-when-something-goes-wrong" path, host AND device.
Method: walked every SW return in `handler/*.c` + `dispatcher.c`; traced the deferred-UI
approval callbacks; walked the host session/provider/entrypoint/transport error paths.

Verdict up front: **the device signing core is fail-CLOSED everywhere I could reach.** No branch
signs/continues on an error or unexpected state. The net-new findings are (a) two
stale-state-lifetime gaps that are siblings of AHW-017 (not independently exploitable, same
"violates the stated invariant" class), (b) host-side error-handling gaps where a security-relevant
failure leaks state or wedges the wallet, and (c) consistency/dead-SW nits. Several promising leads
were chased and **refuted** — recorded as negative results so the validator and external auditor
don't re-chase them.

---

## NET-NEW FINDINGS

### R4-01 · LOW · APP · OURS — `io_send_sw` transport-failure path zeroes `G_context` but NOT the L4 session
**file:** `ledger-app/src/app_main.c:50-55`
**Scenario:** `apdu_dispatcher()` returns the value of `io_send_sw`/`io_send_response_pointer`, which
is **negative on a transport-layer send failure**. On that path app_main does
`explicit_bzero(&G_context, …)` then `return;` (exits the loop → app re-inits). `G_l4_session` /
`G_l4_deploy_session` are NOT zeroed before the exit. This is the *same invariant break* as AHW-017
("any non-0x9000 path zeroes the L4 session") but on the IO-error path rather than the parse-error
path. Consequence is even more benign than AHW-017 (the loop exits and the app restarts, which on
BOLOS re-runs `app_main` and its `explicit_bzero(&G_context)` — but the L4 globals are `.bss` that
*do* survive a soft `app_main` re-entry without an `l4_session_reset`). A subsequent session would
still be re-gated by BEGIN's `l4_session_reset()`, so not exploitable — pure lifetime hygiene.
**Fix:** call `l4_session_reset()` alongside the two `explicit_bzero(&G_context,…)` in app_main
(lines 43 and 53), or better, centralize "wipe ALL signing state" in one helper used by both the
parse-fail (AHW-017) and dispatch-fail paths.
**Overlap flag:** SIBLING of AHW-017 (same invariant, different trigger). Validator: fold into
AHW-017 as "the fix must cover BOTH app_main bail-outs (parse-fail line 43 AND dispatch-fail line
53), not just the parse-fail one the AHW-017 text calls out." If you keep it separate, it's its own
LOW.

### R4-02 · MED · HOST · OURS — Device-reject / transport-throw in the deploy clear-sign path leaves the device session parked (no host-side ABORT on the error path)
**file:** `packages/adapter-ledger/src/clear-signing-entrypoint.ts:232-241` (`#deploySignOnDevice`);
contrast `#clearSignOnDevice:178` which DOES `abortAuthwit()` first.
**Scenario:** `#clearSignOnDevice` defensively calls `await this.device.abortAuthwit()` *before*
`beginAuthwit` (line 178), so a leftover device session from a prior aborted attempt is cleared.
`#deploySignOnDevice` has **no such pre-abort** and **no `try/finally` that aborts on throw**: it
does `beginDeployAccount(ctx)` then `finalizeDeployAndSign(...)`. If `finalizeDeployAndSign` throws
(user rejects → SW 0x6985, transport disconnect, timeout), the JS promise rejects and the function
returns — but the **device-side** deploy session is only reset if the device's own
`finalize_deploy_rejected`/`reject()` fired. On a USER reject the device DOES reset (good). But on a
**transport disconnect / host timeout mid-FINALIZE**, the device may be left in `L4_DEPLOY_CONTEXT`
with a populated `G_l4_deploy_session` (the response/reset never completed), and the host never sends
`abortAuthwit`. The next `deployAccountViaEntrypoint` will hit `begin_deploy_account`'s
`state != L4_IDLE` guard and fail with `SW_DEPLOY_CONTEXT_WRONG_STATE` (0x6F11) until something
resets it — a self-inflicted wedge that an opaque 0x6F11 won't explain to the user.
**Consequence:** wallet wedges on the deploy verb after a flaky-transport FINALIZE; recoverable only
by an L2 INS (which the dispatcher uses to reset) or reconnect, but the UX gives no hint. Not a
signing-integrity break (device still fail-closed), a robustness/availability defect.
**Fix:** mirror `#clearSignOnDevice` — `await this.device.abortAuthwit()` at the top of
`#deploySignOnDevice`, AND wrap begin+finalize in `try { … } catch (e) { await
this.device.abortAuthwit().catch(()=>{}); throw e; }` so a thrown finalize always clears the device.
Apply the same `try/finally`-abort to `#clearSignOnDevice` (today it pre-aborts but does NOT
post-abort on a finalize throw, so a tx-path FINALIZE that throws leaves the authwit session parked
until the *next* call's pre-abort — works by luck, not design).
**Overlap flag:** NET-NEW. Adjacent to AHW-009 (mutex) but distinct — this is device-session cleanup
on the error path, not host concurrency.

### R4-03 · MED · HOST · OURS — In-flight mutex is NOT released if the synchronous prologue throws before `this.inflight = work` is assigned
**file:** `packages/adapter-ledger/src/aztec-ledger-session.ts:334-427` (`deployAccountViaEntrypoint`)
and `:602-631` (`transferViaRealSendTx`).
**Scenario:** Both methods do `const work = (async () => { … })();` then later `this.inflight = work;
try { return await work; } finally { this.inflight = null; }`. The IIFE begins executing
**synchronously** up to its first `await`. If anything in that synchronous prologue throws **before
the first await** — e.g. `csDeployProfileLookup` returns undefined → `throw` (line 342-344), or
`projectExecutionPayloadIntoCallIntent`/`preflightIntent` throws synchronously inside
`#clearSignOnDevice` before its first `await` — then `work` is a rejected promise, control returns to
the caller, `this.inflight = work` is assigned, `await work` rethrows, and `finally` sets
`this.inflight = null`. *That* case self-heals. **But** the dangerous case: the throw happens and the
caller's `try` has already passed the assignment — fine. The real hole is the TOCTOU already logged
as AHW-009 (two synchronous entries both see `inflight===null`). What is NET-NEW here: an
**unhandled promise rejection**. Because `work` is created and starts running *before* it is
`await`ed, if the prologue rejects synchronously, for one microtask tick `work` is a floating
rejected promise with no attached handler. In a browser that surfaces as an `unhandledrejection`
event (noise; some apps treat it as fatal). More importantly, if a caller ever calls these in a
fire-and-forget manner (no `await`), the `finally` still runs but the rejection is unobserved.
**Consequence:** primarily an unhandled-rejection/observability defect; combined with AHW-009 the
mutex can be left stuck (`inflight` pointing at a settled promise) if the assignment races.
**Fix:** assign `this.inflight` to the promise *before* the IIFE can reject — i.e. build the work
function but gate the mutex with `this.inflight = (async () => {…})().finally(() => { this.inflight =
null; })` in one statement, and check+set the guard synchronously at the very top (closes AHW-009
too). Don't start the async work before the guard is set.
**Overlap flag:** TIGHTLY adjacent to AHW-009 (dup mutex guard). Validator: likely fold the *fix*
into AHW-009 (same refactor closes both the dup AND this rejection/ordering issue), but the
**failure mode** (unhandled rejection on synchronous-prologue throw) is net-new and not described in
AHW-009.

### R4-04 · LOW · APP · OURS — `SW_DEPLOY_CONTEXT_TWICE` (0x6F10) and `SW_NOT_IMPLEMENTED` (0x6F07) are defined + mirrored host-side but NEVER returned by the device
**file:** `ledger-app/src/sw.h:17,28`; `packages/adapter-ledger/src/apdu.ts:216,226`;
`begin_deploy_account.c:173-174` returns `SW_DEPLOY_CONTEXT_WRONG_STATE` (0x6F11) — NOT `_TWICE` —
for a second BEGIN_DEPLOY.
**Scenario:** A second `BEGIN_DEPLOY_ACCOUNT` mid-session (the literal "context twice" case the
0x6F10 comment describes) returns **0x6F11 (WRONG_STATE)**, the same code as "BEGIN_DEPLOY before
GET_VERSION or after auth." So two semantically-distinct conditions collapse to one SW, and the
purpose-built 0x6F10 is dead. `SW_NOT_IMPLEMENTED` (0x6F07) is also never emitted (only referenced in
a poseidon2 README). Not a security hole — but it's an item 5 (consistency) issue: a host/auditor
reading the SW table will believe a second-BEGIN is distinguishable when it isn't, and dead SWs rot.
**Fix:** either return `SW_DEPLOY_CONTEXT_TWICE` from the `state == L4_DEPLOY_CONTEXT` sub-case in
`begin_deploy_account` (distinguish "already in a deploy ctx" from "in an authwit/other state"), or
delete 0x6F10 and 0x6F07 from both `sw.h` and `apdu.ts`.
**Overlap flag:** NET-NEW (consistency/dead-code). Cousin of AHW-006 (stale SW comments) but a
different defect class (unreachable code, not a misleading comment).

### R4-05 · LOW · APP · OURS — `s_armed`/`s_secret` reveal arming is invisible to `l4_session_reset()`; correctness rests entirely on the blocking-IO model (undocumented coupling)
**file:** `ledger-app/src/handler/get_aztec_master_secret.c:52-54` (module-static `s_secret[32]`,
`s_armed`), `:65-73` (`disarm`), `:83` (disarm on entry), `:159-161` (arm), `:166-183` (approve).
**Scenario:** Between `ui_display_master_secret_reveal()` (arms `s_secret`, returns 0/deferred) and
the NBGL confirm callback, the secret sits in a module-static buffer. `l4_session_reset()` (called by
the dispatcher on *every* L2 INS and every reject) does **NOT** clear `s_secret`/`s_armed` — they're
not part of `G_l4_session`. The reveal is fail-closed in the normal flow ONLY because BOLOS IO is
single-threaded + blocking: while the review is up, `io_recv_command()` does not return another APDU,
so no second INS can interleave and observe/abuse the armed secret, and `disarm()` at handler-entry
(line 83) re-zeroes on every fresh reveal so nothing accumulates. I could NOT find an interleaving
path → **not currently exploitable**. The risk is latent: the safety is an *implicit* property of the
io loop, not an enforced invariant. If a future refactor (e.g. an async UX, a background APDU, or a
"cancel reveal" INS) ever lets another handler run while armed, the secret is exposed with no reset
hook. Also: a `disarm()` is correctly present, but it is the *only* thing standing between the armed
secret and a `l4_session_reset`-style global wipe — the two state machines are not unified.
**Fix:** (a) document at the `s_secret` declaration that its safety depends on the blocking-IO
single-in-flight model; (b) call `disarm()` from `l4_session_reset()` (cheap, makes the wipe total
and removes the coupling), so any "reset everything" path also clears the reveal arm.
**Overlap flag:** NET-NEW. Related theme to AHW-038 (host forget doesn't zeroize) but this is the
DEVICE-side armed-secret lifetime, distinct surface.

### R4-06 · LOW · HOST · OURS — `decodeApdu`/`fromHex` (Speculos) silently coerce non-hex to bytes via `Number.parseInt` → a malformed Speculos response can pass length checks with garbage data
**file:** `packages/adapter-ledger/src/speculos-transport.ts:144-164`.
**Scenario:** `decodeApdu` guards `hex.length < 4` and odd length, but `fromHex` does
`Number.parseInt(hex.slice(2i,2i+2), 16)` with **no validation that the slice is actually hex**.
`Number.parseInt('zz', 16)` → `NaN` → `Uint8Array` coerces `NaN` to `0`. So a corrupt/garbage
Speculos `/apdu` response body (non-hex chars) is silently turned into zero-bytes of the right
*length*, then the downstream exact-length checks in `provider.ts` PASS, and the host proceeds with
fabricated all/partly-zero `data` + a fabricated `sw`. For SIGN/FINALIZE the SW would have to read
0x9000 and data be exactly 64B for this to matter, and a corrupt response is overwhelmingly more
likely to fail the length/SW gate — so this is **fail-closed in practice**, and Speculos is a trusted
local test transport (the WebHID prod path uses raw bytes, not hex, and is unaffected). But it's an
item-4 trust-boundary gap: the transport does not detect malformed wire and fail explicitly; it
launders garbage into structurally-valid zeros.
**Fix:** validate each 2-char slice with `/^[0-9a-fA-F]{2}$/` (or check `Number.isNaN`) in `fromHex`
and throw `Bad APDU hex`. 3 lines.
**Overlap flag:** PARTIAL overlap with AHW-011 (unvalidated Speculos JSON casts). AHW-011 is about
the *shape* cast of the JSON object; this is about the *content* of the hex string inside it →
distinct defect, same trust boundary. Validator: keep separate or fold as AHW-011's second bullet.

### R4-07 · LOW · HOST · OURS — `getCaps()` `>>> 0` is correct, but the result is never used to gate anything → a device that DROPS a capability (e.g. clears CAPS_GRUMPKIN) is not detected; the host signs blindly against assumed capabilities
**file:** `packages/adapter-ledger/src/provider.ts:51-61` (`getCaps`); the host never calls it on the
connect path (AHW-043 established `getCaps` is test-only).
**Scenario:** This is the *failure-mode* consequence of the already-logged AHW-043 (dead capability
negotiation). Because `getCaps` is never consulted before a Schnorr flow, if the connected device is
an older/different build that does NOT advertise `CAPS_GRUMPKIN`, the host still streams a
GRUMPKIN-curve BEGIN and only discovers the mismatch when the device rejects with
`SW_INVALID_CURVE_ID` (0x6F04) deep into the flow — after the user has been prompted. No graceful
"this device can't do Schnorr" message. Worse for forward-compat: a host built for caps it assumes
present will mis-drive a device that lacks them.
**Fix:** call `getVersion()` + `getCaps()` in `AztecLedgerSession.connect()` and assert the required
cap bit (K1 / GRUMPKIN per `scheme`) before building the account; fail fast with a legible message.
**Overlap flag:** OVERLAP with AHW-043 (dead `getCaps`). Validator: this is the failure-mode framing
of AHW-043 — likely fold in as "consequence: no graceful degrade, late opaque SW_INVALID_CURVE_ID."
Net-new angle = the late-rejection UX + forward-compat, not just "dead code."

---

## CONFIRMED FAIL-CLOSED (negative results — checked, robust; do NOT re-chase)

These are the paths an attacker WOULD target; I walked them and they hold. Recorded so the external
auditor sees the coverage and the validator doesn't burn cycles.

1. **Every device error branch is fail-CLOSED.** Walked all SW returns in
   `dispatcher.c` + all 12 handlers. Every error/rejection path routes through a local
   `reject(sw)` that calls `l4_session_reset()` first (append_call.c:42-45, begin_authwit.c:23-26,
   begin_deploy_account.c:45-48, finalize_and_sign.c:51-54, finalize_deploy_and_sign.c:48-51) OR is
   an L2 single-shot handler that `explicit_bzero(&G_context)` on every error exit. **No branch
   accepts, continues, or signs on an error or unexpected state.** The dispatcher's `reject_dispatch`
   (dispatcher.c:54-57) wraps EVERY non-9000 early return with `l4_session_reset()`.

2. **Partial-stream abuse is rejected, not signed.**
   - APPEND past `call_count`: `append_call.c:85-87` → `reject(SWO_INVALID_INS)` + session wipe.
   - APPEND in wrong state (no BEGIN): `append_call.c:84` `state != L4_HEADER_PARSED` → reject+wipe.
   - FINALIZE before all calls received: `finalize_and_sign.c:186` `state != L4_CALLS_COMPLETE` →
     reject+wipe. (`calls_received == call_count` is the only way to reach `L4_CALLS_COMPLETE`,
     append_call.c:174-176.)
   - FINALIZE after a rejected APPEND: the rejected APPEND already wiped the session → FINALIZE sees
     `L4_IDLE` → rejects. No "park then finalize."
   - BEGIN_DEPLOY over a live session: `begin_deploy_account.c:173` `state != L4_IDLE` → reject+wipe.
   - BEGIN_AUTHWIT over a live deploy ctx: `begin_authwit.c:29` unconditionally `l4_session_reset()`
     first, so it CANNOT inherit a deploy ctx — it always starts clean.
   - FINALIZE_DEPLOY without a prior FINALIZE claim: `finalize_deploy_after_approval` gates on the
     explicit `claimed_outer_hash_received` bool (NOT a zero-scan — correctly avoids the Fr(0)-is-valid
     trap), finalize_deploy_and_sign.c:119-121.

3. **`abort_authwit` is robustly idempotent and fail-closed.** `abort_authwit.c:10-17` resets the L4
   session on BOTH the trailing-byte-error path (line 12) and the success path (line 15). It never
   touches `G_context` — but it doesn't need to (L2 state is single-shot and re-zeroed by its own
   handlers). Returns 0x9000 from any state. No way to use ABORT to leave anything signable.

4. **The device NEVER signs the host-claimed hash.** Finalize signs the *locally recomputed*
   `recheck_outer` / `recomputed_outer` (finalize_and_sign.c:318 signs `recheck_outer`;
   finalize_deploy_and_sign.c:223 copies `recomputed_outer` into `outer_hash_local` and signs that),
   explicitly to defeat a TOCTOU glitch on the mutable session field. claimed_outer_hash is only ever
   a cross-check. Confirmed across all three signing handlers.

5. **No secret left un-wiped on any error path.** Every `derive`/`pubkey`/`sign` error branch
   `explicit_bzero`s its scalar/pubkey/sig buffers BEFORE returning (audited in
   finalize_and_sign.c:280-308, finalize_deploy_and_sign.c:236-269, begin_deploy_account.c:190-316,
   get_schnorr_pubkey.c:42-54, get_aztec_master_secret.c:120-164). The reveal `disarm()`
   (get_aztec_master_secret.c:65-73) wipes secret + checksum on entry, approve, and reject.

6. **Master-secret reveal cannot be observed by a concurrent INS** (see R4-05): single-threaded
   blocking IO means no second handler runs while armed; `disarm()` on handler-entry prevents
   accumulation. Fail-closed today (the R4-05 finding is about the *latent* coupling, not a live bug).

7. **Counter under/overflow:** `calls_received` is `uint8_t`, only ever `++` and only while
   `< call_count ≤ L4_MAX_CALLS (5)` (append_call.c:85,173). Cannot overflow or wrap. `call_count`
   bounded at BEGIN (begin_authwit.c:95). No unbounded counter anywhere in the stream bookkeeping.

8. **No buffer/DoS wedge from a hostile host:** `l4_compute_outer_hash` rejects `call_count >
   L4_MAX_CALLS` (parity.c:86), the payload buffer is fixed `31*32 = 992B` stack (parity.c:98), every
   APDU body length is exact-checked (`cdata->size != cdata->offset` rejects trailing bytes on EVERY
   handler). No VLA/alloca. The only "wedge" is the recoverable R4-02 deploy-state park.

9. **Host transport length handling is exact + fail-closed** on the prod path: `webhid-transport.ts`
   rejects `response.length < 2` (line 100); `provider.ts` checks EXACT data length on every response
   (`!== 64`, `!== 3`, `!== 4`, `!== FR_BYTES`) and `requireOk(sw)` throws on any non-0x9000. A
   "SW=success but data too short" response is caught by the explicit length check → throws, never
   proceeds. (Speculos `fromHex` content-laundering is the one soft spot — R4-06.)

10. **SW codes are used consistently on the signing-integrity surface:** internal-fault conditions
    (glitched recompute, dual-sign mismatch, dual-derive mismatch) all map to generic
    `SW_HASH_MISMATCH`/`SW_DUP_SIG_MISMATCH`, deliberately NOT to the host-disagreement codes
    (`SW_DEPLOY_*_MISMATCH`) — so a fault is not mistakable for a host error (begin_deploy_account.c
    comments at :287-294 are explicit about this trap). The two inconsistencies I found are dead SWs,
    not mis-mapped ones (R4-04).

---

## LEADS CHASED AND REFUTED (false-positive avoidance — for the validator)

- **Schnorr witness packed as ECDSA `r||s`?** `clear-signing-entrypoint.ts:185,239` call
  `packEcdsaSignature(sig.r, sig.s)` regardless of curveId. REFUTED as a bug: `packEcdsaSignature`
  (`packages/core/src/ecdsa.ts:52-63`) is a pure 32+32 concatenation with no ECDSA-specific
  transform, so for a GRUMPKIN account it correctly produces the 64-byte `s||e` Schnorr witness
  Aztec's SchnorrAccount expects. Only the *function name* lies — already covered by AHW-012. NOT
  net-new.
- **`curveId` defaults to SECP256K1 in `l4-manifest.ts:210` — could a Schnorr account sign as
  ECDSA?** REFUTED: `LedgerSchnorrAccountContract` constructs its provider with
  `curveId: CURVE_ID.GRUMPKIN` (schnorr-account-contract.ts:31), which propagates through
  `createClearSigningEntrypoint` → entrypoint options → `buildL4Manifest({curveId})`. The `??
  SECP256K1` default only fires when curveId is genuinely undefined (the ECDSA path), where it's
  correct. No mis-dispatch in the live flow.
- **Frontend catch swallows a device-reject and shows success?** REFUTED: TransferPanel.tsx:119-129,
  OnboardPanel.tsx:118-133, AccountPanel/ConnectPanel all route caught errors to a `kind:'error'`
  state and log to console.error. No failure-as-success.
- **`speculos-transport.ts:74` autoConfirm `.catch()` swallows a security error?** REFUTED (and it's
  already noted in code): the swallowed promise is the *button-driver* (test-only Speculos
  automation), explicitly fire-and-forget so it can't mask the real APDU response promise, which is
  returned independently (line 80). The APDU result + its SW are unaffected. Not the AHW-001-class
  swallow.
- **Zero-call authwit (`call_count==0` → `L4_CALLS_COMPLETE` immediately, begin_authwit.c:106) is
  signable — bypass?** REFUTED: it produces the canonical all-padding outer_hash (parity.c handles
  count=0 by emitting 5 padding calls), the B3 consumer check still binds the signer path to
  `consumer`, and an empty authwit authorizes nothing. Intentional + tested
  (b3-consumer-binding.test.ts:72, l4_outer_hashes.json "zero-calls").
- **`s_is_high` boundary at exactly n/2?** REFUTED: `s == n/2` → `cmp==0` → not high → not normalized,
  which is correct (low-s admits s ≤ n/2). Clean across all three copies.
