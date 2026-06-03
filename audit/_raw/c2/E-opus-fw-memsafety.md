# Wave 2 — Agent E (opus): FW memory-safety + APDU/I-O lifecycle + adversarial input handling

Read-only red-team. Scope: `apdu/dispatcher.c`, `app_main.c`, the five parse functions
(`begin_authwit.c`, `append_call.c`, `begin_deploy_account.c`, `finalize_and_sign.c`,
`finalize_deploy_and_sign.c`), `handler/cxmath_spike.c`, `clear_signing_v0/format.c`, plus the
RAM-rendering and path-bearing collaborators they call into (`verified_calls_ui.c`,
`get_aztec_master_secret.c`, `get_public_key.c`, `get_schnorr_pubkey.c`, `sign_outer_hash.c`,
`args_hash.c`, `account_binding.c`, the two NBGL review UIs). Every line cited was read in the
current tree. Dedup is against AHW-001..094.

**BOTTOM LINE — the strong negative is the result.** The C in scope is memory-safe under arbitrary
host input. I attacked it specifically for OOB read/write, off-by-one on length/offset/count math,
integer overflow/truncation on `uint8_t`/`size_t` mixes, host-length-driven `memcpy`/indexing,
VLAs/`alloca`/recursion, stale-buffer reuse across APDUs, and parsers advancing past `recv_len`.
**I found zero memory-corruption bugs.** Every count is capped at a compile-time constant *before*
it indexes any array; every parser is bounded by the SDK `buffer_t` (`size`/`offset`) and rejects
trailing bytes; every fixed buffer write has a guard or a provably-sufficient size. The handful of
NEW items below are I/O-contract / integer-handling / dead-code observations, all LOW/INFO, none a
corruption primitive. See "## Confirmed clean" for the invariants I verified.

The one finding worth a sentence: the entire app's protection against a header-claimed `lc` that
exceeds the bytes actually received is delegated WHOLESALE to the BOLOS `apdu_parser` (a
LEDGER-PLATFORM function not vendored in-repo) — our `make_buf` trusts `cmd->lc` as the buffer size
with no independent reconcile against `input_len`. Correct per the SDK contract, but it is an
un-asserted single point that no in-repo test pins (F-E-1).

---

### F-E-1: `make_buf` trusts `cmd->lc` as the buffer size with no in-app reconcile against the received `input_len`
- Severity: LOW — correct under the documented BOLOS contract; the risk is an un-asserted platform dependency with no in-repo guard/test, not a present over-read.
- Owned: MIXED — the `lc`-vs-`input_len` validation lives in the BOLOS SDK `apdu_parser` (LEDGER-PLATFORM, `lib_standard_app`, not vendored here); the *unconditional trust* + absence of a defensive assert is OURS.
- Category: FW-STATEMACHINE
- Location: `ledger-app/src/apdu/dispatcher.c:44-50` (`make_buf`: `buf.size = cmd->lc`); `ledger-app/src/app_main.c:40-50` (the only call to `apdu_parser(&cmd, G_io_apdu_buffer, input_len)`; `input_len` is consumed ONLY by the parser, never re-checked against `cmd.lc` afterward).
- What: Every L4/L2 handler reads its body through `buffer_t{ ptr=cmd->data, size=cmd->lc, offset=0 }`. The body buffer's *size* is the header-claimed `lc`, never the transport's `input_len`. If `apdu_parser` ever returned `true` while leaving `cmd.lc > (input_len - 5)` and `cmd.data` pointing into `G_io_apdu_buffer`, every `buffer_read_bytes`/`buffer_read_bip32_path` would over-read the 260-byte `G_io_apdu_buffer` tail (stale prior-APDU bytes, then OOB). Our code has no `cmd.lc <= input_len - OFFSET_CDATA` assert; it relies entirely on the SDK enforcing it.
- Attack/impact: NOT exploitable against the stock SDK — `apdu_parser` rejects `lc` mismatches (that is exactly the `BAD LENGTH` path at `app_main.c:41`). The exposure is a defense-in-depth / supply-chain one: an SDK regression or an `apdu_parser` build variant that loosened the check would silently turn every parser into an over-read, and nothing in *our* tree would catch it. The host `wire_host` shim's `buffer_t` is hand-built in tests, so the differential/fuzz oracle never exercises the real `lc`↔`input_len` coupling either.
- Evidence: `make_buf` sets `buf.size = cmd->lc` (dispatcher.c:47) with no clamp; `app_main.c` passes `input_len` only into `apdu_parser` and then discards it (the `cmd` struct carries `lc` forward). The `command_t`/`apdu_parser` definitions are not in `src/` or `tests/` (grep: only reference is the call site) → platform.
- Fix sketch: add a cheap belt-and-suspenders assert after a successful parse — `LEDGER_ASSERT(cmd.lc + OFFSET_CDATA <= (uint16_t)input_len, ...)` (or reconcile in `make_buf`); and/or a host-shim test that builds an APDU whose declared `lc` exceeds the payload and asserts a clean reject. Documents the platform reliance and fails loud on an SDK drift.
- Confidence: high (the trust relationship is unambiguous; the mitigation is purely platform-side).
- Dedup-check: AHW-017/059 cover the malformed-APDU *session reset*; AHW-024 asks for a malformed-frame-mid-stream *test*. Neither addresses the `lc`-vs-`input_len` buffer-sizing trust or a missing in-app reconcile/assert on the body length. Novel.

