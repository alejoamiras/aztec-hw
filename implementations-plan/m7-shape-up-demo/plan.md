# M7 — Shape up the demo (consolidated plan)

**Status:** awaiting user approval. Consolidated from three parallel drafts:
- `plan-main.md` (in-process draft)
- `plan-codex.md` (codex @ xhigh, session `019e6b10-4f3b-7b62-8c20-da301568a4aa`)
- `plan-opus.md` (opus subagent)

**Tier:** A (cross-cutting: ledger-app + adapter + UI + protocol; UI-flow redesign).

```
[✓] 0. Clarifying questions
[✓] 1. Parallel plans (main + codex + opus)
[✓] 2. Consolidation + Security & adversarial section
[✓] 3. Final codex review — REJECT → 3 blockers + 3 majors + 2 minors fixed inline
[▶] 4. Approval gate (← we are here)
[ ] 5. Implementation
[ ] 6. Post-impl codex review
[ ] 7. Fix loop
```

**Codex audit findings + remediations** (full audit in `plan-codex-audit.md`):
- **BLOCKER #1** (wrong tx-request shape): §3.1 step 7-9 now distinguishes `DefaultMultiCallEntrypoint.wrapExecutionPayload` (merge) from `DefaultEntrypoint.createTxExecutionRequest` (final tx request).
- **BLOCKER #2** (overstated v0 security): §3.4 + §8.1 now correctly state that v0 does NOT defend against hostile-host privacy attacks; only signing-key/path binding + fault resistance. The prior "availability attack only" framing was wrong — host can deploy a valid account and retain IVPM visibility.
- **BLOCKER #3** (wrong deploy-hash math): §3.4 step 2 now correctly uses Noir ABI encoding (`[u8;32]` flattens elementwise → 64 Frs, not 2).
- **MAJOR #1** (BEGIN/FINALIZE desync): §3.3 now explicitly asserts the invariant: BEGIN commits all deploy semantics, FINALIZE adds only `claimed_outer_hash`.
- **MAJOR #2** (missing files): §11 now lists `provider.ts`, `apdu.ts`, `types.h`, `aztec_command_sender.py`, ragger tests, `auth-witness-provider.test.ts`.
- **MAJOR #3** (brittle NBGL test): Phase 3 now asserts home-menu screenshot labels + post-success `GET_PUBLIC_KEY` round-trip, not a wall-clock 500ms timer.
- **MAJOR #4** (Phase 3/4 split): wire layer (`apdu.ts` + `provider.ts`) folded into Phase 3 so ragger tests have the host counterpart they need.
- **MINOR #1** (phase-order assertion): now throws in dev/test, logs in production.
- **MINOR #2** (proveTx API): pinned to v4.2.1's positional form; senderForTags propagated via txRequest options at construction time per `prepareDeployOptions`.

---

## 1. Goal

Ship a demo that is (1) visually credible, (2) accurate about its on-screen progress reporting, and (3) honest about what the device is signing — no blind-sign for account deployment. The current demo achieves end-to-end deploy + drip + transfer on alpha-testnet (safe-v1 checkpoint `bdf2936`); this arc replaces the blind-sign deploy with a clear-signed flow, replaces the regex phase heuristic with structured emission, and polishes the visual layer.

---

## 2. Three locked work streams (final order: deploy → phases → polish)

Codex and opus both pushed back on ordering polish first. Polish ships **last** so it can't paper over the timeline bug. Order:

1. **Clear-sign account deployment.** New `deploy_profiles` manifest section (NOT a new CS_VERB entry). New device APDU set. Bypass `DeployAccountMethod` on the host. Builds on the existing L4 parity-pass-3 fault hardening + M6.11 NBGL dismissal pattern.
2. **Structured-step phase emission.** `onStep(phase, label)` replaces `onStep(label)`. Drop the regex inferrer in StatusBar. Deploy then participates in the unified 9-step pipeline (drip/transfer already there).
3. **CSS-in-place visual polish.** ~80 lines net diff, no shadcn migration. Type scale, neutral ramp, status bar shadow, phase-timeline connector bug, finite (not infinite) pulse, button feedback, address pill.

---

## 3. Architecture — clear-sign deployment

### 3.1 The critical blocker codex caught

`DeployAccountMethod.request()` (in `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:128-153`) goes through `AccountEntrypointMetaPaymentMethod.wrapFeePayload()` → `DefaultAccountEntrypoint.wrapExecutionPayload()` which calls `auth.createAuthWit(messageHash)` **during request assembly**. Therefore "intercepting `.send()` with a frozen witness" is too late. By the time `.send()` runs, blind-signing has already happened during `.request()`.

**Decision:** bypass `DeployAccountMethod` entirely. Build the deploy ExecutionPayload manually using the same primitives the framework uses:

