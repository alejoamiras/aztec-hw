# M8 Phase 7 + 8 — Onboarding & sovereign re-derivation (deep plan)

**Status:** drafted, dual-codex-audited, then **simplified by the protocol owner** (see "The simplification"). Tier B.
**Predecessors:** Phases 0–6 complete + Speculos-validated (`lessons/phase-6.md`).

**Locked decisions:**
- Onboarding is an explicit "Derive viewing keys" step (reveal once per session, cache in-memory/sessionStorage only — **never persisted to disk**).
- **Recovery = Ledger re-derivation, NOT a separate backup.** Plug in the Ledger (or a Ledger restored from its own seed) → re-onboard → the same account, viewing keys, and balance come back. No BIP-39 mnemonic, no sidecar, no device-less path, no read-only mode. The viewing-key *export capability* still exists (the reveal INS) for advanced/auditor use; we don't ship a UI for it.
- Demo target: testnet. Build scope: UI + logic + Speculos/host validation; the live testnet deploy→drip→wipe→reconnect→restore is a guided/Playwright run.
- Reveal hardening = copy only (no latch). Master-secret derivation = keep the validated single-path.

## The simplification (why Phase 8 nearly vanished)
The owner (Aztec ecosystem lead) corrected three assumptions that collapsed the original device-less recovery design:
1. **Note discovery is aztec.js's job** once the wallet + account + token contract are registered correctly — which `connect()` already does. No custom sync. (Kills the §8.0 spike.)
2. **Sync is fast.** (Kills the §8.4 timing gate.)
3. **The Ledger re-deriving the same viewing keys IS the backup.** A separate 24-word Aztec mnemonic is redundant with the Ledger's *own* seed backup.

The technical kicker that makes this airtight: **with the deterministic salt (§7.2), the account address recomputes entirely from the device + constants** — `address = f(publicKeys, signingPubkey, salt, classId)`, and on reconnect every input is reproduced (same seed → same viewing keys & `publicKeys`; same Ledger+path → same signing pubkey; salt fixed; class fixed). The sidecar only ever existed to carry the address for the *device-less* case; with the Ledger always present in recovery, **the sidecar is unnecessary too.** "Lost the physical Ledger" is covered by standard Ledger seed restore. The Aztec layer needs **zero** extra backup artifact.

⇒ Recovery is not a feature you build; it's an *emergent property* of correct onboarding + a deterministic address.

## 0. The pivotal insight (unchanged — still the core)
`AztecLedgerSession.connect()` does `secret = opts.secret ?? Fr.random()` and `salt = opts.salt ?? Fr.random()` (aztec-ledger-session.ts:213-214); `ConnectPanel` passes neither. Under M8 the device derives publicKeysHash + address from **its own seed** and rejects host mismatches (`0x6F0F`/`0x6F0E`). A random session secret ⇒ **every deploy now rejects.** So Phase 7 is load-bearing: **the session's Aztec secret MUST be the device's master secret, and the salt MUST be deterministic** so the same device always reproduces the same account.

## Folded from the M8 implementation audit (codex `bb56tmdxj`)
Its BLOCKER is §0 (confirms Phase 7 is the target); device gate "genuinely solid, matches installed 4.2.1." Items kept:
- **(MAJOR) Don't over-expose the secret.** Once the real root flows through `connect()`, `internalDeps()` returns it publicly (aztec-ledger-session.ts:79,433) and the wallet DB stores `secretKey` (session-embedded-wallet.ts:57). → **7.2:** stop `internalDeps()` returning the secret; scope it to the PXE boundary; no public accessor.
- **(MAJOR) Harden the reveal screen** → **7.0:** screen must state what it does ("LET THIS COMPUTER SEE YOUR PRIVATE BALANCE — reveals your viewing keys; your spending key never leaves"). Reframed from "permanent export/backup" to a per-session handoff. Copy only; no latch (locked).
- **(MINOR) Scrub EC temporaries** → **7.0:** `explicit_bzero` `acc/tmp/result/base/zinv*` in mul_generator.c/point.c.
- **(NIT) Kill stale insecure docs** → **7.0:** plan.md, provider.ts:88, get_aztec_master_secret.c:4 still describe the old pubkey-based derivation.
- *(Plan-audit BLOCKER 1 — salt — survives as §7.2; its BLOCKER 2 + the 3 device-less MAJORs are MOOT now that device-less recovery is cut.)*