### F-E-2: `cxmath_spike` (flag-gated) advances past the canonical Aztec defenses — unbounded `iters` loop + no path/session discipline — and the Makefile has no guard preventing a release build from enabling it
- Severity: LOW — dead in the shipped build; becomes a real attacker-reachable, unreviewed field-arith INS the moment `CX_MATH_SPIKE` is defined, with a 65 535-iteration host-controlled busy-loop.
- Owned: OURS (the handler + the `DEFINES += $(EXTRA_DEFINES)` passthrough).
- Category: BUILD
- Location: `ledger-app/src/handler/cxmath_spike.c:99-131` (handler); `ledger-app/src/apdu/dispatcher.c:180-187` (the `#ifdef CX_MATH_SPIKE` case); `ledger-app/src/types.h:42-46` (INS 0x70); `ledger-app/Makefile:40-42` (`DEFINES += $(EXTRA_DEFINES)` — passes `CX_MATH_SPIKE` straight through, no `#error`/`_Static_assert` gate vs a release/`DEBUG`-off build).
- What: This is NOT a memory bug — the handler's buffers (`a[32]`,`b[32]`,`out[32]`) are all fixed and every read is a bounded `buffer_read_*`. Two NEW-vs-AHW-021 observations: (1) the dispatcher case (unlike every other INS) does **not** call `l4_session_reset()` and is **not** treated as an L4 boundary — an in-flight verified-calls session survives a spike INS (state-machine hygiene hole, distinct from the build-flag concern AHW-021 logged); (2) `iters = (iters_hi<<8)|iters_lo` (line 110) yields up to 65 535, and `native_fr_mul_loop`/`cxbn_mul_loop` run that many field multiplies with **no upper sanity cap** beyond the wire ceiling — a trivial host-driven compute-DoS / watchdog-trip primitive on any build that ships the flag.
- Attack/impact: only on a mis-built binary (`make … EXTRA_DEFINES=CX_MATH_SPIKE`). Then: a raw `E0 70 …` APDU runs arbitrary-operand field arithmetic, can be wedged into a multi-second loop, and silently leaves any open L4 session live across it. The shipped `app.elf` is unaffected (B3 empty-diff gate holds).
- Evidence: dispatcher.c:183-186 — the `INS_CXMATH_SPIKE` case has no `l4_session_reset()` and no `reject_dispatch` wrapper, unlike INS 0x01–0x13; cxmath_spike.c:110-111 caps only `iters==0`, not a max; Makefile:42 is an unconditional passthrough.
- Fix sketch: delete the spike before external-audit submission (it has served its purpose per the file header); until then, add the `_Static_assert(!defined(CX_MATH_SPIKE) || defined(DEBUG))`-style guard AHW-021 already recommends AND, if kept, route the case through `reject_dispatch`/`l4_session_reset` like the other L2 INSes and clamp `iters` to a small constant.
- Confidence: high (control-flow + Makefile read directly).
- Dedup-check: AHW-021 flags the *presence* + recommends a release-build `#error` guard. NEW here: the missing `l4_session_reset` on the spike case (a state-machine boundary gap the other 13 INSes all honor) and the uncapped `iters` busy-loop. Folds into AHW-021 if the orchestrator prefers, but both sub-points are net-new to that finding's text.

