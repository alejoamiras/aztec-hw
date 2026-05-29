# M9 — Real-wallet UX (multi-account + address-first device reviews + demo polish)

**Status:** drafted, pre-audit. Tier B (one main plan + codex audit). Builds on M8 (`safe-v4`).
**Goal:** make the Ledger feel like a real Aztec wallet — deploy/use *multiple* accounts with good UX, and make every on-device review speak the user's language (the **account address**, not the BIP-32 path). Folds in the M8 post-impl codex findings (session `019e752e`).

**Locked decisions (this turn):**
- Webpage: **polish the existing plain-CSS app** (flow + states + copy), not a Tailwind/shadcn retrofit.
- **Include the device-verified `From` address on transfers** now (full address-first across reveal/deploy/transfer/drip), not staged.
- Account multiplicity via the **BIP-32 account index** (path), salt stays `Fr.ZERO`. NOT salt-saving (path index is re-derivable; saving salts reintroduces the device-less-backup fragility we cut in M8).
- Recovery model unchanged from M8: the device (its own seed) is the backup; nothing on disk.

## UX principles for device screens (the spec the C code implements)
1. **Identity = account address, framed as "your account."** Every review leads with `Account #N` + abbreviated address (`0x0aa630…3dbe`, the `address_8_6` helper).
2. **BIP-32 path is plumbing — drop it from the main flow.** The account *index* carries "which account" in human form.
3. **Everything shown is device-verified, never host-claimed.** The address/amounts/mode are device-computed/decoded/cross-checked (the M8 trust model). This is why the transfer `From` needs a device verify step, not a print.
4. **Plain-verb titles + one risk line.** "Derive viewing keys" (⚠ this computer will SEE your balance) / "Deploy account" (fee source) / "Send USDC" (recipient + amount).
5. **Consistent layout:** `Title → Account/Address → action specifics → Approve`.

(Reference ASCII for the four reviews — reveal / deploy / send / drip — is the design the user signed off on; reproduced in `eli5.html`.)