1. Construct the initialization payload by mirroring `DeployMethod.getInitializationExecutionPayload()` with `skipClassPublication=true, skipInstancePublication=true` (`aztec-packages/yarn-project/aztec.js/src/contract/deploy_method.ts:517-529`).
2. Construct the inner sponsor-fee payload via `SponsoredFeePaymentMethod.getExecutionPayload()` (`aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:22-40`).
3. Choose a fresh `txNonce` host-side.
4. Run our clear-sign device APDU stream (§3.4) → obtain witness `W`.
5. Wrap the sponsor-fee payload via `DefaultAccountEntrypoint(this.address, new FrozenAuthWitnessProvider(W, outer_hash)).wrapExecutionPayload(...)` with `feePaymentMethodOptions: EXTERNAL, cancellable: false, txNonce`.
6. Merge in self-deploy order: `[deploymentInitPayload, wrappedSponsorPayload]`.
7. Wrap the merged payload through `DefaultMultiCallEntrypoint.wrapExecutionPayload(...)` — this gives us a single-call ExecutionPayload representing the self-paid multicall. **Do NOT use `DefaultMultiCallEntrypoint` to create the final tx request** (codex audit BLOCKER #1; ref `deploy_account_method.ts:140-153`, `default_multi_call_entrypoint.ts:17-38`).
8. Hand the single-call payload to `DefaultEntrypoint.createTxExecutionRequest(...)` (or the equivalent BaseWallet helper) to produce the final `TxExecutionRequest`. Ref `base_wallet.ts:174-176`, `default_entrypoint.ts:10-41`.
9. Prove via PXE. **v4.2.1 caveat:** the installed PXE has the positional signature `proveTx(txRequest, scopes: AztecAddress[])` (`node_modules/.bun/@aztec+pxe@4.2.1*/dest/pxe.d.ts:201`). The ProveTxOpts object form (`scopes` + `senderForTags`) ships in v4.3.0+ and we're deliberately pinned to v4.2.1 to avoid address-derivation drift. Therefore: `pxeClient.proveTx(txRequest, [this.address])`. The `senderForTags`-equivalent must be propagated through txRequest options at construction time — mirror `prepareDeployOptions` from `aztec-packages/yarn-project/aztec.js/src/wallet/deploy_account_method.ts:196-201` (injects `additionalScopes: [address]` and `sendMessagesAs: address` for NO_FROM).
10. Submit + wait, same as `runRecipe`.

The deploy flow then has **9 host-side phases** (matching drip/transfer), not 3, and not the 8-phase collapsed flow opus suggested.

### 3.2 Manifest extension — sibling `deploy_profiles` section

Codex is right: deploy is a profile, not a call verb. Adding `DEPLOY_ACCOUNT` to `CS_VERBS` would conflate two different lookup shapes. Instead:

```jsonc
// packages/adapter-ledger/clear-signing-v0/manifest.json
{
  "registry": [/* unchanged: 4 slots */],
  "verbs": [/* unchanged: 8 selector verbs */],
  "deploy_profiles": [
    {
      "id": "DEPLOY_ACCOUNT_ECDSAK_V1",
      "version": 1,
      "account_class_id": "0x1850bf05...e76327",   // EcdsaKAccount class pinned
      "ctor_selector_u32": "0x...",                 // pinned constructor selector
      "ctor_arg_schema": "ecdsa_k_pubkey_xy",       // [u8;32] x || [u8;32] y
      "deployer": "0x0000...0000",                   // ZERO for universal deploy
      "sponsor_fpc_address": "0x254082b6...181257",  // pinned SponsoredFPC instance
      "sponsor_selector_u32": "0x23d77f89",          // sponsor_unconditionally
      "fee_mode": "EXTERNAL"
    }
  ]
}
```

Codegen extension: emit `deploy_profiles.gen.{c,h}` (device) + `deploy_profiles.generated.ts` (host) alongside the existing `registry.gen.*` / `selectors.gen.*`. Cross-check that the pinned `account_class_id` matches `EcdsaKAccountContractArtifact`'s computed class id — fail closed at codegen on drift.

### 3.3 Device APDU set — two new instructions

Codex sketched three APDUs (BEGIN / SET_IVPK / FINALIZE). Opus sketched one (PROVIDE_DEPLOY_CONTEXT). Picking **two** as the right compromise:

```
INS_BEGIN_DEPLOY_ACCOUNT = 0x10   (133 + 32 = 165 B payload)
  manifest_version    : 1 B
  profile_id          : 1 B   (DEPLOY_ACCOUNT_ECDSAK_V1 = 0)
  curve_id            : 1 B   (= K1)
  path_scheme         : 1 B
  path_len            : 1 B
  path[]              : 4*path_len B
  chain_id            : 32 B  (Fr BE, canonical)
  protocol_version    : 32 B  (Fr BE, canonical)
  tx_nonce            : 32 B  (Fr BE, canonical)
  salt                : 32 B  (Fr BE, canonical)
  public_keys_hash    : 32 B  (Fr BE, canonical — see §3.5 on what this binds)
  expected_address    : 32 B  (Fr BE, canonical — UI-displayed and asserted)

INS_FINALIZE_DEPLOY_AND_SIGN = 0x11   (32 B payload)
  claimed_outer_hash  : 32 B  (Fr BE, canonical)
```

Why two not three: `ivpk_m` (the master incoming-viewing-public-key point) is only needed if the device implements the Grumpkin EC step. **We are NOT shipping Grumpkin scalar mult on device in this arc** (§3.5 decision), so the device doesn't need `ivpk_m`. If the production version (§7) lifts to full EC, add `INS_SET_DEPLOY_IVPK` then.

Trailing-byte rejection on both APDUs, mirroring `ledger-app/src/handler/begin_authwit.c:31-84`.

**5 new SWs:**
- `SW_UNKNOWN_PROFILE_ID = 0x6F0D`
- `SW_DEPLOY_ADDRESS_MISMATCH = 0x6F0E` (reserved, fires only when §7 Grumpkin lift lands)
- `SW_DEPLOY_PUBKEY_HASH_MISMATCH = 0x6F0F` (reserved, for §7 lift)
- `SW_DEPLOY_CONTEXT_TWICE = 0x6F10`
- `SW_DEPLOY_CONTEXT_WRONG_STATE = 0x6F11`

New L4 state machine extension: `L4_HEADER_PARSED → L4_DEPLOY_CONTEXT → L4_DEPLOY_FINALIZE`. Guard with profile-id allowlist + state assertion.

**Invariant (codex audit MAJOR #1):** BEGIN_DEPLOY_ACCOUNT carries **all** deploy semantics. FINALIZE_DEPLOY_AND_SIGN carries **only** `claimed_outer_hash` and adds NO new semantic data. The device's review screen renders from BEGIN data; FINALIZE only triggers the parity-recompute-and-sign sequence. This eliminates the "host changes its mind between BEGIN and FINALIZE" desync class.

### 3.4 Device recomputation — what gets verified

For v0 (this arc), the device verifies the **poseidon2 chain up to `partial_address`** and asserts internal consistency. It does NOT do the final Grumpkin EC step. Specifically:

1. Derive `(sx, sy)` from the BIP-32 path (existing `get_public_key.c`).
2. Construct constructor args by mirroring Noir ABI encoding (codex audit BLOCKER #3): `EcdsaKAccount::constructor` takes `[u8;32] x, [u8;32] y` (`packages/adapter-ledger/src/account-contract.ts:37-49`). Arrays flatten **elementwise** in the ABI encoder (`yarn-project/stdlib/src/abi/encoder.ts:24-33, 108-119`) — that produces **64 Frs** (one per byte), not 2 Frs. Then: `init_hash_local = poseidon2HashWithSeparator([ctor_selector_as_Fr, computeVarArgsHash(encoded_args_64_Frs)], DomainSeparator.INITIALIZER)`. Canonical path: `FunctionSelector.fromNameAndParameters` + `encodeArguments` + `computeVarArgsHash` exactly as `stdlib/src/contract/contract_address.ts:70-90` does.
3. `salted_init_local = poseidon2([salt, init_hash_local, ZERO_DEPLOYER], DomainSeparator.PARTIAL_ADDRESS)`.
4. `partial_addr_local = poseidon2([account_class_id, salted_init_local], DomainSeparator.PARTIAL_ADDRESS)`.
5. `preaddress_local = poseidon2([public_keys_hash_from_apdu, partial_addr_local], DomainSeparator.CONTRACT_ADDRESS_V1)` — computed but UNUSED for the address check in v0.
6. **Cannot compute** `address = ((preaddress * G) + ivpk_m).x` without Grumpkin EC. The device does NOT compare `expected_address` to a recomputed value — it just stores it for display.
7. Profile-id allowlist check: `profile_id ∈ {0}`. Else `SW_UNKNOWN_PROFILE_ID`.
8. 3-pass parity recompute of steps 1-5 mirroring `finalize_and_sign.c:80-117`.

**Synthesized canonical call list** (codex audit MAJOR #1): before `outer_hash` recomputation, the device synthesizes the fixed canonical call sequence the host has implicitly committed to — `[init call to (class_id, salt, ctor_selector, encoded_args, sender=NO_FROM), sponsor call to (FPC_address, sponsor_selector, args=∅, sender=expected_address)]`. The synthesized list is fully determined by BEGIN_DEPLOY payload + the pinned deploy profile; no extra semantic input from FINALIZE.

**What "address shown on device" means in v0** (codex audit BLOCKER #2 — corrected security claim): the device verifies binding from the BIP-32-derived signing pubkey + BIP-32 path + manifest-pinned account class + 3-pass fault recompute. It does NOT authenticate host-chosen protocol keys (`publicKeys`). Since `AccountManager.create()` derives `publicKeys` entirely from a host-side secret (`account_manager.ts:32-49`), and the final address depends on `public_keys_hash` and `ivpk_m` (`contract_address.ts:35-90`, `derivation.ts:46-62`), **a malicious host can deliberately pick a valid host-controlled key bundle and a matching `expected_address` — the deploy will prove and succeed on the rollup, and the host retains visibility into IVPM-encrypted notes**. v0 provides **signing-key/path binding and fault-resistance, NOT hostile-host address ownership verification**. If "hostile host" is in scope, `INS_GET_AZTEC_SECRET` (§7) must move into required scope.

This trust model is documented in the lessons log and the device-side `ui_display_deploy_review.c` header comment.

### 3.5 What the device displays (CONTESTED — see §8 decisions)

**LOCKED at approval gate** — address + path + fee-payer (no key fingerprint, no class label). User picked the consolidated middle option after codex + opus both rejected "address only":

```
Deploy your Aztec account?

Address:     0x014ca15c...547f2771       (8 leading + 6 trailing hex; 56 bits)
Path:        m/44'/0'/0'/0/0
Fee paid by: testnet sponsor

[Confirm with Both]   [Reject Left/Right]
```

The truncation is **8+6 hex chars** (56 bits ≈ 80 years brute-force) per the approval-gate decision — not full 64-char, not 6+4. Apply the same 8+6 convention to the host-side address pills for consistency.

### 3.6 Host injection — the prearm pattern done right

`LedgerEcdsaKAuthWitnessProvider.armDeploy(ctx, expectedOuterHash)` sets a one-shot deploy context flag. Then **we (the adapter), not the framework**, call `provider.createAuthWit(outerHash)` directly to trigger the L4-deploy APDU stream. The framework path is bypassed at step §3.1.4, so there's no double-signing risk that opus's pattern had.

```ts
// In aztec-ledger-session.ts:
async deployAccountClearSigned(opts: SubmitOptions = {}): Promise<SubmitResult> {
  const step = opts.onStep ?? (() => {});
  step('build', 'Building deploy initializer payload…');
  const initPayload = await this.buildSelfDeployInitPayload();

  step('build', 'Building sponsored fee payload…');
  const sponsorPayload = await this.buildSponsorFeePayload();

  step('build', 'Fetching chain info…');
  const chainInfo = await this.getChainInfo();
  const txNonce = Fr.random();

  step('sign', 'Awaiting deploy approval on device…');
  const deployCtx = await this.buildDeployContext(initPayload, sponsorPayload, chainInfo, txNonce);
  const outerHash = await computeOuterHashFromDeploy(deployCtx);
  await this.deps.ledgerProvider.armDeploy(deployCtx);
  const witness = await this.deps.ledgerProvider.createDeployAuthWit(outerHash);

  step('prove', 'Building tx request…');
  const frozen = new FrozenAuthWitnessProvider(witness, outerHash);
  const entrypoint = new DefaultAccountEntrypoint(this.address, frozen);
  const wrappedSponsor = await entrypoint.wrapExecutionPayload(sponsorPayload, /* opts */);
  const merged = mergeExecutionPayloads([initPayload, wrappedSponsor]);
  /* Codex audit BLOCKER #1: merge via DefaultMultiCallEntrypoint.wrapExecutionPayload(),
   * then build the final tx via DefaultEntrypoint.createTxExecutionRequest() —
   * NOT via DefaultMultiCallEntrypoint. See deploy_account_method.ts:140-153. */
  const singleCallPayload = await new DefaultMultiCallEntrypoint(...).wrapExecutionPayload(merged);
  const txRequest = await new DefaultEntrypoint(/* version+chainId */).createTxExecutionRequest(
    singleCallPayload, gasSettings, chainInfo,
    { cancellable: false, txNonce, feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL },
  );

  step('prove', 'Proving deploy tx (in-browser WASM)…');
  /* v4.2.1 PXE: positional (txRequest, scopes). The senderForTags equivalent
   * is propagated through txRequest options (sendMessagesAs / additionalScopes)
   * at construction time per prepareDeployOptions semantics. */
  const provenTx = await session.pxeClient.proveTx(txRequest, [this.address]);

  step('submit', `Submitting tx ${tx.getTxHash().slice(0, 10)}…`);
  await session.nodeClient.sendTx(await provenTx.toTx());

  step('include', 'Awaiting L2 inclusion…');
  const receipt = await waitForTx(session.nodeClient, txHash);

  step('done', 'Account deployed');
  return { txHash, receipt };
}
```

The blind-sign deploy path stays as a fallback (legacy export, not wired into UI) so the existing provider.test.ts SIGN_OUTER_HASH coverage keeps working.

---

## 4. Architecture — structured-step phase emission

### 4.1 Signature change

```ts
// packages/adapter-ledger/src/types.ts (new)
export type PhaseId = 'build' | 'sign' | 'prove' | 'submit' | 'include' | 'done';
export type SubmitStepHandler = (phase: PhaseId, label: string) => void;
```

```ts
// SubmitOptions in aztec-ledger-session.ts
export interface SubmitOptions {
  onStep?: SubmitStepHandler;
}
```

`SubmitStep` in `apps/demo-browser/src/state.ts` carries `{ phase, label, at }`. `inferPhaseIndex` and `activePhase` in `StatusBar.tsx` delete. Active phase = `state.steps.at(-1)?.phase ?? 'build'`.

### 4.2 Exhaustive emission map (after refactor)

**deployAccountClearSigned (9 emissions, NEW unified flow):**

| # | Phase | Label |
|---|-------|-------|
| 1 | build | `Building deploy initializer payload…` |
| 2 | build | `Building sponsored fee payload…` |
| 3 | build | `Fetching chain info…` |
| 4 | sign  | `Awaiting deploy approval on device…` |
| 5 | prove | `Building tx request…` |
| 6 | prove | `Proving deploy tx (in-browser WASM)…` |
| 7 | submit| `Submitting tx ${hash}…` |
| 8 | include| `Awaiting L2 inclusion…` |
| 9 | done  | `Account deployed` |

**dripUsdc (9 emissions, refactored from existing runRecipe):**

| # | Phase | Label |
|---|-------|-------|
| 1 | build | `Building drip payload…` |
| 2 | build | `Fetching chain info…` |
| 3 | build | `Projecting clear-sign intent…` |
| 4 | sign  | `Awaiting clear-signed approval on device…` |
| 5 | prove | `Signature received — building tx request…` |
| 6 | prove | `Proving tx (in-browser WASM)…` |
| 7 | submit| `Submitting tx ${hash}…` |
| 8 | include| `Awaiting L2 inclusion…` |
| 9 | done  | `Tx checkpointed` |

**transferUsdc{PubToPub,PrivToPub,PubToPriv,PrivToPriv} (9 emissions, shape identical to drip):**

Only label 1 varies: `Building transfer ${mode} payload…`. Phase sequence identical.

### 4.3 Monotonic phase-order assertion

In the UI reducer when applying a step: if `nextPhase`'s index < `prevPhase`'s index, **throw** in dev/test (codex audit MINOR #1 — phase regression is a state-machine bug, not a soft warning); log in production builds. Not a security control — a fast-feedback test for adapter bugs. Wire a Vitest unit test that drives the reducer with a backwards phase and asserts it throws.

### 4.4 Anti-forging note

`onStep` is fired only from the adapter. The browser UI never injects synthetic phases. Document this invariant in `SubmitOptions`'s TSDoc. Long-term tightening (out of scope for v0): replace closure callback with a typed MessagePort so a browser extension can't interpose.

---

## 5. CSS polish targets (≤80 lines net diff)

Lifted from opus's plan with minor tweaks. Specific targets:

### 5.1 Type + neutral ramp (`style.css:3-16`)
- Base font 14px → 15px.
- `h1` 1.4rem → 1.65rem (don't compete with status-bar primary).
- `h2` 1rem → 0.78rem + weight 600 (reads as section marker).
- Drop `'SF Mono'` (Apple-only) from mono stack.
- Token expansion: add `--bg-elev-1`, `--bg-elev-2`, `--fg-strong`, `--fg-muted`, `--fg-subtle`. Promote `rgba(124,92,255,0.18)` to `--accent-soft`.

### 5.2 Status bar (`style.css:36-105`)
- Padding 0.85→1rem vertical, 1→1.25rem horizontal.
- `box-shadow: 0 1px 2px rgba(0,0,0,0.2)` so it visually lifts above panels.
- Badge: +3px horizontal padding (currently claustrophobic).

### 5.3 Phase timeline (`style.css:107-200`)
- **Connector bug fix:** `left: 60%; right: -40%` overshoots the last cell on narrow viewports. Use `left: calc(50% + 0.85rem); right: calc(-50% + 0.85rem)` so connectors always meet the next marker's center.
- **Finite pulse:** the active-phase animation is infinite (`animation: phase-pulse 1.4s ease-in-out infinite`). Change to 3 cycles then settle (`infinite` → `3`). Infinite pulses on signing screens are a phishing pattern — never use them.
- Add `aria-current="step"` on the active `<li>`.

### 5.4 Panel + button polish
- Border-radius 8→10px.
- `.panel.disabled` opacity 0.45→0.55 (currently can't read the address).
- `transition: opacity 120ms` on panels.
- Button press feedback: `box-shadow: 0 1px 0 rgba(0,0,0,0.2)` + `:active { transform: translateY(1px) }`.
- Disabled button opacity 0.6 — different from "wrong state".

### 5.5 Address rendering
- `word-break: break-all` → `overflow-wrap: anywhere` (better hex line-breaking).
- Address pill: monospace, copy-on-click icon (button, not anchor — accessibility).

### 5.6 Speculos aside polish (lower priority)
- Visual: device console treatment, not generic card. Subtle scanline / monospace background.
- Stays sticky on the right (existing).

### 5.7 What NOT to add (anti-phishing discipline)
- No host-side "✓ Verified" badges or checkmarks. The device screen is the only authoritative surface. A polished demo could be cloned into a phishing site; never add UI elements that suggest the host is authoritative.

---

## 6. Sequencing

Plan-final order with verifiable exit criteria:

**Phase 1 — Structured phases (smallest, unblocks UX tests):**
- Define `PhaseId` + `SubmitStepHandler` + updated `SubmitStep`.
- Refactor every `onStep('…')` call site in `aztec-ledger-session.ts` to `onStep('phase', '…')`.
- Drop the regex inferrer from StatusBar.
- Exit: dev server, click Deploy, timeline shows Build/Sign correctly (still blind-sign at this point — Phase 1 doesn't touch the device).

**Phase 2 — Manifest + codegen for deploy profile + class allowlist:**
- Add `deploy_profiles` section to `manifest.json`.
- Extend gen script — emit `deploy_profiles.gen.{c,h}` + `deploy_profiles.generated.ts`.
- Class-id cross-check from `EcdsaKAccountContractArtifact` — fail closed at codegen.
- Exit: `bun run packages/adapter-ledger/scripts/gen-clear-signing-v0.ts --check` passes; class id pinned.

**Phase 3 — Wire protocol + device deploy clear-signing** (codex audit MAJOR #4: bundle the wire layer in with the device work since provider tests need both):
- New SWs in `ledger-app/src/sw.h`.
- New L4 state: `L4_DEPLOY_CONTEXT`, `L4_DEPLOY_FINALIZE`.
- New `DeployContext` struct in `ledger-app/src/types.h`.
- `INS_BEGIN_DEPLOY_ACCOUNT` handler: parse, validate, allowlist check, 3-pass parity recompute (poseidon2 chain + Noir-ABI [u8;32] flatten encoding), store context.
- `INS_FINALIZE_DEPLOY_AND_SIGN` handler: receive `claimed_outer_hash`, recompute, sign with parity-pass-3 hardening.
- New `ui_display_deploy_review.c` using `nbgl_useCaseReview(TYPE_TRANSACTION, ...)`.
- Ship `nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main)` dismissal from commit zero.
- Host wire layer: `packages/adapter-ledger/src/apdu.ts` — INS_BEGIN_DEPLOY_ACCOUNT=0x10 + INS_FINALIZE_DEPLOY_AND_SIGN=0x11 + payload encoders.
- Host wire layer: `packages/adapter-ledger/src/provider.ts` — new APDU calls + new SW handling.
- Ragger tests: `test_deploy_clear_sign.py` covering OK / user-reject / unknown-profile / wrong-state.
- NBGL dismissal regression test (codex audit MAJOR #3): assert post-success screenshot shows the **home menu labels**, then immediately send GET_PUBLIC_KEY; expect a successful APDU round-trip with NO required UI cleanup. Avoids both the false-fail on slow CI and false-pass on a brief flicker that a wall-clock timer would suffer.
- Exit: ragger tests green; `provider.test.ts` exercises the deploy SWs against the new device.

**Phase 4 — Host deploy builder:**
- `LedgerEcdsaKAuthWitnessProvider.armDeploy()` + `createDeployAuthWit()`.
- `aztec-ledger-session.ts::deployAccountClearSigned()` building the payload manually (§3.1).
- `aztec-ledger-session.ts::deployAccount()` becomes a thin wrapper that calls the clear-signed path.
- Smoke test on alpha-testnet: deploy account, observe device review surface shows address.
- Exit: end-to-end deploy clear-signed flow works against alpha-testnet.

**Phase 5 — Remaining transfer modes (M6.13 carryover):**
- Wire pub→priv / priv→pub / priv→priv UI buttons in TransferPanel.
- With M6.12 selector fix in place, smoke test all four modes.
- Exit: all 4 transfer modes succeed end-to-end on alpha-testnet.

**Phase 6 — CSS polish (≤80 lines net diff):**
- Apply §5 targets.
- Visual diff against baseline.
- Playwright DOM stability check.
- Exit: no visual regressions in existing flows.

**Phase 7 — Final codex review + fix loop:**
- Submit full diff to codex at `xhigh` for adversarial review.
- Triage findings, fix real ones.
- Exit: codex blockers closed.

**Estimated effort:** ~7 working days with no Grumpkin EC lift, no `INS_GET_AZTEC_SECRET` (deferred to §7).

---

## 7. Deferred to a follow-up arc (M8)

These are surfaced explicitly by codex/opus but deliberately out of scope:

1. **Grumpkin scalar mult on device.** Would let the device do the FINAL EC step and cryptographically verify the full address. Significant — write Grumpkin field arithmetic from scratch in C, lift ~2 weeks. Reserve as M8.
2. **`INS_GET_AZTEC_SECRET` (BIP32-derived protocol secret).** Replaces host-side `Fr.random()` for `secret`, eliminates the chicken-and-egg in publicKeys-host-control. Opus pushed strongly. Real production design, ~1 week. Reserve as M8.
3. **Independent crypto oracle.** Both codex and opus flagged: a shared poseidon2 bug across host TS and device C silently survives if golden vectors are same-repo. Need at least one barretenberg or Noir-derived vector set + firmware unit tests. Reserve as M8.
4. **Typed MessagePort for `onStep`.** Replaces the closure callback so a browser extension can't interpose. Tightening, not a v0 requirement.
5. **Account-class-id allowlist for v2 account contracts.** Manifest-pinned. Out of scope for one-class-only v0.

---

## 8. Security & Adversarial Considerations

### 8.1 Address spoofing (corrected per codex audit BLOCKER #2)
**v0 anchor:** device verifies poseidon2 chain up to `partial_address`. Cannot do final EC step. Therefore device shows host-supplied `expected_address` and verifies internal consistency, not strict address binding.
**Honest claim:** v0 provides **signing-key/path binding + manifest-pinned class + fault-resistance**. It does NOT provide **hostile-host address ownership verification**. Since `AccountManager.create()` derives `publicKeys` from a host-side secret (`account_manager.ts:32-49`), a malicious host can pick a valid host-controlled key bundle and a matching `expected_address` — the deploy proves and succeeds, the user thinks they own it, the host retains IVPM visibility into incoming notes. This is a **privacy/visibility attack the user authorized unknowingly**, not an availability attack. The prior plan called this "availability only"; that was wrong.
**v1 anchor (deferred to M8):** `INS_GET_AZTEC_SECRET` (BIP-32-derived protocol secret) + Grumpkin scalar mult on device → full cryptographic binding. If "hostile host" must be in scope, these move out of §7.

### 8.2 Pubkey-swap
**Mitigation:** device's BIP32-derived pubkey is the ONLY source for `init_hash`. Device IGNORES any host-supplied signing pubkey. **High confidence.**

### 8.3 Path mis-selection (the cheaper attack)
**Codex's point:** an attacker who can suggest a BIP32 path (e.g. via a malicious dApp) can pick a path the user wouldn't notice and produce an account at a different address than expected.
**Mitigation:** display the **full BIP32 path** on the deploy review screen. The current blind-sign UI already displays the path (`ledger-app/src/ui/sign_ui.c:57-82`); preserve that.

### 8.4 Salt vanity brute force
**The math:** 6+4 hex truncation = 40 bits ≈ 17 minutes at 10⁹ poseidon2/sec on commodity hardware.
**Locked mitigation (approval gate):** 8+6 hex truncation (56 bits ≈ 80 years). Apply consistently across device review screen and host-side address pills.

### 8.5 Class id spoofing
**Mitigation:** profile-id allowlist on device (`profile_id ∈ {DEPLOY_ACCOUNT_ECDSAK_V1}`). Class id pinned in manifest, cross-checked at codegen.

### 8.6 outer_hash mismatch
**Mitigation:** existing 3-pass parity recompute around the review screen. Adapt to deploy flow.

### 8.7 TOCTOU between recomputation and signing
**Mitigation:** sign the locally-recomputed `outer_hash` (stack), not the mutable session value. Mirror `finalize_and_sign.c:141-148`.

### 8.8 NBGL dismissal regression
**Mitigation:** ship `nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main)` from commit zero. Add ragger regression test: device on main menu within 500ms of success APDU. **Without this test, this will regress.** M6.11 was a real bug; don't ship the new verb with the same one.

### 8.9 Phase forging
**Mitigation:** `phase` is a typed enum; non-enum value = TS compile error. `label` rendered via React text node (no `dangerouslySetInnerHTML`). Documented invariant: `onStep` fires only inside the adapter.

### 8.10 Visual phishing
**Mitigation:** polished CSS MUST NOT add host-rendered "verified" indicators. No checkmarks, no badges. Device screen remains the authoritative surface. Codex + opus both flagged.

### 8.11 Shared crypto bug across host TS + device C
**Mitigation (deferred to M8):** independent oracle. v0 still uses same-repo golden vectors; flag the gap.

### 8.12 Sponsor fee display
**Opus's add:** the deploy review should explicitly say `Fee paid by: testnet sponsor`. Without it, the user can't tell who's paying — relevant for an Aztec-Foundation demo audience.

---

## 9. Locked decisions (approval gate)

User explicitly confirmed at approval gate, post codex+opus pushback:

**A. Device review fields:** address + path + fee-payer. No key fingerprint, no class label.

**B. Address truncation:** 8+6 hex chars (56 bits) everywhere — device review AND host-side address pills.

**C. Grumpkin scalar mult on device:** deferred to M8.

**D. INS_GET_AZTEC_SECRET:** deferred to M8.

v0 ships with the honest "signing-key + path binding + manifest-pinned class + fault resistance, NOT hostile-host privacy" framing. The privacy gap (host-controlled publicKeys → host retains IVPM visibility into incoming notes) is documented in §8.1, in the device-side `ui_display_deploy_review.c` header comment, and in `lessons/phase-N.md`. Closing it is the M8 arc.

---

## 10. Open questions (post-approval, pre-implementation)

1. **Sponsor fee display copy:** "Fee paid by: testnet sponsor" vs "Sponsored by: SponsoredFPC" vs literal address? Opinion: human-readable label.
2. **Deploy review animation:** show a brief "Deriving address…" state before the review screen renders? Or open straight to the review? Opinion: straight to review, no animation theatre.

---

## 11. Files we'll touch

```
ledger-app/
├── src/handler/begin_deploy.{c,h}            NEW
├── src/handler/finalize_deploy.{c,h}         NEW
├── src/ui/deploy_review_ui.{c,h}             NEW
├── src/l4/deploy_address.{c,h}               NEW (poseidon2 chain + Noir-ABI [u8;32] flatten encoding)
├── src/clear_signing_v0/deploy_profiles.gen.{c,h}   NEW
├── src/clear_signing_v0/registry.gen.{c,h}   UNCHANGED (verbs only)
├── src/sw.h                                  UPDATE (5 new SWs)
├── src/types.h                               UPDATE (DeployContext struct; codex audit MAJOR #2)
├── src/apdu/dispatcher.c                     UPDATE (route 0x10 + 0x11)
└── src/l4/session.{c,h}                      UPDATE (new states)

ledger-app/tests/
├── application_client/aztec_command_sender.py    UPDATE (deploy APDU helpers; codex audit MAJOR #2)
├── test_deploy_clear_sign.py                 NEW (ragger E2E: OK / user-reject / unknown-profile / wrong-state)
└── test_nbgl_dismissal_regression.py         NEW (codex audit MAJOR #3: home-menu label assertion + post-success GET_PUBLIC_KEY round-trip)

packages/adapter-ledger/
├── clear-signing-v0/manifest.json            UPDATE (deploy_profiles)
├── scripts/gen-clear-signing-v0.ts           UPDATE (emit deploy_profiles)
├── src/types.ts                              NEW (PhaseId, SubmitStepHandler)
├── src/apdu.ts                               UPDATE (INS_BEGIN_DEPLOY_ACCOUNT=0x10 / INS_FINALIZE_DEPLOY_AND_SIGN=0x11 + payload encoders; codex audit MAJOR #2)
├── src/provider.ts                           UPDATE (deploy APDU calls + new SW handling; codex audit MAJOR #2)
├── src/auth-witness-provider.ts              UPDATE (armDeploy, createDeployAuthWit)
├── src/auth-witness-provider.test.ts         UPDATE (deploy witness branching; codex audit MAJOR #2)
├── src/aztec-ledger-session.ts               UPDATE (deployAccountClearSigned, structured onStep)
├── src/clear_signing_v0/deploy_profiles.generated.ts   NEW
└── src/provider.test.ts                      UPDATE (deploy SW tests + dismissal regression)

apps/demo-browser/
├── src/state.ts                              UPDATE (SubmitStep carries phase)
├── src/panels/StatusBar.tsx                  REWRITE (drop regex)
├── src/panels/AccountPanel.tsx               UPDATE (structured callback, calls deployAccountClearSigned)
├── src/panels/TransferPanel.tsx              UPDATE (wire 3 missing modes + structured callback)
└── src/style.css                             POLISH (~80 lines net diff)

implementations-plan/m7-shape-up-demo/
├── plan.md                                   THIS FILE
├── plan-main.md, plan-codex.md, plan-opus.md FROZEN (source plans)
├── plan-codex-audit.md                       FORTHCOMING (final codex review)
├── eli5.html                                 FORTHCOMING
└── lessons/phase-N.md                        FORTHCOMING (per-phase)
```

---

## 12. Deliverables

- 5 new device handlers + UI + L4 state + new SWs, all with parity-pass-3 hardening
- New manifest section + codegen
- New host method + provider extension
- Structured-step refactor across adapter + UI
- CSS polish ≤80 lines net diff
- All 4 transfer modes wired
- ELI5 HTML companion
- Per-phase lessons logs
- Updated `implementations-plan/index.md`
- All work behind `bun run lint:all && bun test` clean

---

## 13. Acknowledged limitations (v0)

- Device cannot perform Grumpkin EC; final address step is not cryptographically verified on-device. Deferred to M8.
- Host-side `Fr.random()` for `secret` means `publicKeys` is host-controlled. Deferred to M8.
- Same-repo golden vectors for poseidon2; no independent oracle. Deferred to M8.

These limitations are documented in the device-side `ui_display_deploy_review.c` header comment and in `lessons/phase-N.md`.