### F-E-3: `fr_as_u32_or_hex` builds a u32 with `unsigned`-typed shifts — relies on `unsigned == 32-bit` to avoid a wrong (not unsafe) value
- Severity: INFO — portability nit, no memory impact, no security impact on the ARM target (`unsigned` is 32-bit there).
- Owned: OURS.
- Category: FW-UI
- Location: `ledger-app/src/ui/verified_calls_ui.c:131-133` (`unsigned v = ((unsigned)bytes[28] << 24) | …`).
- What: The chain/version "small-Fr" pretty-printer casts to `unsigned` (not `uint32_t`) before the `<<24`. On any platform where `unsigned` were 16-bit the top byte would be lost; the value would render wrong (never OOB — the output goes through a bounded `snprintf(out, out_len, …)`). The sibling helpers `selector_u32_from_be` (append_call.c:57, verified_calls_ui.c:206) correctly use `(uint32_t)`. Cosmetic inconsistency; the BOLOS target is 32-bit so it is correct today.
- Attack/impact: none (display-only, bounded write, correct on-target). Pure type-hygiene.
- Evidence: read verified_calls_ui.c:125-137; contrast with the `(uint32_t)`-cast cousins.
- Fix sketch: use `uint32_t` for `v` for consistency with the rest of the file.
- Confidence: high.
- Dedup-check: not in any AHW finding (the existing integer-handling notes are about `bytesEqual as number` on the HOST, AHW-010, and `cs_format_amount` fuzz coverage, AHW-027 — neither is this). Novel, trivial.

---

## Confirmed clean (memory-safety invariants I verified hold)

Each was checked by reading the exact arithmetic/buffer, not assumed:

- **Every host-controlled count is capped at a compile-time constant BEFORE it indexes an array.**
  `call_count > L4_MAX_CALLS(5)` → reject at `begin_authwit.c:103`; `calls_received >= call_count`
  → reject at `append_call.c:85`, so `&G_l4_session.calls[calls_received]` (`:89`) is always within
  `calls[5]`. `args_count > L4_MAX_ARGS(4)` → reject at `append_call.c:114` and re-checked in
  `args_hash.c:11`, so `slot->args[i]` (`:118`) and `payload + offset` (`args_hash.c:36`) stay in
  bounds. `args` is `memset` to 0 first (`append_call.c:116`), so even a verb that reads `args[0]`
  with `args_count==0` (none do — DRIP/transfer carry ≥2/4 args, verified in `selectors.gen.c`)
  would read zeroed RAM, not OOB.

- **Every BIP-32 path read is doubly bounded.** All path-bearing handlers
  (`begin_authwit`, `begin_deploy_account`, `get_public_key`, `get_schnorr_pubkey`,
  `get_aztec_master_secret`, `sign_outer_hash`) reject `path_len > MAX_BIP32_PATH_LEN(10)` BEFORE
  calling `buffer_read_bip32_path(…, path_len)`, and the SDK/`bip32_path_read` itself caps at
  `MAX_BIP32_PATH` AND checks `offset+4 <= in_len` per element (verified via the in-repo host shim
  `tests/wire_host/hostshim/bip32.c:26-47`). The session arrays are `uint32_t bip32_path[10]`. No
  overflow possible. The deploy path's post-read `[0..4]` accesses (`begin_deploy_account.c:104-119`)
  are guarded by the earlier `path_len < L4_MIN_BIP32_PATH(5)` reject (`:97`).

