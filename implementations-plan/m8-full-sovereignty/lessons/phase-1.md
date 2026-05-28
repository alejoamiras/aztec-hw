# Phase 1 — P4 host deploy builder (→ safe-v3)

**Status:** in progress.
**Branch:** `m8-phase-1-deploy-builder`.

## Scope decision (deviation from canonical plan §1.1.A3)

The canonical plan calls for Phase 1 to add a **device-side `outer_hash` recompute** in `finalize_deploy_and_sign.c::finalize_deploy_after_approval`. After reading the existing M7 P3 plumbing + Aztec's `EncodedAppEntrypointCalls` encoding, I'm deferring this device-side piece to **Phase 6**, where it lands alongside the `publicKeysHash` + address recompute as one consistent verification block.

**Why defer:**

1. **Substantial isolated work.** The device-side recompute needs to synthesize the canonical call list (init payload + sponsor payload) in C with byte-exact `EncodedAppEntrypointCalls` encoding (poseidon2 over a specific layout). That's a meaningful chunk of new C code that touches `l4/parity.c` + manifest profile semantics. Phase 6 already touches `l4/deploy_address.c` for the `publicKeysHash` + address recompute — folding outer_hash into the same change is cheaper than two separate device-side commits.

2. **No sovereignty gap closes on its own.** Without Phase 6's `publicKeysHash` + address recompute, the device still trusts the host's claimed `publicKeysHash` and `expected_address`. An outer_hash-recompute that signs over those trust-host values doesn't refute a malicious host's swapped viewing keys. The sovereignty win comes from the **combined** check, not from outer_hash binding alone.

3. **Phase 1 still delivers value.** Wiring the M7 P3 device handlers end-to-end via the host's `buildDeploy()` + `FrozenAuthWitnessProvider` (a) replaces the M7-P3-era blind-sign fallback with a clear-signed flow, (b) fixes the pre-existing typecheck error at `aztec-ledger-session.ts:300` (the `from: NO_FROM` field), (c) plays the device's NBGL deploy-review UI for real instead of bypassing it. This is the foundation Phase 6 depends on.

**`safe-v3` revised meaning:** "deploy now uses clear-signed end-to-end via the M7 P3 device handlers, replacing the M7 P3-era blind-sign fallback. Device still trusts host-supplied `publicKeysHash`/`expected_address`/`outer_hash` — same trust model as M7 P3, but no longer blind-signing." Full sovereignty (device-derived everything) lands at `safe-v4`.

**Effort impact:**
- Phase 1 most-likely: ~0.7 wk (was ~1 wk in plan).
- Phase 6 most-likely: ~1.2 wk → ~1.5 wk (absorbs the device-side outer_hash recompute).
- Total M8 effort unchanged: ~8 wk most-likely.

## Phase 1 host-side architecture

The two-pass deploy flow mirrors the M5/M6 transfer pattern via `FrozenAuthWitnessProvider`:

```
1. Spy pass:
   - Inject a SPY auth provider into the account that captures `messageHash`
     when the framework's `request()` internally calls `createAuthWit(...)`.
   - Spy returns a stub witness (64 zero bytes). Discard the resulting
     `ExecutionPayload`.

2. Device sign:
   - Build `DeployContext` from chain info + salt + signing pubkey + manifest
     profile + the captured `messageHash` as `expectedAddress` claim.
   - Call `provider.beginDeployAccount(ctx)` → device runs 3-pass partial
     address parity.
   - Call `provider.finalizeDeployAndSign(messageHash)` → device displays the
     NBGL review (address + path + fee), waits for user approval, signs.
   - Wrap (r, s) as `AuthWitness(messageHash, sigBytes)`.

3. Frozen pass:
   - Inject a `FrozenAuthWitnessProvider(witness, messageHash)` into the
     account.
   - Call `deployMethod.request(...)` again. The framework's `createAuthWit`
     hits the frozen provider, which asserts hash-match and returns the
     pre-signed witness. Result: an `ExecutionPayload` with the device sig
     baked into the meta-payment wrapper.
   - Continue with `DefaultEntrypoint.createTxExecutionRequest(...)` →
     `proveTx` → `sendTx`. Standard from here.
```

The two-pass overhead is one extra `request()` call (cheap; no transport).
Auth-interception requires a mutable hook on `LedgerEcdsaKAccountContract` —
adapter-ledger already wires its auth via the account contract, so the hook
fits naturally.

## Files in scope

- `packages/adapter-ledger/src/deploy-builder.ts` (new) — `buildDeploy()` pure
  function that orchestrates the two-pass flow.
- `packages/adapter-ledger/src/auth-witness-provider.ts` (update) — add
  `createAuthWitForDeploy(ctx, messageHash, opts)`.
- `packages/adapter-ledger/src/account-contract.ts` (update) — add an
  `authInterceptor?` hook on the contract that, if present, overrides
  `getAuthWitnessProvider`.
- `packages/adapter-ledger/src/aztec-ledger-session.ts` (update) — replace
  `deployAccount()` with the two-pass builder; fixes pre-existing typecheck
  error at line 300.
- `packages/adapter-ledger/src/deploy-builder.test.ts` (new) — unit tests
  on the spy auth + frozen provider sequencing.
- `apps/demo-browser/src/panels/AccountPanel.tsx` (update) — call
  `deployAccount()` (now clear-signed) instead of blind-sign fallback.

## What's not in Phase 1

- Device-side `outer_hash` recompute (deferred to Phase 6).
- Ragger test for adversarial wrong outer_hash (also Phase 6; needs the
  recompute to exist to test).
- `publicKeysHash` / `address` recompute on device (Phase 6).

## Lessons (populated as work proceeds)
