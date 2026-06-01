# Entrypoint-seam refactor — CONSOLIDATED PLAN (Tier B; deep-plan protocol)

Status board:
```
[✓] 0. Clarifying questions (Tier B; full migration spike-gated; doc = conditional P3)
[✓] 1. Main plan + dual audit (codex xhigh + opus subagent) — both DONE, folded below
[✓] 2. Security & Adversarial section (revised per audits)
[✓] 3. Final codex review — GO-with-edits (folded): in-band nonce CONFIRMED correct; deploy carrier = fee.feeEntrypointOptions → wrapExecutionPayload(options); P0 must drive the REAL EmbeddedWallet.sendTx
[▶] 4. Approval gate (+ /goal + /loop)
[ ] 5. Implementation (P0 spike → P1 migrate → P2 validate → P3 doc?)
[ ] 6. Post-impl codex review   [ ] 7. Fix loop
```

## Context
A codex-as-Grego review of a draft "aztec.js gaps" doc returned do-not-send; verification proved our wallet routes transaction signing through the **hash-only** `AuthWitnessProvider` and bolts on workarounds (parallel `createAuthWitFromIntent` we drive ourselves; a deploy "spy→freeze" two-pass with `FrozenAuthWitnessProvider`; a host-side replica of the entrypoint payload encoding pinned to commit `2770bcb`). aztec.js's intended seam for a signer that must *see what it signs* is a custom **`EntrypointInterface`** (via `AccountContract.getAccount()`), whose `createTxExecutionRequest(exec, …)` receives the full `ExecutionPayload`. This arc re-wires onto that seam, deletes the workarounds **once proven**, and leaves only an honest residue for a conditional upstream doc (P3). The wallet works today (deploy/drip/transfer × ECDSA-K + Schnorr on testnet); the bar is same behavior, cleaner path, **no security regression**, net LOC down.

## Dual-audit consolidation (codex × opus) — adopted / rejected
Both auditors **verified the TX-path seam is correct** (no hidden dependency for normal txs) — the refactor is the right call. Changes adopted into this plan:
- **[ADOPTED] Sign IN-BAND inside `createTxExecutionRequest`.** `sendTx` (`base_wallet.ts:178-189`) chooses `txNonce` (random) and passes it to the account's `createTxExecutionRequest`. Signing **inside** our custom entrypoint (consuming that `txNonce`) makes the device sign exactly the nonce that lands on-chain — this is what dissolves the old pre-sign/freeze nonce-mismatch (opus B2). We do **not** "delete the driving and use vanilla sendTx" naively; we move signing into the entrypoint. Simulation uses a stub account (opus M2), so the device is invoked once, on the real prove.
- **[ADOPTED] Deploy is gated separately; the sideband carrier is `fee.feeEntrypointOptions`.** `wrapExecutionPayload` is reached only on the **self-paid `NO_FROM`** deploy path (opus B1), and it sees only the *fee* payload — the device's deploy review needs the sideband **`DeployContext`** (profileId/salt/publicKeysHash/expectedAddress/path) the entrypoint payload doesn't carry (codex Blocker). **Final codex review (folded): the clean carrier already exists** — `RequestDeployAccountOptions.fee.feeEntrypointOptions` flows into `AccountEntrypointMetaPaymentMethod`, which passes arbitrary `options` into `account.wrapExecutionPayload(…, options)` (`deploy_account_method.ts:36`, `account_entrypoint_meta_payment_method.ts:49`, `interfaces.ts:40` `wrapExecutionPayload(…, options?: any)`). So **P0 spikes the `feeEntrypointOptions` pass-through first**; deploy is treated as a **discoverability/docs** matter, NOT a hard upstream gap, *unless the spike disproves the pass-through*. P1 must not delete the deploy workaround until the new path is proven on-chain.
- **[ADOPTED] Honest attestation scope.** The signed authwit hash = `encodedCalls.hash()` + `(address, chainId, version)` only. `feePaymentMethodOptions`, `cancellable`, `capsules`, `extraHashedArgs` enter the tx request **outside** that hash (codex Major). The device attests **calls/args/txNonce/consumer** — NOT fee mode/cancellability/capsules. We will not claim otherwise (and this under-coverage is itself a candidate P3 upstream point).
- **[ADOPTED] Keep the host-side preflight/allowlist** near the new entrypoint (else regress to opaque device SW; codex Minor), and **keep `createAuthWit`** (private→private transfers collect app-authwits via it; opus M2).
- **[ADOPTED] Import surface:** `EncodedAppEntrypointCalls` from the subpath **`@aztec/entrypoints/encoding`** (verified exported in shipped 4.2.1), not the bare root.
- **[REJECTED/Refined] opus "override sendTx / keep a pinned-nonce driver":** unnecessary if we sign in-band — the framework's `txNonce` is the one we sign. Kept as fallback only if the spike shows in-band signing can't block on device review.

