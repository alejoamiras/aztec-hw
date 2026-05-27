Couldn’t write `/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/implementations-plan/m7-shape-up-demo/plan-codex.md` because this session is running in a read-only sandbox. Exact Markdown follows.

# M7 Plan (Codex)

## Problem statement
The demo currently has two incompatible trust models. Drip and transfer use the reviewed clear-signing path: the host builds an L4 manifest, the device rechecks selectors and args, recomputes `outer_hash`, and shows semantic review before signing. Deploy does not: `AztecLedgerSession.deployAccount()` emits only three free-text labels, calls `accountManager.getDeployMethod()`, and then delegates to `deployMethod.send({ from: NO_FROM, fee: SponsoredFeePaymentMethod(...) })`, so the browser loses visibility into the real sign/prove/submit boundary and the device falls back to blind `outer_hash` review. `packages/adapter-ledger/src/aztec-ledger-session.ts:253-267`

The UI then compounds the problem by inferring phases from label regexes. `StatusBar` maps words like “Submitting” to `submit`, so deploy lights the `Submit` phase while the device is still waiting for approval. The step model itself only stores a label and timestamp, not a structured phase. `apps/demo-browser/src/panels/StatusBar.tsx:42-60`, `apps/demo-browser/src/panels/StatusBar.tsx:142-152`, `apps/demo-browser/src/state.ts:28-43`

The fix therefore needs three coordinated changes, not one-off patching: a dedicated clear-signed deploy architecture, structured phase emission from the adapter, and in-place CSS polish so the demo reads as intentional product work rather than scaffold CSS. `apps/demo-browser/src/style.css:3-16`, `apps/demo-browser/src/style.css:36-45`

## Architecture decisions
I would not try to “inject” a frozen witness into `AccountManager.getDeployMethod().send()`. `AccountManager.getDeployMethod()` constructs a `DeployAccountMethod` around the account returned by `getAccount()`. `LedgerEcdsaKAccountContract.getAuthWitnessProvider()` always returns the live Ledger provider, and `DeployAccountMethod.with({ authWitnesses })` only appends extra witnesses to the deploy payload; it does not replace the payload auth-witness signer. `aztec-packages/yarn-project/aztec.js/src/wallet/account_manager.ts:112-138`, `packages/adapter-ledger/src/account-contract.ts:52-58`, `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:203-233`

The harder blocker happens even earlier. For `from === NO_FROM`, `DeployAccountMethod.request()` wraps the fee path through `AccountEntrypointMetaPaymentMethod`, and that wrapper calls `account.wrapExecutionPayload()`. `DefaultAccountEntrypoint.wrapExecutionPayload()` builds `payloadAuthWitness` immediately by calling `auth.createAuthWit(messageHash)`. That means blind signing already happens while `request()` is assembling the execution payload, before the caller can freeze or swap anything. `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:128-153`, `aztec-packages/yarn-project/aztec.js/src/wallet/account_entrypoint_meta_payment_method.ts:38-67`, `aztec-packages/yarn-project/aztec.js/src/account/account.ts:56-58`, `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:86-113`, `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:123-142`

The consequence is clear: deploy must bypass `deployMethod.send()` and most of `deployMethod.request()`. I would add a dedicated adapter-side `deployAccountClearSigned()` path and retire the current blind-signed deploy route for the demo.

There is also an important constraint in the address story. The device cannot derive the final Aztec account address from the BIP32 signing key and salt alone. Project conventions explicitly say the protocol keys stay host-side while the hardware wallet only holds the signing key. `AccountManager.create()` derives `publicKeys` from the browser secret and mixes them into the instance, while the constructor args only carry the Ledger-derived secp256k1 `(x, y)` signing pubkey. `CLAUDE.md:39-40`, `aztec-packages/yarn-project/aztec.js/src/wallet/account_manager.ts:32-49`, `packages/adapter-ledger/src/account-contract.ts:41-49`