- **Every parser rejects trailing bytes** via `cdata->size != cdata->offset` after the last field
  (`begin_authwit.c:106`, `append_call.c:124`, `begin_deploy_account.c:156`,
  `finalize_and_sign.c:158`, `finalize_deploy_and_sign.c:97`, `sign_outer_hash.c:101`,
  `get_aztec_master_secret.c:118`, `get_public_key.c:42`, `get_schnorr_pubkey.c:39`,
  `abort_authwit.c:11`). No parser can advance past `recv_len`: the BOLOS `buffer_read_*`
  primitives all gate on `buffer->size - buffer->offset >= n` (verified, host shim `buffer.c`),
  returning `false` (→ `SWO_WRONG_DATA_LENGTH`) rather than over-reading.

- **`cs_format_amount` is bounds-safe under adversarial decimals/value** (the AHW-027 routine).
  `digits[40]` holds at most 39 u128 digits (`digit_count++` capped by the divmod loop).
  `decimals > 30` → reject (`format.c:34`). `need_room` (`:62-66`) is computed and `out_len <
  need_room` → reject (`:67`) BEFORE any `out[pos++]`. I traced all three branches (decimals==0;
  decimals>0 & digit_count>decimals; decimals>0 & digit_count<=decimals): bytes written incl. NUL
  = `digit_count+2`, `digit_count+2`, and `decimals+3` respectively, each `<= need_room`. Callers
  pass `out_len = CS_FORMAT_MAX_LEN(48)` (`verified_calls_ui.c:219-224`), comfortably above the
  42-byte worst case. The high-16-bytes-zero check (`:31`) enforces the u128 domain; the divmod10
  uses a `uint32_t` accumulator (`(rem<<8)|byte`, max 0xFFF) — no overflow.

- **The NBGL pair pool cannot overflow.** `verified_calls_ui.c` writes into `g_pairs[32]`
  (`VC_PAIR_CAPACITY`). 4 fixed header pairs; the per-call loop guard `n_pairs + 5 <=
  VC_PAIR_CAPACITY` (`:363`) reserves exactly the 5-pair worst case (TRANSFER w/ Flags); MINT(4),
  DRIP(3), SPONSOR(2) write fewer; +1 outer_hash at the tail. Worst case (5 transfers) = 30 ≤ 32.
  Each per-call string buffer (`g_call_*[L4_MAX_CALLS][N]`) is written only via bounded `snprintf`
  / guarded `short_hex_field`/`full_hex_field` (`:92`,`:115` length guards) / `cs_format_amount`.

- **Fixed-size response/UI string writes are all sufficient.** `raw_public_key[65]` →
  `memcpy(response, &raw[1], 64)` reads `[1..64]` (`get_public_key.c:71`, `account_binding.c:29-30`
  with the `raw[0]==0x04` precondition). `g_account_str[16]` ⊃ `"#%u"` (max 12B),
  `g_confirm_str[8]` ⊃ 5B checksum, `g_addr_str[40]` ⊃ 34B `address_8_6` (guarded `< 34`),
  `cinput[19+32]` exact for the checksum preimage (`get_aztec_master_secret.c:157-159`).

- **No VLAs, no `alloca`, no recursion** anywhere in `src/` (grep + manual read). `args_hash.c:23`
  `payload[(1u + L4_MAX_ARGS) * L4_FR_BYTES]` is a constant-expression size (160), NOT a VLA.

- **No stale-buffer reuse across APDUs.** `G_context` is `explicit_bzero`'d at the top of every L2
  handler and on every non-success/parse-fail path (`app_main.c:47/58`,
  `sign_outer_hash.c:74/112/132/…`, `get_public_key.c:26`, `get_schnorr_pubkey.c:24`,
  `get_aztec_master_secret.c:101`). The L4 session is zeroed by `l4_session_reset()` on BEGIN and on
  every reject (the `reject()` helpers) and on the L2-INS boundary (`dispatcher.c`). APPEND_CALL
  overwrites `slot->args_hash` with the device-recomputed value before finalize reads it
  (`append_call.c:181`), so no host-claimed bytes survive into signing.

- **No integer overflow in the count/offset math.** All counts are `uint8_t` compared against
  `<= K` constants; `offset` accumulation in `args_hash.c` (`offset += 32`, max 160) and `format.c`
  (`pos`, `need_room` as `size_t`) cannot wrap. The `iters_hi<<8` in the dead spike promotes to
  `int` (no overflow). No `uint8_t`/`size_t` mix produces a truncation that bypasses a bound.