## Verified seam facts (anchored to shipped 4.2.1; clone ~4.4.0 matches semantically)
- `DefaultAccountContract.getAccount(addr)` → `new BaseAccount(new DefaultAccountEntrypoint(addr, provider), provider, addr)` (`accounts/src/defaults/account_contract.ts:25`). Our `getAccountFromAddress` override (`session-embedded-wallet.ts:66`) already returns `accountContract.getAccount()`, invoked by the real send path.
- `BaseAccount` forwards `createTxExecutionRequest` + `wrapExecutionPayload` to the supplied entrypoint (`aztec.js/src/account/account.ts:47-57`). Override `getAccount()` → swap in our entrypoint. **One method.**
- Reference `DefaultAccountEntrypoint.createTxExecutionRequest` (`entrypoints/src/account_entrypoint.ts`): `EncodedAppEntrypointCalls.create(exec.calls, opts.txNonce).hash()` → `computeOuterAuthWitHash(addr, chainId, version, payloadHash)` → `auth.createAuthWit(messageHash)` (the step we replace with in-band device signing) → assemble request with `authWitnesses: [...exec.authWitnesses, payloadAuthWitness]`.
- `EncodedAppEntrypointCalls` public via `@aztec/entrypoints/encoding`; `computeOuterAuthWitHash` public via `@aztec/stdlib/auth-witness`.

