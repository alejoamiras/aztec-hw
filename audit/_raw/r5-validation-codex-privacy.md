# Round 5 validation — codex privacy/metadata (FINAL validation pass)

Adjudicator: final-validation subagent (skeptic). Verified every cited `file:line` against HEAD; deduped vs AHW-001..078. This is the LAST validation round — closing QA on register coherence at the bottom.

## Verdicts

| Cand | Codex sev/tag | file:line verified? | Dedup vs index | Verdict | Final (if NEW) |
|------|---------------|---------------------|----------------|---------|----------------|
| CP-1 | LOW / HOST / OURS | YES — `onboarding.ts:69-75`, `get_public_key.c:57-66`, `OnboardPanel.tsx:63-74` | Adjacent AHW-048 (sessionStorage persistence of revealed *secret*) + AHW-064 (path-len gate). Neither covers a *pre-reveal pubkey pseudonym*. | **VALID-NEW** | LOW / HOST / OURS |
| CP-2 | LOW / HOST / MIXED | YES — `webhid-transport.ts:53-63`(create at :61), `ConnectPanel.tsx:39-52`(getVersion probe :51), `dispatcher.c:62,68-74` | No fingerprint/WebHID-presence finding exists. AHW-011/R4-06 are byte-parsing trust-boundary, orthogonal. | **VALID-NEW** | LOW / HOST / **MIXED** (tag confirmed) |
| CP-3 | LOW / HOST / OURS | YES — no silent logger anywhere in `session-embedded-wallet.ts`/`aztec-ledger-session.ts`/app; shim only Node-detects pino | No logging/console finding exists. | **VALID-NEW** | LOW / HOST / OURS |
| CP-4 | INFO / DESIGN / OURS | YES — `vite.config.ts:189-197` (`/aztec`→beast-5), `ConnectPanel.tsx:16-21,110-117` (`DEFAULT_NODE_URL='/aztec'`) | No RPC-operator-metadata finding exists. | **VALID-NEW** | INFO / DESIGN / OURS |
| CP-5 | INFO / TEST / OURS | YES — panel `console.error({name,message,stack})` ×4 (`AccountPanel:70`,`OnboardPanel:121`,`TransferPanel:121`,`ConnectPanel:59`); `app_main.c:40,47` PRINTF (debug-gated) | No error-log-metadata finding exists. | **VALID-NEW** | INFO / TEST / OURS |

