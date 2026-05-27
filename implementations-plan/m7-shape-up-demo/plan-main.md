# M7 — Shape up the demo

**Status:** drafting (Tier A, parallel main + codex + opus)
**Owner:** main draft
**Goal:** ship a demo that's (1) visually credible, (2) accurate in its on-screen progress reporting, and (3) honest about what the device is signing — no blind-signing for account deployment.

## 0. Success criteria

- [ ] Account deployment is clear-signed on the device. The device screen shows the **new account address** (truncated) and the user explicitly approves it. Host cannot lie about which address gets deployed — device recomputes from signing pubkey + salt + class id.
- [ ] Status header timeline reflects the **actual** progress of the tx, not a string-parsed heuristic. When the user clicks Deploy and the device is waiting for approval, the header says "Sign" — not "Submit".
- [ ] Visual quality: spacing, color, typography, motion, info hierarchy all tightened. The user shouldn't think "amateur" when they look at it. Polished vanilla CSS, no shadcn port (per user choice).
- [ ] All four transfer modes work end-to-end on alpha-testnet (M6.13 carries over).
- [ ] No regressions in existing 100-test suite; provider integration tests still 6/6 against rebuilt elf.
- [ ] All work logged in `lessons/phase-N.md`. Index updated.

## 1. Scope (three locked work streams)

### A. Clear-sign account deployment (largest piece)

Replaces the current `BaseWallet.sendTx`-via-blind-sign path with a recipe that mirrors `submitClearSignedIntent`: pre-sign on-device with a structured DEPLOY review screen, inject the witness via a `FrozenAuthWitnessProvider`, then let the framework submit.

**New device verb:** `DEPLOY_ACCOUNT` (manifest-driven, in the same registry/selector pipeline as transfer verbs).

**Device APDU payload:** `claimed_address(32B) || class_id(32B) || salt(32B) || outer_hash(32B)`. Signing pubkey is **not transmitted** — the device re-derives it from the user's BIP32 path. That's the cryptographic anchor: even if the host lies about address/salt/class_id, the device can independently recompute the address using the BIP32-derived pubkey and assert against `claimed_address`. Mismatch → SW_DEPLOY_ADDRESS_MISMATCH, hard-reject.

**Device UI (NBGL review screen):**
```
Deploy your Aztec account?

Address:  0x014ca15c...547f2771
          (truncated; full hash signed below)

[Confirm with Both]   [Reject with Left/Right]
```

The display deliberately keeps it minimal — user picked address-only. The pubkey/salt/class-id are still verified internally (parity-pass-3 style fault hardening) but not shown.

**Host side:**
1. New `aztec-ledger-session.ts::deployAccountClearSigned(opts)` method.
2. New `auth-witness-provider.ts::createDeployAuthWit(claimedAddress, classId, salt)` method.
3. Reuse `FrozenAuthWitnessProvider` infrastructure — same shape, just a different intent kind.
4. `AccountManager` registered with the frozen provider; framework's deploy path proceeds with a witness it can't tell apart from a fresh AuthWitnessProvider.

**Why this is the security-honest path:** the device's BIP32-derived pubkey is the SINGLE input the device fully controls. By making the address claim provable from that anchor + the other fields, the user trust collapses to: "Does my device show the address I expect?" If the host lies about salt, the device-derived address won't match the host's claim → reject. If the host lies about the class id, same. If the host lies about the address, same.

### B. Structured-step phase emission (the timeline-accuracy fix)

Replace `(label: string) => void` step callback with `(phase: PhaseId, sublabel?: string) => void`.

**Phase IDs (canonical):**
- `'build'` — Composing call payload (host-only)
- `'sign'` — Awaiting approval on device
- `'prove'` — Generating ClientIVC proof (in-browser WASM)
- `'submit'` — Sending tx to the node
- `'include'` — Waiting for L2 block inclusion (CHECKPOINTED)
- `'done'` — Tx checkpointed

**Per-action emission map (after refactor):**

```
deployAccount (clear-signed, NEW):
  build   → "Composing deploy payload"
  build   → "Projecting DEPLOY intent"
  sign    → "Awaiting deploy approval on device"
  sign    → "Signature received"
  build   → "Building tx request"        ← transient, falls back to last seen phase
  prove   → "Generating ClientIVC proof"
  submit  → "Sending tx {0x...}"
  include → "Awaiting L2 inclusion"
  done    → "Account deployed"

dripUsdc / transferUsdc (existing, refactored):
  build   → "Composing {drip|transfer-X} payload"
  build   → "Fetching chain info"
  build   → "Projecting CallIntent"
  sign    → "Awaiting clear-signed approval on device"
  sign    → "Signature received"
  build   → "Building tx request"
  prove   → "Generating ClientIVC proof"
  submit  → "Sending tx {0x...}"
  include → "Awaiting L2 inclusion"
  done    → "Tx checkpointed"
```

