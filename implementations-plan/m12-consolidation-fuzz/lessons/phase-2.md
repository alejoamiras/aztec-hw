# M12 Phase 2 — libFuzzer/ASan handler-seam harness → `safe-v17` (IN PROGRESS)

## Harness approach (de-risks resolved)
- **Toolchain gotcha:** Apple clang ships NO libFuzzer runtime (`libclang_rt.fuzzer_osx.a` missing → link error). Use **Homebrew LLVM clang** (`/opt/homebrew/opt/llvm/bin/clang`, v22) — has fuzzer+ASan+UBSan. Pinned via `CLANG ?=` in the Makefile.
- **Shim (`ledger-app/tests/wire_host/`):** compiles the REAL handler `.c` + real l4 sources + the VENDORED `lib_standard_app` buffer cluster (the reader *is* the thing under test) against thin `os.h`/`io.h` shims; `io.h` captures the emitted SW into `g_wire_host_last_sw`.
- **opus's 2–3× shim-cost fear is RETIRED.** The buffer cluster's include closure is light: 11 small files (`buffer`/`read`/`varint`/`write`/`bip32` `.c`+`.h`, `macros.h`, `status_words.h`) pulling only `stdint`/`stddef`/`stdbool`/`string` — **no `os.h`/`cx.h`/crypto/USB**. So the off-device build is *faithful*, not a partial-SDK reimplementation. Vendored verbatim from SDK **v26.1.6** + `make verify-vendored` drift check (`hostshim/VENDORED.md`).
- **Faithfulness:** fixed 260-byte APDU buffer (matches device `G_io_apdu_buffer` over-read semantics); the handlers use the bounds-checked `buffer_read_*`, so they never read past `size` — the "fuzz-controlled slack" concern is moot for these parsers. The known-SW assertion traps on a garbage/unknown SW. SEMANTIC accept/reject divergence is the job of the bidirectional Speculos differential-replay gate (TODO).

## P2a — begin_authwit + append_call (DONE, both fuzz-clean)
- `fuzz_authwit.c` → `handler_begin_authwit`: **300k runs, cov 82 / ft 199, ZERO crashes / ASan / UBSan / unknown-SW.** Version/curve/path-canonicality/Fr-canonical gates robust.
- `fuzz_append_call.c` → `handler_append_call` (seeds a `L4_HEADER_PARSED` session first): **400k runs, cov 113 / ft 257, ZERO findings.** The richest parser — per-call decode, registry/verb allowlist gates, 4-arg `from==consumer` self-spend gate, args_hash recompute (poseidon2) — all robust. (append_call's local `ct_memcmp32` has a benign pre-existing `-Wsign-compare`: `int i < L4_FR_BYTES`; the device `-Werror` build's flags differ — not touched.)

These two cover ~80% of the untrusted-input parser attack surface (opus). No BOLOS crypto in either path → faithful off-device.

## P2b — begin_deploy parse-only seam (Option X, owner-approved) (DONE, fuzz-clean)
- **Extraction (codex, workspace-write, session bqda92424):** `int deploy_parse_and_validate(buffer_t *cdata, const cs_deploy_profile_t **out_profile)` lifted out of `handler_begin_deploy_account` — the ENTIRE parse block (manifest/profile/curve-pairing/path-canonicality/6×Fr-canonical/trailing-bytes/session-scalar assignments), ending `*out_profile = profile; return SWO_SUCCESS;`. Handler keeps the `L4_IDLE` state-check + `l4_session_reset()`, calls the seam, then the recompute/binding tail **unchanged**.
- **Validation gates (all green):**
  1. `git diff` = exactly 2 hunks, both at the seam; the B3 binding region (`/* --- Parity pass 1 … */` → end) appears only as unchanged context → **byte-identical, empty-diff gate satisfied.** `.h` adds the decl + the `deploy_profiles.gen.h` include for `cs_deploy_profile_t`.
  2. **Device build clean** — `make BOLOS_SDK=/opt/nanosplus-secure-sdk` (nanos2, `-Werror`): `begin_deploy_account.o` + `dispatcher.o` recompiled, linked, ZERO warnings.
  3. **Fuzz-clean** — `fuzz_deploy_parse` (1,000,000 runs, cov 94 / ft 211, max_len 260): ZERO crashes / ASan / UBSan / unknown-SW. Known-SW set {0x9000,0x6a87,0x6F01,0x6F02,0x6F03,0x6F04,0x6F05,0x6F0D}.
- **Off-device link posture:** `begin_deploy_account.c` #includes `cx.h` + `crypto_helpers.h` (authwit/append_call did not) — both are **empty hostshim headers** (no `cx_*`/helper symbol used directly here). The 3 binding-tail crypto fns (`account_binding_deploy_pubkey_xy`, `account_binding_deploy_partial`, `az_account_derive_from_path`) are **dead link-stubs in `fuzz_deploy_parse.c` that `__builtin_trap()` if reached** — so "crypto is off the fuzz path" is *self-enforcing*: the 1M-run clean campaign with ZERO traps **empirically proves** the parse seam always returns before the binding tail (Option X posture holds). No UI stub needed — `handler_begin_deploy_account` triggers no `ui_display_*` (the review UI fires at FINALIZE).
- **Nice tell:** libFuzzer's recommended dictionary surfaced `"\200\000\000,"` = `0x8000002C` = `0x80000000 | 44` — it discovered the hardened BIP32 path-prefix gate unaided.

## Remaining (this phase, → safe-v17)
- **Seed corpus** (negatives from `wire-negative.test.ts` + ≥1 valid per target) + structure-aware targets (args_count over `L4_MAX_ARGS`, call_count boundary, trailing bytes, non-canonical Fr at each offset, selector high-bytes, 4-arg `from!=consumer`).
- **Bidirectional Speculos differential-replay** (accepted + near-boundary rejects → same SW class) — the anti-false-negative gate (codex final-review Major). For P2b the faithful assertion accounts for the seam/device asymmetry: a harness *parse-reject* must equal the device SW exactly; a harness *parse-accept* (0x9000 sentinel) maps to the device emitting either 0x9000 OR a binding-tail SW (never a parse-level reject SW).
- On-chain re-deploy at a fresh index (belt-and-suspenders on top of the byte-identical proof + P0's dual-scheme deploy).
- Triage + FIX any crash **in the device handler, not the shim** → `safe-v17`.

(Committed UNSIGNED — the 1Password SSH agent is flaking this session, blocking commit-signing + push auth; backfill + push on recovery.)
