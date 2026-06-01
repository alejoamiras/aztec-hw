# Round 2 — opus — supply-chain + build/CI + cross-package consistency + operational recovery

Angle: supply chain, build/CI, cross-package consistency, operational recovery/custody.
NOT protocol crypto, NOT host-API trust-boundary (other reviewers).
Method: read real config/workflows/code; cite `file:line` / path. Round-1 dups flagged.

Legend: Sev = CRITICAL/HIGH/MED/LOW/INFO. Cat = HOST/APP/PLATFORM/DESIGN/BUILD/TEST.
Owned = OURS / LEDGER / MIXED.

---

## NEW-R2-01 · HIGH · BUILD · OURS — CI typecheck gate is RED on committed `main` (8 TS errors, exit 2)
**Path:** `.github/workflows/ci.yml:36` runs `bunx tsc -b --noEmit packages/core packages/adapter-trezor packages/adapter-ledger apps/demo`.
**Substantiation (ran the exact command on the committed tree, all 4 files clean vs HEAD):**
```
EXIT CODE: 2 — 8× "error TS"
packages/adapter-ledger/src/grumpkin-point-add-edge.test.ts(30,12): TS2322 (string|undefined → string)
packages/adapter-ledger/src/grumpkin-point-add-edge.test.ts(30,21): TS2322
packages/adapter-ledger/src/wire-differential-replay.test.ts(158,13): TS2345
packages/adapter-ledger/src/wire-differential-replay.test.ts(158,39): TS2532 / TS2345
apps/demo/src/clear-sign-testnet.ts(120,34): TS2339 createAuthWitFromIntent missing on LedgerEcdsaKAuthWitnessProvider
apps/demo/src/clear-sign-testnet.ts(123,57): TS7006 implicit any
apps/demo/src/index.ts(121,9): TS2322 type mismatch
```
**Impact:** the "Typecheck all packages" PR gate either fails on every run (and is being merged-around / ignored), or `main` is shipping type-unsafe. Two NET-NEW root causes:
(a) `adapter-ledger/src/grumpkin-point-add-edge.test.ts:30` (`o[0]`,`o[1]`) and `wire-differential-replay.test.ts:158` (`files[i]`,`lines[i]`,`...split()[1]`) violate `noUncheckedIndexedAccess` — these are LIVE test files, not dead demo code, and are unrelated to AHW-028;
(b) `apps/demo` calls the retired `createAuthWitFromIntent` (root cause overlaps AHW-028, but the *consequence* — a perpetually-red gate — is new).
A broken typecheck gate gives false assurance and lets real type regressions land. An auditor will immediately ask "is CI actually green?"
**Fix dir:** fix the two test-file index accesses (guard or `!`), delete/repair `apps/demo` (see NEW-R2-02), and add a tiny CI smoke assertion that the typecheck step's own exit code is honored (it is — but the gate has clearly been bypassed, so confirm branch protection requires it green).
**Overlap:** partial w/ AHW-028 (apps/demo deleted-API) — but the test-file `noUncheckedIndexedAccess` errors and the "CI is red" framing are NET-NEW. Validator: keep separate from AHW-028.

## NEW-R2-02 · MED · BUILD · OURS — CI typechecks the DEAD demo (`apps/demo`) but NOT the LIVE one (`apps/demo-browser`); no e2e in CI
**Path:** `.github/workflows/ci.yml:36` lists `apps/demo`; grep confirms `apps/demo-browser` appears in **zero** workflows. A full Playwright e2e suite exists (`apps/demo-browser/e2e/`, `apps/demo-browser/playwright.config.ts`) but no workflow runs Playwright.
**Impact:** the demo that's actually shipped/recorded (`apps/demo-browser`, React+Vite in-browser PXE) has **no** typecheck and **no** e2e coverage in CI, while the broken legacy CLI demo (`apps/demo`) is what's gated. Regressions in the real demo (the security-relevant clear-signing UI panels) land silently. Inverted coverage.
**Fix dir:** swap `apps/demo` → `apps/demo-browser` in the typecheck list (or include both once apps/demo is fixed); wire a `tsc --noEmit -p apps/demo-browser` + at least one Playwright smoke job (the e2e infra already exists).
**Overlap:** none direct. Related to AHW-028 (which proposes deleting apps/demo).