The canonical derivation path is: build `initializationHash` from the constructor selector and ABI-encoded constructor args, compute `saltedInitializationHash`, compute `partialAddress`, then compute `address = x((preaddress * G) + ivpk_m)` where `preaddress = H(public_keys_hash, partialAddress)`. The final address therefore depends on both host-derived address keys and the device-derived signing key. `aztec-packages/yarn-project/stdlib/src/contract/contract_instance.ts:117-145`, `aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:35-61`, `aztec-packages/yarn-project/stdlib/src/keys/public_keys.ts:75-87`, `aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:46-62`

For the PoC, I would stream `public_keys_hash`, `ivpk_m`, and `expected_address` to the device. That is enough for exact address recomputation, but it does not authenticate the host’s choice of protocol keys. I would state that limitation explicitly rather than pretending the Ledger alone can validate host-held privacy keys.

I would also not overload the current selector registry with a fake `DEPLOY_ACCOUNT` call verb. The existing manifest/codegen model is built around registry kinds plus `(kind, selector, visibility, arg_count)` lookup tables for real calls, not deploy profiles. `packages/adapter-ledger/clear-signing-v0/manifest.json:10-141`, `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:38-66`, `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:94-198`, `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:311-375`

Instead, I would add a sibling `deploy_profiles` section to `clear-signing-v0/manifest.json`, with one reviewed profile `DEPLOY_ACCOUNT_ECDSAK_V1`. Codegen should emit `deploy_profiles.gen.{h,c}` and `deploy_profiles.generated.ts`. That profile should pin the reviewed `account_class_id`, the constructor selector and arg schema `([u8;32], [u8;32])`, `deployer = AztecAddress.ZERO`, the sponsor contract address and selector, the fee mode `EXTERNAL`, and its own profile version. `aztec-packages/yarn-project/stdlib/src/contract/contract_class.ts:17-45`, `packages/adapter-ledger/src/account-contract.ts:37-49`, `packages/adapter-ledger/clear-signing-v0/manifest.json:25-31`, `aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:22-40`

The APDU shape I would use is three calls. `BEGIN_DEPLOY_ACCOUNT` should carry `manifest_version | curve_id | path_scheme | path_len | path[] | chain_id | protocol_version | tx_nonce | salt | expected_address | public_keys_hash`. `SET_DEPLOY_IVPK` should carry `ivpk_m_x | ivpk_m_y`. `FINALIZE_DEPLOY_AND_SIGN` should carry `claimed_outer_hash`. I would keep these as separate INS values, but reuse the same dispatcher/session-reset discipline already enforced for the L2/L4 paths. `ledger-app/src/apdu/dispatcher.c:1-135`, `packages/adapter-ledger/src/apdu.ts:18-27`

On device, the recomputation algorithm should be exact, not “equivalent-looking”. First, validate path scheme/prefix exactly like `BEGIN_AUTHWIT`, and validate every `Fr` input as canonical with trailing-byte rejection. `ledger-app/src/handler/begin_authwit.c:31-84` Second, derive the secp256k1 signing pubkey `(x, y)` from the approved BIP32 path. `packages/adapter-ledger/src/provider.ts:62-74`, `ledger-app/src/handler/get_public_key.c:28-58` Third, compute the constructor `initializationHash` exactly like stdlib: constructor selector from the pinned ABI, Noir ABI encoding of `[u8;32] x` and `[u8;32] y`, `computeVarArgsHash(encodedArgs)`, then Poseidon2 with `DomainSeparator.INITIALIZER`. `packages/adapter-ledger/src/account-contract.ts:37-49`, `aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:70-90` Fourth, compute `saltedInitializationHash = H(salt, initializationHash, ZERO_DEPLOYER)` and `partialAddress = H(accountClassId, saltedInitializationHash)`. `aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:35-61` Fifth, compute `preaddress = H(public_keys_hash, partialAddress)` and `address = x((preaddress * G) + ivpk_m)`. `aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:46-62` Sixth, compare the recomputed address with `expected_address`; any mismatch fails closed before UI and zeroes session state.

