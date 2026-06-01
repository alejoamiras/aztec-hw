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

## Remaining (this phase)
- **P2b `begin_deploy` parse-only (Option X, owner-approved)** — extract `deploy_parse_and_validate()` (seam ends *before* `deploy_derive_pubkey_xy`; binding tail byte-identical), fuzz the parse half, stub the crypto.
- **Seed corpus** (negatives from `wire-negative.test.ts` + ≥1 valid per target) + structure-aware targets (args_count over `L4_MAX_ARGS`, call_count boundary, trailing bytes, non-canonical Fr at each offset, selector high-bytes, 4-arg `from!=consumer`).
- **Bidirectional Speculos differential-replay** (accepted + near-boundary rejects → same SW class) — the anti-false-negative gate (codex final-review Major).
- Triage + FIX any crash **in the device handler, not the shim** → `safe-v17`.

(Committed UNSIGNED — the 1Password SSH agent is flaking this session, blocking commit-signing + push auth; backfill + push on recovery.)
