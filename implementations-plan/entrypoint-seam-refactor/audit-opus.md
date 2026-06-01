# Opus audit — seam-refactor plan (independent subagent, ~4.5min, 36 tool uses)

**Verdict: Sound-with-changes.** Core seam premise is **correct and verified** (refactor is the right call), but the plan materially understates one sequencing trap (txNonce control) and has one factually wrong deploy-mechanism claim.

## BLOCKERS

### B1 — Deploy doesn't go through `wrapExecutionPayload` today; routing it there needs a `NO_FROM` switch
Current `deployAccount` (`aztec-ledger-session.ts:426`) calls `request({ deployer: ZERO, fee: plainSponsor })` with `from` **unset** → `opts.from === NO_FROM` is **false** (`deploy_account_method.ts:140`) → `else` branch → `AccountEntrypointMetaPaymentMethod` never constructed → `account.wrapExecutionPayload` **never called**. The deploy authwit today comes from the init-call payload going through the account entrypoint during `super.sendTx`'s prove (captured by the spy). For the planned `wrapExecutionPayload` override to carry the deploy authwit, P1 must **switch deploy to the self-paid `from: NO_FROM` path** (`account_entrypoint_meta_payment_method.ts:66` is the only call site). P0 spike tests only a transfer → deploy lands unguarded. **Fix: add deploy to the spike gate; prove the `NO_FROM` path reaches our `wrapExecutionPayload` before deleting spy/freeze.**

### B2 — txNonce sovereignty: you cannot "delete the driving and use vanilla `sendTx`"
The bypass exists **specifically because** `EmbeddedWallet`/`BaseWallet`'s real prove path injects `txNonce: Fr.random()` (`embedded_wallet.js:189`; `base_wallet`) **after** signing. The device binds txNonce inside the signed `outer_hash` (`l4-manifest.ts:183` → `EncodedAppEntrypointCalls.toFields` includes `tx_nonce`, `encoding.ts:75`). A custom `EntrypointInterface` does NOT solve this: `createTxExecutionRequest` *receives* `options.txNonce`, but the **caller** (`sendTx`) randomizes it. If P1 routes through vanilla `sendTx`, the wallet picks a different nonce than the device signed → every tx fails (or signs a nonce the user never saw). **Fix: keep driving `createTxExecutionRequest` with a pinned nonce, or override `sendTx` — do NOT hand nonce control back to the framework.** P1's "delete the TX-path driving" is wrong as written.

## MAJOR
- **M1 — P0 spike scope wrong.** "One transfer" gives false confidence; the hard, workaround-bearing flows are **deploy** (B1) and **nonce control** (B2). Add deploy + an explicit "nonce device signed == nonce on-chain" assertion to P0.
- **M2 — Don't delete `createAuthWit` prematurely.** Simulation uses a stub account (`createStubAccount`, `embedded_wallet.js:187`), but app-level authwits for **private transfers** are collected via `this.createAuthWit(...)` (`embedded_wallet.js:88`) on the real account during `sendTx`. The matrix's private→private transfers may need it.

## MINOR
- **Mn1 — claim (d) VERIFIED CORRECT:** `EncodedAppEntrypointCalls` IS exported in shipped **4.2.1** (`@aztec/entrypoints/encoding` + package index). Reuse premise holds. But pin doc line refs to 4.2.1 (`account_entrypoint.js:38/61/95`), not the clone's ~4.4.0 numbers.
- **Mn2 — commit-pin:** dropping `l4-manifest.ts:8`'s `2770bcb` pin is fine ONLY if the parity test (device C `hash()` == `EncodedAppEntrypointCalls.hash()`) runs against the **installed 4.2.1** encoder. Load-bearing.
- **Mn3 — explicit nonce threading:** `deployAccount` + `runRecipe` pick `txNonce = Fr.random()` host-side then thread it; the new path must preserve explicit threading into BOTH the device manifest AND `createTxExecutionRequest`/`wrapExecutionPayload` options.

## What's genuinely right (verified)
- Core seam real: `getAccountFromAddress` override (`session-embedded-wallet.ts:66`) → `accountContract.getAccount()` → custom `EntrypointInterface` in `BaseAccount` IS invoked by the real send path (`embedded_wallet.js:42`, `account.ts:53`). No hidden dependency forces a workaround for the **TX path** (calls, raw args, consumer binding flow through `ExecutionPayload`).
- Clear-signing invariant unchanged (firmware/wire untouched; host `messageHash` stays a cross-check).
- Deploy authwit CAN be carried by `wrapExecutionPayload` once B1's `NO_FROM` switch is made.
- Fail-closed supply-chain reasoning correct (device's independent C encoder → drift is a rejection, not silent forgery).

## Net
Refactor is achievable + reduces code, but **not** by "delete driving + vanilla sendTx." The **txNonce control** and the **deploy `NO_FROM` switch** are mandatory and currently under-specified; the spike must gate **both** before any deletion.