## Goal / definition of done
TX flows clear-sign via the custom `EntrypointInterface` (in-band signing); deploy clear-signs via a proven new path (or stays a documented custom path if the seam can't carry `DeployContext`); workarounds deleted **only after** their replacement is proven; host encoding uses `@aztec/entrypoints/encoding` (commit-pin gone); device firmware unchanged; M12 fuzz + differential-replay green; full matrix (deploy/drip/transfer × both schemes) green on testnet; net LOC down.

## Phases

### P0 — SPIKE (hard gate; tests BOTH hard flows via the REAL send path)
1. `LedgerClearSigningEntrypoint implements EntrypointInterface`, `createTxExecutionRequest` mirroring the reference impl but signing **in-band** on the device (map `exec.calls`→manifest, stream BEGIN/APPEND/FINALIZE, device recomputes + clear-signs, assert device recompute == host `messageHash`). Wire via `getAccount()` override. **Drive a transfer through the real `EmbeddedWallet.sendTx`** (NOT a handcrafted `createTxExecutionRequest` call) so the spike actually proves the "stub-simulate → device-prompts-once on real prove" claim; confirm it lands on testnet and **assert `nonce_signed == nonce_on_chain`**.
2. **Prove the deploy path:** drive a real **self-paid (`NO_FROM`)** deploy and confirm (a) it reaches our `wrapExecutionPayload`, and (b) the `DeployContext` reaches the device via **`fee.feeEntrypointOptions`** (the verified carrier) → `wrapExecutionPayload(…, options)`.
- **Gate:** both green → P1. Only if the `feeEntrypointOptions` pass-through proves unusable → STOP; *then* it's a genuine upstream gap → re-plan deploy (minimal custom path) + P3 doc. **Do not delete any workaround in P0.**

### P1 — migration (delete only what P0 replaced)
- TX: route through the custom entrypoint; retire the parallel `createAuthWitFromIntent` TX-driving; **keep** `createAuthWit` (app-authwits) + the preflight/allowlist (relocated near the entrypoint).
- Deploy: per P0's outcome — either migrate to the proven `NO_FROM`+`DeployContext` path and delete spy/freeze + `FrozenAuthWitnessProvider`, or keep a documented minimal custom deploy path.
- Host encoding → `@aztec/entrypoints/encoding`; drop the `l4-manifest.ts` replica + commit-pin; keep the device **wire bytes**, with a parity test (device C `hash()` == `EncodedAppEntrypointCalls.hash()`) against the **installed 4.2.1** encoder.
- Mirror to `schnorr-account-contract.ts`.

### P2 — re-validate (parity, no regressions)
Full matrix on Speculos + testnet (both schemes); device review screens still render decoded calls + (deploy) the account context; re-run M12 fuzz + differential-replay (device unchanged → green); `bun run lint:all && bun test`; tx hashes recorded; `git grep FrozenAuthWitnessProvider|setAuthWitnessOverride|2770bcb` returns nothing (or only a documented deploy exception).

### P3 — residual-gap doc (CONDITIONAL)
Write only for what genuinely remains after the proper seam: candidates now sharpened to — **(a)** deploy-review context not carried by the entrypoint seam (if P0 confirms), **(b)** the authwit hash not covering fee mode / cancellability / capsules / extraHashedArgs, **(c)** encoding **stability/versioning** for the on-device C replica, **(d)** seam **discoverability/docs**, **(e)** consolidated **published** test vectors. codex-as-Grego re-review before any send.

## Critical files
New: `packages/adapter-ledger/src/clear-signing-entrypoint.ts`. Edit: `account-contract.ts` + `schnorr-account-contract.ts` (override `getAccount()`; drop `setAuthWitnessOverride` once deploy migrated), `aztec-ledger-session.ts` (`deployAccount`), `l4-manifest.ts` (import encoder, keep device wire bytes + parity test), `auth-witness-provider.ts` (drop TX-path intent driving, keep `createAuthWit` + preflight). Delete (post-proof): `frozen-auth-witness-provider.ts`. Reuse: `@aztec/entrypoints/encoding`, `@aztec/stdlib/auth-witness`, `@aztec/aztec.js/account`. Unchanged: `ledger-app/`.

## Security & Adversarial Considerations (MANDATORY; revised per audits)
Threat: a malicious/compromised host getting the device to sign ≠ what the user reviews.
- **Clear-signing invariant preserved.** Device independently recomputes `outer_hash` from streamed calls and rejects on mismatch (`SW_HASH_MISMATCH`); host `messageHash` is a **cross-check, never a trust input**; the B3 consumer/address binding + M8-P6 self-derived pkh/address sovereignty stay. A test asserts: stream calls A, claim `messageHash` for B → rejected.
- **In-band nonce (the resolved B2).** Device signs the framework-chosen `txNonce` inside `createTxExecutionRequest`; spike asserts `nonce_signed == nonce_on_chain`. Failure mode if mis-built: device signs a nonce the user never saw → the spike's nonce assertion is the guard.
- **Honest attestation scope.** Device attests calls/args/txNonce/consumer only — NOT fee mode/cancellability/capsules/extraHashedArgs (they enter the request outside the signed hash). UI + docs must not overstate; treat fee-mode/cancellable coverage as out-of-attestation (P3 candidate).
- **Deploy sovereignty.** The new deploy path must still feed the device its `DeployContext` and run the M8-P6 self-derived pkh/address verification + 3-pass partial-address recompute. Spike re-validates a real on-chain deploy + the device review.
- **Supply chain.** Importing `@aztec/entrypoints/encoding` (vs our pinned replica): the device's independent C encoder makes upstream drift a **rejection, not a silent forgery** (fail-closed). Parity test (host vs device hash) is load-bearing; `bun.lock` + 7-day min-age pin the dep.
- **Least privilege / regression.** Signing key never leaves the device; the entrypoint attaches exactly one payload authwit; no half-migrated dual paths (`git grep` gate). Spike-gate + full-matrix on-chain re-validation + fuzz/differential-replay are the regression nets.

## Verification
- P0: testnet tx hash (transfer via new entrypoint) + `nonce_signed == nonce_on_chain` asserted; a self-paid deploy proven to reach `wrapExecutionPayload` with `DeployContext` to the device.
- P2: full matrix green (tx hashes, both schemes); fuzz + differential-replay green; lint + tests; workaround-removed `git grep` clean (modulo documented deploy exception).
