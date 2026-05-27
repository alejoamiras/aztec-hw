# Phase 2 — deploy_profiles manifest section + codegen

**Status:** completed
**Exit criteria:** `bun run gen-clear-signing-v0.ts` emits new files; `--check` mode passes; cross-check verifies `account_class_id` and `ctor_selector_u32` against the live SDK; elf still builds.

## Approach + log

Per plan §3.2 + §6 Phase 2:

1. Added `deploy_profiles` sibling section to `manifest.json` with one entry (`DEPLOY_ACCOUNT_ECDSAK_V1`, profile_index=0). Fields: account_class_id, ctor_selector_u32, ctor_arg_schema (`ecdsa_k_pubkey_xy`), ctor_arg_byte_len (64), deployer (ZERO), sponsor_fpc_address, sponsor_selector_u32, fee_mode (EXTERNAL), display_name.

2. Extended `gen-clear-signing-v0.ts`:
   - Added `crossCheckDeployProfile()` that re-derives `account_class_id` via `computeContractClassId(getContractClassFromArtifact(EcdsaKAccountContractArtifact))` and the ctor selector via `FunctionSelector.fromNameAndParameters('constructor', ctor.parameters)` from `getAllFunctionAbis()`. Fails closed at codegen on drift.
   - `emitDeployProfilesC()` emits `cs_deploy_profile_t` struct + lookup function. Mirrors the registry emitter style — single C array indexed by `profile_index`, plus a bounds-checked `cs_deploy_profile_lookup(profile_index)`.
   - `emitDeployProfilesTs()` emits parallel TS types + `CS_DEPLOY_PROFILES` array + `csDeployProfileLookup(id)` helper.
   - Wired both into `main()` cross-check loop + output targets list (6 → 9 generated files).

3. Re-ran codegen — all 9 outputs land, biome-formatted. `--check` mode confirms zero drift.

4. Rebuilt elf — `deploy_profiles.gen.c` compiles as part of `APP_SOURCE_PATH += src` (no Makefile change needed). Provider tests 6/6 against fresh elf.

## Values confirmed

- `account_class_id = 0x1850bf05edce02839f8f95c164b10b7a8f82177ae7921a2bc2c083ceece76327` — matches the value already pinned in the registry from prior arcs.
- `ctor_selector_u32 = 0xb6b8e0f8` — newly pinned. Constructor is `abi_private` + `abi_initializer`, takes `signing_pub_key_x: [u8;32], signing_pub_key_y: [u8;32]`. Normalized artifact already strips `inputs` so the M6.12 stripping logic isn't needed for this verb path.
- `ctor_arg_byte_len = 64` — two `[u8;32]` flatten elementwise to 64 Frs per `encoder.ts:24-33`. Codex audit BLOCKER #3 surfaced this; the device-side handler in Phase 3 will replicate the same flatten + `computeVarArgsHash` chain.

## Notes for Phase 3

- The C struct has 32+4+1+2+32+32+4+1+2 = 110 bytes per entry. Reasonable for the 4kB BOLOS code area.
- `cs_deploy_profile_lookup(profile_index)` is the device's only public entry point into the deploy-profile table — keeps the API surface small.
- The `display_name` field is in the TS side only; the device renders its own copy ("EcdsaKAccount v1") from `ui_display_deploy_review.c` — we don't want the host to control display strings.