## Phase 7 — Onboarding (your Ledger IS your Aztec wallet)

### 7.0 — Hardening sweep (before wiring)
- Device: reword `master_secret_reveal_ui.c` to the per-session viewing-handoff warning; `explicit_bzero` the Grumpkin EC temporaries.
- Host/docs: fix the stale derivation descriptions to the private-key-hash reality.
- **Done-when:** reveal screen states the viewing-disclosure semantics; EC temporaries provably zeroed; no doc describes the old pubkey derivation.

### 7.1 — Reveal helper + session uses the device secret
- `packages/adapter-ledger/src/onboarding.ts` (new): `revealMasterSecret(transport, path): Promise<{ secret: Fr; checksum: string }>` (wraps `getAztecMasterSecret` + the 4-hex `masterSecretChecksum`); `onboardedAccount(secret, signingPubkey, salt)` pure derivation reusing the device-proven `getContractInstanceFromInstantiationParams(...)`.
- Flow: `ConnectPanel` opens transport → `OnboardPanel` reveal (1 approval) → `connect({ secret, salt })`. `connect()` signature unchanged.
- **Done-when:** `connect({ secret: deviceSecret, salt: <deterministic> })` produces an account the device's BEGIN_DEPLOY accepts (already proven in `provider.m8.test.ts`; here wired through the UI).

