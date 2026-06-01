# Codex audit — seam-refactor plan (session 019e83a0, xhigh)

**Verdict: sound-with-changes for regular txs; flawed as written for deploy + a few security claims.**

## Blocker
- **Deploy seam ≠ "the full deploy payload."** In self-paid deploy, `DeployAccountMethod.request()` builds the deploy/publication payload separately, then `AccountEntrypointMetaPaymentMethod.getExecutionPayload()` calls `account.wrapExecutionPayload(innerPayload)` on the **fee payload only**, then multicall-wraps the merged result. So `wrapExecutionPayload` DOES create the deploy authwit, but it does **not see the constructor/publication calls** the device review currently reasons about. The current deploy device path needs sideband **`DeployContext`** (`profileId`, `salt`, `publicKeysHash`, `expectedAddress`, path). The plan never says how that context reaches the new entrypoint. Deleting spy/freeze before proving that = churn. Refs: `deploy_account_method.ts:136-153`, `account_entrypoint_meta_payment_method.ts:38-66`, `packages/adapter-ledger/src/deploy-context.ts:33-46`.

## Major
- **Over-claim on what the device attests.** Entrypoint args are `[encodedCalls, feePaymentMethodOptions, cancellable]`, but the authwit hash = `encodedCalls.hash()` + `(address, chainId, version)` only. `capsules` + `extraHashedArgs` also enter the tx request **outside** that hash. So the device attests **calls/args/txNonce/consumer**, but **not** fee mode, cancellability, capsules, or extra hashed args. Don't describe those as clear-signed guarantees. Refs: `account_entrypoint.ts:69-80,133-141`.
- **P0 gates the wrong thing.** One transfer proves `createTxExecutionRequest`, not the deploy path (`wrapExecutionPayload` via self-paid deploy). Add a hard gate for one real self-paid deploy before any deletion. Ref: `plan.md:31-37`.
- **Import surface:** `EncodedAppEntrypointCalls` is exported in 4.2.1 but via subpath `@aztec/entrypoints/encoding`, **not** a bare `@aztec/entrypoints` root export. Premise right; import path in plan slightly wrong. Ref: `@aztec/entrypoints@4.2.1 package.json:7-14`.

## Minor
- If deleting `createAuthWitFromIntent`, preserve the host-side **preflight/allowlist** near the new entrypoint, else regress from clear TS errors → opaque device SW rejects. Ref: `auth-witness-provider.ts:104-108`.

## What's genuinely right
- TX seam analysis correct: `DefaultAccountContract.getAccount()` is the injection point; `BaseAccount` forwards both `createTxExecutionRequest` + `wrapExecutionPayload` to the supplied entrypoint. Refs: `accounts/src/defaults/account_contract.ts:25-31`, `aztec.js/src/account/account.ts:47-57`.
- For normal txs the custom entrypoint receives raw `ExecutionPayload.calls` + `txNonce`/fee options → drive the device with the full call list + recompute the canonical payload hash, no intent/frozen workaround. Refs: `interfaces.ts:31-59`, `account_entrypoint.ts:123-141`, `base_wallet.ts:178-189`.
- `wrapExecutionPayload` really is where the deploy authwit happens — the seam isn't wrong; the missing piece is **deploy-specific context**, not another hidden authwit call.

## Cross-audit reconciliation (codex × opus)
- **Agree:** TX seam correct + verified; `EncodedAppEntrypointCalls` exported in 4.2.1 (subpath); spike must gate deploy; keep preflight + `createAuthWit` (private transfers).
- **opus B2 (txNonce) — resolved by design:** both note `sendTx` chooses `txNonce` (random) and passes it to `createTxExecutionRequest`. **Resolution = sign IN-BAND inside `createTxExecutionRequest`** (consuming the framework `txNonce`), so the device signs exactly the nonce that lands on-chain — dissolving the old pre-sign/freeze mismatch. Simulation uses a stub account (opus M2), so the device is invoked once, on the real prove. **The spike MUST assert `nonce_signed == nonce_on_chain`.**
- **Deploy is the genuinely hard part** (codex Blocker + opus B1): needs the `DeployContext` sideband the entrypoint payload doesn't carry, AND the `NO_FROM` self-paid switch to even reach `wrapExecutionPayload`. This is the #1 spike target and a candidate **verified upstream gap** (P3 doc) if the seam genuinely can't carry deploy-review context.
