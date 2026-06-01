# M12 Phase 7 — closing codex post-impl review + fix loop (DONE)

## Codex review (session 019e80ce, xhigh, adversarial) — verdict: SHIP-WITH-FIXES (no blocker)
Codex independently **confirmed P2b binding integrity is sound** (the highest-priority concern): after diffing vs `safe-v14`, the seam split preserves assignment/order/SW behavior; no malformed deploy became accepted or mis-bound. Also confirmed fine: the append session-prep faithfulness, `lcClamp(255)`, and the flag-gated-spike no-leakage story. (I independently re-verified the binding region byte-identical: P0 `4a932e6` → HEAD, 142-line region, empty diff.)

3 Majors + 2 Minors — **all folded + re-validated:**

- **[Major 1] Deploy replay accept-bucket too loose.** `{0x9000, 0x6F0F, 0x6F0E}` let a device *over-accept* (0x9000 on a random input) pass. Fix: every parse-accepted corpus/reservoir input is RANDOM → its host pkh ≠ the device's seed-derived pkh → the sovereignty gate fires at the pkh check FIRST → **exactly 0x6F0F**. Tightened the assertion to `=== 0x6F0F`; documented the residual (the oracle IS the parser, so the gate proves device-*faithfulness*, not parser-*correctness* — a shared over-accept is covered by the fuzzer + the un-bypassable binding tail). **Re-ran the gate: still 3/3 green → the device DOES return 0x6F0F for all parse-accepts (reasoning confirmed on real firmware).**
- **[Major 2] Reservoir optional → blind-spot silently reopens.** A green run could degrade to corpus-only. Fix: `requireReservoir()` — each target asserts `reservoir/<t>` has ≥ `MIN_RESERVOIR=20` files, else fails with the harvest command. Docstring "optional" → "REQUIRED".
- **[Major 3] Vendored-buffer check not fail-closed.** `verify-vendored.sh` exited 0 when docker was absent ("unverified" read as "verified"); SDK-version coupling undocumented. Fix: **fail-closed** (exit 2 without docker; `VERIFY_VENDORED_ALLOW_NO_DOCKER=1` opt-out), + `VENDORED.md` now states the firmware `BOLOS_SDK` and the pinned image hash must be re-pinned TOGETHER or the harness fuzzes a different reader than ships.
- **[Minor 1] cx-math doc overstated.** "DEFINITIVE / disproven / high confidence" from 4 vectors → softened: "strong evidence for our two moduli", confidence split (high on *our moduli*, moderate on *broad* correctness).
- **[Minor 2] Flag-name typo.** `cxmath_spike.c` said `DEFINES_EXTRA` → corrected to `EXTRA_DEFINES`.

## Outcome
M12 P0–P3 implementation reviewed adversarially; no blocker; the differential-replay gate is now strictly stronger (precise deploy SW + mandatory reservoir + fail-closed drift check) and re-confirmed green. The arc's assurance work is complete.

(Fixes committed UNSIGNED — 1Password down this session; tag safe-v18 + push + backfill-sign pending recovery.)
