# Phase 4 (W3) — host public-API lockdown — DONE ✅

AHW-097 (HIGH) + AHW-103 (MED). Host-only (no firmware/Speculos), done first while the firmware build ran. Commits `9ffebb8` (AHW-097) + `12e2c6e` (AHW-103). Verified: `bun test packages/adapter-ledger` 121 pass / 0 fail; demo-app `tsc --noEmit` exit 0; `git grep` clean.

## AHW-097 — raw `signOuterHash` off the public driver
- The raw blind-sign was a METHOD on the root-exported `LedgerProvider`. `transport` is `private readonly`, so a free helper can't reach it via the provider — so `unsafeSignOuterHash(transport, …)` takes the **`LedgerTransport` directly** (tests already hold it). The method is gone from the class; the capability lives in `src/unsafe.ts`, exposed only via the `./unsafe` package subpath (`package.json` `exports`).
- Faithful detail: `unsafe.ts` replicates the strict BIP-32 encoder + the exact `SW=0x….` error format, so the device-side rejects (0x6F13 blind-sign-disabled, 0x6F03 non-canonical, 0x6985 user-reject) still relay byte-identically — the migrated Speculos tests' `.rejects.toThrow('SW=0x…')` assertions are unchanged.
- Callers were tests-only (no app/internal use), so the relocation was low-risk: 3 test files migrated `provider.signOuterHash(` → `unsafeSignOuterHash(transport,` (replace_all).

## AHW-103 — privacy-root cache reread off the barrel
- Key finding: the cache (`loadCachedSecret`/`cacheSecret`) was driven ONLY by the frontend `OnboardPanel.tsx` — the adapter's own onboarding/session layer never used it. So the clean fix = move the orchestration INTO the host layer: new `revealOrReuseMasterSecret()` in `onboarding.ts` (computes the device key, returns cached or does ONE reveal + caches), and drop the raw read/write/clear-one primitives from the barrel. Barrel now exposes only `clearAllCachedSecrets` (forget) + `hasCachedSecret` (presence) + `revealOrReuseMasterSecret`.
- **Owner scope call:** the fix needs a minimal `OnboardPanel.tsx` (frontend) consumer change, which was scoped OUT. Surfaced it as a fork; owner chose "do the minimal touch" (it's a forced consumer migration for the host-API change, not independent frontend work). `onReveal` hook preserves the "Approve on device" UX on a cache miss.
- `secret-cache.test.ts` imports the primitives via the RELATIVE module path (not the barrel), so the lockdown didn't break it — the functions still exist, just aren't re-exported.

## Gotchas
- **commitlint header-max-length = 100.** The first AHW-103 message (`…onboarding owns reveal-or-reuse (AHW-103/W3)`) was ~106 chars → husky commit-msg rejected (staged changes survived; just shortened the subject and re-committed).
- biome (lint-staged) reordered the barrel exports alphabetically on commit — expected.
- The stale `speculos-aztec-playwright` orphan on :5001 (Jun-2 elf) is NOT trusted; a fresh nanosp build (`bhgzjoqdz`, exit 0 → `ledger-app/bin/app.elf` Jun-3) is ready for the firmware phases on a CLEAN port (5005/9995).

## Status note
W3/P4 ✅. P0 partial: the marker-based approver (`approveByMarker`, `82a3d68`) is committed + import-verified, but the deploy/reveal/address walker migrations + clean-Speculos marker verification are pending (need the fresh elf on a clean port). Firmware phases (P1 W1 snapshot, P2 W5 scrub, P3 W2 fee-target, P5 W4 INS) next — each a docker-build + clean-Speculos loop.
