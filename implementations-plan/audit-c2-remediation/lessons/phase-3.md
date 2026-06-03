# Phase 3 (W2) — deploy sponsor render + single-source — DONE (AHW-096 HIGH)

Commit `966a041` (unsigned — 1Password agent down mid-session; backfill `-S` on recovery).

## The finding, re-graded
AHW-096 originally read as "poisoned build signs a hidden sponsor/deployer; UI shows only 'Sponsored'." During the deep-plan the owner pushed back: **there is no CANONICAL sponsored FPC** (the address is instance/network-specific), so we can't anchor it to an artifact the way class-id/ctor-selector are. The fix became: **render the real sponsor on-device + single-source the config + fail-closed equality**, with the irreducible "user must read the screen" residual documented.

## Fix (three layers)
1. **Device renders it** (`deploy_review_ui.c`): the review now shows a `Sponsor` pair =
   `profile->sponsor_fpc_address` as 8+6 hex + ` fn 0x<selector>`, not a bare "Sponsored".
   Manual hex for the selector — BOLOS's reduced `snprintf` has no reliable `%x` (the
   existing `hex_n`/`address_8_6` helpers exist for exactly this reason). Proven on
   Speculos: `DEPLOY PAGE 4: [Sponsor 0x254082b62f9108d0… abb840181257 fn 0x23d77f89]`.
2. **Codegen single-sources it** (`gen-clear-signing-v0.ts` `crossCheckDeployProfile`):
   fail-closed if a profile's `sponsor_fpc_address` != the ONE `SPONSOR`-kind registry
   slot, or `sponsor_selector_u32` != the artifact-verified `SPONSOR` verb selector, or
   `deployer` != ZERO. So there is exactly one sponsor source and a per-profile literal
   can't drift. `bun run …gen-clear-signing-v0.ts --check` exit 0 (current manifest passes).
3. **Host fails fast** (`aztec-ledger-session.ts`): `deployAccountViaEntrypoint` asserts the
   runtime `sponsoredFpcAddress` == the generated profile's sponsor before building the fee.
   Defense-in-depth over the device's authoritative 6d outer-hash recompute (a wrong sponsor
   → wrong outer_hash → device rejects 0x6F01, proven by provider.m8's 6d-gate test). The
   host assert turns a cryptic device reject into a clear config-time error.

## Why this is the right depth
The device's 6d recompute (`finalize_deploy_and_sign.c:199-212`) already signs an outer_hash
built from `profile->sponsor_fpc_address` (manifest-pinned, on-device) and rejects a host
mismatch — so the SIGNATURE was already sponsor-sovereign. AHW-096 was really "the human
can't SEE which sponsor, and the build-time value isn't cross-checked." Layers 1+2 close
those; layer 3 is fail-fast UX + removes the runtime value as an independent trust input.

## Residual (documented, not closed)
A hand-edited checked-in `*.gen.c` bypasses codegen entirely → the device would compile a
different sponsor. Closing that needs the CI build to regenerate-and-diff (or build only from
the manifest) — that is **AHW-102 (DEFERRED)**, the reproducible-build / gen-drift gate. The
plan's P3 scope boundary called this out explicitly.

## Proof
Speculos (:5005, new elf): `provider.m8` 6 pass / 16 expect — the FULL happy path drives the
deploy review with a text-collecting marker walker and asserts the sponsor 8+6 prefix/suffix +
"Sponsor" label are on-screen, then the device signs a verifying ECDSA sig. `--check` exit 0,
`bun run lint:all` + `bun test packages/` (130 pass) exit 0.

Register: AHW-096 → **FIXED** (with the AHW-102 build-gate residual noted inline).