### 7.2 — Deterministic salt + in-session secret cache
- **(plan-audit BLOCKER 1)** salt is randomized today (aztec-ledger-session.ts:214) ⇒ reconnect would derive a *different* address. Fix: **deterministic salt** (`Fr.ZERO` for v0 — one account per device path; reproducible with zero stored state). Threaded through `connect({ secret, salt })`. This is THE piece that makes reconnect == recovery.
- `secret-cache.ts` (new): caches the revealed secret **in-memory + sessionStorage only** (wiped on tab close). **No localStorage / no disk persistence** — consistent with "the viewing root is re-derived each session, never written down." Purely a within-session convenience so page actions don't re-prompt the device.
- Keep the secret OUT of any public accessor (don't let `internalDeps()` return it).
- **Done-when:** reconnect within a tab reuses the in-memory secret (no re-reveal); tab close forces a fresh reveal; a fresh reveal reproduces the **identical address**; the secret is unreachable via any public session accessor; nothing is written to localStorage/IndexedDB.

### 7.3 — OnboardPanel
- `apps/demo-browser/src/panels/OnboardPanel.tsx` (new). After Connect, before deploy. Button "Derive Aztec viewing keys (1 device approval)" → reveal → render the 4-hex checksum ("confirm it matches your Ledger") + the derived account address + a one-line explainer ("your viewing keys are now in this browser; your signing key never left the device; reconnect any time to re-derive"). Then unlock deploy. Never auto-fired (anti-phishing).

## Phase 8 — Sovereign re-derivation demo (the safe-v4 hero)
Recovery is emergent — so Phase 8 is a demo + a small affordance, not new crypto.

### 8.1 — "Forget session" + wipe-and-reconnect flow
- A clear-session control (disconnect + wipe in-memory/sessionStorage; optionally clear the PXE IndexedDB store) so the demo can show a genuinely empty browser.
- The hero sequence (guided/Playwright): deploy → drip USDC → **wipe all browser state** → reload → reconnect Ledger → re-onboard (1 approval) → the **same** account address resolves and the balance reappears (notes re-discovered by aztec.js).
- Assertion that makes the point: the post-wipe re-derived address **=== byte-for-byte** the pre-wipe address (the determinism proof). A mismatch is a loud failure (bug or tampered host), never silently tolerated.
- **Done-when:** a scripted run proves address-identity across wipe/reconnect and a non-zero balance reappears post-wipe with no stored artifact.

## Validation
- Unit (`bun:test`): `onboardedAccount` is deterministic — same (secret, signingPubkey, salt) → identical address across repeated calls; deterministic-salt path reproduces the device-accepted address.
- Speculos (device): the reveal → onboardedAccount → matches device BEGIN_DEPLOY accept (extend `provider.m8.test.ts`). Re-run the full deploy happy-path after the 7.x session changes (regression gate on Risk #4).
- Host: `onboardedAccount` address == the address the device verifies (reuse the proven derivation).
- Guided/manual (user drives): the full testnet wipe-and-reconnect hero on real hardware/Speculos + the browser app.

## Security & adversarial considerations
- **Viewing root is disclosed to the host every session** (by design — the PXE needs it to decrypt notes). XSS / malicious extension / compromised page can read it from the live session ⇒ treat the browser as untrusted; **never persist it to disk** (in-memory/sessionStorage only). This is *better* than a pasteable backup: nothing on disk to steal at rest.
- **Spending key never leaves the device.** A host compromise leaks *viewing* (privacy loss) but cannot move funds — the M8 deploy gate + on-device signing stand.
- **Secret over-exposure (impl-audit MAJOR):** keep the secret off `internalDeps()`/public accessors; scope to the PXE boundary.
- **Reveal screen = phishing surface:** high-friction, clearly worded as a viewing-disclosure, never auto-fired.
- **Determinism integrity:** the re-derived address must equal the original; a mismatch fails loudly (guards against a host feeding a different salt/path to silently swap accounts).
- **Supply chain:** no new deps (BIP-39 dropped). Lockfile committed; 7-day min-age stands.

## API facts (verified against installed 4.2.1)
- `connect()` randomizes secret AND salt (aztec-ledger-session.ts:213-214) — the §7.2 injection point.
- `connect()` already registers the account instance+artifact (242) + USDC/Dripper/FPC instances+artifacts (249-253) — so a reconnect re-registers everything ⇒ aztec.js re-discovers notes (owner-confirmed). Recovery rides this unchanged.
- `ConnectPanel` passes no secret/salt (apps/demo-browser/src/panels/ConnectPanel.tsx ~L65).
- `AccountManager.create(session, secret, accountContract, salt)` derives the address from these four (aztec-ledger-session.ts:216) — deterministic given a fixed salt.

## Risks
| # | Risk | P | I | Mitigation |
|---|---|---|---|---|
| 4 | Session refactor breaks the M7/M8 deploy path | 20% | High | keep `connect()` signature; onboarding pre-connect; **full Speculos deploy re-run** after 7.x |
| — | Re-derived address ≠ original after wipe | 10% | High | deterministic salt + fixed BIP-32 path; explicit byte-equality assertion in 8.1 |
| — | ~~sync mechanism / timing / sidecar / mnemonic / device-less gates~~ | — | — | **MOOT** — device-less recovery cut; aztec.js handles discovery (owner-confirmed) |

## Open questions
- None blocking. (The sync-mechanism and timing questions are resolved by owner authority: aztec.js handles discovery, sync is fast.)

## Sequencing
**7.0 (hardening) → 7.1 (reveal→session) → 7.2 (deterministic salt + in-session cache) → 7.3 (OnboardPanel)** → full Speculos deploy re-run → **8.1 (wipe-and-reconnect hero)**. `safe-v4` tag after the guided testnet hero records.

## Audit trail
- impl-audit `bb56tmdxj` (DO-NOT-SHIP → BLOCKER = Phase 7's reason to exist): hardening items folded into 7.0/7.2.
- plan-audit `bvof0xgzl` (CHANGES-NEEDED): BLOCKER 1 (salt) → §7.2; BLOCKER 2 + the device-less MAJORs (sync/sidecar-selector/chainId/senders/decode) → **rendered moot** by the device-less cut, not ignored.
- Owner reframe (this turn): device-less recovery → Ledger re-derivation; ~60% of remaining build removed; story strengthened.