After the address check, the device should synthesize the fixed one-call sponsor intent and reuse the current outer-hash parity/signing discipline. The existing firmware already knows how to recompute `outer_hash` three times around the review screen and how to duplicate-check the ECDSA signature. `ledger-app/src/l4/parity.c:1-137`, `ledger-app/src/handler/finalize_and_sign.c:1-223` The deploy UI should show the full recomputed address as primary content, with path and a short signing-pubkey fingerprint under “details”. The current blind path already formats the full BIP32 path safely, and both blind and verified-calls paths explicitly dismiss NBGL back to home after approve/reject; preserve those properties. `ledger-app/src/ui/sign_ui.c:57-123`, `ledger-app/src/ui/verified_calls_ui.c:273-310`, `ledger-app/src/handler/sign_outer_hash.c:189-203`, `ledger-app/src/handler/finalize_and_sign.c:208-222`

On the host side, I would reuse the current `FrozenAuthWitnessProvider` pattern, but only after bypassing the deploy builder that signs during `request()`. `packages/adapter-ledger/src/frozen-auth-witness-provider.ts:10-28`, `packages/adapter-ledger/src/frozen-auth-witness-provider.ts:59-81` The deploy builder should recreate the pure initialization payload by mirroring `DeployMethod.getInitializationExecutionPayload()` with `skipClassPublication=true`, `skipInstancePublication=true`, and no self-fee/auth-witness side effects. `aztec-packages/yarn-project/aztec.js/src/contract/deploy_method.ts:517-529` It should build the inner sponsored-fee payload directly with `SponsoredFeePaymentMethod.getExecutionPayload()`. `aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:22-40` It should choose a fresh `txNonce`, send the deploy-profile APDUs, and obtain a witness via `createAuthWitForDeploy(...)`. It should then wrap the sponsored-fee payload with `DefaultAccountEntrypoint(this.address, frozen).wrapExecutionPayload(... { cancellable: false, txNonce, feePaymentMethodOptions: EXTERNAL })`. `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:86-113`, `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:123-142`

After that, merge `[deploymentExecutionPayload, wrappedSponsorPayload]` in that order, matching the current self-deploy ordering constraint, then wrap the merged payload through `DefaultMultiCallEntrypoint`. `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:145-153`, `aztec-packages/yarn-project/entrypoints/src/default_multi_call_entrypoint.ts:40-60` Build the final tx request via the `NO_FROM` path, then prove with `scopes: [this.address]` and `senderForTags: this.address`, because the standard deploy flow relies on those deploy-specific proving hints. `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:172-191`, `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:182-200`, `aztec-packages/yarn-project/pxe/src/pxe.ts:95-100`, `aztec-packages/yarn-project/pxe/src/pxe.ts:776-795`

## Structured-step refactor
Change `SubmitStepHandler` from `(label: string) => void` to `(phase: PhaseId, label: string) => void`, and persist `phase` inside `SubmitStep`. The current adapter, UI state, and `AccountPanel` all traffic in label-only steps, which is why `StatusBar` falls back to keyword regexes. `packages/adapter-ledger/src/aztec-ledger-session.ts:97-104`, `apps/demo-browser/src/state.ts:28-43`, `apps/demo-browser/src/panels/AccountPanel.tsx:22-38`

Remove `inferPhaseIndex()` and `activePhase()` from `StatusBar`; the active phase should be the last emitted `step.phase`, not a best-effort string parse. `apps/demo-browser/src/panels/StatusBar.tsx:42-60`

The exhaustive emission map I would use is:

- Deploy emits `build / Building deploy initializer payload…`
- Deploy emits `build / Building sponsored deploy fee payload…`
- Deploy emits `build / Fetching chain info…`
- Deploy emits `sign / Awaiting deploy approval on device…`
- Deploy emits `prove / Deploy approval received — building tx request…`
- Deploy emits `prove / Proving deploy tx (in-browser WASM)…`
- Deploy emits `submit / Submitting deploy tx 0x…`
- Deploy emits `include / Awaiting deploy inclusion…`
- Deploy emits `done / Deploy tx mined`

