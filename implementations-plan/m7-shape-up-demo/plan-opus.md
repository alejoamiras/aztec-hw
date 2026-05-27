# M7 — Shape-Up Demo: Clear-Sign Deploy + Structured Phases + CSS Polish

Independent plan. I have not read `plan-main.md`.

---

## 1. Problem Statement

Three apparently-unrelated annoyances share one root cause: the device review surface is incomplete, so the host UI has to pretend.

- `deployAccount()` blind-signs a 32-byte digest (`packages/adapter-ledger/src/aztec-ledger-session.ts:253-268`). An attacker who controls the host could substitute publicKeys, salt, or class id; the user has nothing to compare against.
- The 6-phase StatusBar regex-infers phase from step labels (`apps/demo-browser/src/panels/StatusBar.tsx:43-52`). It jumps to `Submit` when deploy emits label 2 (`aztec-ledger-session.ts:257`), even though the device is in `Sign` for ~10 seconds. The timeline lies.
- CSS is fine but flat — it hides the timeline bug behind nice typography.

Fix order I'd defend: **clear-sign deploy → structured phases → CSS polish**. The first eliminates the structural reason the regex was wrong (deploy joins the 9-step recipe). The second cleans up an inherited footgun. The third is fastest but smallest-payoff.

I do NOT accept framing the StatusBar as cosmetic. If the host can mislead the user about phase, it can mislead about device state. Lock it down.

---

## 2. Architecture for `DEPLOY_ACCOUNT` Verb

### 2.1 The fundamental constraint

Aztec address derivation (`/Users/alejoamiras/Projects/aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts:22-49` + `/yarn-project/stdlib/src/keys/derivation.ts:50-62`):

```
init_hash    = poseidon2([ctor_selector, args_hash], INITIALIZER=385396519)
salted_init  = poseidon2([salt, init_hash, deployer], PARTIAL_ADDRESS=2103633018)
partial_addr = poseidon2([class_id, salted_init], PARTIAL_ADDRESS=2103633018)
preaddress   = poseidon2([publicKeysHash, partial_addr], CONTRACT_ADDRESS_V1=1788365517)
address      = (preaddress * G + ivpk_m).x  // Grumpkin curve
```

`args_hash` is over `[signing_pub_key_x, signing_pub_key_y]` (`packages/adapter-ledger/src/account-contract.ts:41-50`). `publicKeys` are 4 Grumpkin points derived from a host-side `Fr` (`aztec-ledger-session.ts:187`: `Fr.random()`).

**The device cannot do the final EC step**: no Grumpkin scalar-mul or point-add in the Ledger SDK. Implementing it would mean writing Grumpkin field arithmetic from scratch — overkill for v0.

### 2.2 Decision — what the device CAN bind

The device can compute everything **up to `partial_address`** with Poseidon2 (already shipped, `ledger-app/src/l4/parity.c`). The Grumpkin EC step is unreachable.

So the device's binding is:
- **Independently re-derives** `init_hash` from its OWN BIP-32 pubkey + the host-supplied constructor selector. **Refutes pubkey-swap.**
- **Independently re-derives** `salted_init` + `partial_address` from host-supplied salt + class_id. **Refutes salt/class swap.**
- **Allowlists** `class_id ∈ {EcdsaKAccount}`. **Refutes attacker-controlled contract code.**
- **Asserts** `multicall.consumer == claimed_address` (already in `G_l4_session.consumer` from BEGIN_AUTHWIT). This is *internal consistency* — if the host lied about `claimed_address`, the deploy tx fails on the rollup. **Refutes one class of inconsistency, NOT address spoofing in the strict sense.**

**Gap I won't paper over**: host can substitute `publicKeys` (and `publicKeysHash`); device records but cannot derive them. The user's protocol secret is `Fr.random()` per session today — the device has no link.

**My position**: ship `INS_GET_AZTEC_SECRET` returning `sha256(bip32_priv || "AZTEC_PROTOCOL_SECRET_V1") mod Fr.MODULUS`, and stop doing `Fr.random()` on the host. Two days. Without it, "clear-sign deploy" is partly theatre. **I'd take this position publicly even if it slips the demo a week.**

If we won't pay that cost, the v0 fallback is: **display `publicKeysHash` short-fingerprint on-device** so the user can compare across sessions/devices via a printed backup card.

### 2.3 APDU layout