**StatusBar refactor:** ditch the regex inferrer. `state.steps[].phase` is now an enum, the active phase is `last(state.steps).phase`. Sub-labels render under the timeline as the live caption. Phase ordering enforced by the canonical list — out-of-order emissions are a programming error and would surface in dev as a console.error.

### C. CSS-in-place visual polish

User chose this over shadcn port. Areas to tighten:

1. **Typography scale**: pick a sane modular scale (e.g. 0.75 / 0.875 / 1 / 1.125 / 1.5 / 2 rem) and apply consistently. Currently the font-sizes are ad-hoc.
2. **Spacing scale**: 4px base unit (0.25rem). All gaps/padding/margins as multiples.
3. **Color tokens**: refine the existing dark palette. Borders + muted text are currently a bit washed; primary accent could be punchier. Keep dark mode only (user didn't ask for light).
4. **Card hierarchy**: panels currently look identical. Differentiate primary action panels (Account/Transfer) from utility panels (Speculos/Status) — slight border-color or background-tint variation.
5. **Buttons**: clearer disabled/hover/active states. Loading state with a small spinner glyph next to the label, not just text change.
6. **Phase timeline**: refine the pulse animation (currently 1.4s, may feel slow). Add a subtle background gradient on the active phase marker. Connector line should grow from done-phase to active-phase rather than being statically grey.
7. **Address rendering**: monospace, copy-on-click affordance (small "copy" icon).
8. **Status bar polish**: shouldn't take 4 lines of vertical space when idle. Compact mode for idle/ready states.
9. **Motion**: subtle 120ms transitions on state changes (button disabled→enabled, phase pending→active). Currently abrupt.
10. **Empty/error states**: clearer iconography (`!`, `?`, `…`) without going emoji-heavy. Aztec brand is restrained, not playful.

NOT in scope (per user):
- shadcn/ui port
- Tailwind migration
- Custom illustrations / iconography library
- Light mode

## 2. Sequencing

**Phase 1 — Structured phases** (smallest, unblocks A's timeline integration):
1. Define `PhaseId` enum + `SubmitStep { phase, label, at }` in `state.ts`
2. Refactor `SubmitOptions.onStep` to `(phase: PhaseId, label: string) => void`
3. Update every `step('…')` call site in `aztec-ledger-session.ts` to `step('phase', '…')`
4. Update `StatusBar.tsx`: drop the regex, read `phase` directly
5. Update `AccountPanel.tsx` / `TransferPanel.tsx`: same callback shape
6. Test: spin up dev server, click Deploy, verify timeline doesn't jump

**Phase 2 — DEPLOY_ACCOUNT verb (device-side)**:
1. Add `DEPLOY_ACCOUNT` entry to `clear-signing-v0/manifest.json`
2. Extend the registry kind enum: add `'DEPLOY'`
3. Extend gen script: handle non-token, non-dripper, non-FPC verbs (DEPLOY has no contract address — it IS the deployment target)
4. Device handler: new APDU opcode `INS_REVIEW_DEPLOY`, struct `DeployReviewPayload { claimed_address, class_id, salt, outer_hash }`
5. Device address-recomputation: poseidon2 chain mirroring `computeContractAddressFromInstance`, returning a 32B Fr value
6. Device UI: new `ui_display_deploy_review.c` calling `nbgl_useCaseReview(TYPE_TRANSACTION, ...)` with the address pair_list
7. Device finalization: `finalize_deploy_after_approval` signing outer_hash with the parity-pass-3 hardening
8. Provider tests: add SIGN_DEPLOY_OK + SIGN_DEPLOY_USER_REJECT + SIGN_DEPLOY_ADDRESS_MISMATCH tests (Speculos roundtrip)
9. Rebuild elf, regenerate registry, validate provider tests still green

**Phase 3 — DEPLOY_ACCOUNT verb (host-side)**:
1. New `createDeployAuthWit(claimedAddress, classId, salt, outerHash)` in `auth-witness-provider.ts`
2. New `deployAccountClearSigned()` method in `aztec-ledger-session.ts`:
   - Get deploy method via `accountManager.getDeployMethod()`
   - Pre-build the deploy tx request WITHOUT calling `.send()`
   - Extract the outer_hash from the tx
   - Send DEPLOY APDU to device via `createDeployAuthWit`
   - Wrap witness in `FrozenAuthWitnessProvider`
   - Inject into account manager / framework, call `.send()`
3. Wire `AccountPanel.tsx` to call the new method
4. Smoke test on alpha-testnet end-to-end

**Phase 4 — CSS polish**:
1. Pull the design tokens out of `:root` into a more organized `@layer` (or comment-grouped) block
2. Apply the typography + spacing scales consistently
3. Refine the status bar visual hierarchy
4. Polish the phase timeline (gradient + grow-line connector)
5. Button loading states + copy-on-click address
6. Compact idle/ready status bar

**Phase 5 — Remaining transfer modes (M6.13 carryover)**:
1. Wire pub→priv / priv→pub / priv→priv UI buttons in TransferPanel
2. With correct selectors now in registry, smoke test all four modes
3. Add `describe.skipIf(!ENV_VAR)` Playwright spec covering all four modes

**Phase 6 — Validation**:
1. Run full `bun run lint:all && bun test` suite
2. Manual E2E on alpha-testnet for all flows (deploy clear-signed, drip, all 4 transfers)
3. Demo dry-run with screen recording

## 3. Files we'll touch (locality map)

```
ledger-app/
├── src/handler/
│   ├── review_deploy.c          NEW
│   ├── review_deploy.h          NEW
│   ├── finalize_deploy.c        NEW (or merged into finalize_and_sign.c)
│   └── finalize_deploy.h        NEW
├── src/ui/
│   └── deploy_review_ui.c       NEW
├── src/l4/
│   └── deploy_address.c         NEW (poseidon2 address recomputation)
├── src/clear_signing_v0/
│   ├── registry.gen.{c,h}       REGEN
│   └── selectors.gen.{c,h}      REGEN
├── src/                         (sw.h add SW_DEPLOY_ADDRESS_MISMATCH)
├── src/apdu/dispatcher.c        (route INS_REVIEW_DEPLOY)
└── Makefile                     (probably no change)

packages/adapter-ledger/
├── clear-signing-v0/manifest.json    UPDATE (add DEPLOY_ACCOUNT)
├── scripts/gen-clear-signing-v0.ts   UPDATE (handle DEPLOY kind)
├── src/
│   ├── auth-witness-provider.ts      UPDATE (createDeployAuthWit)
│   ├── aztec-ledger-session.ts       UPDATE (deployAccountClearSigned)
│   ├── clear_signing_v0/
│   │   ├── selectors.generated.ts    REGEN
│   │   └── registry.generated.ts     REGEN
│   └── speculos-transport.ts         (no change)

apps/demo-browser/
├── src/state.ts                   UPDATE (PhaseId, structured SubmitStep)
├── src/panels/StatusBar.tsx       REWRITE (drop regex, structured phase)
├── src/panels/AccountPanel.tsx    UPDATE (call deployAccountClearSigned, structured callback)
├── src/panels/TransferPanel.tsx   UPDATE (wire 3 missing modes + structured callback)
└── src/style.css                  POLISH (typography, spacing, motion, hierarchy)

implementations-plan/m7-shape-up-demo/
├── plan-main.md                   THIS FILE
├── plan-codex.md                  parallel
├── plan-opus.md                   parallel
├── plan.md                        consolidated final
├── eli5.html                      ELI5 companion
└── lessons/phase-N.md             per-phase logs
```

## 4. Security & Adversarial Considerations

### Threat model

The user is willingly using their laptop + browser to drive a hardware wallet. The browser is partially trusted (they chose to load our app). The Ledger device is the trust anchor — it must independently verify everything it shows.

### Per-component adversarial review

**DEPLOY_ACCOUNT verb (the new attack surface):**

- **Address spoofing.** Host crafts `claimed_address` that doesn't match the salt + class_id + pubkey it sends. Mitigation: device recomputes address from inputs (BIP32-derived pubkey + host-supplied salt + class_id) and asserts equal to `claimed_address`. Fail-closed → SW_DEPLOY_ADDRESS_MISMATCH.
- **Pubkey swap.** Host claims a different signing pubkey than the device would derive at this BIP32 path. Mitigation: device IGNORES any host-supplied pubkey and always uses its BIP32-derived value in the recomputation. Net result: the address shown to the user is bound to THEIR seed, not the host's choice.
- **Salt rotation attack.** Host pre-generates many salts to find one producing a "vanity" address that looks like a legitimate one (e.g. matches a phishing target's address). Mitigation: short address truncation (6 leading + 4 trailing hex chars) gives ~40 bits of search space. That's brute-forceable in seconds. Future hardening: deterministic salt from device-derived path (out of scope for v0; flag in lessons).
- **Class id spoofing.** Host claims a different account contract class than EcdsaKAccount. Mitigation: device manifests pin the allowed class id(s); deploys to other class ids reject as SW_DEPLOY_UNKNOWN_CLASS. v0 ships with one allowed class id; future versions extend.
- **Outer_hash mismatch.** Host signs an outer_hash that doesn't correspond to the deploy tx the user thinks they're signing. Mitigation: the FrozenAuthWitnessProvider's hash-asserted shape catches this — framework's recomputed outer_hash MUST match what was pre-signed, else FrozenWitnessMismatchError.
- **Race conditions / TOCTOU.** Adapt the parity-pass-3 hardening from finalize_and_sign.c: recompute address THREE TIMES around the sign step, fail on any mismatch. Same fault-injection defense.
- **NBGL dismissal.** Apply the M6.11 fix from day one — call `nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main)` after the success response. Don't ship the deploy verb with the same regression.

**Structured-step phase emission:**

- **Phase forging.** If the adapter has a bug where it emits a stale or out-of-order phase, the UI shows a misleading state. Mitigation: phase ordering enforced canonically; out-of-order emissions log a dev console.error. Not a security vuln (no privileged action taken from phase), but a credibility one.
- **Sub-label injection.** Step labels are user-displayable strings; an attacker who could control them via tx data would be a problem. Mitigation: step labels are emitted by adapter code with hardcoded strings + safe interpolation (tx hash truncation), not from any external input. Document this invariant in the SubmitOptions type doc.

**CSS polish:**

- **Visual phishing.** A polished demo could be screenshotted and reused for phishing. Mitigation: out of scope for v0; the demo isn't production. Flag in lessons.

### Cross-cutting

- **Supply chain.** Stick with the 7-day npm min-age. No new dependencies introduced in this arc (CSS polish is in-tree). 
- **Least privilege.** No new privileged operations on device or host. The new APDU is signing-only, no key export.
- **Cryptography.** Reusing established primitives (poseidon2 for address derivation, ECDSA-K1 for signing). No new crypto.
- **Replay / domain separation.** Deploy intents are domain-separated by including `txNonce` (random per session) in the outer_hash composition — same defense as transfer outer_hashes.

### Adversarial questions for codex/opus to chew on

1. Is "address-only display" enough for user trust? Should we also show a truncated pubkey fingerprint?
2. What's the right error UX when SW_DEPLOY_ADDRESS_MISMATCH fires? Host bug vs attack — user can't tell.
3. Is the FrozenAuthWitnessProvider lifecycle correct for deploy? It's used per-tx in clear-signed flows; deploy is also per-tx but goes through `AccountManager.deploy()` rather than `BaseWallet.sendTx`. Are the witness lookup keys compatible?
4. If we wire a per-call review for the SUB-CALLS of the deploy multicall (the protocol's auto-injected class registration + account init), is that a UX gain (max transparency) or loss (too many clicks)?
5. Are there any pubkey/salt/class_id values that could trigger device-side undefined behavior in the poseidon2 chain (e.g. non-canonical Fr)? Need to add canonicality checks.

## 5. Open questions (pre-implementation)

- Should the device's address truncation match the host's? (User comparison — pixel-perfect parity matters.)
- Does AccountManager support injecting a FrozenAuthWitnessProvider into `getDeployMethod()`? If not, we may need to bypass AccountManager and build the deploy tx request manually (similar to how runRecipe bypasses BaseWallet.sendTx). Codex needs to dig into AccountManager source.
- What's the user's expectation on the M6.13 transfer modes — same blind-sign-with-address-display? They're already clear-signed (drip pattern), just need UI wiring.
- For the visual polish: should we add a "tx receipt" success animation when an action completes (current is text-only)? Subtle enough to feel polished but not gimmicky.

## 6. Deliverables

- New device elf + tests
- New adapter methods + generated manifest
- New UI with structured timeline + polished CSS
- ELI5 HTML companion (`eli5.html`)
- Per-phase lessons log
- Updated `index.md` entry
