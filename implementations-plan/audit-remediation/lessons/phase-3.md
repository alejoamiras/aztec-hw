# Phase 3 — blind_signing NVM toggle (HARD ITEM a) + device-hardening nits

Commits unsigned (1Password down — backfill later).

```
[x] P3 — device hardening — COMPLETE (blind_signing toggle proven; 4 nits fixed; 1 documented)
  [x] blind_signing NVM toggle (HARD ITEM a) — full lifecycle proven on app.elf
      - settings.{h,c}: classic Ledger NVM (const in NVRAM + nvm_write); default OFF (zero-init),
        sticky, device-only (NO apdu writes it).
      - sign_outer_hash.c: OFF -> SW_BLIND_SIGN_DISABLED (0x6F13) + "Blind signing disabled" status,
        BEFORE any UI/sign. ON -> existing nbgl_useCaseReviewBlindSigning (⚠ warning review).
      - menu_nbgl.c: SWITCHES_LIST "Blind signing" switch in App settings; callback flips + persists.
      - blind-signing-toggle.test.ts: reject-OFF -> toggle ON -> warn+sign -> toggle OFF -> reject (3 ✓).
      - speculos-settings.ts: shared toggle-nav helper. provider.test.ts: beforeAll enables it for the
        SIGN_OUTER_HASH sign/verify tests.
  [x] AHW-064 — shared `az_bip32_path_is_canonical` (path_canonical.{h,c}) applied to blind-sign +
      both pubkey getters; begin_authwit refactored to use it (no 2nd definition). Non-canonical ->
      0x6F03 (canonical-path.test.ts, 2 ✓); regression green.
  [x] AHW-017 — l4_session_reset() now called on the malformed-APDU path in app_main.c.
  [x] AHW-059 — master_secret_disarm() folded into l4_session_reset() (explicit reset invariant).
  [x] AHW-068 — value-barrier on grumpkin_point_cmov keeps it branchless under -Oz; value-preserving
      (Grumpkin mul/varbase + Schnorr parity green).
  [~] AHW-016 — DOCUMENTED RESIDUAL (v0): no NVM rate-limit. Reveal is human-gated (not spammable),
      root constant-time issue (AHW-029) is PLATFORM-deferred, and a rate cap on un-gated pubkey/FINALIZE
      hurts UX. Production mitigation noted in get_aztec_master_secret.c + audit/index.md. (MED →
      surfaced to owner; can be reopened to implement if they want it.)
```

## Lessons

### GET_CAPS assertion was stale (0x05 → 0x0D) — surfaced by the correct elf
provider.test.ts asserted `caps == 0x05` (K1|CLEAR_SIGN). The real build returns **0x0D** —
M10 added `GRUMPKIN = 1<<3 = 0x08` (Schnorr-over-Grumpkin). The stale assertion only "passed"
earlier because this session was hitting the 18-h orphan elf (see phase-2). Fixed to
`CAPS.K1 | CAPS.CLEAR_SIGN | CAPS.GRUMPKIN`. Lesson: a green Speculos test proves nothing if it's
the wrong elf; re-validate assertions whenever the build/elf provenance is in doubt.

### Speculos Settings-switch nav (nanosp), for toggling NVM flags in tests
The flag has no read APDU by design (device-only). To reach a known state, drive the UI:
`home → right ("App settings") → both (enter → "Blind signing" switch) → both (toggle) → left ×2 (home)`.
Let post-APDU status screens auto-dismiss (~3.5 s) before navigating. Probing the NVM state via a
SIGN_OUTER_HASH is UNSAFE (when OFF there's no review, so the autoConfirm's button presses leak onto
the home carousel and can land on "Quit app" → kills the app). So tests assume a FRESH emulator
(NVRAM resets on restart → OFF) and flip from there; no afterAll restore (a mis-timed toggle could
hit Quit; leaving ON is harmless to the clear-signing-only suites). bun runs test FILES sequentially
(verified: "2 tests across 2 files"), so a shared single Speculos is safe across files.

### Why classic N_storage over lib_standard_app app_storage
app_storage needs `ENABLE_APP_STORAGE=1` + a 480-byte versioned store + prop flags — overkill for one
bool. The classic `const app_settings_t N_app_settings_real;` (zero-init in NVRAM) + `nvm_write` is
battle-tested (Ethereum app), needs no Makefile change, and makes "default OFF" automatic.