**Tally: 5 VALID-NEW, 0 FOLD, 0 DUP, 0 REJECT.** (All LOW/INFO, as predicted. Codex's pre-dedup was accurate; nothing collapsed.)

These promote to **AHW-079..083** (orchestrator assigns). Suggested mapping: CP-1→AHW-079, CP-2→AHW-080, CP-3→AHW-081, CP-4→AHW-082, CP-5→AHW-083.

---

## Tightened detail for VALID-NEW

### CP-1 → AHW-079 · LOW · HOST · OURS
**Pre-reveal stable account/device pseudonym via the cache-key pubkey.** `deviceCacheKey()` (`onboarding.ts:69-75`) returns the full K1 signing pubkey `x‖y` (64 B) as hex; `OnboardPanel.tsx:64` calls it on connect — *before* any viewing-key reveal — to decide cache hit/miss. `getPublicKey` is non-confirmed BY CONSTRUCTION: `get_public_key.c:57-59` rejects `display=1` with `SWO_INCORRECT_P1_P2`, so the host cannot even force a confirmation. Therefore a connected origin harvests a stable, collision-resistant `(seed, path)` pseudonym after a bare connect, can enumerate account indices by varying the path, and can link the ECDSA and Schnorr accounts at the same path (same `(seed,path)` → same K1 pubkey). **Distinct from AHW-048** (which is about persisting the revealed *secret* in sessionStorage) and **AHW-064** (path-LENGTH gate `1≤len≤10`): this is the identifier-linkage property of using an approval-free pubkey as a durable cache ID, present even if AHW-048 and AHW-064 were both fixed. **Bound:** origin-scoped (the origin already has the device); not a secret leak; pseudonym not cross-origin. **Fix dir:** don't use an approval-free pubkey as a persistent cache key — per-tab random handle, or a salted/hashed key that isn't the raw pubkey, or gate caching behind the reveal that already happened.

### CP-2 → AHW-080 · LOW · HOST · MIXED
**WebHID reconnect + custom-INS probe fingerprints "Ledger present + Aztec app open."** Once an origin holds HID permission, `TransportWebHID.create()` (`webhid-transport.ts:61`) silently reuses the authorized device with no new prompt and exposes `productId` (→ device model); `ConnectPanel.onConnect` then fires `getVersion()` (`:51`) — `INS_GET_VERSION` is a CUSTOM `CLA`-gated INS (`dispatcher.c:62` rejects wrong CLA, `:68-74`), so its success/failure cleanly separates "the Aztec app is answering" from any other/no app. **MIXED is the correct tag** (consistent with AHW-016/068): silent reuse + `productId` model-leak is `@ledgerhq/hw-transport-webhid`/browser PLATFORM behavior (LEDGER); the custom-INS app-presence probe is OURS. **Bound:** origin-scoped, not cross-origin; a revisit/usage fingerprint, not key exposure. **Fix dir:** prefer `request()`/privacy mode where available; disclose in UI copy that Connect reveals Ledger + Aztec-app presence.

### CP-3 → AHW-081 · LOW · HOST · OURS
**Default Aztec browser logger emits account/contract/tx metadata to console.** The demo passes NO quiet/silent logger to the embedded wallet or PXE (grep-clean across `session-embedded-wallet.ts`, `aztec-ledger-session.ts`, app; the only logger-related code, `shims/detect-node.ts`, merely detects Node for pino transport, it does not lower the browser level). So `@aztec/foundation`'s logger runs at its default `info`, writing the registered account address + contract addresses/class-ids on connect and tx hashes + simulation metadata on send into the browser console. **Not a secret leak** (no keys/secret), but a second always-on activity channel readable by any same-page script/extension and durable in devtools. **Fix dir:** pass a silent/warn-only logger; scrub addresses/tx-hashes from info-level lines.

### CP-4 → AHW-082 · INFO · DESIGN · OURS
**Hidden third-party RPC operator on the default demo path.** UI shows `/aztec` (`ConnectPanel.tsx:20`, `DEFAULT_NODE_URL`), but `vite.config.ts:189-197` proxies it to `https://rpc.testnet.aztec.beast-5.aztlanlabs.xyz`. That operator therefore sees the user's IP/session metadata, node-polling cadence, registered PUBLIC function signatures, public-call simulations, and submitted txs/hashes. **Confirmed NO path sends the master secret** — private proving is local (`ephemeral` PXE + bundled WASM prover), and the reveal returns the secret to the browser only, never over the RPC. **Fix dir:** surface the real operator URL in the UI, default to blank/self-hosted, document exactly what the node observes. (INFO: testnet, public data, deliberate demo convenience — but undisclosed.)

### CP-5 → AHW-083 · INFO · TEST · OURS
**Failure/diagnostic paths persist wallet metadata.** Every demo panel catch logs `{name, message, stack}` via `console.error` (`AccountPanel.tsx:70`, `OnboardPanel.tsx:121-126`, `TransferPanel.tsx:121`, `ConnectPanel.tsx:59-64`); an Aztec `SimulationError` stack can carry serialized `txRequest`/scopes, making transaction metadata durable in console/Playwright stdout. On-device, `app_main.c:40,47` PRINTF the APDU header and the malformed raw bytes — but PRINTF is DEBUG-build-only on Ledger (compiled out in release), so the device half is dev/test-only, exactly as codex scoped it. Net: mainly a dev/test metadata-durability channel, not a runtime secret leak. **Fix dir:** sanitize browser error logging (don't dump full stacks/addresses by default); keep test harness metadata-mirroring opt-in; keep PRINTF debug-only (already true). Adjacent to CP-3 (both are metadata channels) but distinct mechanism (error/diagnostic path vs steady-state info logging) — keep separate or the orchestrator may fold CP-5 into CP-3; I recommend KEEPING SEPARATE (different trigger, different fix surface, different category TEST vs HOST).

---

## Negatives — soundness check (all CONFIRMED sound)

- **No app-name APDU leak:** `get_app_name.c/.h` exist and `dispatcher.c:29` includes the header, but the dispatcher `switch` has NO `case` for it (cases run GET_VERSION..CXMATH_SPIKE; no app-name). Handler is **dead/unreachable** — codex's claim that the fingerprint is via custom-INS success/failure (CP-2), not a literal app-name query, is **correct**.
- **No analytics/telemetry/beacon:** grep of `apps/demo-browser/src` + `index.html` for analytics/sentry/posthog/gtag/sendBeacon/3p-`<script src>` is **clean**. Sound.
- **Ephemeral PXE/wallet:** `session-embedded-wallet.ts:108` sets `ephemeral: true` (top-level `EmbeddedWalletOptions`); comment confirms it keeps the wallet DB OUT of IndexedDB across reloads. So no extra at-rest secret persistence beyond AHW-048's sessionStorage. Sound.
- **Explorer leakage / no new protocol-timing leak:** not re-verified line-by-line here (StatusBar `rel="noreferrer"` and the AHW-029/048 timing scoping are already VALIDATED in the register); no reason to doubt. Accepted.

The negatives are **credible and correctly reasoned** — no false-clean.

---

## Closing QA — register hand-off readiness

- **Count:** table has exactly **78** unique IDs, **contiguous AHW-001..078, zero gaps** (verified programmatically). + 5 VALID-NEW here → **83** after promotion. The index header still says "Count: 78"; orchestrator must bump to 83 and renumber the "Loop closed" footer (it still says "Stopped at 56 findings", which is **already stale at 78** — a pre-existing doc-debt, NOT introduced this round; flag for cleanup).
- **No double-counts in round-5 additions (AHW-064..078):** checked. AHW-073's defect is correctly noted as living in shared `packages/core` (survives `adapter-trezor` deletion); AHW-074/075/076/077 are correctly scoped under AHW-078's deletion umbrella yet kept as distinct sub-issues (not silently folded). AHW-065/070/071/072 are genuinely distinct (path-grant vs C-dup vs empty-toml vs icon-matrix). No overlap among them or with AHW-008/009/034/035.
- **OURS / LEDGER / MIXED tags:** distribution = 75 OURS, 2 MIXED, 1 LEDGER. The single LEDGER (AHW-029, platform constant-time) is the right call. Both MIXED (AHW-016 rate-limit-over-platform-CT, AHW-068 optimizer-de-CT) correctly split our-mitigation-gap from platform-root. CP-2 joining as MIXED is consistent with that convention. **No mis-tags found.**
- **Coherence:** no severity-vs-detail contradictions spotted in the round-5 block; all VALIDATED rows carry a `Src:`; folds are explicitly marked "no new ID."

**Verdict: audit-handoff-ready** after two mechanical doc fixes (NOT findings work): (1) bump the header count 78→83 and add AHW-079..083 rows; (2) correct the stale "Stopped at 56 findings" footer. Substantively the register is coherent, deduped, and correctly tagged. The IMPACT-thinning call is vindicated — this final round yielded **only LOW/INFO privacy/metadata items, 0 HIGH/CRITICAL, 0 rejects, 0 dups** — the textbook diminishing-returns signal to STOP.