- Drip emits `build / Building drip payload…`
- Drip emits `build / Fetching chain info…`
- Drip emits `build / Projecting clear-sign intent…`
- Drip emits `sign / Awaiting clear-signed approval on device…`
- Drip emits `prove / Signature received — building tx request…`
- Drip emits `prove / Proving tx (in-browser WASM)…`
- Drip emits `submit / Submitting tx 0x…`
- Drip emits `include / Awaiting inclusion…`
- Drip emits `done / Tx mined`

- Transfer emits `build / Building transfer pub→pub payload…` or `priv→pub` or `pub→priv` or `priv→priv`
- Transfer emits `build / Fetching chain info…`
- Transfer emits `build / Projecting clear-sign intent…`
- Transfer emits `sign / Awaiting clear-signed approval on device…`
- Transfer emits `prove / Signature received — building tx request…`
- Transfer emits `prove / Proving tx (in-browser WASM)…`
- Transfer emits `submit / Submitting tx 0x…`
- Transfer emits `include / Awaiting inclusion…`
- Transfer emits `done / Tx mined`

Add a monotonic phase-order assertion in the browser reducer. This is not a security control, but it will catch accidental phase regressions immediately.

## CSS polish targets
Replace the current token-light system-font treatment with a deliberate type pair and a fuller token set. Today the root theme is a minimal dark palette plus system UI font, which makes the page read like scaffolding. `apps/demo-browser/src/style.css:3-16`

Redesign the status bar as a denser hero card: stronger hierarchy for badge, action, and current step; clearer connector states; and a mobile fallback that stacks or scrolls the six phases instead of squeezing them into equal columns. `apps/demo-browser/src/style.css:36-45`, `apps/demo-browser/src/style.css:107-200`, `apps/demo-browser/src/panels/StatusBar.tsx:167-189`

Give deploy its own visual affordance. Right now deploy and drip share the same generic primary-button treatment, while the copy explicitly says deploy is blind-signed. After the clear-sign change, deploy should read as “one-time setup” with a distinct button variant and explanatory callout. `apps/demo-browser/src/style.css:290-320`, `apps/demo-browser/src/panels/AccountPanel.tsx:65-96`

Replace the raw wrapped address text with an address pill and secondary actions. The current `.address` just breaks anywhere. `apps/demo-browser/src/style.css:350-355`, `apps/demo-browser/src/panels/AccountPanel.tsx:59-63`

Remove remaining inline styling from `AccountPanel` and formalize a panel header, meta row, and footer-note pattern so all three main panels read as one system. `apps/demo-browser/src/panels/AccountPanel.tsx:59-63`, `apps/demo-browser/src/style.css:243-260`

Make the Speculos aside look like a device console, not just another generic card, and keep the main column visually dominant. `apps/demo-browser/src/App.tsx:22-31`, `apps/demo-browser/src/style.css:203-222`, `apps/demo-browser/src/style.css:399-478`

## Sequencing / milestones
1. Structured phases and UI plumbing. Exit: `SubmitStep` carries `phase`, `StatusBar` has no regex inference, and clicking Deploy shows `Sign` while the device waits for approval. `apps/demo-browser/src/state.ts:28-43`, `apps/demo-browser/src/panels/StatusBar.tsx:42-60`

2. Host-side deploy builder. Exit: adapter deploy no longer calls `deployMethod.send()`, and the deploy action uses the same one-shot frozen-witness pattern as the current clear-sign recipe. `packages/adapter-ledger/src/aztec-ledger-session.ts:253-267`, `packages/adapter-ledger/src/aztec-ledger-session.ts:470-545`

3. Device deploy clear-signing. Exit: new deploy APDUs exist, mismatch on address or `outer_hash` fails closed, and deploy review shows the recomputed address instead of `outer_hash`. `ledger-app/src/ui/sign_ui.c:94-121`, `ledger-app/src/handler/finalize_and_sign.c:93-145`

4. Codegen and regression harness. Exit: manifest/codegen emit deploy-profile constants, CI cross-checks class and selector drift, and golden vectors cover host/device address derivation plus sponsor `outer_hash` parity. `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:94-198`, `packages/adapter-ledger/src/l4-manifest.ts:1-13`

