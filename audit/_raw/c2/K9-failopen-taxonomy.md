<!-- codex K9 fail-open taxonomy, read-only xhigh -->

### F-K9-1: `SW_HASH_MISMATCH` conflates host mismatch, malformed canonical fields, and internal recompute faults
- Severity: MED — device-side integrity faults and hostile host mismatches collapse to the same live SW on auth/deploy signing paths.
- Owned: OURS
- Category: DESIGN
- Location: [sw.h](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/sw.h:11), [begin_authwit.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_authwit.c:79), [append_call.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/append_call.c:97), [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:161), [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:212), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:98), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:153), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:182), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:209)
- What: `0x6F01` is reused for canonical-Fr input rejects, host/device hash disagreement, and internal parity/recompute failure.
- Attack-impact: a glitch or helper regression in `l4_compute_outer_hash` / deploy recompute paths is indistinguishable from bad host data, weakening triage and alerting on the real signing path.
- Evidence: `if (!l4_fr_is_canonical(...)) return reject(SW_HASH_MISMATCH);` and `if (!l4_compute_outer_hash(...)) return reject(SW_HASH_MISMATCH);`
- Fix-sketch: split host-data mismatch from internal recompute fault, or keep `6F01` user-facing and add a distinct internal-only SW/log bucket.
- Confidence: high
- Dedup-check: distinct from AHW-017/059 and F-E-2/F-F-1; this is live SW taxonomy, not reset/disarm coverage.

### F-K9-2: `SW_DUP_SIG_MISMATCH` also covers reveal derivation faults
- Severity: MED — one SW now means either “signature duplication fault” or “privacy-root dual-derive mismatch.”
- Owned: OURS
- Category: DESIGN
- Location: [sw.h](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/sw.h:16), [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:149), [sign_outer_hash.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:189), [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:330), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:317)
- What: `0x6F06` is reused across different subsystems: reveal dual-derive mismatch and duplicate-signature mismatch.
- Attack-impact: a regression or fault on the reveal path gets triaged as a signing-path problem, hiding a broken secret-derivation path behind the wrong SW bucket.
- Evidence: `if (ct_memcmp32(pass1, pass2) != 0) ... return io_send_sw(SW_DUP_SIG_MISMATCH);`
- Fix-sketch: add a reveal-specific SW and keep `0x6F06` only for signature-parity failures.
- Confidence: high
- Dedup-check: distinct from AHW-022/AHW-059; those were wording/reset issues, not SW reuse.

### F-K9-3: `GET_PUBLIC_KEY` leaks raw SDK error codes outside the app taxonomy
- Severity: LOW — fail-closed, but it bypasses the documented SW set on a live handler.
- Owned: OURS
- Category: DESIGN
- Location: [get_public_key.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_public_key.c:51)
- What: on `bip32_derive_get_pubkey_256()` failure, the handler forwards `cx_err_t` directly with `io_send_sw(error)`.
- Attack-impact: host code that assumes app-defined SWs can see undocumented platform codes; SDK/backend changes can silently alter failure handling and observability.
- Evidence: `if (error != CX_OK) { return io_send_sw(error); }`
- Fix-sketch: normalize all non-`CX_OK` pubkey-derive failures to one app SW; keep raw `cx_err_t` only in logs/debug builds.
- Confidence: medium
- Dedup-check: distinct from AHW-064; path validation was fixed, this is the remaining taxonomy escape hatch.

### F-K9-4: Verified-calls review fails open on unrenderable calls
- Severity: LOW — current tables cover live verbs, but the generic control flow accepts missing render coverage instead of rejecting.
- Owned: OURS
- Category: DESIGN
- Location: [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:236), [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:239), [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:321), [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:364)
- What: the review builder silently drops a call when registry/verb lookup fails, and its `switch` default does not reject unknown verbs.
- Attack-impact: a future allowlist/codegen addition, or post-APPEND corruption, can degrade clear-signing into partial/label-only review while the approval path still reaches `finalize_after_approval()`.
- Evidence: `if (reg == NULL) return 0;`, `if (verb == NULL) return 0;`, `default: break;`, then caller does `n_pairs += render_call_pairs(i, n_pairs);`
- Fix-sketch: make any unrenderable call fatal before UI, and turn the verb `default` into a fail-closed path.
- Confidence: medium
- Dedup-check: distinct from AHW-040 and AHW-086; those were specific DRIP/flag omissions, this is the generic accept-on-unrenderable control flow.

**Confirmed clean**
- [app_main.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/app_main.c:36) parse-failure path now zeroes `G_context` and calls `l4_session_reset()` before continuing; I did not re-report AHW-017/AHW-059.
- [dispatcher.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/apdu/dispatcher.c:52) `reject_dispatch()` resets on dispatcher-level rejects, and L2 boundaries reset before `GET_PUBLIC_KEY`, `GET_SCHNORR_PUBKEY`, `SIGN_OUTER_HASH`, and reveal.
- The live L4 reject helpers in [begin_authwit.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_authwit.c:24), [append_call.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/append_call.c:42), [begin_deploy_account.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_deploy_account.c:45), [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:51), and [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:48) all fail closed via `l4_session_reset()`.
- [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:65) plus [session.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/session.c:10) disarm the reveal secret at handler entry, on reject, and on any session reset.
- [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:119) fails closed if approval fires before a valid FINALIZE APDU populated `claimed_outer_hash_received`.
- I did not find a new live path that returns `0x9000`/`SWO_SUCCESS` on an error, or a new session-park/secret-armed bug beyond the already-known exclusions.