<!-- Harvested from codex session 019e89a3-6675-7621-8502-26867b79eb6c (read-only, xhigh). Scope: FW state-machine/APDU/authwit+deploy binding. -->

No new host-only signature-integrity or B3-binding bypass jumped out in the scoped firmware. The new yield is narrower: one real hardening regression against the stated recompute invariant, one fail-closed gap in the new shared binding helper, and one meaningful test blind spot around the remediated tail.

### F-A-1: Authwit FINALIZE no longer re-derives `args_hash` from stored raw args
- Severity: MED — this weakens the core “device recomputes from streamed calls” guarantee at sign time; exploitation needs session-state fault/corruption rather than a pure host, but this codebase explicitly claims fault-hardening here
- Owned: OURS — the gap is in our L4 recompute design, not BOLOS
- Category: DESIGN
- Location: `ledger-app/src/l4/session.h:40-46`, `ledger-app/src/handler/append_call.c:177-181`, `ledger-app/src/l4/parity.c:57-67,101-106`
- What: the session stores raw args specifically so FINALIZE can rebuild per-call hashes, but the actual FINALIZE path never uses them; it hashes the cached `call->args_hash` written at APPEND time
- Attack/impact: a fault/glitch or any latent corruption between `APPEND_CALL` and `FINALIZE_AND_SIGN` can tamper the cached per-call hash without being caught by the advertised “three-pass finalize re-derivation from stored raw args”; the later outer-hash passes are then only re-hashing cached session state
- Evidence: `session.h` says raw args are used by “`M5.2's three-pass finalize re-derivation from stored raw args`”; `append_call.c` then does `memcpy(slot->args_hash, device_args_hash_a, L4_FR_BYTES);`; but `parity.c` emits `memcpy(payload + (*offset) * L4_FR_BYTES, call->args_hash, L4_FR_BYTES);` and never recomputes from `call->args[]`
- Fix sketch: in `l4_compute_outer_hash`, recompute each call’s `args_hash` from `function_selector + args[] + public/private mode` on every pass and compare against the cached value before using it
- Confidence: high
- Dedup-check: nearest `AHW-025`, but distinct — `AHW-025` was “missing glitch-sim tests”; this is an implementation gap in the hardening itself

### F-A-2: Shared binding helper still defaults unknown constructor schemas to ECDSA
- Severity: LOW — not exploitable with today’s two shipped profiles, but it is a real fail-closed hole in the new shared security helper
- Owned: OURS
- Category: MODULARITY
- Location: `ledger-app/src/l4/account_binding.c:61-71`, `ledger-app/src/l4/wire.h:44-47`, `ledger-app/src/handler/finalize_and_sign.c:111-115`
- What: `account_binding_deploy_partial()` handles `SCHNORR` explicitly and sends every other schema down the ECDSA path; authwit FINALIZE only re-checks `(curve_id, profile_id)`, not the retrieved profile’s `arg_schema`
- Attack/impact: if manifest/codegen drift ever changes the schema behind an allowlisted authwit profile id, B3 can keep accepting that profile id and silently bind against the wrong constructor encoding instead of fail-closing
- Evidence: `account_binding.c` does `if (profile->arg_schema == CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY) { ... } return az_deploy_compute_partial_address(...);`; the authwit allowlist is only `K1 && profile 0` or `GRUMPKIN && profile 1`; FINALIZE then only does `const cs_deploy_profile_t *profile = cs_deploy_profile_lookup(...)`
- Fix sketch: make `account_binding_deploy_partial()` switch exhaustively on known schemas and `return -1` on default; also assert `profile->arg_schema` matches the expected curve in `b3_verify_consumer_is_this_account()`
- Confidence: high
- Dedup-check: novel; closest prior note was the closed “fail closed on unknown curves”, but schemas are still open-ended

### F-A-3: The new binding/finalize tail is outside the adversarial fuzz/replay envelope
- Severity: LOW — this is a coverage gap, not a demonstrated exploit, but it leaves the highest-risk remediated path with mostly happy-path validation
- Owned: OURS
- Category: TEST
- Location: `ledger-app/tests/wire_host/Makefile:1-15,57-74`, `ledger-app/tests/wire_host/fuzz_deploy_parse.c:3-7,26-33,35-52`
- What: the wire harness explicitly proves parser robustness only, not multi-APDU session state, and the deploy harness intentionally never executes `account_binding_deploy_*` or `az_account_derive_from_path`
- Attack/impact: regressions in the new remediation cluster — B3 binding, deploy pre-sign recompute, and finalize-state handling — can ship without ever being hit by the current fuzz/differential-replay suite
- Evidence: the Makefile says the harness proves “`per-APDU memory-safety + parser robustness, NOT multi-APDU session-state machines`”; for deploy it says the fuzzer calls “`ONLY the parse fn, never the crypto/binding tail`”; `fuzz_deploy_parse.c` then defines `account_binding_deploy_pubkey_xy`, `account_binding_deploy_partial`, and `az_account_derive_from_path` as `__builtin_trap()`
- Fix sketch: add seeded replay/fuzz targets for `FINALIZE_AND_SIGN` and `FINALIZE_DEPLOY_AND_SIGN`, and a host-buildable oracle that actually executes the binding tail instead of trapping out of it
- Confidence: high
- Dedup-check: nearest `AHW-024/025/026`, but distinct — those were individual missing tests; this is a broader blind spot around the new centralized binding/finalize code

**Confirmed clean**
- I could not get either signing path to sign the host claim directly: authwit signs local `recheck_outer` after compare-back (`ledger-app/src/handler/finalize_and_sign.c:207-219,280-287`), and deploy signs local `outer_hash_local` copied from a recomputed deploy hash (`ledger-app/src/handler/finalize_deploy_and_sign.c:191-224`).
- I could not break B3 consumer/address binding with current shipped profiles: authwit re-derives from `(path, profile_id, salt)` and re-checks the allowlist at FINALIZE (`ledger-app/src/handler/finalize_and_sign.c:108-149`), and deploy verifies device-derived `public_keys_hash`/`address` in BEGIN and again before signing (`ledger-app/src/handler/begin_deploy_account.c:255-316`, `ledger-app/src/handler/finalize_deploy_and_sign.c:165-187`).
- I could not find a host replay/cross-path confusion between deploy and authwit from `MANIFEST_VERSION=3`: the INS values are separate, the body layouts diverge, and both outer-hash builders bind `chain_id`, `protocol_version`, and `tx_nonce` (`ledger-app/src/l4/parity.c:108-131`, `ledger-app/src/l4/deploy_outer_hash.c:75-93`).
- The reject/reset discipline is solid in the scoped code: parse failures reset in `app_main` (`ledger-app/src/app_main.c:40-49`), dispatcher rejections reset via `reject_dispatch()` (`ledger-app/src/apdu/dispatcher.c:52-57`), and wrong-state APPEND/FINALIZE/DEPLOY paths all fail closed with session wipe.