5. CSS polish. Exit: desktop and mobile screenshots are stable, no inline panel styles remain, and the timeline remains legible below 720px. `apps/demo-browser/src/style.css:215-222`, `apps/demo-browser/src/panels/AccountPanel.tsx:59-63`

## Security & adversarial considerations
Address-only display is not sufficient if it is truncated. A malicious host can brute-force `salt` until the first and last displayed bytes collide, especially if NBGL only shows a short teaser. Show the full address across pages, and add a signing-key fingerprint plus full path in details. `ledger-app/src/ui/sign_ui.c:103-121`, `ledger-app/src/ui/verified_calls_ui.c:83-95`, `ledger-app/src/ui/verified_calls_ui.c:273-309`

The cheaper attack is path mis-selection, not breaking secp256k1. The host can move from `.../0/0` to `.../1/0`, changing the signing pubkey and therefore the initializer hash. Displaying the full path and a pubkey fingerprint makes that visible; address-only does not. `ledger-app/src/handler/begin_authwit.c:51-57`, `ledger-app/src/ui/sign_ui.c:57-82`

On-device address recomputation cannot authenticate host-held protocol keys. The host chooses the browser secret and therefore `publicKeys`; the Ledger only holds the signing key. Streaming `public_keys_hash` and `ivpk_m` lets the device check consistency, not honesty. `CLAUDE.md:39-40`, `aztec-packages/yarn-project/aztec.js/src/wallet/account_manager.ts:32-49`

Salt, chain id, version, tx nonce, and expected address must all be canonical fields, with trailing-byte rejection on every deploy APDU, matching the current parser discipline. `ledger-app/src/handler/begin_authwit.c:31-84`, `ledger-app/src/handler/finalize_and_sign.c:83-91`

If deploy later supports multiple account classes, the device must not accept arbitrary class ids from the host. It should accept only manifest-pinned profile ids, each with pinned class id, constructor schema, and sponsor policy.

A shared Poseidon2 bug across host TS and device C can silently survive if both sides use the same wrong constants or field order. Mitigate with independent test oracles, not only same-repo golden vectors: at least one barretenberg or Noir-derived vector set plus firmware unit tests. `aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:35-90`, `packages/adapter-ledger/src/l4-manifest.ts:6-13`

Reuse the current fault defenses: double address and args recompute before UI, recheck after approval, duplicate ECDSA signing, and zero session state on every non-success path. `ledger-app/src/handler/append_call.c:148-178`, `ledger-app/src/handler/finalize_and_sign.c:93-197`, `ledger-app/src/apdu/dispatcher.c:45-50`

New deploy UI must preserve the explicit success and reject dismissal back to home. That regression already existed once in both blind and clear paths. `ledger-app/src/handler/sign_outer_hash.c:189-203`, `ledger-app/src/handler/finalize_and_sign.c:208-222`

The structured-phase callback is a UX improvement, not an attestation channel. A malicious host can still lie to the browser about phase names. Use structured phases to eliminate heuristic bugs, but never present them as a security signal.

## Open questions / things I haven’t decided
I have not fully decided whether the PoC should stream full `PublicKeys` or the leaner `public_keys_hash + ivpk_m`. I would ship the leaner form first because it keeps the deploy flow smaller and acknowledges the real trust model.

I have not fully decided whether deploy UI should literally show only the address. I would make the address primary, but keep path and key fingerprint one tap away.

I have not fully decided whether to upstream a `DeployAccountMethod.buildSelfDeployExecutionPayload()` hook. For the PoC I would duplicate the small initializer and self-fee assembly locally; upstreaming can follow once the flow is validated.

## Disagreements with the obvious approach
I do not think “new `DEPLOY_ACCOUNT` verb in `CS_VERBS`” is the right abstraction. Deploy is not a selector-matched call; it is a reviewed deploy profile that happens to synthesize a fixed sponsor auth call.

I do not think “address-only display” is enough, even for a PoC, unless the address is full-length and accompanied by a key or path anchor.

I would not describe on-device recomputation as “malicious-host resistant”. Given host-owned protocol keys, it is fault resistant against drift, path mix-ups, and host/address mismatches, but not a complete hostile-host defense.