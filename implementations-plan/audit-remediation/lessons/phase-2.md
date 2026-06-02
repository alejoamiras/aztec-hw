# Phase 2 — device UI (firmware C) + the validation loop

## Firmware validation loop WORKS in this env (corrected — I was wrong earlier)
Earlier I declared firmware "blocked" after checking the *system* Python. Wrong: the project venv
+ docker have everything. The confirmed write→build→validate loop:
1. **Build:** `docker run --rm -v "$PWD/ledger-app:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest bash -c "make BOLOS_SDK=/opt/nanosplus-secure-sdk"` → `ledger-app/build/nanos2/bin/app.elf` (build/ is gitignored).
2. **Speculos:** `docker run -d --name speculos-aztec --rm -p 5001:5000 -p 9999:9999 -v "$PWD/ledger-app/build/nanos2/bin:/app" ghcr.io/ledgerhq/speculos:latest --display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf` (poll `POST :5001/apdu`).
3. **Validate:** `SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/<test>.ts`.
Proven: clean rebuild → fresh elf; Speculos runs it; `getPublicKeyXY` + `b3-consumer-binding` pass.
- **Note:** `ledger-app/.venv/bin/speculos` (0.26.8) + ragger also present (alt to docker speculos).
- **Gap that remains:** the TESTNET matrix (network + funded account) — Speculos covers device behavior.
- **clangd diagnostics** on the .c files are false positives (no SDK include path in the IDE); the docker build is the real compiler.

## Checklist
```
[▶] P2 — device UI
  [x] AHW-050 — short_hex_field 8+8 (was 4+4); g_call_from/to buffers 24→40. Built + B3 binding still
      rejects 0x6F12 on the new elf (no regression). Widens BOTH the per-call To AND the account From
      (codex must-fix #1 prereq for the wire change).
  [x] AHW-052 — ASCII ".." marker (was U+2026, which the Nano font lacks). Same edit.
  [x] AHW-040 — DRIP render: format_action "Drip" (symbol omitted — faucet name ≠ token) +
      render_call_pairs shows Amount (token decimals/symbol via args[0] cross-slot lookup) + "To: you (drip)".
      Built clean + B3 no-regression on the new elf. GOLD proof = AHW-046 DRIP review-content test (next).
  [x] AHW-051 — format_amount_with_raw: "<scaled> <SYM> (raw <int>)" on transfer/mint/drip; buffer 2×.
      Built + B3 no-regression. A wrong host `decimals` can mis-scale the human amount but never hide
      the true integer magnitude.
  [ ] AHW-046 — per-verb review-content tests (ragger/Speculos screen assertions) — the gap that hid AHW-040.
  [ ] AHW-055 — mint WARNING as a salient banner; AHW-054 — scope "(verified)"; AHW-053 — full outer_hash.
  [ ] AHW-047/022 — reveal "privacy root" wording.
```

## Remaining phases
- P3 — `blind_signing` NVM toggle + Settings UI (HARD ITEM a) + path-canon (AHW-064) + rate-limit (AHW-016) + cmov (AHW-068).
- P4 — B3 wire-v3 (salt+profile_id, derive-don't-trust) — codex consult first, then implement + Speculos negative tests + fuzz/differential-replay regen.
- testnet matrix — needs network + funded account (out of this env).
