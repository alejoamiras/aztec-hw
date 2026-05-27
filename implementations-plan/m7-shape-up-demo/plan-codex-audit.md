REJECT — these issues must be fixed first.

- BLOCKER: `plan.md:51-54, 194-199` gets the `NO_FROM` execution semantics wrong. The framework wraps the merged deploy payload with `DefaultMultiCallEntrypoint.wrapExecutionPayload(...)`, but the final tx request is then built by `DefaultEntrypoint.createTxExecutionRequest(...)`, not by `DefaultMultiCallEntrypoint`. See `deploy_account_method.ts:140-153`, `base_wallet.ts:174-176`, `default_entrypoint.ts:10-41`, `default_multi_call_entrypoint.ts:17-38`. Exact text to change: replace “Wrap through `DefaultMultiCallEntrypoint` for the `from: NO_FROM` path” with “Wrap the merged payload through `DefaultMultiCallEntrypoint`, then hand that single-call payload to `DefaultEntrypoint.createTxExecutionRequest(...)` (or an equivalent helper). Do not use `DefaultMultiCallEntrypoint` to create the final tx request.”

- BLOCKER: `plan.md:132-136`, `386-388`, `447-449`, `518-519` materially overstate v0 security. A malicious host choosing `publicKeys` is not “availability attack only” and does not necessarily produce an invalid tx. `AccountManager.create()` derives `publicKeys` entirely from the host secret `account_manager.ts:32-49`, and the final address depends on `public_keys_hash` and `ivpk_m` `contract_address.ts:35-90`, `derivation.ts:46-62`. A malicious host can choose a valid host-controlled key bundle and matching address, and that deploy can prove and succeed. Exact text to change: replace “tx would fail on the rollup / availability attack only” with “v0 does not authenticate host-chosen protocol keys; it provides signing-key/path binding and fault-resistance, not hostile-host address ownership verification.” If that is unacceptable, move `INS_GET_AZTEC_SECRET` out of §7 and into required scope.

- BLOCKER: `plan.md:126-134` specifies the wrong deploy-hash algorithm. `EcdsaKAccount::constructor` takes `[u8;32] x, [u8;32] y` from the Ledger pubkey `account-contract.ts:37-49`; the canonical hash path is `FunctionSelector.fromNameAndParameters` + `encodeArguments` + `computeVarArgsHash(encodedArgs)` `contract_address.ts:70-90`. Arrays flatten elementwise in the ABI encoder, not as two `Fr`s `encoder.ts:24-33,108-119`. Exact text to change: delete `computeVarArgsHash([Fr(sx), Fr(sy)])` and replace it with “mirror Noir ABI encoding for constructor args, then hash the encoded fields exactly as stdlib does.” Also add one sentence defining the exact canonical call list the device synthesizes before `outer_hash` recomputation.

- MAJOR: `plan.md:86-120, 124-136` is only safe if `BEGIN_DEPLOY_ACCOUNT` commits all deploy semantics and `FINALIZE_DEPLOY_AND_SIGN` adds no new semantic data beyond `claimed_outer_hash`. Say that explicitly. Otherwise the “host changes its mind between BEGIN and FINALIZE” attack is under-specified.

- MAJOR: `plan.md:461-497` misses critical files. At minimum add:
  - `packages/adapter-ledger/src/provider.ts`
  - `packages/adapter-ledger/src/apdu.ts`
  - `ledger-app/src/types.h`
  - `ledger-app/tests/application_client/aztec_command_sender.py`
  - new/updated ragger tests under `ledger-app/tests/`
  - likely `packages/adapter-ledger/src/auth-witness-provider.test.ts`
  Without these, APDU constants and test harnesses drift.

- MAJOR: `plan.md:342, 411` uses a brittle NBGL regression test: “device on main menu within 500ms of success APDU.” That can false-fail on slow CI and false-pass on a brief flicker. Better: assert the post-success/post-reject screenshot shows the home menu labels, then immediately send `GET_VERSION` or `GET_PUBLIC_KEY` and verify no UI cleanup is required. That matches the actual return path in `finalize_and_sign.c:208-222`.

- MAJOR: `plan.md:335-350` should split wire/protocol work from host-builder work. Phase 1 before manifest is fine. But Phase 3 already expects provider tests for new APDUs, so `apdu.ts` and `provider.ts` belong in Phase 3, with `auth-witness-provider.ts` and `aztec-ledger-session.ts` remaining in Phase 4.

- MINOR: `plan.md:268-270` should be a hard assertion in dev/test, not `console.error`. Phase regression is a state-machine bug. Throw in dev/test; log only in production.

- MINOR: `plan.md:195, 198` uses nonexistent APIs. Use `createTxExecutionRequest(...)`, and `proveTx(txRequest, { scopes: [this.address], senderForTags: this.address })` per `default_multi_call_entrypoint.ts:17-38` and `pxe.ts:95-100,776-795`.

Couldn’t save `implementations-plan/m7-shape-up-demo/plan-codex-audit.md` because this session is in a read-only sandbox.