<!-- Validator V2 — cluster SUPPLY-CHAIN / PUBLIC-API / ATTESTATION / CUSTODY.
     Source-verified every cited file:line. Local refs only (V2-NN); no global AHW numbers assigned.
     Inputs: H-codex-wire-codegen, J-opus-onboarding-attestation, K6-build-supplychain,
             K7-consumer-api-misuse, K10-recovery-custody. -->

# Validated — V2 cluster

## Verdict table

| Local | Source F-id | Title (short) | Verdict | FINAL Sev | Owned | Note |
|-------|-------------|---------------|---------|-----------|-------|------|
| V2-01 | F-H-1 / F-K6-2 (MERGED) | Deploy-profile `sponsor_*`/`deployer` + emitted `*.gen.*` tables never canonical-verified → poisoned build signs hidden sponsor/deployer | **ACCEPT (merge)** | HIGH | OURS | Same root: unverified codegen→signed-device path. Distinct from AHW-035 (host node_modules provenance) by device/display consequence. |
| V2-02 | F-K6-1 | Mutable GitHub Action refs in firmware build gate | **ACCEPT** | MED (was HIGH) | OURS | Real net-new gap, but owner PARKED all CI hygiene; no runtime device hole; Docker images ARE digest-pinned. Downgrade. |
| V2-03 | F-K6-3 | CI blesses the same ELF it built (no independent rebuild / digest gate) | **ACCEPT** | MED | OURS | Reproducibility/attestation gap. Sibling to AHW-034 (source provenance) but distinct (binary attestation). CI-hygiene class → MED. |
| V2-04 | F-K6-4 | BOLOS SDK identity not asserted/recorded at build | **FOLD → V2-03** | (MED) | MIXED | Same "build output unattested" theme; SDK-id is one facet of the missing build-provenance record. Local-harness `:latest` overlaps AHW-069. |
| V2-05 | F-K7-1 | Root-exported `LedgerProvider.signOuterHash` = blind-sign oracle outside entrypoint | **ACCEPT** | HIGH | OURS | Distinct from AHW-002 (now CLOSED — `internalDeps` strips session+ledgerProvider). This is the *published root barrel* raw signer; a different escape hatch. |
| V2-06 | F-K7-2 | Root barrel exports reveal + `loadCachedSecret` reread of privacy root | **ACCEPT** | HIGH→**MED** | OURS | Real published-API composition gap; but in-process same-origin only (cache is memory-only, AHW-048). No 2nd-device-prompt bypass across origins. Calibrate MED. |
| V2-07 | F-K7-3 | Public `setEntrypointOverride`/`overrideAccount` policy-escape seams | **ACCEPT** | MED | OURS | Verified public on exported classes. Distinct from AHW-088 (the shared-map non-revert *bug*); this is the *exposed seam at the boundary*. |
| V2-08 | F-J-1 | Onboard/receive address host-derived, NEVER device-attested; reveal checksum binds SECRET not address | **ACCEPT** | HIGH | OURS | Source-confirmed. Root is adapter/wire trust model (IN SCOPE), surfaces in frontend. Distinct from AHW-044/045/047/087. |
| V2-09 | F-J-2 | Signing pubkey fetched approval-free from 2 provider instances, no cross-check | **ACCEPT** | MED | OURS | Verified: `deviceCacheKey` throwaway provider vs `getPublicKeyXY` `cachedXY` — no byte-equal assert. Distinct from AHW-087 (sig-verify). |
| V2-10 | F-K10-1 | Single-seed custody (impl derives `sk` from HW seed) vs spec's 2-of-2 split-brain | **ACCEPT (downgrade)** | HIGH→**MED** | OURS | Real DESIGN contradiction, but **doc/spec↔impl mismatch, not a runtime exploit**. Runtime consequence already = AHW-047. Honest calibration: MED. |
| V2-11 | F-K10-2 | Onboarding UI hard-limits recovery to account indices 0–4 | **ACCEPT** | MED | OURS | Verified `OnboardPanel.tsx:163` `[0,1,2,3,4]`; `apdu.ts` accepts uint31. UX/recovery footgun. Novel. |
| —     | F-J-3 | Host-rendered "Device verified"/"✓ on-device" copy w/o device anchor | **ACCEPT** | LOW | OURS (APP) | Out-of-primary-scope (frontend) but valid anti-phishing inconsistency; substrate for V2-08. Keep LOW. |
| —     | — | All "Confirmed clean" negatives in H/J/K6/K7 | **ACCEPT (negatives)** | — | — | Independently spot-verified the load-bearing ones (gen-check fail-closed on class-id/ctor; AHW-002 closed; createAuthWit throws; B3/deploy device-authored; bunfig min-age; Docker digest-pins). |