Reuse the existing L4 stream. Add **one** new APDU `INS_PROVIDE_DEPLOY_CONTEXT = 0x09`, sent **between `BEGIN_AUTHWIT` and the first `APPEND_CALL`**:

```
DEPLOY_CONTEXT (130 B)
  flags                   : 1 B   bit0 = is_universal_deploy
  class_id                : 32 B  Fr BE
  salt                    : 32 B  Fr BE (host Fr.random() per session)
  publicKeysHash          : 32 B  Fr BE (host commits; device records; not derived)
  ctor_selector           : 4 B   u32 BE
  deployer                : 32 B  Fr BE (zero for universal)
  claimed_address         : 32 B  Fr BE (UI display + consumer-equality check)
```

Plus 5 new SWs in `ledger-app/src/sw.h`: `SW_UNKNOWN_CLASS_ID`=0x6F0D, `SW_DEPLOY_CONSUMER_MISMATCH`=0x6F0E, `SW_DEPLOY_PARTIAL_MISMATCH`=0x6F0F, `SW_DEPLOY_CONTEXT_TWICE`=0x6F10, `SW_DEPLOY_CONTEXT_WRONG_STATE`=0x6F11.

New L4 state: `L4_HEADER_PARSED → L4_DEPLOY_CONTEXT → L4_CALLS_COMPLETE`. **Deploy context allowed ONLY when the manifest header's flags mark it as a deploy stream** — guard against an attacker prefixing a normal transfer with `DEPLOY_CONTEXT` to corrupt session state.

### 2.4 Device recomputation algorithm

