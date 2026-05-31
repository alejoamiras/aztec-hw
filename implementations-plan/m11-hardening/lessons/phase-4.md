# M11 P4 — dedup account-binding + handler-seam fuzz + private-binding spike

## Done
- **Private-from-binding spike (codex Minor): NO GAP** — all 4 transfer verbs have `from=args[0]` + `verb_is_4arg_transfer` covers all 4, so `append_call.c` enforces `from==consumer` uniformly (public AND private). With B3 (`consumer==account`), `from==consumer==account` holds everywhere. See phase-4-spike.md. → P6 is validation-only; safe-v13 provisional note cleared.
- **Handler-seam negatives (codex T1.4)** — `wire-negative.test.ts`: 7 malformed APDUs vs the REAL handlers on Speculos assert exact fail-closed SWs (bad version 0x6F02, bad curve 0x6F04, bad path 0x6F03, K1+Schnorr-profile 0x6F04, unknown profile 0x6F0D, empty/truncated ≠ 0x9000). 7/7 pass. Gated on SPECULOS_URL.
- **Dedup the 3 `derive_signing_pubkey_xy` copies (codex Minor)** — new `l4/account_binding.{c,h}` is the single source for the secp256k1 signing-pubkey derive; the authwit B3 + both deploy handlers now delegate (one-line). They had already drifted cosmetically (begin_deploy split the err/0x04 checks, finalize_deploy combined them) — exactly the drift this removes. Byte-neutral (nanos2 text=45650 unchanged); ECDSA deploy-review PASS (#2 = 0x2bef2da9…, same address) confirms identical behavior.

## Remaining P4 (documented follow-ups, lower priority)
- **dedup `deploy_derive_pubkey_xy` / `deploy_compute_partial`** (2 copies, begin_deploy + finalize_deploy). These are recent (M10), co-located, and entangled with the deploy session + profile + curve dispatch — lower drift risk than the 3 secp256k1 copies just unified. Move to a shared deploy-binding helper.
- **host-compiled libFuzzer + ASan harness** over the wire handlers (`wire_host/`). The Speculos negatives already cover the fail-closed LOGIC on the real elf; the host+ASan harness adds memory-UB detection. Needs a BOLOS shim layer (io/buffer/session) — deferred to avoid a rushed, false-confidence harness.

safe-v11 = P4 core (spike + negatives + secp256k1 dedup). Next: P5 (authwit-v3 wire).