## Phase A — Account model + cache binding (host/adapter + demo UI)
- **A1. Cache keyed by the device signing pubkey** *(folds codex MAJOR 1 — the cache is currently global → a different device/index in the same tab reuses the prior viewing root)*. On onboard, `getPublicKey(defaultAztecPath(N))` (no approval) → the full pubkey `x‖y` is a collision-resistant identifier for `(device seed, index)` (codex MINOR: treat it as a session id, not a proof-grade uniqueness claim). Cache key = that pubkey. `loadCachedSecret(pubkeyKey)`: hit ⇒ reuse (same device+index, no re-reveal); miss ⇒ fresh device reveal + cache under the pubkey key. Device-identity change ⇒ automatic miss ⇒ fresh reveal. This single change fixes the security bug AND enables multi-account keying.
- **A2. Account-index selector + single source of truth (codex MAJOR — account `0` is hardcoded in the reveal, cache, and deploy paths today).** `defaultAztecPath(N)` is supported; store the selected **index/path in session state** and source reveal + deploy + cache from that ONE value (remove the hardcoded `0` in OnboardPanel / secret-cache / `deployAccount`). Onboarding chooses `N` (default 0); salt stays `DEFAULT_ACCOUNT_SALT`. **(opus MAJOR — sharper than "remove the 0"):** there are FOUR path sources today, incl. `deployAccount`'s hardcoded `defaultDeployPath(0)` (aztec-ledger-session.ts:382 — a *separate, byte-identical* helper) and OnboardPanel's `connect({secret})` with no `bip32Path` (silently index 0). Fix properly: (i) collapse `defaultAztecPath`/`defaultDeployPath` into ONE helper; (ii) `deployAccount` reads the account contract's *configured* path, not a literal; (iii) make connect's `bip32Path` and the reveal-path a single value derived from the selected index, and **assert they agree**; (iv) add a **negative** unit test that reveal-index ≠ connect/deploy-index *throws* (not just that #1≠#0). Mis-threading otherwise builds a deploy the device rejects with `0x6F0E` (fails closed — good — but a broken multi-account deploy ships, and a reveal-at-N/connect-at-0 split yields a host address that exists nowhere on-chain).
- **A3. Deployed-detection — use init-status, NOT `getContract` alone (codex MAJOR).** `node.getContract(address)` only means "a public instance exists in the node view"; it false-positives on *registered-but-uninitialized* accounts (4.2.1 covers this case explicitly). Use the proper **initialization-status** check (the 4.2.1 `base_wallet` init path), not `getContract` alone, to set `alreadyDeployed`. Drives the UI (disable Deploy, show "on-chain", jump to drip/transfer). A false "deployed" must never hide a needed Deploy.
- **Done-when:** picking Account #1 derives a *different* address than #0; reconnecting #0 reuses its cached secret (no re-reveal); connecting a different account index forces a fresh reveal (no cross-index secret reuse); an already-deployed account shows "on-chain" and hides Deploy.

## Phase B — Address-first device reviews (ledger-app C + adapter + the `From`-verify protocol)
- **B1. Deploy review** (`deploy_review_ui.c`): add the `Account #N` label; **drop `Path`** (keep the already-shown verified `Address` + `Fee`). Trivial.
- **B2. Reveal review** (`master_secret_reveal_ui.c`): show `Account #N` + the **account address** (device computes it from signing pubkey + derived viewing keys + the fixed `salt`, reusing M8 `az_account_address`) + the viewing-disclosure warning; demote/drop the checksum + path (the address is now the cross-check).
- **B3. Transfer/authwit review** (`verified_calls_ui.c` + the wire) — *the meatiest piece*:
  - **(codex BLOCKER — cross-check the field that is ACTUALLY signed.)** `BEGIN_AUTHWIT` already commits the signed outer_hash to `consumer` (= the account address; M8 used `consumer = address_local`). A *separate* host `expected_address` would let the UI show "From = X" while the hash signs `consumer = Y` — a clear-signing lie. So **do NOT add `expected_address`/`salt` to the wire** (salt is pinned `Fr.ZERO`; a host-chosen salt would widen the model to same-signing-key sibling accounts). **No wire/manifest change, no version bump.**
  - **Device (the real work):** recompute the account address from the seed via the FULL deploy-profile chain — `az_deploy_compute_partial_address` (pinned class id + ctor selector + signing pubkey + `salt=Fr.ZERO` + `deployer=ZERO`) then `az_account_address` (**codex MAJOR**: the M8 helpers need a `partial_address`, not a salt) — and **cross-check it equals the `consumer` already in `BEGIN_AUTHWIT`** (reject `0x6F0E`-style on mismatch). Display `From` = that verified address; **drop `Path`/`Chain`** from the header.
  - Net: *smaller and safer* than the original wire-change design — `consumer` is already present + signed, so the new surface is just the device recompute + the consumer cross-check + the UI. (Risk #1 — the wire change — eliminated.)
- **Done-when:** deploy/reveal/transfer/drip reviews all lead with `Account #N` + a device-verified address; no `Path` in the main flow; the displayed `From` provably equals the signed `consumer`; a transfer whose `consumer` ≠ the device's recomputed account address is rejected on-device.
- **B3 invariants (opus audit — record these):** (1) `consumer == account` holds *because every demo verb is self-spend* (`from == account`, no token inner-authwit) — B3 binds the **entrypoint** authwit only. State the invariant + link the address-first `From` to the `SW_DELEGATED_SPEND_UNSUPPORTED` allowlist so it's never read as "the device vets arbitrary senders." Delegated spend (`from != account`) is out of scope and would add a second authwit (consumer = token) the device wouldn't review. (2) The authwit session struct (`l4_session_t`) lacks `profile_id`/salt/class-id/signing-pubkey (they live in the deploy struct) — B3's recompute is a NEW authwit-finalize path ≈ the M8 deploy-verify crypto surface, +~10-15 Grumpkin mults **per transfer/drip** (note for the Nano S+ perf pass). (3) That recompute MUST reuse M8's `grumpkin_secure_wipe` discipline — verify no un-wiped sk / viewing-scalar on the transfer path (a new per-tx secret-residue surface; copy-paste hazard).

## Phase C — Demo webpage polish (demo-browser, plain CSS — flow/states/copy)
- **C1.** OnboardPanel: account-# selector; deployed-detection states ("Account #1 · 0x0aa6… · on-chain ✓" vs "not deployed → Deploy"); address-first confirmation after derive.
- **C2.** The recovery hero made visually obvious: a clear "Wipe & reconnect" affordance + a short narrative ("your Ledger is your backup — clear everything, reconnect, your account returns") so the safe-v4 story reads on camera.
- **C3.** State polish: empty/connecting/onboarding/ready/submitting/error across panels; **honest Forget/secret copy** *(codex MAJOR 3 + opus NIT)* — the viewing root sits in `sessionStorage` (DevTools-inspectable, disk-backed in some browsers), so the copy is **"kept in this browser tab for the session (cleared on Forget or tab close)"** — NOT "in memory" / "never on disk". And A2 must remove EVERY no-arg `cacheSecret()`/`loadCachedSecret()` call so no stale global `'default'` entry survives the pubkey-keyed scheme.
- **C4.** Copy pass for the whole flow (plain language, no jargon — the frontend-copywriting addendum).
- **Done-when:** the page legibly tells the sovereignty + multi-account + recovery story; states are unambiguous; copy claims nothing false about where the secret lives.

## Phase D — Codex honesty folds (distributed)
- **D1 [MAJOR 1]** cache device-binding → **Phase A1**.
- **D2 [MAJOR 2]** the viewing secret is inherently reachable in the browser (PXE/`walletDB` need it to decrypt notes); `protected` is not a runtime boundary. → **Correct the framing** in comments/docs + the plan's security section; the `internalDeps` strip is defense-in-depth, not a boundary. Do NOT claim the secret is unreachable — but also NOT "no mitigation exists" (codex MINOR: a trusted-process PXE — browser extension / native / remote — is the real future isolation; the decrypting component still needs the secret).
- **D3 [MAJOR 3]** "Forget session" → null the session ref (drop strong refs so the PXE/walletDB are GC-eligible) + clear cache + **honest copy** (C3). No claim of cryptographic heap erasure (not possible in JS).
- **D4 [MINOR]** soften the deploy-fix comment in `aztec-ledger-session.ts` — "the inner account-entrypoint auth hash is pinned (txNonce) and the frozen provider rejects inner-hash drift," not "the whole payload is identical."

## Security & adversarial considerations
- **Cross-device / cross-index secret reuse (the fixed bug):** keying the cache by the signing pubkey makes reuse impossible across devices or indices; a device swap forces a fresh reveal. Threat closed.
- **Viewing secret in the browser (honest model):** the PXE must hold it to decrypt notes; treat the browser as untrusted. XSS/extension/same-origin code can reach it (`walletDB`, PXE, the live wallet) — `protected` is not a boundary. We minimize accessors + lifetime (sessionStorage, Forget) but do **not** claim unreachability. The spending key never leaves the device, so the worst case stays *privacy* loss, not theft.
- **Transfer `From` spoofing:** showing a host-claimed `From` would be a clear-signing lie. The device **re-derives + cross-checks** the address (reject on mismatch) before display — same guarantee as deploy's `address_local`.
- **Deterministic salt:** one account per `(device, index)`; universal deploy ⇒ an attacker can at most predeploy the *same* instance, not squat a different contract (codex-confirmed). Account index is enumerable but not secret.
- **Reveal as export:** unchanged high-friction screen; now address-first so the user sees *which* account's privacy they disclose.
- **Supply chain:** no new deps expected. Lockfile committed; 7-day min-age stands.

## Risks
| # | Risk | P | I | Mitigation |
|---|---|---|---|---|
| 1 | ~~`BEGIN_AUTHWIT` wire change breaks proven flows~~ | — | — | **ELIMINATED** by the codex BLOCKER fix — no wire change; cross-check the existing `consumer` |
| 2 | Device address recompute at authwit underspecified (needs `partial_address`, not just salt) | 25% | Med | reuse `az_deploy_compute_partial_address` + `az_account_address` (M8-proven); host-parity test before wiring the UI |
| 6 | `consumer` ≠ the account address for some transfer mode (so the cross-check can't bind) | 20% | High | verify `consumer == account address` across ALL transfer modes (held for deploy) — the B3 spike checks this first |
| 3 | Address-at-reveal compute adds latency/complexity to onboarding | 15% | Low | salt is the fixed default; reuse M8 address derivation; fall back to index+checksum if it bloats |
| 4 | Demo polish scope-creeps | 25% | Low | flow/states/copy only; no styling-system change (locked) |
| — | ~~cache device-binding / salt squatting~~ | — | — | A1 fixes binding; salt squatting refuted (codex) |

## Validation
- Unit (`bun:test`): cache keyed-by-pubkey (hit/miss across keys); deployed-detection (`getContract` present/absent → flag); account-index → distinct address.
- Host parity: the device-computed account address at reveal/authwit == the Aztec-reference address (reuse M8 golden vectors).
- Speculos (device): each review renders address-first (reveal/deploy/transfer/drip); the transfer `From` cross-check rejects a tampered `expected_address`; **full regression** of deploy + drip + all transfer modes after the wire change.
- Demo e2e (headless): onboard with account selector; deployed-detection state; address-first reveal/deploy screens (extend `deploy-review.e2e.ts`).

## Open questions
1. ~~Wire layout for `From`-verify fields~~ **Moot** (no wire change). New: does `consumer` in `BEGIN_AUTHWIT` equal the account address for ALL transfer modes (it did for deploy)? — the **B3.0 spike** answers this before any device code.
2. Account-# selector range (0–4 enough?). **Deployed-badge: resolved → LAZY-on-selection** (register the instance, then init-status check) — NOT eager per-index `getContract` (opus item 4: that gives only `isContractPublished` — the false-positive A3 warns of — and for an un-registered index the init-status check falls back to a public-nullifier lookup that returns UNKNOWN for accounts).
3. Reveal address display — full address-first (compute on-device) vs `Account #N` + checksum if the on-device compute proves heavy. (Default: compute it; user accepted.)

## Sequencing
**A (account model + cache-binding + single-source path) → B1/B2 (cheap device reviews: drop Path, show address) → B3.0 SPIKE [gates B3]: prove `consumer == account address` across all transfer modes + the device address-recompute path, no regression → B3 (consumer cross-check + UI) → C (demo polish) → D (honesty folds, in A/C).** Full Speculos regression after B3. **Codex + opus plan-audits both done + folded — Tier-B dual audit COMPLETE** (codex CHANGES-NEEDED → all folded incl. the B3 BLOCKER; opus LGTM-WITH-NITS → the headline B3 `consumer` cross-check independently confirmed sound for all transfer modes + drip; its MAJOR = the A2 path-threading, folded). `safe-v5` at the recordable demo checkpoint.