1. Re-derive `(sx, sy)` from BIP-32 path (existing `GET_PUBLIC_KEY` code path).
2. `args_hash = computeVarArgsHash([sx_as_Fr, sy_as_Fr])` — Poseidon2 sequence we already implement.
3. `init_hash_local = poseidon2([ctor_selector_as_Fr, args_hash], INITIALIZER)`.
4. `salted_init_local = poseidon2([salt, init_hash_local, deployer], PARTIAL_ADDRESS)`.
5. `partial_addr_local = poseidon2([class_id, salted_init_local], PARTIAL_ADDRESS)`.
6. **Class allowlist**: `class_id ∈ CS_DEPLOY_CLASSES` (codegen'd, see §5 Phase 1). Else `SW_UNKNOWN_CLASS_ID`.
7. **Consumer-equality**: `memcmp(G_l4_session.consumer, claimed_address, 32) == 0`. Else `SW_DEPLOY_CONSUMER_MISMATCH`.
8. Store `partial_addr_local`, `publicKeysHash`, `claimed_address` in `G_l4_session.deploy_context`.

**At FINALIZE**, mirror the 3-pass parity-recompute pattern in `finalize_and_sign.c:80-117` for the deploy context: recompute steps 1-5 twice pre-UI, once at `finalize_after_approval`. Mismatch → `SW_DEPLOY_PARTIAL_MISMATCH`, zero session.

### 2.5 Host injection

`AccountManager.deploy` does **not** accept a `FrozenAuthWitnessProvider`. The framework's `BaseAccount` resolves the provider via `accountContract.getAuthWitnessProvider(completeAddress)` (`/Users/alejoamiras/Projects/aztec-packages/yarn-project/accounts/src/defaults/account_contract.ts:25-32`). The provider is constructed once per contract.

Solution: add a **prearm** state to `LedgerEcdsaKAuthWitnessProvider`:

```ts
private prearmed: { ctx: DeployContext; expectedOuterHash: Fr } | null = null;

async armDeploy(ctx: DeployContext, expectedOuterHash: Fr): Promise<void> {
  if (this.prearmed) throw new Error('already armed');
  this.prearmed = { ctx, expectedOuterHash };
}

async createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness> {
  if (this.prearmed) {
    const { ctx, expectedOuterHash } = this.prearmed;
    this.prearmed = null;
    return this.runDeployRecipe(messageHash, ctx, expectedOuterHash);
  }
  return this.signAndWrap(/* legacy blind sign retained for tests only */);
}
```

`runDeployRecipe` asserts `messageHash === expectedOuterHash` (FrozenWitnessMismatch semantics from `packages/adapter-ledger/src/frozen-auth-witness-provider.ts:42-57`), then streams `BEGIN_AUTHWIT → PROVIDE_DEPLOY_CONTEXT → APPEND_CALL × N → FINALIZE_AND_SIGN`.

In `aztec-ledger-session.ts:deployAccount` (`aztec-ledger-session.ts:253-268`):

1. Build deploy `ExecutionPayload` via `accountManager.getDeployMethod().request({ from: NO_FROM, fee: ... })`.
2. Project into `CallIntent` (reuse `projectExecutionPayloadIntoCallIntent`).
3. Compute host-side `outer_hash` (reuse `buildL4Manifest`).
4. Build `DeployContext` from instance + ctor args + publicKeys hash.
5. `ledgerProvider.armDeploy(ctx, outerHash)` — no device traffic yet.
6. `deployMethod.send({ from: NO_FROM, fee: ... })` — framework internally calls `provider.createAuthWit(outerHash)`, which now triggers the L4 stream.

No subclassing. No framework patch. Single point of policy.

---

## 3. Structured-Step Refactor — Per-Action Emission Map

```ts
// packages/adapter-ledger/src/types.ts (new)
export type PhaseId = 'build' | 'sign' | 'prove' | 'submit' | 'include' | 'done';
export type SubmitStepHandler = (phase: PhaseId, label: string) => void;
```

`label` is display-only filler. `phase` drives the timeline. **Decoupled.**

### 3.1 `deployAccount` (8 emissions, post-§2)

| # | Phase | Label |
|---|-------|-------|
| 1 | build | `Computing deploy payload…` |
| 2 | build | `Projecting CallIntent…` |
| 3 | build | `Computing host outer_hash…` |
| 4 | sign  | `Awaiting clear-signed approval on device…` |
| 5 | prove | `Proving deploy tx…` |
| 6 | submit | `Submitting deploy tx ${txHash}…` |
| 7 | include | `Awaiting inclusion…` |
| 8 | done | `Account deployed` |

### 3.2 `dripUsdc` (9 emissions)

`build` ×3 (drip payload / chain info / project intent) → `sign` ×1 → `prove` ×2 (sig received / WASM proving) → `submit` ×1 → `include` ×1 → `done` ×1.

### 3.3 `transferUsdc{PubToPub,PrivToPub,PubToPriv,PrivToPriv}` (9 emissions)

Identical shape to drip, build label varies by method name (`aztec-ledger-session.ts:391`).

### 3.4 Frontend impact

`SubmitStep` becomes `{ phase, label, at }` (`apps/demo-browser/src/state.ts:28-31`). `inferPhaseIndex` (`StatusBar.tsx:43-52`) and `activePhase` (`StatusBar.tsx:54-60`) delete. `activeIdx = PHASES.indexOf(steps.at(-1)?.phase ?? 'build')`. `AccountPanel.tsx:29-32` and `TransferPanel.tsx:73-82` update closure signatures.

### 3.5 Anti-forging

`onStep` is fired **only inside the adapter**. Host UI never injects synthetic phases. The closure capture pattern in `AccountPanel.tsx:29-32` is fine for v0 — it's a single in-process call. Document in code review that **the host MUST NOT call `onStep` itself**. Long-term flag: replace closure with typed `MessagePort` so a browser extension can't interpose.

---

## 4. CSS Polish — Concrete Targets

Net diff target: ≤80 lines.

### 4.1 Type scale (`style.css:14-16,26,225-236`)

- Base font 14px → 15px. Improves readability without growing layout.
- `h1` 1.4rem → 1.65rem so it doesn't compete with `.status-bar-primary`.
- `h2` 1rem → 0.78rem + weight 600 — reads as section marker, not body.
- Drop `'SF Mono'` (Apple-only) from mono stack.

### 4.2 Neutral ramp (`style.css:3-13`)

Today: `--bg`, `--card`, `--border`, `--muted`. Too flat. Add: `--bg-elev-1` (= current `--card`), `--bg-elev-2` (= input bg), `--fg-strong` (#f1f5f9), `--fg-muted` (current `--muted`), `--fg-subtle` (#64748b). Add `--accent-soft: rgba(124, 92, 255, 0.18)` (already used inline at line 78) as a token.

### 4.3 Status bar (`style.css:36-105`)

- Padding 0.85→1rem vertical, 1→1.25rem horizontal.
- Add `box-shadow: 0 1px 2px rgba(0,0,0,0.2)` so it visually sits above panels.
- Badge: +3px horizontal padding (currently claustrophobic).
- `.status-bar-secondary-mono` modifier for the case currently mixing prose + mono content.

### 4.4 Phase timeline alignment bug (`style.css:126-135`)

Connector lines use `left: 60%; right: -40%`, which overshoots the last cell on narrow viewports. Fix with `left: calc(50% + 0.85rem); right: calc(-50% + 0.85rem)` so the line always meets the next marker's center.

Pulse animation (`style.css:194-201`) is **infinite**. That's a phishing-grade attention trap. Change to 3 cycles then settle (`animation: phase-pulse 1.4s ease-in-out 3`).

Add `aria-current="step"` on the active phase `<li>` (StatusBar.tsx ~line 80).

### 4.5 Panel polish (`style.css:243-254`)

- Border-radius 8→10px.
- `.panel.disabled` opacity 0.45→0.55 (currently can't read the address).
- Add `transition: opacity 120ms` so panels fade rather than snap.

### 4.6 Button feedback (`style.css:290-310`)

- Add `box-shadow: 0 1px 0 rgba(0,0,0,0.2)` + `:active { transform: translateY(1px) }` for press feedback.
- Disabled `opacity: 0.6` so "disabled-because-prerequisite" reads visually different from "wrong state".

### 4.7 Address rendering (`style.css:350-355`)

`word-break: break-all` → `overflow-wrap: anywhere` (better at line-breaking on hex). No change to truncation logic (handled in TSX).

---

## 5. Sequencing — Verifiable Exit Criteria

```
[ ] 0. Pre-decision gate (§2.2 device-derived secret vs publicKeyHash fingerprint)
[ ] 1. Manifest + codegen for DEPLOY_ACCOUNT + class allowlist
[ ] 2. Device INS_PROVIDE_DEPLOY_CONTEXT + recompute + parity passes
[ ] 3. verified_deploy_ui.c + NBGL dismissal from day one
[ ] 4. Host armDeploy() + provider refactor
[ ] 5. Structured phases everywhere (delete regex)
[ ] 6. CSS polish (≤80 lines net diff)
[ ] 7. Codex adversarial review + fix loop
```

**Exit criteria per phase:**

- **P0**: written decision on §2.2. Codex consult on the partial-address-only design.
- **P1**: `bun run gen-clear-signing-v0.ts --check` passes; class_id re-derived from `EcdsaKAccountContractArtifact` matches manifest pin (fail-closed CI).
- **P2**: ragger test — malicious `claimed_address ≠ consumer` → device rejects with `0x6F0E`; bad class → `0x6F0D`; concurrent context APDU → `0x6F10`.
- **P3**: ragger test asserts device on main menu within 500ms of signature (M6.11 regression guard).
- **P4**: Playwright against alpha-testnet — deploy account → verify review surface shows address; drip + transfer still pass.
- **P5**: every Playwright deploy/drip/transfer asserts deterministic timeline transitions (no regex string-matching in test code).
- **P6**: visual diff vs baseline reviewed; no Playwright DOM regressions.
- **P7**: codex `xhigh` adversarial review on full diff; close findings.

**Total: ~9 days with §2.2 device-secret. ~7 days without.**

---

## 6. Security & Adversarial Considerations

### 6.1 Address spoofing despite on-device recomputation

Open gap (§2.2): device can't do Grumpkin EC, so it can't refute substituted `publicKeys`. Internal-consistency anchor (`multicall.consumer == claimed_address`) catches lies that would have failed on-chain anyway — **availability** protection, not strict address binding. **Moderate confidence** for v0 if §2.2(a) ships; **low** otherwise.

### 6.2 Pubkey-swap attacks

Device recomputes `init_hash` from its OWN BIP-32 pubkey, NEVER from a host-supplied value. `DEPLOY_CONTEXT` deliberately does not carry `init_hash`. **High confidence.**

### 6.3 Salt vanity brute-force on 6+4 truncation

User flagged correctly: 40 bits = ~17 minutes at 10⁹ Poseidon2/sec on commodity hardware. Cheap remediation: show **8+6 = 56 bits → ~80 years**. Better: show **full 64-char** scrollable on the one-time deploy review (Nano S+ NBGL supports it). I'd ship full-length for deploy; keep 8+6 for per-call transfer review.

### 6.4 Class id allowlisting

`CS_DEPLOY_CLASSES` codegen'd from `manifest.json`, cross-checked against pinned `EcdsaKAccountContractArtifact`. CI fail-closed on drift. **High confidence** — the attack surface is `manifest.json` editing, which is in-repo + reviewable.

### 6.5 outer_hash mismatch

Existing 3-pass recompute in `finalize_and_sign.c:80-117`. Add a 4th pass right before `verified_deploy_ui.c` renders, mirroring the existing pattern. Cheap. Defense in depth.

### 6.6 TOCTOU between recomputation and signing

`finalize_after_approval` already signs the **locally-recomputed** outer_hash (`finalize_and_sign.c:141-148`), not the mutable session value. Mirror for deploy: pass `partial_addr_local` via stack, don't re-read `G_l4_session.deploy_context` at sign time.

### 6.7 NBGL dismissal regressions (M6.11)

Ship `DEPLOY_ACCOUNT` with `nbgl_useCaseReviewStatus(STATUS_TYPE_TRANSACTION_SIGNED, ui_menu_main)` from commit zero (mirror `finalize_and_sign.c:210-214`). Ragger E2E test: device on main menu within 500ms of success APDU. Without this test, this **will** regress.

### 6.8 Phase forging / sub-label injection

`phase` is a typed enum (non-enum value = TS compile error). `label` rendered via React text node in `StatusBar.tsx:175` (no `dangerouslySetInnerHTML` — safe). Closure interception risk for v0 is documented; long-term: typed `MessagePort` instead of closure.

### 6.9 Visual phishing risk from a polished demo

A polished demo can be cloned into a phishing site. **The CSS polish must NOT add UI elements that suggest the host is authoritative** — no "✓ Verified" badges, no host-side checkmarks. Only the timeline (descriptive, not authoritative). The device screen remains the user's source of truth.

### 6.10 Sponsored fee misuse for deploy

Deploy routes through `SponsoredFeePaymentMethod` (`aztec-ledger-session.ts:264`). The sponsor address is in `manifest.json:26-32` (slot 2). The deploy review screen MUST show "Fee paid by: testnet sponsor". Add as a 6th pair in `verified_deploy_ui.c`. Without it, the user can't tell who pays.

---

## 7. Open Questions Where I'd Push Back

**Q1: User said "show only the address". I disagree** — show address + salt + class + (if §2.2(a)) publicKeyHash. Minimalism is reasonable but leaves the user with nothing to *rederive* with. If the host swaps salt+class and the resulting address is one the user wants (vanity brute-force, §6.3), the user signs. Adding 2-3 fields makes the recomputation transparent without overwhelming. **Pushing on this.**

**Q2: Why not derive `secret` on-device?** §2.2(a). Without it, address spoofing is partially undefended. Either ship device-derived secret, or ship the publicKeyHash backup card. Picking neither = security debt I refuse to sign off on.

**Q3: Address truncation length?** 6+4 = 40 bits is brute-forceable in minutes. Use 8+6 (56 bits) minimum. Show full 64-char on one-time deploy review.

**Q4: Should deploy fully port into the 9-step `runRecipe` with a custom `txNonce`?** User suggests yes. I disagree — `deployMethod.send` internally builds the multicall + chooses `txNonce: Fr.random()` (`base_wallet.ts:180`). Porting that into `runRecipe` is a much larger change than the prearm-provider approach (§2.5). The prearm approach gives us the same security properties with smaller blast radius. **Deploy emits 8 phases, not 9** — the framework's `BaseWallet.sendTx` is a black box across prove + submit, so we collapse them.

**Q5: Is `multicall.consumer == claimed_address` actually meaningful?** It refutes one class of inconsistency, NOT strict address spoofing. An attacker who controls the host could pick `(consumer, claimed_address)` both equal but with wrong `(publicKeys, salt, class)` — the tx fails on the rollup. **Availability attack only**, not confidentiality/integrity. Acceptable for v0; flag for v1.

---

## 8. Disagreements I Anticipate

Positions I'd defend against any plan author:

1. **"Blind-sign the deploy"** — Rejected. Theatre; ship the verb or don't ship.
2. **"Skip BIP32-derived secret"** — Rejected unless we ship publicKeyHash backup card.
3. **"6+4 truncation is fine"** — Rejected. 40 bits is vanity-brute-forceable.
4. **"Improve the regex"** — Rejected. Regex-as-FSM is a smell.
5. **"CSS polish first as a quick win"** — Rejected. Polish ships LAST.
6. **"Salt is a debug field"** — Frame as recovery field.

End of plan-opus.md.
