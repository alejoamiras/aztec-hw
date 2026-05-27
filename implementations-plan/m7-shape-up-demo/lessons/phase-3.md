# Phase 3 — Wire protocol + device deploy clear-signing

**Status:** completed
**Exit criteria:** new SWs land, L4 state extended, INS_BEGIN_DEPLOY_ACCOUNT (0x10) + INS_FINALIZE_DEPLOY_AND_SIGN (0x11) handlers compile + smoke-test against Speculos, device UI dismisses correctly, ragger tests cover OK / unknown-profile / wrong-state.

## Approach + log

Per plan §3.3 + §3.4 + §3.5:

### Device side
- New SWs in `ledger-app/src/sw.h`: `SW_UNKNOWN_PROFILE_ID = 0x6F0D`, `SW_DEPLOY_ADDRESS_MISMATCH = 0x6F0E` (reserved for M8 Grumpkin lift), `SW_DEPLOY_PUBKEY_HASH_MISMATCH = 0x6F0F` (reserved), `SW_DEPLOY_CONTEXT_TWICE = 0x6F10`, `SW_DEPLOY_CONTEXT_WRONG_STATE = 0x6F11`.
- New INS codes in `ledger-app/src/types.h`: `INS_BEGIN_DEPLOY_ACCOUNT = 0x10`, `INS_FINALIZE_DEPLOY_AND_SIGN = 0x11`. Codex audit MAJOR #1 invariant documented in the comment block: BEGIN commits ALL semantics, FINALIZE adds only `claimed_outer_hash`.
- New `L4_DEPLOY_CONTEXT` state on the shared `l4_state_e` machine. The deploy and AUTHWIT paths are mutually exclusive — BEGIN_DEPLOY only fires from L4_IDLE; BEGIN_AUTHWIT can't fire from L4_DEPLOY_CONTEXT.
- New `l4_deploy_session_t` struct in `l4/session.h`. Holds profile_id + bip32_path + 6 canonical Fr fields (chain_id, protocol_version, tx_nonce, salt, public_keys_hash, expected_address) + device-recomputed `init_hash_local` + `partial_address_local` + claimed outer_hash. `l4_session_reset()` zeroes BOTH structs.
- New `l4/deploy_address.{c,h}`: poseidon2-chain partial-address recomputation. Uses the sponge directly (`az_poseidon2_sponge_*`) to stream the 64 pubkey-byte Frs without a 2KB stack buffer. Each byte of [u8;32] x,y becomes a zero-padded BE Fr per the Noir ABI encoder (codex audit BLOCKER #3). Chain: `args_hash = poseidon2_sep(64 byte-frs, FUNCTION_ARGS)` → `init_hash = poseidon2_sep([selector_fr, args_hash], INITIALIZER)` → `salted_init = poseidon2_sep([salt, init_hash, deployer], PARTIAL_ADDRESS)` → `partial_address = poseidon2_sep([class_id, salted_init], PARTIAL_ADDRESS)`. Stops here (Grumpkin EC deferred to M8).
- `handler/begin_deploy_account.{c,h}`: parse + validate + profile-allowlist + state-check + 2-pass partial-address recompute (parity 1 + parity 2) + stash → return SUCCESS. Pubkey buffers zeroed after consumption.
- `handler/finalize_deploy_and_sign.{c,h}`: claimed_outer_hash parsing + state-check, then UI invocation. `finalize_deploy_after_approval` runs the 3rd parity pass, signs sha256(claimed_outer_hash) with the duplicate-ECDSA-signing pattern from sign_outer_hash.c, replies via `io_send_response_pointer`, then `nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main)` (M6.11 regression guard from commit zero).
- `ui/deploy_review_ui.c`: NBGL review with three pairs — Address (8+6 hex, codex+opus locked at approval gate; 6+4 was 40 bits brute-forceable), Path (full BIP-32), Fee ("Sponsored (testnet)"). Pubkey fingerprint + class label deliberately omitted (user picked minimal triplet).
- `apdu/dispatcher.c`: route 0x10 + 0x11 to the new handlers.

### Host wire layer
- `packages/adapter-ledger/src/apdu.ts`: new `INS.BEGIN_DEPLOY_ACCOUNT = 0x10` + `INS.FINALIZE_DEPLOY_AND_SIGN = 0x11`. New SW constants for the 5 new SWs + the existing 8x f0-f0c codes that were missing from the prior export.
- `packages/adapter-ledger/src/deploy-context.ts` NEW: `DeployContext` interface + `encodeBeginDeployAccountBody()` + `defaultDeployPath()`. Wire layout mirrors the C handler 1:1 (manifest_version | profile_id | curve | path_scheme | path_len | path[] | 6×32B Frs).
- `packages/adapter-ledger/src/provider.ts`: new `beginDeployAccount(ctx)` + `finalizeDeployAndSign(claimedOuterHash, opts)` methods. Latter takes the same `SignOuterHashOptions` shape so the Speculos `autoConfirm` driver plugs in unchanged.
- Re-exported from package root: `DeployContext`, `defaultDeployPath`, `encodeBeginDeployAccountBody`.

### Tests
- 3 new ragger-style tests in `provider.test.ts`:
  - `BEGIN_DEPLOY_ACCOUNT accepts the registered profile and returns 0x9000` — happy path
  - `BEGIN_DEPLOY_ACCOUNT rejects an unknown profile_id with 0x6F0D`
  - `FINALIZE_DEPLOY_AND_SIGN before BEGIN returns 0x6F11`
- The full UI-driven OK/reject pair lands in P4 when the host has a real `claimedOuterHash` to send. The blind-sign deploy is then deprecated.

## Notes for Phase 4

- The pubkey buffers are zeroed in begin_deploy AND finalize_deploy after consumption (both files duplicate the BIP-32 derivation helper). Could refactor into a shared static if it becomes a maintenance burden.
- The `init_hash_local` is stored on the deploy session but currently unused at FINALIZE (parity pass 3 recomputes from scratch). It's there for the M8 Grumpkin lift, where the preaddress = poseidon2([public_keys_hash, partial_address]) step will want it.
- The synthesized canonical-call list claim in plan §3.4 is not yet actually validated against `claimed_outer_hash`. P4 needs to host-side compute the SAME outer_hash from the same inputs so the device can do its own outer-hash recompute and compare. Right now FINALIZE accepts any 32-byte canonical Fr as the outer hash — which means a malicious host could in principle sign over a different outer_hash than the deploy chain implies. **This is the open hole P4 must close** before the deploy path can be trusted end-to-end.

Actually re-reading my own §3.4 note: the device does NOT currently bind the outer_hash to the device-recomputed partial_address. The right hardening is: device computes its own outer_hash from the synthesized canonical call list (init payload using device-recomputed partial_address + sponsor payload from manifest profile) and asserts it equals claimed_outer_hash. **Adding this to the P3 / P4 boundary** — flag it for the P7 codex review.

## Validation

- `bun run lint` clean.
- `bun test` 110 pass / 0 fail / 1 skip (+3 new ragger tests vs 107).
- Elf rebuilds cleanly with 4 new C files. Warnings: same pre-existing sign-compare in append_call.c; 1 new fixed (size_t for i).