## NEW-R2-03 · MED · BUILD · OURS — `tsc -b` used against non-composite projects: brittle, mode-confusing build graph
**Path:** `ci.yml:36` and `apps/demo-browser/package.json` build (`tsc -b && vite build`). No package tsconfig sets `composite: true` (`grep composite` across all tsconfigs = empty); root `tsconfig.json` has no `references`.
**Impact:** `tsc -b` (build mode) is designed for composite project graphs with `references`. Run against a flat path list of non-composite projects it still *happens* to surface errors here, but the behavior (which projects get checked, incremental `.tsbuildinfo` caching, error attribution) is undefined/fragile and differs from `tsc --noEmit -p`. A future tsconfig tweak could silently shrink what's actually checked (a real supply-chain-adjacent risk: a gate that quietly stops gating). This is the kind of footgun that produced the confusion in NEW-R2-01.
**Fix dir:** either make packages truly composite (`composite: true` + `references` graph) so `tsc -b` is correct, or drop build mode and run explicit `tsc --noEmit -p <each>` per package (deterministic, no hidden caching). Prefer the latter for a PoC.
**Overlap:** none.

## NEW-R2-04 · MED · BUILD · OURS — `bun audit` is advisory but findings are NOT surfaced (12 vulns, 6 HIGH, silently swallowed)
**Path:** `.github/workflows/ci.yml:41-43` — `run: bun audit` + `continue-on-error: true`, with **no** `GITHUB_STEP_SUMMARY` write and no `--json` capture.
**Substantiation (ran `bun audit`):** `12 vulnerabilities (6 high, 5 moderate, 1 low)` — all transitive via `@aztec/*`: `systeminformation <5.27.14` (4× HIGH command-injection, via `@aztec/bb-prover`, `@aztec/pxe`), `undici <6.23.0` (HIGH WebSocket memory-exhaustion + request-smuggling, via `@aztec/foundation`).
**Impact:** the project's own CLAUDE.md policy is "advisory via `continue-on-error` **AND surface findings in the step summary**." Only the first half is implemented — `continue-on-error` hides the non-zero exit and there's no summary, so 6 HIGH advisories are invisible on every PR. The team will not notice when a *new* (potentially direct, non-transitive) advisory appears. Defeats the supply-chain tripwire.
**Fix dir:** pipe `bun audit --json` to a step that appends a table to `$GITHUB_STEP_SUMMARY` (keep `continue-on-error` if noise is the concern, but make the findings visible). Triage the systeminformation/undici HIGHs (they're transitive Aztec deps — document as accepted-with-rationale or pressure upstream).
**Overlap:** none. (AHW-016 is device-side rate-limit, unrelated.)

## NEW-R2-05 · MED · DESIGN · OURS — Embedded `ledger-app/` is NOT a submodule and has an UNCOMMITTED orphan `.git` (firmware source can drift unnoticed)
**Path:** parent repo tracks 159 `ledger-app/**` files at mode 100644 (`git ls-files -s ledger-app/...` → blobs, not gitlinks); **no `.gitmodules`**. The nested `ledger-app/.git` is a *separate* repo whose branch `main` **has zero commits** (`git -C ledger-app rev-parse HEAD` → "fatal: needed a single revision"; 73 files all staged `A`, never committed). `ledger-app/.git/` is gitignored by the parent (`.gitignore` last line).
**Impact:** two divergent, independently-mutable copies of the BOLOS firmware source exist with **no integrity link**: (1) the parent's embedded copy (the one CI builds), (2) the nested orphan working tree (which is what a Ledger-app-submission reviewer would expect to clone as the canonical app repo). The nested repo has **no commit history at all**, so there is no pinned firmware version/hash the parent references, no provenance, and no way to prove "the firmware audited == the firmware shipped." A modification to `ledger-app/src/*.c` directly in the parent tree is the only source of truth, but the presence of the orphan `.git` invites accidental edits/commits in the wrong tree that then silently diverge. For a hardware wallet this is a supply-chain-grade provenance gap. Also: `ledger_app.toml` (line 3-5) explicitly claims `ledger-app/` is a "self-describing Ledger project" for submission — but its git repo is empty.
**Fix dir:** decide one model and enforce it: either (a) make `ledger-app/` a real git submodule pinned to a commit SHA (firmware gets its own auditable history + the parent pins an immutable hash), or (b) fully absorb it (delete the orphan `ledger-app/.git`, single source of truth in parent) and record a firmware build hash in CI artifacts. Today it is neither — the worst of both.
**Overlap:** none (Round 1 had no submodule/provenance finding).

## NEW-R2-06 · MED · BUILD · OURS — Codegen cross-check trusts MUTABLE `node_modules` artifacts; `_meta` pins are comments, not enforced
**Path:** `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:26-34` reads the authority artifacts from `packages/adapter-ledger/node_modules/@defi-wonderland/aztec-standards/target/{token_contract-Token,dripper-Dripper}.json` (1.1 MB files, dated by npm install). `manifest.json:_meta.aztec_standards_npm_pin` is a **string comment** (`"@defi-wonderland/aztec-standards@4.2.0-aztecnr-rc.2"`); the script never asserts the on-disk artifact matches that pin nor a content hash.
**Impact:** the entire clear-signing security model rests on this cross-check (manifest selectors verified against the "reviewed authority" artifact — codex BLOCKER #2). But the artifact is read from a mutable, install-time-resolved location. If a future `bun install` resolves a different `aztec-standards` build (e.g. the `-rc.2` tag is re-pointed, or the dep is bumped without updating the comment), the cross-check would happily validate against the *new* selectors and the device tables would silently track the new contract — with the `_meta` pin still claiming `rc.2`. The pin provides documentation, not enforcement. The `bun.lock` does pin the resolved version, which mitigates a *re-point* of the same tag (good), but does NOT protect against a manifest/codegen run after an intentional-but-unreviewed dep bump, and does nothing to catch artifact tampering inside an unpacked node_modules.
**Fix dir:** (a) assert the installed `@defi-wonderland/aztec-standards` version === `manifest._meta.aztec_standards_npm_pin` at codegen/check time (read its `package.json`); (b) hash the two target artifacts and pin the SHA-256 in `_meta`, fail-closed on mismatch. Cheap, closes the "reviewed authority is mutable" gap.
**Overlap:** none. (Strengthens the trust model behind AHW-003's clear-sign path but is a distinct supply-chain finding.)

## NEW-R2-07 · MED · HOST · OURS — `adapter-trezor` replicates the blind-sign hole (parallel to AHW-001) AND ships a self-described "malicious-host-spoofable" clear-sign path; it's live, exported, type-checked, but security-dead
**Path:** `packages/adapter-trezor/src/provider.ts`. `createAuthWit` (line 81-86) is a pure blind sign (`signAndWrap` over `ecdsaPreimage(outerHash)` only). `createAuthWitFromIntent` (line 99-104) is, per its own doc-comment (line 88-98): *"decorative only. The device does not yet recompute outer_hash from the displayed fields — a malicious host could in principle show benign visual text while signing a malicious digest."* The class `implements IntentAuthWitnessProvider` (line 46) so callers treating it as clear-sign-capable get a false guarantee.
**Impact:** the project's headline security property is "clear-sign everything; device verifies the intent." The Trezor adapter is shipped, exported, in the workspace, typechecked in `ci.yml`, and run by `bun test` — yet it provides **zero** device-side verification (Phase A/B.1 only) and actively advertises a spoofable `createAuthWitFromIntent` via the `IntentAuthWitnessProvider` type. This is the AHW-001 blind-sign pattern living in a *second* adapter, plus a worse one: a method whose name implies intent-binding but whose implementation is decorative. An auditor reviewing "the wallet" will (rightly) treat both adapters as in-scope; inconsistent security posture between them is itself the finding. If adapter-trezor is research-only/dead, it must be quarantined out of the published surface and the CI graph; if it's alive, it needs the same device-verification bar as Ledger (which Trezor firmware can't meet today → it should not exist in a production wallet).
**Fix dir:** decide explicitly. If dead: delete or move to a `research/` path excluded from `ci.yml` typecheck/test and from any published exports, with a README banner. If kept: make `createAuthWit` fail-closed (mirror the AHW-001 fix) and either remove `createAuthWitFromIntent` or guard it behind an explicit `UNSAFE_DECORATIVE` flag so the `IntentAuthWitnessProvider` type stops lying.
**Overlap:** AHW-001 (Ledger host blind-sign) + AHW-012 (type-name-lies, Ledger). This is the *cross-package consistency* angle: the same two defects recur in adapter-trezor. Validator: NET-NEW because it's a different package + the "decorative createAuthWitFromIntent is exported as IntentAuthWitnessProvider" is a distinct lie from AHW-012.

## NEW-R2-08 · LOW · BUILD · OURS — Crypto-library version fragmentation: `@noble/curves` ×3, `@noble/hashes` ×6, TypeScript major split (5 vs 6)
**Path:** `bun.lock`. `@noble/curves` resolves to `=1.7.0`, `~1.9.0`, `1.9.1` (three specs); `@noble/hashes` to `1.6.0`, `^1.6.1`, `^1.8.0`, `~1.8.0`, `1.8.0`, `2.2.0` (incl. a v1↔v2 major split); `typescript` is `^6.0.3` (root) vs `^5.7.0` (`apps/demo-browser`).
**Impact:** for a wallet, multiple resident versions of the EC/hash primitives enlarge the audit surface and the supply-chain blast radius (a CVE in any one `@noble/*` line now has 3-6 install sites to patch, each independently). The TS major split (6 vs 5) means the live demo compiles under a different type-checker than the libraries it consumes — subtle type-soundness differences are possible, and it contradicts a single-strict-toolchain posture. Most of the `@noble` fan-out is transitive via `@aztec/*` (not directly fixable), but our *direct* dep `@noble/secp256k1 ^3.1.0` plus the `@noble/curves`/`hashes` we pull should be deduped where possible.
**Fix dir:** add `overrides`/`resolutions` to collapse `@noble/curves` and `@noble/hashes` to a single line each where the dep graph allows; align TypeScript to one major across the workspace (bump apps/demo-browser to ^6 or pin root to 5 — pick one). Document the irreducible transitive duplicates.
**Overlap:** none.

## NEW-R2-09 · LOW · BUILD · OURS — `apps/demo-browser` re-declares root devDeps (`typescript`, `vite-plugin-node-polyfills`) at different/overlapping versions — drift risk
**Path:** root `package.json:45-46` (`typescript ^6.0.3`, `vite-plugin-node-polyfills ^0.28.0`) vs `apps/demo-browser/package.json` devDeps (`typescript ^5.7.0`, `vite-plugin-node-polyfills ^0.28.0`).
**Impact:** duplicated tool declarations across workspace roots rot independently (CLAUDE.md "same code in 3 places is a refactor signal" applies to dep declarations too). The `typescript` copy is already drifted (5 vs 6). Polyfill version match today is luck, not enforcement.
**Fix dir:** hoist shared dev tooling to the root `package.json` only; remove the per-app `typescript`/polyfill devDeps unless the app genuinely needs a pinned-different version (and if so, document why).
**Overlap:** subset of NEW-R2-08's TS split; file as the dedup/discipline angle.

## NEW-R2-10 · LOW · DESIGN · OURS — Operational recovery footgun: `onForget()` wipes the cache but in-memory `Fr` secrets are never zeroized; "reconnect == recovery" undocumented for users
**Path:** `apps/demo-browser/src/panels/ConnectPanel.tsx:76-83` (`onForget` → `clearAllCachedSecrets()` + `setState({kind:'idle'})`); `packages/adapter-ledger/src/secret-cache.ts:58-66` (`clearAllCachedSecrets` does `mem.clear()` + removes sessionStorage keys). `loadCachedSecret` (line 45-49) rebuilds an `Fr` from hex.
**Impact (process/ops, not crypto):**
(1) **No zeroization.** `clearAllCachedSecrets` drops references but the underlying hex strings and any `Fr`/`Buffer` instances already handed to callers live until GC; sessionStorage values are removed, but JS gives no guarantee the cleared string bytes are scrubbed from the heap. For a viewing-root-grade secret the "Forget" control over-promises — a heap snapshot / extension after "Forget" may still recover it. The secret-cache header (line 12-14) correctly treats the browser as untrusted, but the Forget UX implies a clean wipe it can't deliver.
(2) **Recovery model is correct but invisible to the user.** The "Ledger seed IS the backup, no sidecar" claim holds operationally — `secret-cache.ts:5-9` + ConnectPanel:78-79 confirm the viewing root is re-derived from the device each session (reconnect → reveal → identical keys), nothing key-bearing is persisted at rest (no localStorage/IndexedDB — verified). But there is **no recovery/onboarding doc** (`grep -rln recovery|backup|seed docs/ README HANDOFF` = empty) telling a user "if you wipe/lose the device, restore the Ledger seed and reconnect; there is no other backup and no export." A user who reaches the `error`/`idle` state and assumes the app holds something recoverable has no in-product or doc guidance. No literal *unrecoverable-state* footgun was found (every state re-derives from the device), but the absence of an explicit custody/recovery doc is itself a gap before an external audit.
**Fix dir:** (a) best-effort zeroize `Fr`/buffer backing stores on clear where the runtime allows, and soften the "Forget" copy to "Clear this session" (don't claim a guarantee the platform can't keep); (b) add a short `docs/recovery.md` stating the single-source-of-truth model: device seed is the only backup, viewing root is always re-derived, nothing is exported, logout clears the session cache only.
**Overlap:** none (Round 1 has no recovery/custody-process finding; AHW-022 is a device-UI wording bug, distinct).

## NEW-R2-11 · INFO · BUILD · OURS — `bunfig.toml` lockfile `frozen = false`; CI freeze relies on the `--frozen-lockfile` flag only (fine, but no defense-in-depth)
**Path:** `bunfig.toml:12` (`frozen = false`); CI uses `bun install --frozen-lockfile` (`ci.yml:27`, `ledger-app.yml:93`).
**Impact:** correct per the documented "local dev allows updates, CI freezes" intent, and `bun.lock` is committed (1817 lines, ~941 dep entries). No bug. But the freeze is enforced *only* by the CLI flag in two workflow files — if a future workflow forgets `--frozen-lockfile` (e.g. a new publish/deploy job runs a bare `bun install`), an un-committed dep change would silently resolve. Low risk today (only 2 workflows, both correct), noted for the auditor as a single-point-of-discipline.
**Fix dir:** optional — none required for PoC. If hardening: a repo-wide convention test / a composite action that always installs with the frozen flag. `minimumReleaseAgeExcludes` is empty (good — no bypasses active).
**Overlap:** none.

## NEW-R2-12 · INFO · BUILD · OURS — `CX_MATH_SPIKE` reachable via `EXTRA_DEFINES` Make var with no release guard (build-surface dimension of AHW-021)
**Path:** `ledger-app/Makefile:40-42` — `DEFINES += $(EXTRA_DEFINES)`, documented as `make … EXTRA_DEFINES=CX_MATH_SPIKE`. AHW-021 already flags the INS handler (`dispatcher.c`/`cxmath_spike.c`) lacking an `#error` guard.
**Impact:** confirms the *build-system* half of AHW-021 — the spike isn't only `#ifdef`-gated in C, it has a first-class, documented Makefile entry point (`EXTRA_DEFINES`) that injects arbitrary `-D` flags. Nothing in the Makefile or CI prevents a release build from passing `EXTRA_DEFINES=CX_MATH_SPIKE` (or any other define). The shipped CI matrix (`ledger-app.yml:50-57`) does NOT pass it (good — default build is byte-identical per the comment), but the open `EXTRA_DEFINES` passthrough is an un-validated build-config trust boundary.
**Fix dir:** as AHW-021 — `_Static_assert`/`#error` fail-closed if `CX_MATH_SPIKE` is defined without an explicit `ALLOW_SPIKE` dev flag; consider whitelisting permitted `EXTRA_DEFINES` keys rather than a blind passthrough. Delete the spike before submission.
**Overlap:** AHW-021 (BUILD). This is the Makefile/`EXTRA_DEFINES`-passthrough refinement of the same root issue — validator may MERGE into AHW-021 as the build-system evidence, or keep as INFO corroboration.

---

## Summary for validator
- **NET-NEW candidates: 12** (NEW-R2-01 … NEW-R2-12).
- **Strongest (file separate):** R2-01 (CI typecheck red on main, 8 errors), R2-04 (6 HIGH `bun audit` vulns silently swallowed), R2-05 (ledger-app embedded + orphan empty `.git`, no firmware provenance), R2-06 (codegen trusts mutable node_modules, pins are comments), R2-07 (adapter-trezor blind-sign + spoofable decorative clear-sign, parallel to AHW-001/AHW-012).
- **Suspected overlaps to adjudicate:**
  - R2-01 ↔ AHW-028: same `apps/demo` deleted-API root cause; KEEP SEPARATE — R2-01's test-file `noUncheckedIndexedAccess` errors are new and the "CI is red" consequence is the actual finding.
  - R2-07 ↔ AHW-001 (blind sign) + AHW-012 (type-name lies): same defects, different package (adapter-trezor). NET-NEW on cross-package-consistency grounds.
  - R2-12 ↔ AHW-021: build-system (`EXTRA_DEFINES`) evidence for the same spike; MERGE or keep as INFO corroboration.
  - R2-09 ⊂ R2-08 (TS version split) — could fold together.
- **Method note:** every "exit code" was re-verified with a non-piped `$?` (an earlier piped read falsely showed exit 0 for both `tsc -b` and `bun audit`; the real exits are 2 and non-zero respectively). No false positives carried.