**Counts:** ACCEPT 10 · MERGE 1 (V2-01) · FOLD 1 (V2-04→V2-03) · DOWNGRADE 3 (V2-02 H→M, V2-06 H→M, V2-10 H→M) · REJECT-INVALID 0.
Raw HIGH candidates entering: 6 (F-H-1, F-K6-1, F-K6-2, F-K6-3, F-K7-1, F-K7-2, F-J-1, F-K10-1 = 8 actually). **Surviving HIGH after consolidation: 3** (V2-01, V2-05, V2-08).

---

## Reasoning — merges / folds / downgrades / rejects

### MERGE: V2-01 = F-H-1 ⊕ F-K6-2
Source-verified both:
- `crossCheckDeployProfile` (`gen-clear-signing-v0.ts:478-531`) asserts ONLY `account_class_id`, `ctor_selector_u32`, `ctor_arg_schema`, `ctor_arg_byte_len`. It NEVER touches `.deployer`, `.sponsor_fpc_address`, `.sponsor_selector_u32` — confirmed; the emitter (`:574-598`) blindly serializes those three into `CS_DEPLOY_PROFILES`.
- The device signs them: `deploy_review_ui.c:106-107` renders only `"Sponsored (testnet)"` (no sponsor address/selector on screen — verified), while the deploy outer-hash consumes `sponsor_fpc_address`/`sponsor_selector_u32` and `account_binding_deploy_partial` consumes `deployer`.
- F-K6-2's "firmware workflow compiles unchecked `*.gen.*`" is the **build-gate facet of the same defect**: `ledger-app.yml:63` runs `make` directly; the `gen:clear-signing-v0:check` gate lives in a SEPARATE workflow (`ci.yml:33`) with its own `dorny/paths-filter` (`ledger-app.yml` filters on `ledger-app/**` + `packages/adapter-ledger/**`; `ci.yml` is unconditional on push/PR to main — so on a PR it DOES run, but the firmware-build job does not *depend* on it and won't gate `make` on gen drift). And even when the gate runs, it does not check the sponsor/deployer literals (the F-H-1 hole). **Same root → one finding:** unverified codegen literals flow into the signed/displayed deploy path; no codegen, CI, or runtime equality check on `sponsor_*`/`deployer`. Merging avoids double-counting "unverified codegen→device." Keep F-K6-2's build-gate fix-sketch as the second remediation lever.
- **Distinct from AHW-035:** AHW-035 = host-side mutable `node_modules`/comment-only `_meta` pin (the artifact the codegen *reads from*). V2-01 = the *emitted* literals that are outside that cross-check entirely AND reach a hidden signed field. Confirmed distinct.
- **Distinct from F-D-2** (dead `fee_mode`) and **AHW-034** (firmware source provenance).
- One honest caveat carried from F-H-1: in the *current stock* path a C-table-only drift mostly fails closed because the live host payload comes from `new SponsoredFeePaymentMethod(...)`; the HIGH is realized only when a poisoned build aligns host config + generated tables. The codegen/CI gap that *permits* that alignment is the defect → HIGH stands (it's a missing fail-closed gate on a value that reaches signing and is never shown).

### DOWNGRADE: V2-02 (F-K6-1) HIGH → MED
Mutable action refs (`actions/checkout@v6`, `dorny/paths-filter@v4`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/setup-python@v5`) are all real and net-new (not in AHW-001..094). But: (1) the owner has **explicitly PARKED all CI/build hygiene** ("don't care about CI" — see index PARKED list AHW-031..072); (2) the high-risk container images ARE digest-pinned (`ledger-app.yml:49,107`, `ci.yml:52`) — the codex "confirmed clean" is accurate; (3) no runtime device consequence. This is a genuine pre-external-audit release-gate, but a SHA-pin chore, not a HIGH runtime hole. MED, BUILD, OURS — release-gate class with AHW-034/066.

### DOWNGRADE: V2-06 (F-K7-2) HIGH → MED
Verified the exports (`index.ts:53,61-66`) and `loadCachedSecret` (`secret-cache.ts`). The composition IS a footgun: any in-process consumer can `deviceCacheKey` (approval-free) → `loadCachedSecret` → pull the `Fr` after one legitimate reveal. But the blast radius is **same-origin, same-page-lifetime, in-process only** — the cache is memory-only (AHW-048 fix, re-confirmed), so there is no persistent/cross-origin exfil and no bypass of a *second device approval* across sessions. It's a defense-in-depth API-surface hardening (move cache access internal), not a remote-exploitable HIGH. Adjacent to AHW-047/048 (reveal scope/lifetime) — V2-06 is the published-API-composition slice, distinct, MED.

### DOWNGRADE: V2-10 (F-K10-1) HIGH → MED — the calibration call you flagged
Source-verified the contradiction:
- Spec (`03-recovery-and-backup.md:11-24,130-134`): two secrets; protocol `sk` host-generated via `Fr.random()`; **"Do not derive `sk` from the HW seed"** (collapses split-brain).
- Impl (`master-secret.ts:1-26,66-74`): `master_secret = SHA-512(DOMAIN ‖ secp256k1-child-privkey) mod Fr`, revealed and fed straight into `deriveKeys()` (`onboarding.ts:1-16`). UI (`ConnectPanel.tsx`) says the seed *is* the backup.
**This is real and worth recording, but it is a doc/architecture ↔ implementation mismatch, NOT a runtime exploit.** No attacker action is enabled *by the mismatch itself*. The actual runtime security fact it implies — "one approval exports the path-wide privacy ROOT; seed compromise = full privacy-root compromise for that path" — is **already captured as AHW-047 (HIGH)**. So promoting F-K10-1 to a second runtime HIGH would double-count AHW-047's consequence. Honest severity: MED, DESIGN — "fix the docs/UI to declare the actual single-seed model, or build the documented Design C/D." The recovery doc lives in `../aztec-hardware-wallet/architectures/` (research repo, out of the PoC signing-scope), which further argues against runtime-HIGH. Distinct from AHW-047 (that's the export-scope finding; this is the custody-model contradiction) and AHW-038 (missing custody DOC).

### FOLD: V2-04 (F-K6-4) → V2-03 (F-K6-3)
Both are "the built artifact carries no machine-readable proof of how it was produced." F-K6-3 = no independent rebuild + `app.sha256` never consumed as a gate (verified: `ledger-app.yml` uploads `build/**`+`bin/**`, test jobs download the same; README mentions `app.sha256` but no job verifies it). F-K6-4 = BOLOS SDK revision not asserted/emitted (verified `Makefile` only checks `BOLOS_SDK` exists, blindly includes `Makefile.target`). SDK-identity is one input to the missing provenance record → fold into one "build provenance/attestation" finding (MED). The local-harness `ledger-app-builder-lite:latest` half overlaps AHW-069 (toolchain pin).

### ACCEPTs without downgrade — why they hold at stated severity
- **V2-05 (F-K7-1) HIGH:** `provider.ts:214` `signOuterHash(bip32Path, outerHash)` accepts a caller-chosen 32-byte digest and sends `INS.SIGN_OUTER_HASH`, and `index.ts:55` root-exports `LedgerProvider`. This sits entirely outside `LedgerClearSigningEntrypoint`; the only guard is the device blind-sign NVM toggle (default-OFF). AHW-002 is CLOSED (`internalDeps` strips the bypasses — verified `aztec-ledger-session.ts:441-451`), so this is a *genuinely distinct* surviving escape: the published root barrel hands every downstream consumer a raw blind-sign primitive. HIGH for a published wallet SDK boundary. (Today only the in-repo `dist` bundle calls it — no external misuse yet — but the export is the latent capability.)
- **V2-08 (F-J-1) HIGH:** Verified end-to-end. Onboard derives the session secret from the device-revealed master secret, but the **address** is computed host-side (`AccountManager.create`), and the device's only onboard cross-check (reveal checksum, `master-secret.ts:79-85`) is over the SECRET (16-bit SHA-256 prefix), not the address. The device renders an address only on the DEPLOY review (`deploy_review_ui.c:105`, device-derived `address_local`), which is skipped for already-deployed accounts. So a malicious host shows a host-chosen receive address with a genuinely-matching device checksum. Distinct from AHW-044 (Speculos panel authoritative), AHW-045 ("cached" string), AHW-047 (reveal scope), AHW-087 (sig-verify of signature, not pubkey/address). The index's "address pill IS device-attested" negative is scoped to SEND/DEPLOY (B3) and does NOT cover the receive/onboard surface. Root is the adapter/wire trust model (IN SCOPE); it manifests in `apps/*` display. HIGH.
- **V2-07 (F-K7-3) MED, V2-09 (F-J-2) MED, V2-11 (F-K10-2) MED:** all source-verified above; severities calibrated as published-seam / identity-split / recovery-UX respectively. None are runtime fund-loss without a second precondition.

### No rejects
Every candidate is source-confirmed real. No false positives in this cluster.

---

## Ready-to-index blocks (ACCEPTED — schema per `_state.md`; orchestrator assigns AHW-###)

### V2-01 [merge F-H-1 ⊕ F-K6-2]: Deploy-profile sponsor/deployer literals + emitted `*.gen.*` tables are never canonical-verified → poisoned build signs a hidden sponsor/deployer the user is not shown
- Severity: HIGH — codegen/CI/runtime have NO equality check on `sponsor_fpc_address`, `sponsor_selector_u32`, `deployer`; the device signs them while the screen shows only "Sponsored (testnet)". A poisoned release that aligns host config + generated tables signs a different sponsor/deployer call than reviewed.
- Owned: OURS — codegen pipeline (`gen-clear-signing-v0.ts`) + firmware build gate + deploy review flow
- Category: BUILD
- Location: `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:478-531,574-598`; `packages/adapter-ledger/clear-signing-v0/manifest.json` (deploy_profiles); `ledger-app/src/handler/finalize_deploy_and_sign.c:191-212`; `ledger-app/src/ui/deploy_review_ui.c:106-112`; `ledger-app/src/l4/account_binding.c:57-71`; `.github/workflows/ledger-app.yml:63` (build runs `make` with no gen-drift gate); `.github/workflows/ci.yml:33` (gen-check in a separate workflow, doesn't gate the firmware build, and checks only class-id/ctor); `packages/adapter-ledger/src/deploy-outer-hash-parity.test.ts:96-107`
- What: `crossCheckDeployProfile` asserts only `account_class_id`/`ctor_selector_u32`/`ctor_arg_schema`/`ctor_arg_byte_len`; `deployer`/`sponsor_fpc_address`/`sponsor_selector_u32` are emitted into `CS_DEPLOY_PROFILES` unchecked. The firmware workflow compiles those generated tables (`make`) with no in-job gen-drift reconciliation; the only gen-check is in a separate workflow and is itself blind to these three fields. The parity test recomputes the sponsor selector from a signature constant, never reading the generated table.
- Attack/impact: build-time actor (or anyone who can land a `*.gen.*` edit aligned with host config) ships an `app.elf` that signs a deploy to an attacker sponsor FPC / selector / deployer while the review screen still reads "Sponsored (testnet)". Stock-path drift mostly fails closed (host payload from the live `SponsoredFeePaymentMethod`), so realization requires a coordinated poisoned build — the *missing fail-closed gate* is the defect.
- Evidence: source-verified all cited lines (V2 read `gen-clear-signing-v0.ts:478-598`, `deploy_review_ui.c:98-112` shows only `g_fee_str="Sponsored (testnet)"`, `ledger-app.yml:63` runs `make BOLOS_SDK=...` directly, `ci.yml:33` is the only `gen:clear-signing-v0:check`).
- Fix sketch: fail-closed at codegen on canonical equality for `sponsor_selector_u32`/`sponsor_fpc_address`/`deployer` against the real deploy path; gate the firmware build on gen-drift (rebuild+diff or run the check in `ledger-app.yml`); make the parity test consume `CS_DEPLOY_PROFILES`; show the sponsor FPC address/checksum on the deploy review screen.
- Confidence: high
- Dedup-check: distinct from AHW-035 (host node_modules/comment-pin provenance), AHW-034 (firmware source provenance), F-D-2 (dead fee_mode). Merges F-H-1 (device/display consequence) + F-K6-2 (missing build gate on emitted sources) — same root.

### V2-02 [F-K6-1]: Mutable GitHub Action refs in the firmware build + CI gates
- Severity: MED — moving action tags can change what source is checked out / whether the firmware job runs / which artifact is archived; but owner-PARKED CI-hygiene class, container images already digest-pinned, no runtime device hole.
- Owned: OURS
- Category: BUILD
- Location: `.github/workflows/ledger-app.yml:19,59,66,85,96,147,149,158`; `.github/workflows/ci.yml:19,23,50`
- What: `uses:` targets are mutable tags (`actions/checkout@v6`, `dorny/paths-filter@v4`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/setup-python@v5`), not full commit SHAs. The Docker `container:`/`docker://` images ARE digest-pinned (correct).
- Attack/impact: a compromised/ref-retargeted action could skip the firmware job, mutate the workspace, or swap the tested/flashed ELF.
- Evidence: source-verified the `uses:` lines; `ledger-app.yml:49,107` + `ci.yml:52` confirmed digest-pinned (codex negative accurate).
- Fix sketch: pin every `uses:` to a full commit SHA (Renovate-free, manual per project policy).
- Confidence: high
- Dedup-check: novel; distinct from AHW-031/033/035/039/067/069/072 (coverage/audit-swallow/codegen/lockfile/-Werror/clang/matrix). Release-gate class — revisit before external-audit submission.

### V2-03 [F-K6-3 ⊕ folds F-K6-4]: Built `app.elf` is self-blessed — no independent rebuild, digest gate, or recorded BOLOS-SDK identity
- Severity: MED — the exact ELF that ships is neither independently reproduced nor digest-verified between jobs, and the build emits no machine-readable proof of the SDK/toolchain that produced it.
- Owned: MIXED — our build interface + Ledger BOLOS SDK
- Category: BUILD
- Location: `.github/workflows/ledger-app.yml:66,96,104` (upload→download same artifact; Speculos runs `/app/app.elf`); `ledger-app/README.md:41` (`app.sha256` produced but never consumed as a gate); `ledger-app/Makefile:7,11` (only checks `BOLOS_SDK` exists, blindly includes `Makefile.target`/`Makefile.standard_app`); `ledger-app/tests/README.md` (local harness uses `ledger-app-builder-lite:latest`)
- What: the build job uploads `build/**`+`bin/**`; the Speculos and ragger jobs download and test that same artifact — no second clean rebuild, `app.sha256` is never verified between jobs, and no expected SDK version/hash is asserted or emitted.
- Attack/impact: if builder/workflow/artifact handling is compromised, the compromised ELF is exactly what gets tested and flashed (same-artifact validation, not reproducibility). A stale/malicious SDK silently changes codegen with no recorded proof.
- Evidence: source-verified `ledger-app.yml:65-76` (upload), `:95-99,149-155` (download same), `:104-110` (Speculos `/app/app.elf`); `Makefile` SDK handling.
- Fix sketch: add a second clean rebuild that must match byte-for-byte; verify the ELF digest between jobs before tests count; assert+emit an expected BOLOS-SDK version/hash alongside `app.sha256`; point the local harness at the same digest-pinned builder as CI. Prefer signed provenance over a bare hash.
- Confidence: high
- Dedup-check: distinct from AHW-034 (source-tree provenance) and AHW-069 (clang drift inside builder). Folds F-K6-4 (unasserted SDK identity = one facet of the missing build-provenance record). Release-gate class.

### V2-05 [F-K7-1]: Root-exported `LedgerProvider.signOuterHash` is a published blind-sign oracle outside the clear-signing entrypoint
- Severity: HIGH — the package root barrel hands every downstream consumer a raw 32-byte-digest signer; the only guard is the device blind-sign toggle. Distinct from the now-closed AHW-002.
- Owned: OURS
- Category: WIRE
- Location: `packages/adapter-ledger/src/index.ts:55` (`export { LedgerProvider ... }`); `packages/adapter-ledger/src/provider.ts:214-236` (`signOuterHash(bip32Path, outerHash)` → `INS.SIGN_OUTER_HASH`)
- What: `signOuterHash` accepts a caller-chosen 32-byte hash and signs it directly, bypassing `LedgerClearSigningEntrypoint`'s call-manifest review. It is reachable by any consumer that imports the public root.
- Attack/impact: a hostile downstream consumer obtains signatures over arbitrary unreviewed hashes whenever blind-signing is enabled, fully bypassing clear-sign.
- Evidence: source-verified both lines; `LedgerClearSigningEntrypoint` guards (`clear-signing-entrypoint.ts`) are bypassed entirely by the raw call; AHW-002's `internalDeps` strip (`aztec-ledger-session.ts:441-451`) confirmed CLOSED, so this is a separate escape.
- Fix sketch: remove the raw signer from the root barrel, or relocate it behind an explicit `unsafe`/onboarding subpath that safe consumers do not import by default.
- Confidence: high
- Dedup-check: distinct from AHW-002 (closed `internalDeps` bypass) — this is the published root export of the raw signer after that rewrite.

### V2-06 [F-K7-2]: Root barrel exports the reveal + cache-reread surface for the privacy root
- Severity: MED — published-API composition lets any in-process consumer reread the revealed `Fr` after one legitimate reveal; in-process/same-origin only (cache is memory-only), so defense-in-depth hardening, not remote-exploitable.
- Owned: OURS
- Category: DESIGN
- Location: `packages/adapter-ledger/src/index.ts:53,61-66` (`revealMasterSecret`, `deviceCacheKey`, `cacheSecret`, `loadCachedSecret`); `packages/adapter-ledger/src/secret-cache.ts` (`loadCachedSecret` returns the cached `Fr`); `packages/adapter-ledger/src/onboarding.ts:77-83` (`deviceCacheKey` builds the key from approval-free `getPublicKey`)
- What: the root exports both the approval-gated reveal and a silent in-process reread keyed by the approval-free pubkey; a second component can derive the key and pull the `Fr` without a second device approval.
- Attack/impact: a hostile same-page consumer exfiltrates the path-wide privacy root during the page lifetime with no second prompt.
- Evidence: source-verified exports + `secret-cache` reread; memory-only cache re-confirmed (AHW-048).
- Fix sketch: keep cache access internal to the onboarding/session layer; export only a presence check / opaque handle; move the reveal seam off the default barrel if it must stay public.
- Confidence: high
- Dedup-check: distinct from AHW-047 (reveal scope), AHW-048 (storage lifetime), AHW-079 (pubkey pseudonym) — this is the published-API composition that makes the root rereadable in-process.

### V2-07 [F-K7-3]: Public `setEntrypointOverride` / `overrideAccount` seams route framework flows around the safe entrypoint
- Severity: MED — published mutations let a consumer install caller-controlled signing logic for `sendTx`/deploy; becomes a full clear-sign bypass only when paired with V2-05.
- Owned: OURS
- Category: DESIGN
- Location: `packages/adapter-ledger/src/ledger-account-contract-base.ts:32-48` (`setEntrypointOverride`, `getAccount` wraps any override in `BaseAccount`); `packages/adapter-ledger/src/account-contract.ts:24`; `packages/adapter-ledger/src/session-embedded-wallet.ts:81-83` (`overrideAccount`)
- What: exported contract/session classes expose `setEntrypointOverride(EntrypointInterface|null)` and `overrideAccount(address, Account)` as public, unbranded, un-allowlisted mutations.
- Attack/impact: a hostile consumer replaces `LedgerClearSigningEntrypoint` with arbitrary logic for normal flows; with V2-05's raw signer that is a complete clear-sign bypass inside the supported account abstraction.
- Evidence: source-verified; internal callers (`aztec-ledger-session.ts:372/395/620`) use set→null around deploy and override on transfer/drip — so the seam is genuinely public.
- Fix sketch: make these seams internal/test-only, or restrict them to an internal branded entrypoint type rather than arbitrary `EntrypointInterface`/`Account`.
- Confidence: med
- Dedup-check: distinct from AHW-088 (the shared-map non-revert *bug* on transfer/drip) — this is the exposed override *seam at the published boundary*.

### V2-08 [F-J-1]: Onboard/receive address is host-derived and NEVER device-attested; the reveal checksum binds the SECRET, not the address
- Severity: HIGH — defeats "this address is controlled by your device" on the receive/identity surface; a malicious host presents a host-chosen address with a genuinely-matching device checksum, and the only device address-attestation (deploy review) is skipped for already-deployed accounts.
- Owned: OURS
- Category: DESIGN
- Location: `packages/adapter-ledger/src/aztec-ledger-session.ts:252-256` (host derives `accountManager.address`, no device round-trip); `packages/adapter-ledger/src/onboarding.ts:42-57`; `packages/adapter-ledger/src/master-secret.ts:79-85` (checksum = 16-bit SHA-256 over the SECRET); `ledger-app/src/ui/master_secret_reveal_ui.c:64-86` (device shows `Account #N` + checksum, no address); `apps/demo-browser/src/panels/OnboardPanel.tsx:103,199-204`; `apps/demo-browser/src/panels/AccountPanel.tsx:28-29,93,110` (skips Deploy when `alreadyDeployed`); `apps/demo-browser/src/panels/TransferPanel.tsx:163-172`; device-side: `get_aztec_master_secret.c`/`get_public_key.c` render no address; only DEPLOY re-derives+rejects (`begin_deploy_account.c:150-153`, `finalize_deploy_and_sign.c:174-183`)
- What: at onboard the device attests the master SECRET (via the checksum the user compares) but never the ADDRESS; the address is computed host-side via `AccountManager.create`. The address becomes device-attested only on a Deploy or a Transfer/Drip (B3) — and Deploy is auto-suppressed on a host-controlled `alreadyDeployed`.
- Attack/impact: a malicious host does a genuine reveal (checksum matches, since it certifies the secret), then displays an attacker-chosen receive address and forces `alreadyDeployed=true` to suppress the only device address check. The user, told "checksum should match the device screen," trusts the host-rendered address; funds sent there go to the attacker.
- Evidence: source-verified the onboard handlers render no address; `master-secret.ts:84` checksum is `subarray(0,2)` over the secret; `OnboardPanel.tsx` copy + `AccountPanel.tsx` deploy-suppression; deploy review (`deploy_review_ui.c:105`) shows the DEVICE-derived address — proving the team knows the address must be device-authored, but only on the deploy path.
- Fix sketch: add an approval-gated `GET_AZTEC_ADDRESS` INS the device derives from its own secret+salt+pubkey and renders 8+6; or fold an address fingerprint into the reveal Confirm pair; or never render an address as device-associated until a device path has attested it, and stop auto-suppressing Deploy on host-supplied `alreadyDeployed`. Widen the 16-bit secret checksum if kept.
- Confidence: high
- Dedup-check: distinct from AHW-044/045 (display fidelity of device-shown values), AHW-047 (reveal scope), AHW-087 (sig-verify). The "address pill is device-attested" negative is scoped to SEND/DEPLOY and excludes the onboard/receive surface. Novel.

### V2-09 [F-J-2]: Signing pubkey (account identity) fetched approval-free from two provider instances with no cross-consistency check
- Severity: MED — a selective-MITM/compromised transport can feed a different pubkey to the cache-key probe vs the address-deriving ctor probe; the inconsistency is detected only later at deploy (or never on the already-deployed path).
- Owned: OURS
- Category: WIRE
- Location: `packages/adapter-ledger/src/onboarding.ts:77-83` (`deviceCacheKey` uses a fresh `new LedgerProvider(transport).getPublicKey`); `packages/adapter-ledger/src/auth-witness-provider.ts:79-89` (`getPublicKeyXY` caches its own `cachedXY`); `packages/adapter-ledger/src/account-contract.ts:41` (ctor args use `getPublicKeyXY`); `packages/adapter-ledger/src/provider.ts:64-76` (`getPublicKey` length-checked only, never verified)
- What: the account-defining pubkey `x‖y` is read approval-free at least twice from two different provider instances with no byte-equal assert and no verification against the revealed secret.
- Attack/impact: a MITM returns pubkey A to the cache-key probe and pubkey B to the ctor/address probe — the cached secret, displayed address, and deployable account become mutually inconsistent with no host detection; fails closed only at deploy (0x6F0F), which the already-deployed path skips. Compounds V2-08.
- Evidence: source-verified the two independent reads; no comparison anywhere; no `secp.verify` of pubkey↔secret.
- Fix sketch: fetch the pubkey once and thread the single value to both consumers (like the single-source bip32Path discipline); and/or device-attest the pubkey→address binding; at minimum assert the two reads are byte-equal.
- Confidence: high
- Dedup-check: distinct from AHW-087/F-C-3 (sig-verify of the SIGNATURE), AHW-079 (pubkey pseudonym), AHW-064 (path-length gate). Novel.

### V2-10 [F-K10-1]: Implementation derives the Aztec master secret from the HW seed (single-seed custody) while the recovery spec mandates a 2-of-2 split-brain
- Severity: MED — real architecture↔implementation contradiction, but a doc/spec mismatch, NOT a runtime exploit; the runtime consequence (privacy-root export) is already AHW-047.
- Owned: OURS
- Category: DESIGN
- Location: `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md:11-24,77,128-134` (two secrets; `sk` host-generated via `Fr.random()`; "Do not derive `sk` from the HW seed"); `packages/adapter-ledger/src/master-secret.ts:1-26,66-74` (`master_secret = SHA-512(DOMAIN ‖ child-privkey) mod Fr`); `ledger-app/src/l4/aztec_secret.c:28`; `packages/adapter-ledger/src/onboarding.ts:1-16` (feeds the revealed secret into onboarding); `apps/demo-browser/src/panels/ConnectPanel.tsx:139` ("the device (its seed) is the backup")
- What: the spec claims two independent secrets and forbids deriving the protocol root from the HW seed; the shipped code derives the Aztec master secret deterministically from the BIP-32 child private key and treats the seed as the sole backup.
- Attack/impact: integrators/auditors defend the wrong asset; in the live impl, seed/path compromise reconstructs the protocol/privacy root for that path (no passphrase/SLIP-39 second factor). Operational procedures built around a separate protocol-secret backup are fiction.
- Evidence: source-verified the spec text and `master-secret.ts` derivation; the runtime export consequence is AHW-047.
- Fix sketch: either implement the documented Design C/D, OR rewrite the architecture/UI/docs to declare the actual single-seed model and its consequence (seed compromise = full privacy-root compromise for that path; seed loss strands the account).
- Confidence: high
- Dedup-check: distinct from AHW-047 (reveal export SCOPE — the runtime HIGH) and AHW-038 (missing custody DOC). This is the custody/recovery MODEL contradiction (doc-vs-impl), recorded as MED to avoid double-counting AHW-047.

### V2-11 [F-K10-2]: Onboarding UI hard-limits recovery to account indices 0–4
- Severity: MED — the protocol/device accept any uint31 account index, but the only shipped onboarding picker is `[0,1,2,3,4]`; a user with funds at index >4 is pushed to an empty account and may misread it as loss.
- Owned: OURS
- Category: APP
- Location: `apps/demo-browser/src/panels/OnboardPanel.tsx:163` (`{[0, 1, 2, 3, 4].map(...)}`); `packages/adapter-ledger/src/apdu.ts:125` (`defaultAztecPath` accepts any uint31 up to `0x7fff_ffff`)
- What: the account picker is a fixed five-item dropdown while the derivation path supports arbitrary indices.
- Attack/impact: a user funding `m/44'/AZTEC'/n'/0/0` for `n>4` cannot select it in recovery/onboarding and can misinterpret the empty default as asset loss.
- Evidence: source-verified `OnboardPanel.tsx:163` and `apdu.ts` range.
- Fix sketch: replace the fixed dropdown with a validated free-form index input or an account-discovery flow.
- Confidence: high
- Dedup-check: novel; distinct from AHW-018/079/094.

### F-J-3 [LOW]: Host-rendered "Device verified"/"✓ on-device" copy with no device-attested anchor
- Severity: LOW — anti-phishing/UX inconsistency (the project's own CSS rule forbids host "verified" badges on the address pill); the social-engineering substrate for V2-08, separately fixable.
- Owned: OURS
- Category: APP
- Location: `apps/demo-browser/src/panels/ConnectPanel.tsx:127` ("Device verified." after only `getVersion()`); `apps/demo-browser/src/panels/OnboardPanel.tsx:197-198` ("✓ Viewing keys derived on-device."); `apps/demo-browser/src/style.css:5-12,391-393` (the anti-"verified-badge" rule)
- What: React panels print host-authored "verified/✓ on-device" status not bound to any device-attested value (except the secret checksum, which per V2-08 doesn't certify the address).
- Attack/impact: no direct exploit; primes the user to trust host-rendered values (the address) the device never attested.
- Evidence: source cited by F-J-opus; consistent with the in-repo CSS anti-phishing rule.
- Fix sketch: scope the copy to what's proven ("App responding" not "Device verified"); drop standalone green ✓ unless tied to a device-attested address fingerprint.
- Confidence: high (note: APP/frontend — outside the campaign's primary FW+WIRE scope, but the root is the same trust-model gap as V2-08).
- Dedup-check: distinct from AHW-054 (on-DEVICE "(verified)" halo) and AHW-044. Novel.
