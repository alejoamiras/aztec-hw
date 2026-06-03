# Phase 1 (W1) — immutable reviewed snapshot — IN PROGRESS (blind-sign core done)

AHW-095 (HIGH) + AHW-099 (MED) + fold AHW-112 (LOW). Commit `8194377`.

## Done + build-verified (compiles, exit 0)
**Blind-sign core (AHW-095):**
- New `src/review_snapshot.{h,c}` — an **out-of-band** `blind_sign_snapshot_t` static, deliberately NOT a field of `global_ctx_t` (so the `pk_info`/`sign_info` union + `bip32_path` clobber from a mid-review `GET_PUBLIC_KEY`, or a RAM glitch, cannot corrupt it). API: `capture_blind_sign` / `verify_blind_sign` (armed && length + diff-OR over path words + hash bytes) / `disarm`.
- `ui_display_blind_sign` (sign_ui.c) captures `(path, outer_hash)` right before `nbgl_useCaseReviewBlindSigning`.
- `sign_outer_hash_after_approval` (sign_outer_hash.c) now: verify live `G_context` vs the snapshot → on NULL **reject `SW_REVIEW_STATE_MISMATCH` (0x6F14)** + disarm + bzero; else copy the reviewed `(outer_hash, path, path_len)` into locals, **disarm (single-use)**, and sign **FROM the locals** (the SHA-256 input + BOTH RFC6979 ECDSA passes) — never the live globals.

**Design (the load-bearing bits):** signing FROM the snapshot makes the signature cover what was SHOWN regardless of any post-review clobber/glitch; the compare-back converts a detected divergence into a clean reject (defense-in-depth + clear failure). Out-of-band storage is what defeats the `types.h:80-83` union-clobber.

## PENDING (continuation — needs the emulator / a harness)
1. **AHW-099 deploy-review TOCTOU** — reuse this module for the deploy site: snapshot `(#N, address)` in `deploy_review_ui.c`; verify-or-reject in `finalize_deploy_and_sign.c` (it already signs a fresh local recompute, so this is the display-identity half). Generalize `review_snapshot` or add a `deploy_snapshot` variant.
2. **AHW-112 reveal `#N`** — snapshot the reveal account index (cheap with the module).
3. **Firmware-native reject-branch harness** — the `/goal` requires proving `SW_REVIEW_STATE_MISMATCH` fires when live state ≠ snapshot. Speculos CANNOT inject a mid-review RAM fault, so this needs a host-compiled harness (like `tests/wire_host`) that calls `sign_outer_hash_after_approval` after mutating `G_context`, asserting `0x6F14`.
4. **Speculos happy-path** — confirm a normal blind-sign still signs (the snapshot matches) on a clean port against the fresh elf.
5. (Optional) dispatcher `review_snapshot_disarm()` on every new APDU — extra hygiene; the sign-from-snapshot + compare-back already covers the interleave vector.

## Status — AHW-095 (blind-sign) FIXED + PROVEN
- **Happy-path (Speculos):** `SPECULOS_URL=:5005 bun test provider.test.ts` → 9 pass / 0 fail on the W1 elf — SIGN_OUTER_HASH signs FROM the snapshot and the sig verifies under `sha256(outer_hash)` AND Aztec `Ecdsa.verifySignature` (in-circuit parity). So sign-from-snapshot produces correct signatures.
- **Reject-branch (firmware-native host test):** `cc -I src tests/review_snapshot_test.c src/review_snapshot.c && ./a.out` → exit 0. `review_snapshot_verify_blind_sign` returns NULL on hash mismatch (first + last byte), path-component mismatch, length mismatch, and disarmed/not-armed; returns the snapshot only on exact match. The handler maps NULL → `io_send_sw(SW_REVIEW_STATE_MISMATCH)` (code-verified one-liner). Speculos can't inject a mid-review RAM mutation, so this host test is the honest proof of the reject decision.
- Register: AHW-095 → **FIXED**.

## Remaining W1 siblings (lower-value display-skew; signature already safe)
AHW-099 (deploy review identity) + AHW-112 (reveal #N) — the deploy/reveal SIGNATURES are already over a fresh device recompute (sovereign), so these are display-consistency, not signature-integrity. Reuse the snapshot pattern for those review screens; pending.

Build: docker `ledger-app-builder-lite` exit 0, `bin/app.elf` Jun-3 12:02.
