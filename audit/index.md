# Audit findings index

**Count: 83 — LOOP STOPPED (diminishing returns; material surface exhausted).** Ceiling was 125, but the honest "repeating ourselves" condition was met: rounds 4–5 (depth + every remaining unrun angle) produced **0 surviving new HIGH/CRIT**; yield collapsed to MED/LOW/INFO/hardening/dead-code/enrichments. 9 red-team subagents (5 opus + 4 codex xhigh) + 8 validators, all diverse. Severity: **1 CRIT · 7 HIGH · ~24 MED · ~44 LOW · ~7 INFO** + recorded confirmed-clean negatives. Legend in `README.md`. Next: deep-plan the fixes.

**UPDATE — Catalog Campaign C2 (2026-06-02):** re-audit of the just-merged audit-remediation (P0–P6) firmware + wire (branch `main` @ `ce82734`). **Wave 1: +11 (AHW-084..094) — 0 CRIT · 0 HIGH · 3 MED · 7 LOW · 1 INFO** + 2 folds (→AHW-070, →AHW-010). **Running total: 94.** NEW Crit+HIGH this campaign: **0 / 50** (stop at 50 Crit+HIGH, diminishing returns, or 4h backstop). 3 diverse red-teamers (1 codex xhigh + 2 opus) + 1 opus validator. Detail in the **Catalog Campaign C2** section below; raw in `audit/_raw/c2/`.

**UPDATE 2 — C2 Wave 2 + 10-codex Burst (2026-06-02, LOOP STOPPED per owner):** +35 (AHW-095..129): **4 HIGH · 11 MED · 18 LOW · 2 INFO**. **Running total: 129.** The 4 HIGH (all NEW, post-consolidation from ~15 raw candidates via 3 theme-split validators): **AHW-095** blind-sign signs unsnapshotted `G_context`; **AHW-096** unverified codegen→signed deploy-profile sponsor/deployer; **AHW-097** root-exported `signOuterHash` blind-sign oracle; **AHW-098** onboard/receive address never device-attested. 3 clean negatives confirmed (crypto-correctness, dual-scheme confusion, firmware memory-safe). Finders: 12 codex xhigh + 4 opus; validators: 4 opus. Loop cron `e3e7b737` deleted. Detail: **C2 Wave 2 + Burst** section below; full per-finding evidence + fix-sketches in `audit/_raw/c2/validated-V{1,2,3}.md`.

> ## Remediation status — branch `audit-remediation` — P0–P6 COMPLETE (post-impl codex review CLOSED + testnet matrix GREEN on beast-5)
> Plan: `../implementations-plan/audit-remediation/`. Commits unsigned (1Password down — backfill-sign pending). `bun run lint:all` + `bun test packages/` both exit 0.
> **Device tooling is NOT blocked** (earlier note was wrong): the docker `ledger-app-builder-lite` build + `ghcr.io/ledgerhq/speculos` loop works in-env — build → run on a CLEAN port (5005/9995, NOT the orphaned playwright 5001) → `SPECULOS_URL=… bun test`. Only the TESTNET matrix needs network + a funded account (out of env).
> - **FIXED + tested + committed (host, P1):** AHW-001 (createAuthWit fail-close), AHW-002 (internalDeps hides raw bypasses), AHW-003 (assertClearSignPolicy guard), AHW-004 (seam guard tests), AHW-007 (secret-strip type-enforced), AHW-008 (canonical-hash dedup), AHW-049 (cancellable txs → public-replay nullifier).
> - **FIXED + Speculos-proven (firmware, P2)** — all asserted on the fresh app.elf by AHW-046's 15-assertion review-content test: AHW-040 (DRIP render), AHW-046 (per-verb content tests), AHW-050 (8+8 recipient), AHW-051 (raw-alongside-scaled), AHW-052 (ASCII ".."), AHW-053 (full outer_hash), AHW-054 (scoped "verified"), AHW-055 (salient mint warning), AHW-047 (reveal = "privacy root" wording), AHW-022 (reveal status = "Privacy root revealed", not "Transaction signed"). NOTE: the nbgl value-alias "show-full" was tried + dropped — counterproductive on Nano (truncates the 8+8); show-full is delivered via the full outer_hash. See lessons/phase-2.md.
> - **DISSOLVED** by deleting `adapter-trezor` + `apps/demo`: AHW-028, AHW-036, AHW-073, AHW-074, AHW-075, AHW-076, AHW-077, AHW-078.
> - **DEFERRED:** AHW-005 (typed sideband — compile-time nicety; CI-red deprioritized).
> - **FIXED + Speculos-proven (firmware, P3):** blind_signing NVM toggle — default-OFF, sticky, device-only (no APDU writes it) + Settings switch; reject-when-OFF (0x6F13) + warn-when-ON proven end-to-end (blind-signing-toggle.test.ts, 3 ✓). AHW-064 (canonical Aztec path now enforced on blind-sign + both pubkey getters via shared `az_bip32_path_is_canonical`; non-canonical → 0x6F03, canonical-path.test.ts). AHW-017 (malformed APDU now resets the L4 session). AHW-059 (reveal secret disarmed by `l4_session_reset`). AHW-068 (value-barrier keeps `grumpkin_point_cmov` branchless under -Oz; value-preserving, parity green).
> - **DOCUMENTED RESIDUAL (firmware, P3):** AHW-016 (no NVM rate-limit on the secret-derivation surface) — accepted for v0: the reveal is human-gated (not spammable), the root non-constant-time issue (AHW-029) is PLATFORM-deferred, and a rate cap on the un-gated pubkey/FINALIZE surfaces would hurt legitimate UX for marginal gain. Production mitigation (NVM throttle + global derivation ceiling) documented in `get_aztec_master_secret.c`.
> - **FIXED + Speculos-proven (firmware, P4):** AHW-018 — B3 wire v3 carries profile_id + salt; B3 re-derives the account for the host-selected (profile, salt) via the deploy path's `account_binding_*` helpers and binds `consumer` to it (derive-don't-trust). Explicit authwit allowlist (K1↔0, GRUMPKIN↔1) + (curve,profile) re-check at FINALIZE + a "Scheme" review line (codex 019e88d0 GO-with-edits, all folded). Hard cut, no v2 fallback. Proven: wire-v3-binding (non-zero salt accepts; wrong salt / unknown profile / curve-profile mismatch reject), differential-replay (oracle rebuilt v3), 3.7M-run fuzz (0 crashes), deploy + authwit round-trip. RESIDUAL (documented, accepted): the host picks (profile, salt) among accounts THIS key controls; the user verifies WHICH via the on-screen From + Scheme.
> - **FIXED (host + comment-truth, P5):** AHW-048 (revealed privacy root now MEMORY-ONLY — no sessionStorage; HARD ITEM e) + AHW-079 (the approval-free-pubkey cache key's persistent-pseudonym half dissolved by the memory-only cache). Comment-truth sweep: AHW-006 ("reserved: M8" → LIVE deploy-sovereignty gates), AHW-041 (preflight.ts + manifest.json no longer falsely claim device-side DRIP token-kind enforcement — host preflight is the only gate), AHW-020 ("single-pass" Schnorr derivation → DUAL-derived, verified), and the dead `adapter-trezor` mirror refs in adapter-ledger headers.
> - **DEFERRED (P5):** AHW-019 (point.c/point.h/mul_generator.c side-channel comments) — left conservative ("NOT side-channel-resistant", the safe posture). The finding warns overstating side-channel resistance is the worst direction + to confirm against the dudect timing result first; that result is out-of-env, so the early-return→cmov mechanism rewrite stays gated on it.
> - **TESTNET MATRIX (P6) — GREEN on beast-5:** demo-browser full flow (onboard→deploy→drip→transfer) via Playwright + speculos-aztec-playwright (CURRENT elf) + in-browser PXE. ECDSA #4 deploy FRESH + drip + transfer (tx 0x11c19f14…); Schnorr #4/#2 drip + transfer FRESH (tx 0x2cdb84dc…, 0x1d874d59…), deploy self-skipped (already on-chain from M10–M12; [0..4] fully deployed for Schnorr). The v3 deploy wire is proven by ECDSA's fresh deploy (shared MANIFEST_VERSION=3); clear-sign = blind-OFF default (blind-ON Speculos-proven separately). e2e fixes (3570ed9): DEMO_PORT (a stale aztec-gate Vite held :5173) + reveal-nav scroll-to-"root?" (AHW-047 wording shifted the page count).
> - **POST-IMPL CODEX REVIEW (step 6–7) — CLOSED:** session 019e8907, verdict SHIP-with-fixes. All 4 findings fixed + a confirm-pass returned all CLOSED, no new regression. HIGH: tx `cancellable=true` now enforced in `#assertClearSignPolicy` (was wallet-default only → a host using the entrypoint directly could strip the AHW-049 nullifier). MED: `append_call.c` enforces args[0]=TOKEN for DRIP on-device (AHW-041, was host-only). MED: `aztec-ledger-session` threads the account salt into the v3 header (non-zero-salt accounts emit their real salt). LOW: `account_binding` fails closed on unknown curves. Confirmed solid: B3, blind-signing device-only, no salt/profile confusion, memory-only cache.
> - **TEST-ISOLATION NOTE:** each Speculos test file assumes its OWN fresh emulator (NVM/UI state). Running many together against ONE shared device interleaves state (e.g. provider.test.ts's blind-signing beforeAll vs blind-signing-toggle's "starts OFF"). All files pass in isolation; a combined run needs per-file device isolation (matches the parallel-safe-E2E principle).
> - **PENDING — CI/provenance:** intentionally deprioritized by the owner this run.

## Triage disposition (2026-06-02) — re-audit map (all 83 findings accounted for)

So a re-audit re-discovers NOTHING: every finding is FIXED, DISSOLVED, PARKED, WON'T-FIX, or OPEN.
**Nothing CRITICAL or HIGH is open.** PARKED + WON'T-FIX are known + intentionally not actioned this
arc (revisit PARKED on re-audit / before mainnet). The per-finding rows below keep `VALIDATED` as
their CATALOG status; this section is the WORK disposition.

**WON'T-FIX — by-design / platform-inherent / honest (not ours to change):**
- `AHW-029` (INFO) portable-C field/EC layer not certified-CT — cert path is cx_/Donjon, a separate platform arc (M13), not a code fix.
- `AHW-044` (LOW) "Speculos screen authoritative" is a dev-EMULATOR artifact; on real HW the device screen IS the trust anchor.
- `AHW-056` (LOW) SPONSOR shows no fee/cap because the verb is arg_count=0 — honest omission, nothing to render.
- `AHW-065` (LOW) the unused SLIP-0013 `13'` prefix is a DELIBERATE forward-grant (codex-endorsed).
- `AHW-080` (LOW) WebHID "Ledger + Aztec app present" fingerprint is inherent to WebHID + a custom CLA; origin-scoped.
- `AHW-082` (INFO) the `/aztec` proxy lets the RPC operator see IP/sims/tx (no secret leak) — inherent to a testnet-proxy demo.
- `AHW-083` (INFO) console.error stack dumps carry tx metadata; PRINTF is debug-only — informational/demo-only.
- `AHW-015` (INFO) "keep the deviceOuterHashForIntent parity mirror" — a note, not a defect; the mirror is intact.

**PARKED — owner deprioritized CI/build hygiene ("don't care about CI"); revisit on the CI/release pass:**
- `AHW-030` (HIGH*) CI typecheck RED on main (tsc errors) — *severity is for the CI gate, NOT a runtime hole; explicitly deprioritized.
- `AHW-031/032/033/035/039/042/067/069/071/072/021` (MED/LOW/INFO) CI coverage inversion · tsc-on-non-composite · bun-audit swallow · codegen provenance+coverage · no -Werror · unpinned clang · empty root toml · Apex matrix gap · spike `#error` guard.

**PARKED — documented residual / deferred (decision recorded in lessons):**
- `AHW-016` (MED) no NVM reveal rate-limit — reveal is human-gated + root is platform (AHW-029); production mitigation documented at the derivation site.
- `AHW-019` (LOW) side-channel comment rewrite gated on a dudect timing run (out-of-env); left conservative ("NOT side-channel-resistant").

**PARKED — low-value polish / naming / refactor (valid, no security impact):**
- `AHW-005` (MED) typed deploy-context sideband · `AHW-009` (MED) session.ts monolith split · `AHW-070` (LOW) dedup the DEPLOY + REVEAL handler canonical-path copies (the riskier blind-sign/pubkey surfaces already share via AHW-064; C2/F-B-2 folded in the reveal-handler copy).
- `AHW-010/011` tighten `as`-casts / Speculos-JSON shape guards · `AHW-012/013` misleading type/comment names · `AHW-023` deploy/authwit claim-check shape · `AHW-037` @noble version fan-out · `AHW-043` live getCaps negotiation · `AHW-045` cached-onboard shows "cached" not a checksum · `AHW-058` dead SW constants · `AHW-060/061` test-vector label / scrub-comment clarity · `AHW-081` quiet logger (all LOW).
- `AHW-038` (LOW) JS can't reliably zeroize heap secrets; AHW-048 (memory-only) bounds exposure to the page lifetime; a recovery/custody DOC is the residual.

**PARKED — test-depth (the fixes are code-verified; these add heavy/low-value coverage):**
- `AHW-024` (MED) on-device malformed-frame-mid-stream test · `AHW-025` (MED) glitch-sim for the fault-injection arms · `AHW-027` (LOW) cs_format_amount adversarial fuzz.

**PARKED — owner-reviewed (release-gates + accepted residuals); revisit before mainnet:**
- `AHW-034` (MED) firmware provenance (no submodule) + `AHW-066` (MED) placeholder coin-type `1666` — RELEASE-GATES: resolve before mainnet / external-audit submission (not PoC bugs; far off).
- `AHW-062` (MED) unsigned fee CONTROLS — the device CANNOT bind fee/gas (not in Aztec's signed outer_hash = protocol). A host-side cap is the only lever, but a malicious host bypasses it and the blast radius is SponsoredFPC-griefing, not user funds → accepted residual.
- `AHW-063` (LOW) manual deploy reports PROPOSED not CHECKPOINTED (false-finality UX) — recognized; UX polish.

**OPEN — none.** (AHW-057, the deploy-wedge, is now FIXED — see below.)

**DISSOLVED — code deleted in P0 (adapter-trezor + apps/demo):** `AHW-028/036/073/074/075/076/077/078`.

**FIXED — see the per-phase remediation entries above:** `AHW-001/002/003/004/006/007/008/014/017/018/020/022/026/040/041/046/047/048/049/050/051/052/053/054/055/057/059/064/068/079`.

| ID | Sev | Cat | Owned | Status | Title |
|----|-----|-----|-------|--------|-------|
| AHW-001 | CRITICAL | HOST | OURS | VALIDATED | Auto-created app-authwits are blind-signed by `sendTx` |
| AHW-002 | HIGH | HOST | OURS | VALIDATED | `internalDeps` exposes raw blind-sign bypasses (`session`, `ledgerProvider`) |
| AHW-003 | HIGH | HOST | OURS | VALIDATED | Clear-signed TX path does not constrain unsigned fields (authwits/capsules/fee-mode) |
| AHW-004 | HIGH | HOST | OURS | VALIDATED | `LedgerClearSigningEntrypoint` has no host unit test (4 guards + `#consume`) |
| AHW-005 | MED | HOST | OURS | VALIDATED | Untyped `ledgerDeployContext` sideband (rename compiles, breaks at runtime) |
| AHW-006 | MED | HOST | OURS | VALIDATED | Stale `// reserved: M8` comments on live sovereignty status words |
| AHW-007 | MED | HOST | OURS | VALIDATED | `internalDeps` secret-strip is comment-asserted, untested |
| AHW-008 | LOW | HOST | OURS | VALIDATED | Duplicated canonical-hash block (tx vs deploy) — drift risk |
| AHW-009 | MED | HOST | OURS | VALIDATED | `aztec-ledger-session.ts` (649 LOC) monolith-risk + duplicated mutex guard |
| AHW-010 | LOW | HOST | OURS | VALIDATED | `bytesEqual` `as number` silences `noUncheckedIndexedAccess` (C2/F-C-7: relocated to `clear-signing-entrypoint.ts:82` by the rewrite) |
| AHW-011 | LOW | HOST | OURS | VALIDATED | Transport `as` casts on untrusted Speculos JSON / wire bytes, no shape guard |
| AHW-012 | LOW | DESIGN | OURS | VALIDATED | Type name `LedgerEcdsaKAuthWitnessProvider` used for Schnorr — name lies |
| AHW-013 | LOW | HOST | OURS | VALIDATED | `deploy-context.ts:8` wire comment `curve_id = K1` stale post-Schnorr |
| AHW-014 | LOW | HOST | OURS | VALIDATED | `index.ts:1-11` header says "scaffolded / lands once C app buildable" — stale |
| AHW-015 | INFO | TEST | OURS | VALIDATED | Add upstream-anchor comment on `deviceOuterHashForIntent` (don't delete as self-test) |
| AHW-016 | MED | APP | MIXED | VALIDATED | No rate-limit on reveal / key-derivation surface (EM-probe amplification) |
| AHW-017 | MED | APP | OURS | VALIDATED | Malformed-length APDU does not reset `G_l4_session` (fail-open vs invariant) |
| AHW-018 | MED | DESIGN | OURS | VALIDATED | B3 binding hard-codes `salt=Fr.ZERO`/profile-0 → non-zero-salt accounts locked out |
| AHW-019 | LOW | APP | OURS | VALIDATED | Stale side-channel comments UNDERSTATE hardening (dangerous direction) |
| AHW-020 | LOW | APP | OURS | VALIDATED | Stale "single-pass" comments — derivation is actually dual-derived (M11) |
| AHW-021 | LOW | BUILD | OURS | VALIDATED | `INS_CXMATH_SPIKE` present (flag-gated); no `#error` guard vs release build |
| AHW-022 | LOW | APP | OURS | VALIDATED | Reveal success-dismiss UI reuses "Transaction signed" instead of "Viewing key revealed" |
| AHW-023 | LOW | APP | OURS | VALIDATED | "claim present" check shape differs (bool vs state-gate) between deploy/authwit |
| AHW-024 | MED | TEST | OURS | VALIDATED | No on-device test for malformed-frame-mid-stream (AHW-017 regression guard) |
| AHW-025 | MED | TEST | OURS | VALIDATED | Fault-injection reject arms (3× recompute, dual-derive) have no glitch-sim test |
| AHW-026 | LOW | TEST | OURS | VALIDATED | B3 non-default-salt lock-out (AHW-018) untested |
| AHW-027 | LOW | TEST | OURS | VALIDATED | `cs_format_amount` has no adversarial fuzz/parity vector |
| AHW-028 | LOW | HOST | OURS | VALIDATED | Legacy `apps/demo` references deleted `createAuthWitFromIntent` — dead/broken code |
| AHW-029 | INFO | PLATFORM | LEDGER | VALIDATED | Portable C field/EC layer NOT certified constant-time (cert path = cx_/Donjon, deferred) |
| AHW-030 | HIGH | BUILD | OURS | VALIDATED | CI typecheck gate RED on `main` (8 `tsc -b` errors, merged-around) |
| AHW-031 | MED | BUILD | OURS | VALIDATED | Inverted CI coverage: dead `apps/demo` typechecked, live app + e2e ungated |
| AHW-032 | LOW | BUILD | OURS | VALIDATED | `tsc -b` run on non-composite projects (latent fragility) |
| AHW-033 | MED | BUILD | OURS | VALIDATED | `bun audit` `continue-on-error` swallows 6 HIGH vulns silently (no summary) |
| AHW-034 | MED | DESIGN | OURS | VALIDATED | `ledger-app/` embedded (no `.gitmodules`), nested `.git` 0 commits — no firmware provenance |
| AHW-035 | MED | BUILD | OURS | VALIDATED | Codegen PROVENANCE: trusts mutable `node_modules` artifact; `_meta` pin is a comment |
| AHW-036 | MED | HOST | OURS | VALIDATED | `adapter-trezor` blind-sign + spoofable `createAuthWitFromIntent` (distinct package) |
| AHW-037 | LOW | BUILD | OURS | VALIDATED | `@noble/*` + TS version fan-out (`@noble/hashes` v1↔v2 split) |
| AHW-038 | LOW | DESIGN | OURS | VALIDATED | "Forget" doesn't zeroize heap secrets; no recovery/custody doc |
| AHW-039 | INFO | BUILD | OURS | VALIDATED | Lockfile-freeze is a single point (ensure CI `--frozen-lockfile`) |
| AHW-040 | HIGH | APP | OURS | VALIDATED | `DRIP_PUB` signed but NOT rendered on device ("Call DRIP", no value pairs) |
| AHW-041 | MED | APP | OURS | VALIDATED | False "enforced device-side" comment for DRIP token-kind (claims unreal control) |
| AHW-042 | MED | BUILD | OURS | VALIDATED | Codegen COVERAGE: registry `address`/`decimals`/`symbol` never verified |
| AHW-043 | LOW | HOST | OURS | VALIDATED | `getCaps()` only called in tests; no live capability negotiation |
| AHW-044 | LOW | HOST | OURS | VALIDATED | Speculos screen text rendered as authoritative device screen (display-integrity) |
| AHW-045 | LOW | APP | OURS | VALIDATED | Cached re-onboard renders literal `"cached"` instead of verifiable checksum |
| AHW-046 | MED | TEST | OURS | VALIDATED | Zero positive review-screen CONTENT tests (why AHW-040 was invisible) |
| AHW-047 | HIGH | DESIGN | OURS | VALIDATED | "Reveal viewing key" exports the path-wide privacy ROOT (4 master keys, chain/scheme-wide) |
| AHW-048 | MED | HOST | OURS | VALIDATED | Revealed privacy root persisted in `sessionStorage` + scheme-blind cache reuse |
| AHW-049 | MED | DESIGN | OURS | VALIDATED | Public clear-signed txs have no replay nullifier → `SponsoredFPC` re-bill on replay |
| AHW-050 | HIGH | APP | OURS | VALIDATED | Recipient `To` rendered 4+4 bytes AND device-unverified (deploy uses 8+6) — budget backwards |
| AHW-051 | MED | APP | OURS | VALIDATED | Host/codegen `decimals` mis-scales the displayed amount by 10^N (raw amount unaffected) |
| AHW-052 | LOW | APP | OURS | VALIDATED | `…` truncation marker is U+2026 on a font lacking non-ASCII glyphs (may render blank/box) |
| AHW-053 | LOW | APP | OURS | VALIDATED | Tail `outer_hash` shown 4+4 (64 bits) while blind-sign shows full 32B — "paranoia" oversold |
| AHW-054 | LOW | APP | OURS | VALIDATED | `"From (verified)"` halo implies the whole screen is verified (recipient/amount aren't) |
| AHW-055 | LOW | APP | OURS | VALIDATED | Mint `WARNING: MINTER action` is an inline pair, not a salient banner |
| AHW-056 | LOW | APP | OURS | VALIDATED | SPONSOR renders `Via: Testnet FPC` with no fee/cap (arg_count=0 → honest omission) |
| AHW-057 | MED | HOST | OURS | VALIDATED | Deploy `#deploySignOnDevice` no abort-on-throw → device deploy-session parks (wallet wedges, 0x6F11) |
| AHW-058 | LOW | APP | OURS | VALIDATED | Dead SW: 0x6F10/0x6F07 defined + host-mirrored but never returned |
| AHW-059 | LOW | APP | OURS | VALIDATED | Armed master-secret (`s_secret`/`s_armed`) unreachable by `l4_session_reset` (implicit safety) |
| AHW-060 | LOW | TEST | OURS | VALIDATED | Poseidon2 smoke-vector labels misleading (`zero_hex` = hash-of-empty, not hash-of-Fr(0)) |
| AHW-061 | LOW | APP | OURS | VALIDATED | `schnorr.c:14-20` parses then zeros `priv` — policy guard+scrub reads as a bug (needs comment) |
| AHW-062 | MED | DESIGN | OURS | VALIDATED | Unsigned `txContext` fee controls → fee-burn / sponsor-drain (defense-in-depth; codex HIGH→MED) |
| AHW-063 | LOW | APP | OURS | VALIDATED | Manual deploy waits PROPOSED not CHECKPOINTED → false-finality window |
| AHW-064 | MED | APP | OURS | VALIDATED | Blind-sign + pubkey getters check only `1≤len≤10`, not the full canonical path (loosest gate, riskiest surface) |
| AHW-065 | LOW | BUILD | OURS | VALIDATED | Manifest grants unused `"13'"` SLIP-0013 path prefix (deliberate forward-grant; least-privilege) |
| AHW-066 | MED | BUILD | OURS | VALIDATED | Placeholder coin-type `1666` baked into `constants.h`/`Makefile`/CI (half-closed prior codex HIGH) |
| AHW-067 | LOW | BUILD | OURS | VALIDATED | No `-Werror`/`ENABLE_SDK_WERROR`; CI only checks exit code |
| AHW-068 | LOW | APP | MIXED | VALIDATED | Barrier-less cmov (`point.c:69-77`) under `-Oz` — optimizer-de-CT risk (distinct from AHW-029) |
| AHW-069 | LOW | BUILD | OURS | VALIDATED | clang version unpinned/unasserted → constant-time evidence drifts on builder bump |
| AHW-070 | LOW | APP | OURS | VALIDATED | Canonical-path check inlined in C handlers (C2/F-B-2: now DEPLOY + REVEAL — `begin_deploy_account.c` + `get_aztec_master_secret.c` still inline vs shared predicate) |
| AHW-071 | LOW | BUILD | OURS | VALIDATED | Root `ledger_app.toml` is 0 bytes despite the nested copy declaring it authoritative |
| AHW-072 | INFO | BUILD | OURS | VALIDATED | Apex-P icon in Makefile but absent from both toml device lists + CI matrix |
| AHW-073 | MED | DESIGN | OURS | VALIDATED | Trezor `createAuthWitFromIntent` signs a NON-canonical digest (root: core `computeOuterHashForIntent`) |
| AHW-074 | LOW | TEST | OURS | VALIDATED | Trezor `createAuthWitFromIntent` has zero direct unit test |
| AHW-075 | LOW | HOST | OURS | VALIDATED | Trezor host never `secp.verify`s the device signature vs cached pubkey |
| AHW-076 | LOW | HOST | OURS | VALIDATED | Trezor subprocess bridge matches req↔resp by FIFO `.shift()` → one stray line desyncs all |
| AHW-077 | LOW | HOST | OURS | VALIDATED | Trezor `getPublicKeyXY` signs 32 zero bytes to read the pubkey (sign-to-read) |
| AHW-078 | INFO | DESIGN | OURS | VALIDATED | `adapter-trezor` is dead weight (only dead `apps/demo` uses it) — recommend deletion |
| AHW-079 | LOW | HOST | OURS | VALIDATED | Pre-reveal `(seed,path)` pseudonym: `deviceCacheKey` caches raw pubkey + `GET_PUBLIC_KEY` non-confirmed |
| AHW-080 | LOW | HOST | MIXED | VALIDATED | WebHID silent reuse + `productId` + custom `GET_VERSION` probe fingerprints "Ledger + Aztec app" |
| AHW-081 | LOW | HOST | OURS | VALIDATED | No quiet logger → default `info` browser logger emits account/contract/tx metadata to console |
| AHW-082 | INFO | DESIGN | OURS | VALIDATED | Vite proxies `/aztec` → beast-5 RPC (operator sees IP/sims/tx hashes; no master-secret leak) |
| AHW-083 | INFO | TEST | OURS | VALIDATED | Panel `console.error` stack dumps carry tx metadata (`SimulationError`); PRINTF debug-only |
| AHW-084 | MED | HOST | OURS | VALIDATED | Poseidon2 domain-separator literals hardcoded in `l4-manifest.ts`, no `===` guard vs `@aztec/constants` (silent drift) |
| AHW-085 | MED | APP | OURS | VALIDATED | Authwit FINALIZE re-hashes cached `args_hash`, never re-derives from raw args — contradicts session.h "three-pass" claim |
| AHW-086 | MED | APP | OURS | VALIDATED | Flags STATIC/HIDE_MSG_SENDER signed for every call but rendered only in TRANSFER arm (MINT/DRIP/SPONSOR blind) |
| AHW-087 | LOW | HOST | OURS | FIXED | Live Ledger adapter never `secp.verify`s device sig vs cached pubkey (AHW-075 was trezor-only, dissolved) |
| AHW-088 | LOW | HOST | OURS | VALIDATED | `overrideAccount` mutates shared wallet map on transfer/drip, never reverted (deploy path uses try/finally) |
| AHW-089 | LOW | HOST | MIXED | VALIDATED | `createAuthWit` fail-close throw swallowed by upstream `embedded_wallet` catch → no user signal |
| AHW-090 | LOW | TEST | OURS | VALIDATED | No host test threads `(salt,profileId)` through provider→entrypoint→`buildL4Manifest` header |
| AHW-091 | LOW | TEST | OURS | VALIDATED | B3 binding / finalize tail trapped out of the fuzz/replay oracle (parse-seam + happy-path only) |
| AHW-092 | LOW | APP | OURS | VALIDATED | `account_binding_deploy_partial` defaults unknown `arg_schema`→ECDSA; FINALIZE never re-checks schema |
| AHW-093 | LOW | HOST | OURS | VALIDATED | No assert that `kind==='deploy'` ⇔ `ledgerDeployContext` present (mode-select is an unpinned sideband) |
| AHW-094 | INFO | APP | OURS | VALIDATED | Reveal UI header docstring claims "full BIP-32 path"; code shows "Account #N" (comment-truth, sensitive screen) |
| AHW-095 | HIGH | APP | OURS | FIXED | Blind-sign approval signs UNSNAPSHOTTED `G_context` (path/outer_hash re-read at approval) — post-review fault signs ≠ reviewed (absorbs F-G-1/F-K1-2/F-K3-1) |
| AHW-096 | HIGH | BUILD | OURS | FIXED | Deploy-profile `sponsor_*`/`deployer` + emitted `*.gen.*` never canonical-verified → poisoned build signs a hidden sponsor/deployer (UI shows only "Sponsored") — now device renders sponsor 8+6+selector, codegen fail-closes sponsor==single SPONSOR slot + selector==artifact verb + deployer==0, host asserts runtime==manifest; RESIDUAL: hand-edited `*.gen.c` build-gate deferred to AHW-102 |
| AHW-097 | HIGH | HOST | OURS | FIXED | Root-exported `LedgerProvider.signOuterHash` = published blind-sign oracle outside the entrypoint (distinct from closed AHW-002) |
| AHW-098 | HIGH | DESIGN | OURS | FIXED | Onboard/receive address host-derived, NEVER device-attested; reveal checksum binds the SECRET not the address; deploy attest skipped on host `alreadyDeployed` — new approval-gated INS_GET_AZTEC_ADDRESS (CAPS_ATTEST_ADDRESS-gated, address-only, snapshot-returned, no fallback) + host `===` fail-close (assertDeviceAttestedAddress / verifyReceiveAddress, deploy-state-independent); round-trip device==host proven on Speculos |
| AHW-099 | MED | APP | OURS | FIXED | Deploy FINALIZE display-identity TOCTOU — approval re-reads mutable session `#N`/address (signs a fresh local, so bounded; sibling of AHW-095) — out-of-band identity snapshot captured at review, verify-or-reject (0x6F14) in finalize_deploy_after_approval |
| AHW-100 | MED | APP | OURS | FIXED | Schnorr sign leaves key-equivalent `pe = priv·e` (+ derive/serialize temporaries) un-scrubbed on the stack |
| AHW-101 | MED | BUILD | OURS | DEFER | Mutable GitHub Action refs (`@v6`/`@v4`…) in the firmware build + CI gates (images digest-pinned; release-gate class) |
| AHW-102 | MED | BUILD | MIXED | DEFER | CI blesses the same ELF it built — no independent reproducible rebuild / digest gate / recorded BOLOS-SDK identity (folds F-K6-4) |
| AHW-103 | MED | DESIGN | OURS | FIXED | Root barrel exports the reveal + `loadCachedSecret` reread → in-process same-origin reread of the privacy root w/o a 2nd prompt |
| AHW-104 | MED | DESIGN | OURS | RESIDUAL | Public `setEntrypointOverride`/`overrideAccount` policy-escape seams (full clear-sign bypass when paired with AHW-097) |
| AHW-105 | MED | HOST | OURS | RESIDUAL | Signing pubkey fetched approval-free from 2 provider instances, no byte-equal/verify cross-check → selective-MITM identity split |
| AHW-106 | MED | DESIGN | OURS | FIXED | Impl derives master secret from HW seed (single-seed custody) while the recovery spec mandates 2-of-2 split-brain (doc↔impl; runtime = AHW-047) |
| AHW-107 | MED | APP | OURS | DEFER | Onboarding UI hard-limits recovery to account indices 0–4 while the path accepts any uint31 (recovery footgun) |
| AHW-108 | MED | TEST | OURS | FIXED | APPEND_CALL strict-allowlist reject arms (0x6F09/0A/0B/0C incl. delegated-spend gate) have NO input→SW test; fuzzer is membership-only |
| AHW-109 | MED | TEST | OURS | FIXED | Device low-S anti-malleability + 0x6F06 dup-sig asserted by NO test (host low-S test exercises a different impl) — low-S now asserted on device sig; 0x6F06 reject = glitch-only RESIDUAL (RFC6979-deterministic, untestable via emulator) |
| AHW-110 | LOW | APP | OURS | VALIDATED | Blind-sign NVM toggle checked pre-UI but NOT re-checked in the approval callback (single-glitch policy bypass) |
| AHW-111 | LOW | APP | OURS | VALIDATED | Authwit clear-sign review shows no path/account fingerprint (B3 re-binds at sign, so display-scope only) |
| AHW-112 | LOW | APP | MIXED | FIXED | Reveal review `#N` can skew under a post-validation path glitch (emitted secret is frozen/safe; display-only) — folded into W1: identity snapshot captured at reveal UI, verify-or-reject (0x6F14) in master_secret_reveal_approved |
| AHW-113 | LOW | DESIGN | OURS | VALIDATED | Duplicate-compute defenses use a single mismatch-compare site (collapse to one pass if the lone branch is skipped) |
| AHW-114 | LOW | DESIGN | OURS | VALIDATED | SW conflation: 0x6F01/0x6F06 cover internal recompute-fault AND host-mismatch — weak alerting (fail-closed) |
| AHW-115 | LOW | APP | OURS | VALIDATED | `GET_PUBLIC_KEY` forwards raw `cx_err_t` via `io_send_sw` — leaks SDK codes outside the app SW taxonomy |
| AHW-116 | LOW | APP | OURS | VALIDATED | `verified_calls_ui` fails OPEN on an unrenderable call (reg/verb NULL → 0 pairs, approval still signs) |
| AHW-117 | LOW | APP | OURS | VALIDATED | Deploy `fee_mode` is dead metadata; "Sponsored (testnet)" hardcoded, not enforced (won't fail-closed on a new mode) |
| AHW-118 | LOW | APP | OURS | VALIDATED | Host-rendered "Device verified"/"✓ on-device" copy w/o a device-attested anchor (anti-phishing; substrate for AHW-098) |
| AHW-119 | LOW | APP | OURS | VALIDATED | Branchy low-S dispatch + `low_s_normalize` leak the (public) ECDSA `s` magnitude via timing/EM |
| AHW-120 | LOW | APP | OURS | VALIDATED | ECDSA dup-sig fault check uses short-circuit `memcmp` (not CT) — prefix oracle on the public `s`/`r` under an active fault |
| AHW-121 | LOW | HOST | MIXED | VALIDATED | APPEND_CALL sends verb/recipient/token/amount raw on the local wire → passive USB/WebHID observer learns tx semantics pre-approval |
| AHW-122 | LOW | DESIGN | OURS | VALIDATED | "Forget" clears the reveal-cache but leaves the account `secretKey` in the embedded-wallet DB (page-lifetime; ephemeral) |
| AHW-123 | LOW | HOST | OURS | VALIDATED | BEGIN frames send device-derivable account identity in clear (consumer/publicKeysHash/expectedAddress), incl. rejected flows |
| AHW-124 | LOW | APP | MIXED | VALIDATED | `make_buf` trusts `cmd->lc` as body size, no in-app reconcile vs `input_len` (over-read defense fully delegated to BOLOS `apdu_parser`) |
| AHW-125 | LOW | APP | OURS | VALIDATED | `render_call_pairs` is a 95-line per-verb switch (the display==signed boundary) untestable off-device |
| AHW-126 | LOW | APP | OURS | VALIDATED | Security primitives copy-pasted: `ct_memcmp32`×5 + `low_s_normalize`/`s_is_high`/`HALF_N`×3 (drift risk, distinct from AHW-070/008) |
| AHW-127 | LOW | TEST | OURS | VALIDATED | `wire-negative.test.ts` hand-copies SW constants instead of importing `apdu.ts` (oracle desyncs on an `sw.h` renumber) |
| AHW-128 | INFO | PLATFORM | LEDGER | VALIDATED | Highest-value approve callbacks are a single `if(confirm)` branch — universal BOLOS/nbgl pattern; single-glitch resistance is the SE's job |
| AHW-129 | INFO | APP | OURS | VALIDATED | `fr_as_u32_or_hex` uses `unsigned`-typed shifts instead of `uint32_t` (portability nit; correct on the 32-bit target) |

---

## Detailed findings

### AHW-001 · CRITICAL · HOST · OURS · VALIDATED
**Auto-created app-authwits are blind-signed.** `auth-witness-provider.ts:82` (`createAuthWit` → `signAndWrap` → `inner.signOuterHash`) is a HASH-ONLY blind sign. `EmbeddedWallet.sendTx` (`embedded_wallet.js:84-100`) pre-simulates, derives a `CallAuthorizationRequest` from each offchain effect, calls `this.createAuthWit(onBehalfOf, {consumer, innerHash})`, and pushes the resulting witnesses into the **caller-owned** `exec.authWitnesses` — all *before* `LedgerClearSigningEntrypoint` runs. A hostile dApp/exec that simulates into auth requests gets the device to blind-sign authorizations the user never reviewed; even on later clear-sign failure the witnesses remain harvestable in the caller array. Not triggered by the shipped transfer/drip/deploy flows (own-account transfers generate no offchain auth effects), but the capability is a real hole in "clear-sign everything." **Fix dir:** fail-close `createAuthWit` for ALL curves (verified: no legitimate caller in the live flow) + reject non-empty `exec.authWitnesses` on the clear-sign tx path. **Src:** codex `bvb4ddyq5`.

### AHW-002 · HIGH · HOST · OURS · VALIDATED
**Raw blind-sign bypasses are public.** `internalDeps` (`aztec-ledger-session.ts:437`) returns `Omit<deps,'secret'>` — which still exposes `session: SessionEmbeddedWallet` (line 86) and `ledgerProvider: LedgerEcdsaKAuthWitnessProvider` (line 90). App code can call `session.internalDeps.session.sendTx(...)` (routes through the default `DefaultAccountEntrypoint` blind-sign account unless overridden) or `…ledgerProvider.createAuthWit(...)` (blind), skipping `LedgerClearSigningEntrypoint` entirely. No external consumers today (grep-confirmed) → safe to tighten. **Fix dir:** stop exposing `session`/`ledgerProvider`, or rename `unsafe_`; cache the clear-signing `BaseAccount` from connect. **Src:** codex `bvb4ddyq5`.

### AHW-003 · HIGH · HOST · OURS · VALIDATED
**TX path doesn't constrain unsigned fields; deploy does.** The signed outer-hash binds only `calls + txNonce + (consumer, chainId, version)`. The deploy path (`clear-signing-entrypoint.ts:127-136`) rejects non-EXTERNAL fee mode + `cancellable`, but the tx path (`#clearSignOnDevice`) applies no such guard, and there are zero guards on `authWitnesses`/`capsules`/`extraHashedArgs` anywhere in the session. A hostile host can omit the sponsor payload (upstream silently switches fee mode to `PREEXISTING_FEE_JUICE`/`FEE_JUICE_WITH_CLAIM`) or pre-seed capsules/authwits while the device shows a benign transfer. **Fix dir:** mirror the deploy guards onto the tx clear-sign path — reject non-empty `authWitnesses`/`capsules`/`extraHashedArgs` + non-EXTERNAL fee modes. Pairs with AHW-001. **Src:** codex `bvb4ddyq5`.

### AHW-004 · HIGH · HOST · OURS · VALIDATED
**The central seam is untested.** No test constructs `LedgerClearSigningEntrypoint`. Four pure-TS, Speculos-free fail-closed guards are unexercised: `feePaymentMethodOptions!==EXTERNAL` (`:127`), `cancellable!==false` (`:132`), `DeployContext` runtime mismatch (`:219-228`), and the **`#consume` stream-A-claim-B reject** (`:245-255`). `plan.md:59` explicitly promised the stream-A-claim-B test; never written. **Fix dir:** `clear-signing-entrypoint.test.ts` with a mock `LedgerProvider` asserting all 4 throw + a `#consume` happy path. ~80 LOC. **Src:** opus quality.

### AHW-005 · MED · HOST · OURS · VALIDATED
**Untyped `ledgerDeployContext` sideband.** Reader `(options as ClearSignDeployOptions).ledgerDeployContext` (`clear-signing-entrypoint.ts:121`); producer an un-annotated literal (`aztec-ledger-session.ts:375-383`). The framework types `options` as `DefaultAccountEntrypointOptions` (no such field). Rename on either side → both compile, deploy silently falls into `#clearSignOnDevice`, skipping the M8-P6 sovereignty carrier (device still fails closed, so not exploitable). **Fix dir:** one shared `LedgerFeeEntrypointOptions` type annotated on both ends → rename becomes a compile error. **Src:** opus quality.

### AHW-006 · MED · HOST · OURS · VALIDATED
**Stale `// reserved: M8` comments on live gates.** `apdu.ts:224-225`: `DEPLOY_ADDRESS_MISMATCH 0x6f0e` and `DEPLOY_PUBKEY_HASH_MISMATCH 0x6f0f` are labeled "reserved" but are the *live* deploy-sovereignty rejects (asserted in `provider.m8.test.ts:174`, `provider.test.ts:188`, `wire-differential-replay.test.ts:53`). Actively misleads an auditor that the core sovereignty gates are unimplemented. **Fix dir:** rewrite both comments to name the live gate. **Src:** opus quality.

### AHW-007 · MED · HOST · OURS · VALIDATED
**Secret-strip untested.** `internalDeps` strips `secret` (`aztec-ledger-session.ts:437-440`, a documented impl-audit MAJOR fix) but no test asserts `'secret' in session.internalDeps === false`. A future refactor could silently reintroduce the leak. **Fix dir:** one assertion. **Src:** opus quality.

### AHW-008 · LOW · HOST · OURS · VALIDATED
**Duplicated canonical-hash block.** `clear-signing-entrypoint.ts:155-164` ≈ `205-213` repeat the identical `EncodedAppEntrypointCalls.create → hash → computeOuterAuthWitHash → bytes`. If they drift, tx and deploy attest different things (security-relevant). **Fix dir:** extract `#canonicalOuterHash(exec, chainInfo, nonce)`; also closes the AHW-005 drift risk. **Src:** opus quality.

### AHW-009 · MED · HOST · OURS · VALIDATED
**`aztec-ledger-session.ts` monolith-risk.** 649 LOC owning connect/deploy/transfer-verbs/submit/infra. Not a true SRP violation (one-sentence summary holds), but the obvious extraction target, and the in-flight mutex guard is duplicated (`329-333` ≈ `597-601`). **Fix dir:** extract a `LedgerDemoVerbs` collaborator (~140 LOC of demo surface) + collapse the mutex into one submit primitive. Defer unless it grows. **Src:** opus quality.

### AHW-010 · LOW · HOST · OURS · VALIDATED
**`bytesEqual` `as number`.** `clear-signing-entrypoint.ts:77` casts indexed bytes `as number` under `noUncheckedIndexedAccess` instead of proving definedness. Benign (lengths checked). **Fix dir:** documented `biome-ignore` for consistency, or leave. **Src:** opus quality.

### AHW-011 · LOW · HOST · OURS · VALIDATED
**Unvalidated trust-boundary casts.** `speculos-transport.ts:93/124` cast HTTP JSON, `:151`/`webhid-transport.ts:108/131` cast device wire bytes to internal shapes with no runtime shape guard. SW/data lengths are validated downstream in `provider.ts`; acceptable for a trusted local Speculos/USB. **Fix dir:** 3-line shape guard on the Speculos JSON, or a comment scoping the trust. **Src:** opus quality.

### AHW-012 · LOW · DESIGN · OURS · VALIDATED
**Misleading type name.** `LedgerEcdsaKAuthWitnessProvider` (`index.ts:35`, used in `ledger-account-contract-base.ts:26,55`, `schnorr-account-contract.ts:31`) is scheme-generic (curveId-driven) and handles Schnorr, but the name says "EcdsaK". A maintainer won't find the Schnorr path under this name. **Fix dir:** rename to `LedgerAuthWitnessProvider` (public-API rename → version bump). **Src:** opus quality.

### AHW-013 · LOW · HOST · OURS · VALIDATED
**Stale wire-layout comment.** `deploy-context.ts:8` says `curve_id : 1 B (= K1)` but the field carries `GRUMPKIN` for Schnorr deploys (`aztec-ledger-session.ts:346`). **Fix dir:** `curve_id : 1 B (K1 / GRUMPKIN per scheme)`. **Src:** opus quality.

### AHW-014 · LOW · HOST · OURS · VALIDATED
**Stale package header.** `index.ts:1-11` says the provider is "scaffolded" and "lands once the C app is buildable" — but the app is built and proven on testnet. First thing an auditor reads. **Fix dir:** update header. **Src:** opus quality.

### AHW-015 · INFO · TEST · OURS · VALIDATED
**Oracle-anchor comment.** `deviceOuterHashForIntent` (`l4-manifest.ts`) is a trustworthy double — anchored to the genuine upstream `EncodedAppEntrypointCalls` in `l4-manifest-parity.test.ts` (CI, non-gated), with device==mirror Speculos-gated. **Fix dir:** add a one-line comment stating the upstream anchor so a future maintainer doesn't mistake it for a self-test and delete the parity assert. **Src:** opus quality.

### AHW-016 · MED · APP · MIXED · VALIDATED
**No anti-amplification on the secret-derivation surface.** `get_aztec_master_secret.c:82-164`, `l4/aztec_secret.c`, `account_derive.c:70-84`, `get_schnorr_pubkey.c` — no NVM attempt counter / cooldown / escalating delay. The reveal is NBGL-gated (good), but the underlying SHA-512 + Montgomery-reduce + `[k]G` run on every FINALIZE/deploy/pubkey query with no rate cap → unlimited fast re-derivation = EM/power side-channel amplification primitive. Root cause (non-constant-time portable C) is **PLATFORM** (AHW-029); the missing rate-limit mitigation is **OURS**. **Fix dir (production):** NVM-backed throttle on the reveal INS + a global derivation-rate ceiling; at minimum document that the constant-time deficiency has no compensating control. **Src:** opus firmware M-1.

### AHW-017 · MED · APP · OURS · VALIDATED
**Malformed APDU doesn't reset L4 session.** `app_main.c:39-45`: an `apdu_parser` failure zeroes `G_context` but not `G_l4_session`/`G_l4_deploy_session`, violating the dispatcher's "any non-0x9000 path zeroes the L4 session" invariant (the parse failure short-circuits before the dispatcher). NOT independently exploitable — subsequent well-formed APDUs still hit the state-machine + parity gates. Pure stale-session-lifetime. **Fix dir:** add `l4_session_reset()` alongside the `explicit_bzero(&G_context,…)` (one line). **Src:** opus firmware M-2.

### AHW-018 · MED · DESIGN · OURS · VALIDATED
**B3 binding assumes zero-salt / profile-0.** `finalize_and_sign.c:98-183` (`b3_verify_consumer_is_this_account`) hard-codes `salt=Fr.ZERO` (B3_ZERO, line 113) + profile 0 / SchnorrAccount class. Salt is never on the authwit wire — the device *assumes* it. Fail-closed (not a hole), but any legally-deployed non-zero-salt account is permanently locked out of clear-signed authwits with a misleading `0x6F12`, and the "from==consumer==this account" guarantee only holds for the assumed salt. **Fix dir:** make salt a BEGIN-committed, displayed field the recompute consumes (salt-agnostic binding), OR document the zero-salt precondition as audit scope + assert it at BEGIN. **Src:** opus firmware M-3.

### AHW-019 · LOW · APP · OURS · VALIDATED
**Stale side-channel comments understate hardening (dangerous direction).** `mul_generator.c:11-29`, `point.h:30-36`, `point.c:77` describe the OLD branchy infinity fast-paths in present tense, but `point.c` is the M11 P3 branch-free cmov rewrite (`point_double` "NO data-dependent early return" :80; `add_affine` cmov-selects all exceptional candidates :138-228). Code is *more* constant-time than its docs. ⚠ Before rewriting these comments, confirm `point.c` is genuinely branch-free against the `dudect` result — overstating side-channel resistance is the worst direction to get wrong. **Fix dir:** rewrite to describe the branch-free reality + keep the operand-dependent `fr_mul` residual (AHW-029). **Src:** opus firmware L-1.

### AHW-020 · LOW · APP · OURS · VALIDATED
**Stale "single-pass" comments.** `finalize_and_sign.c:268-278` + `finalize_deploy_and_sign.c:226-234` say the Schnorr scalar/nonce derivation is "single-pass," but M11 P1 made both dual-derived with a two-direction fault-hard compare (`aztec_secret.c:172,199`). Understates the defense (same auditor-confusion cost as AHW-019). ⚠ Verify against `aztec_secret.c` before rewriting. **Fix dir:** update both comments to "dual-derived + fault-hard compare." **Src:** opus firmware L-2.

### AHW-021 · LOW · BUILD · OURS · VALIDATED
**`INS_CXMATH_SPIKE` throwaway present.** `dispatcher.c:180-187`, `types.h:42-46` (`0x70`), `handler/cxmath_spike.c` — compiled only under `#ifdef CX_MATH_SPIKE`, but if a release Makefile ever defines it, an unreviewed field-arith INS is exposed to the attacker-controlled APDU stream. **Fix dir:** `#error`/`_Static_assert` guard failing the build if `CX_MATH_SPIKE` + a release flag coexist; delete the spike before submission. **Build-layer (NEW-R2-12, folded):** the spike is reachable via the Makefile `EXTRA_DEFINES`/`CX_MATH_SPIKE` passthrough — the guard must specifically prevent a release build from defining it. **Src:** opus firmware L-3 + supply-chain NEW-R2-12.

### AHW-022 · LOW · APP · OURS · VALIDATED
**Reveal dismiss says "Transaction signed."** `get_aztec_master_secret.c:175-182` + `master_secret_reveal_ui.c:79-86` reuse `STATUS_TYPE_TRANSACTION_SIGNED` on the reveal success page (the confirm gate itself is correctly worded). A user could misremember they exported viewing capability. **Fix dir:** custom "Viewing key revealed" status. **Src:** opus firmware L-4.

### AHW-023 · LOW · APP · OURS · VALIDATED
**"claim present" check asymmetry.** Deploy uses an explicit `claimed_outer_hash_received` bool (`finalize_deploy_and_sign.c:94-101`, correctly avoiding the "Fr(0) is valid" pitfall); authwit relies on the `L4_CALLS_COMPLETE` state-gate (`finalize_and_sign.c:188-196`). Both correct; a reader must verify two mechanisms. **Fix dir:** comment on the authwit path noting the state-machine is the guard. **Src:** opus firmware L-5.

### AHW-024 · MED · TEST · OURS · VALIDATED
**No test for malformed-frame-mid-stream.** `wire-negative.test.ts` covers malformed bodies but not a transport-level bad-Lc frame injected between APPENDs (the AHW-017 path). **Fix dir:** Speculos test: `BEGIN_AUTHWIT(count=1)` → raw under/over-length frame → `APPEND_CALL` must return wrong-state. **Src:** opus firmware gap 1.

### AHW-025 · MED · TEST · OURS · VALIDATED
**Fault-injection reject arms untested.** The 3× recompute, dual-derive, and dup-sig defenses have no negative test that simulates a glitch (every parity test confirms the happy path agrees). **Fix dir:** host-compiled unit test stubbing a second derivation/recompute to differ, asserting the mismatch branch rejects. **Src:** opus firmware gap 2.

### AHW-026 · LOW · TEST · OURS · VALIDATED
**B3 non-default-salt lock-out untested.** `b3-consumer-binding.test.ts` should assert a non-zero-salt account yields `0x6F12` (documents the AHW-018 scope cliff as intended), so a future regression is caught. **Src:** opus firmware gap 3.

### AHW-027 · LOW · TEST · OURS · VALIDATED
**`cs_format_amount` adversarial vectors missing.** The routine is bounds-safe (verified) but has no fuzz/parity vector for u128 max, all-9s, decimals=30, high-bytes-set reject. **Fix dir:** small table-driven host test. **Src:** opus firmware gap 5.

### AHW-028 · LOW · HOST · OURS · VALIDATED
**Legacy `apps/demo` references deleted API.** `apps/demo/src/clear-sign-testnet.ts:120` + `apps/demo/src/index.ts:177` call `createAuthWitFromIntent`, which the seam refactor deleted. **Validated dead:** `apps/demo` is a workspace member nothing depends on; CI only typechecks it (no run/build/e2e). It is a direct contributor to AHW-030's CI-red. **Fix dir:** delete `apps/demo`. **Src:** orchestrator + opus supply-chain validator.

### AHW-029 · INFO · PLATFORM · LEDGER · VALIDATED
**Portable C field/EC layer is NOT certified constant-time.** Running custom Grumpkin/BN254 on the Secure Element via portable C (not the certified `cx_bn_*` path) leaves an operand-dependent `fr_mul`/`gk_fq_mul` timing residual. `dudect` proves the control-flow (leading-zero) leak is closed and reports the value-dependent residual as non-gating. The certified mitigation (cx_ ops + Ledger Donjon audit) is a **PLATFORM** path, deferred to M13 / real-silicon eval. **This is a documented, accepted platform constraint — not a fixable bug in our code.** Document for the auditor; pairs with the AHW-016 rate-limit mitigation. **Src:** opus firmware (framing).

---

## Round 2 findings (supply-chain / CI / cross-package — validated)

### AHW-030 · HIGH · BUILD · OURS · VALIDATED
**CI typecheck gate is RED on `main`.** `ci.yml:36` (`tsc -b packages/core packages/adapter-trezor packages/adapter-ledger apps/demo`) → exit 2, **8 `error TS`** on clean HEAD (validator reproduced exactly; bare root `tsc -b` = 19 across more projects). Net-new causes beyond AHW-028: `noUncheckedIndexedAccess` in LIVE test files (`grumpkin-point-add-edge.test.ts:30`, `wire-differential-replay.test.ts:158`) + `cxmath_spike/measure.ts` + `gen-poseidon2-constants.ts`. The project's own quality gate is being merged-around. **Fix dir:** fix the type errors (or correct the gate's project scope) and make typecheck blocking. **Src:** supply-chain NEW-R2-01 (validated).

### AHW-031 · MED · BUILD · OURS · VALIDATED
**Inverted CI coverage.** `ci.yml` typechecks the DEAD `apps/demo` but neither the LIVE `apps/demo-browser` nor the Playwright e2e. The gated thing is dead; the shipped thing is ungated. **Fix dir:** gate the live app + e2e; drop the dead demo (AHW-028). **Src:** supply-chain NEW-R2-02.

### AHW-032 · LOW · BUILD · OURS · VALIDATED
**`tsc -b` on non-composite projects.** Latent fragility (surfaces all errors today but brittle to config drift). Validator downgraded MED→LOW. **Fix dir:** proper composite/project-refs or per-project `--noEmit`. **Src:** supply-chain NEW-R2-03.

### AHW-033 · MED · BUILD · OURS · VALIDATED
**`bun audit` silently swallows HIGH vulns.** `ci.yml:42` `continue-on-error: true` with no step-summary → `bun audit` (exit 1) reports 12 vulns / **6 HIGH** (4× systeminformation cmd-injection, 2× undici) invisible every run. Violates the project's own "advisory AND surface in summary" policy. **Fix dir:** write findings to `$GITHUB_STEP_SUMMARY`; triage the 6 HIGH (transitive via `@aztec/*`). **Src:** supply-chain NEW-R2-04.

### AHW-034 · MED · DESIGN · OURS · VALIDATED
**No firmware provenance link.** `ledger-app/` is embedded (159 files, mode 100644, no `.gitmodules`) and its nested `.git` is an orphan with ZERO commits (unborn `main`). Two divergent mutable copies; the parent pins no firmware version/hash. Provenance gap for a hardware wallet. **Fix dir:** make `ledger-app` a submodule pinned to a commit (or commit + hash-pin the source); record the built `app.elf` hash. (App toml at `ledger-app/ledger_app.toml`.) **Src:** supply-chain NEW-R2-05.

### AHW-035 · MED · BUILD · OURS · VALIDATED
**Codegen PROVENANCE gap.** `gen-clear-signing-v0.ts:26-34` cross-checks against the MUTABLE `node_modules/@defi-wonderland/aztec-standards` artifact; `manifest._meta` pins are comments, never asserted vs installed version / content-hash. A dep bump can silently change what the device treats as canonical. **Fix dir:** assert installed pkg version + artifact content-hash against `_meta` at codegen; fail on mismatch. *(Distinct from AHW-042 coverage gap — neither fix closes the other.)* **Src:** supply-chain NEW-R2-06 (host/frontend R2-04 was a dup, folded).

### AHW-036 · MED · HOST · OURS · VALIDATED
**Second adapter replicates the blind-sign hole.** `adapter-trezor/src/provider.ts:81` (`createAuthWit`, blind) + `:99` self-described "malicious-host-spoofable" `createAuthWitFromIntent` exported as `IntentAuthWitnessProvider` — a second adapter with zero device verification, live in CI. Distinct package + distinct API-lie from AHW-001/012. **Fix dir:** fail-close/gate the trezor authwit paths, or mark the package experimental/excluded. **Src:** supply-chain NEW-R2-07.

### AHW-037 · LOW · BUILD · OURS · VALIDATED
**Dependency version fan-out.** `@noble/curves` ×2 + `@noble/hashes` ×3 (incl. a genuine v1↔v2 split) + TS 5/6 resident. Bloat + the hashes v1↔v2 split is a subtle correctness/supply-chain surface. **Fix dir:** dedupe/align. (Folds NEW-R2-09.) **Src:** supply-chain NEW-R2-08.

### AHW-038 · LOW · DESIGN · OURS · VALIDATED
**Forget doesn't zeroize; no custody doc.** The logout/"Forget" path drops references but doesn't zeroize heap-resident secrets (GC timing leaves them), and there's no written recovery/custody doc for the "Ledger seed IS the backup" claim. **Fix dir:** explicit zeroize on forget; write the recovery/custody threat-model doc. **Src:** supply-chain NEW-R2-10.

### AHW-039 · INFO · BUILD · OURS · VALIDATED
**Lockfile-freeze single point.** Freeze discipline rests on CI using `--frozen-lockfile` (bunfig `frozen=false` for local is fine). **Fix dir:** assert `--frozen-lockfile` in every CI install step. Flag-only. **Src:** supply-chain NEW-R2-11.

## Round 2 findings (host validation / frontend / codegen — validated)

### AHW-040 · HIGH · APP · OURS · VALIDATED
**`DRIP_PUB` is signed but NOT rendered.** Verb 8 (kind=3, selector `0xbe46ea53`, public, 2-arg; `selectors.gen.c:13`) clears every `append_call.c:128-146` gate (the from==consumer gate fires only for 4-arg transfers, so DRIP skips it); `dripUsdc` (`aztec-ledger-session.ts:490-501`) routes through `transferViaRealSendTx` to this UI; but `format_action` (`verified_calls_ui.c:138-147`) and `render_call_pairs` (`:201-258`) have no DRIP case → device shows **"Call DRIP" with ZERO value pairs** (no token/amount/recipient). The device signs a verb it does not render — a clear-signing-integrity defect on a live signed verb (blast radius bounded to the faucet, but the principle is broken). **Fix dir:** add a DRIP render case, or remove DRIP from the allowlist. **Src:** host/frontend R2-01 (validated decisively).

### AHW-041 · MED · APP · OURS · VALIDATED
**Comment claims a control that doesn't exist.** `preflight.ts:129` + `manifest.json:139` state the DRIP token-kind check is "enforced device-side in append_call," but `append_call.c:128-146` has no DRIP arg validation — the constraint lives only in the non-authoritative host preflight. Dangerous direction (claims MORE security than exists), distinct from the understated-comment findings AHW-019/020. **Fix dir:** enforce device-side, or correct the comment to state the host is the only gate. **Src:** host/frontend R2-02.

### AHW-042 · MED · BUILD · OURS · VALIDATED
**Codegen COVERAGE gap.** The cross-check verifies verb `(selector, arg_count, visibility)` but never the registry `address`/`decimals`/`symbol` emitted from `manifest.json` into `registry.gen.c` + `registry.generated.ts`. Even with a clean artifact, a wrong `decimals` mis-displays amounts by 10^N and a wrong `address` renders an attacker contract as "USDC" — with green CI. **Fix dir:** cross-check registry identity fields against the artifact/chain. *(Complements AHW-035 provenance gap.)* **Src:** host/frontend R2-03.

### AHW-043 · LOW · HOST · OURS · VALIDATED
**Dead capability negotiation.** `getCaps()` is invoked only in tests; no live path negotiates device capabilities. **Fix dir:** wire it into the connect handshake, or remove it. **Src:** host/frontend R2-05.

### AHW-044 · LOW · HOST · OURS · VALIDATED
**Speculos screen text shown as authoritative.** The dev `SpeculosPanel.tsx` (cast ~:40, render ~:123) renders emulator screen text as if it were the device screen (display-integrity, dev-only). The transport-cast half folds into AHW-011; the display-integrity slice is net-new. **Fix dir:** label the Speculos panel as emulator-only / not device-attested. **Src:** host/frontend R2-06 (narrowed).

### AHW-045 · LOW · APP · OURS · VALIDATED
**Cached re-onboard hides the checksum.** On a cached re-onboard the UI renders the literal string `"cached"` instead of the verifiable checksum hex, suppressing the user's cross-check of the device-revealed value. **Fix dir:** render the real checksum, or force re-verify. **Src:** host/frontend R2-07.

### AHW-046 · MED · TEST · OURS · VALIDATED
**No review-screen CONTENT tests.** The python device suite covers dispatcher/caps/pubkey/version/sign only; e2e auto-confirms by generic prompt-regex + asserts no browser error. Nothing asserts WHAT the review screen displays per verb — exactly why AHW-040 (DRIP unrendered) was invisible. **Fix dir:** add per-verb review-screen content assertions (ragger screen-text / snapshot). **Src:** host/frontend R2-08.

## Round 2 findings (protocol / cryptography — codex, validated)

### AHW-047 · HIGH · DESIGN · OURS · VALIDATED
**Reveal exports a path-wide privacy ROOT, not a per-account viewing key.** `aztec_secret.c:28-61` reveals `SHA-512("aztec-master-secret-v1\0" || secp256k1 child priv) mod Fr`, scoped only by BIP-32 path; upstream `@aztec/stdlib derivation.ts` expands that one Fr into ALL master privacy keys (NHK_M/IVSK_M/OVSK_M/TSK_M). Address derivation excludes chainId, and both ECDSA + Schnorr account paths consume the SAME secret. The on-device + host UI ("Account #N viewing keys / lets this computer see your notes"; `master_secret_reveal_ui.c`, `OnboardPanel.tsx`) materially under-represents scope: one approval lets the host monitor the user's Aztec privacy state for that Ledger path ACROSS chains AND both schemes and correlate them as one identity. **Corrected from codex:** privacy-root export, NOT spend authority — spend keys stay on-device (`aztec_secret.c:90-92`). Distinct from AHW-016 (rate-limit) / AHW-022 (dismiss wording). **Fix dir:** stronger domain separation of exported viewing material by purpose (and if protocol-allows, scheme/chain), OR fix the reveal UX to say it exports the privacy ROOT for that path, spanning networks/schemes. **Src:** codex C-PROTO-2 (validated, scope corrected).

### AHW-048 · MED · HOST · OURS · VALIDATED
**Revealed root persisted in `sessionStorage`.** `secret-cache.ts:8-15,38-65` stores the revealed master secret in JS memory AND `sessionStorage` (survives in-tab reloads). Any later same-origin XSS / injected script / extension with storage access exfiltrates the privacy root with NO new Ledger prompt. Cache key is device-path-scoped only (scheme-blind) → ECDSA↔Schnorr switch at the same path silently reuses the secret without a second approval. Distinct from AHW-038 (heap-zeroize on forget) + AHW-045 (the "cached" display string). **Fix dir:** memory-only, shortest lifetime, or re-reveal after reload; explicit opt-in + warning if persisted; make the cache key scheme-aware. **Src:** codex C-PROTO-3 (validated).

### AHW-049 · MED · DESIGN · OURS · VALIDATED
**Public clear-signed txs have no replay nullifier → sponsor re-bill.** `cancellable=false` is the framework default (`base_wallet.js:33`); the account entrypoint emits the tx-nonce nullifier only `if cancellable` (`account.nr:75-78`), and `SponsoredFPC.sponsor_unconditionally` has no one-shot guard. Replay protection thus rests entirely on each tx's INNER-call nullifiers: deploy self-protects via the constructor init-nullifier (`#[initializer]`), private transfers via note nullifiers — but PURELY-PUBLIC flows (drip, public self-transfer) emit none and can be replayed to re-bill the unconditional sponsor (sponsor-fund griefing, not user funds). **NB:** codex's original deploy-replay framing was REFUTED (the deploy IS self-protected by the init-nullifier); this is the corrected, narrower public-tx residue. Adjacent-but-distinct from AHW-003 (unsigned-field mutation pre-prove). **Fix dir:** sponsor-side one-shot nullifier keyed by (account, txNonce); or don't use an unconditional replayable SponsoredFPC for public flows; or set `cancellable=true` for clear-signed public txs (emits the nonce nullifier). **Src:** codex C-PROTO-1 residue (validated, reframed).

## Round 3 findings (on-device review-screen deception — validated)

### AHW-050 · HIGH · APP · OURS · VALIDATED
**Recipient address rendered 4+4 AND device-unverified — security budget backwards.** `verified_calls_ui.c:82-94` (`short_hex_field` = first 4 + last 4 bytes) renders the recipient at `:208`; `append_call.c:142-146` binds ONLY `from==consumer` and places ZERO constraint on `args[1]` (the recipient). The DEPLOY path uses a stronger 8+6 (`deploy_review_ui.c:62-79`) and the code itself brands 4+4 "brute-forceable." So the unverified, theft-enabling field gets the WEAK truncation while the device-verified field gets the strong one. Address-poisoning: 24 of 32 recipient bytes never shown; cheap attack is a 4-byte-prefix eyeball collision (~2^32). **Fix dir:** render the full recipient (or ≥8+6) and/or add a device-side recipient confirmation; never render the unverified field more weakly than the verified one. **Src:** UI R3-01 (validated, HIGH).

### AHW-051 · MED · APP · OURS · VALIDATED
**Host-supplied `decimals` mis-scales the displayed amount.** `decimals` comes from `registry.gen.c:7-11` (host/codegen, no device ground-truth) and drives the human-readable scaling at `verified_calls_ui.c:210`; `cs_format_amount` arithmetic itself is faithful. A wrong `decimals` makes a large transfer look small (or vice-versa) by 10^N while the SIGNED raw amount is unchanged. On-device DISPLAY-layer consequence of the codegen gaps AHW-035/042 — kept distinct (its mitigation differs: also render the RAW integer amount so a skewed `decimals` can't hide magnitude). Downgraded HIGH→MED (display-only; no value substitution). **Fix dir:** show the raw integer amount alongside the scaled one; pin/verify `decimals`. **Src:** UI R3-02 (validated, PARTIAL of AHW-042).

### AHW-052 · LOW · APP · OURS · VALIDATED
**Truncation ellipsis is non-ASCII on an ASCII-only font.** The `…` marker is raw U+2026 (`verified_calls_ui.c:90-93`, `deploy_review_ui.c:76`) on a font the app's own comment (`:135-137`) says lacks non-ASCII glyphs → may render blank/box on Nano, merging the two byte-halves into a deceptively "short complete" address. **Fix dir:** ASCII marker (`..`). **Src:** UI R3-03.

### AHW-053 · LOW · APP · OURS · VALIDATED
**Tail `outer_hash` shown 4+4 while blind-sign shows full 32B.** `verified_calls_ui.c:275` truncates the final outer-hash display to 64 of 256 bits, whereas the blind-sign path (`sign_ui.c:100`) shows the full 32 bytes — the "byte-level paranoia" escape hatch is weaker on the path that advertises it. **Fix dir:** show the full hash on the paranoia screen. **Src:** UI R3-04.

### AHW-054 · LOW · APP · OURS · VALIDATED
**"(verified)" halo over-scopes.** `"From (verified)"` (`verified_calls_ui.c:278`) visually implies the whole review is device-verified, but only `from`/consumer is — recipient, amount, symbol are host-trusted. **Fix dir:** scope the "verified" label to the From line; mark the others "as provided by host." **Src:** UI R3-05.

### AHW-055 · LOW · APP · OURS · VALIDATED
**Mint warning not salient.** `WARNING: MINTER action` renders as an inline tag-value pair (`verified_calls_ui.c:240-243`), not a banner/modal — easy to miss on a privileged action. **Fix dir:** prominent banner requiring explicit acknowledgement. **Src:** UI R3-06.

### AHW-056 · LOW · APP · OURS · VALIDATED
**SPONSOR shows no fee/cap.** The SPONSOR verb renders `Via: Testnet FPC` with no fee amount or cap (`verified_calls_ui.c:248-254`). Same honesty class as AHW-040 but LOW — the verb's `arg_count=0`, so there is no amount to hide (honest omission). **Fix dir:** display sponsor fee terms if/when they carry a cap. **Src:** UI R3-07.

## Round 4 findings (depth — failure-modes / crypto-correctness — validated)

### AHW-057 · MED · HOST · OURS · VALIDATED
**Deploy sign path has no abort-on-throw → wallet wedges.** `clear-signing-entrypoint.ts:232-241` (`#deploySignOnDevice`) lacks both a pre-abort and a try/catch that aborts on throw, unlike `#clearSignOnDevice:178` (which pre-aborts). A flaky-transport disconnect mid-`finalizeDeployAndSign` leaves the device parked in `L4_DEPLOY_CONTEXT`; the next deploy attempt hits an opaque `0x6F11` and the wallet wedges on the deploy verb until reset. Availability/UX defect, not a signing-integrity break. **Fix dir:** wrap the device deploy flow in try/catch that calls `abortAuthwit` on throw (mirror `#clearSignOnDevice`) and/or pre-abort at entry. **Src:** failure-modes R4-02 (validated).

### AHW-058 · LOW · APP · OURS · VALIDATED
**Dead status words.** `sw.h:17,28` define `SW_NOT_IMPLEMENTED` (0x6F07) + `SW_DEPLOY_CONTEXT_TWICE` (0x6F10), both host-mirrored (`apdu.ts`), but grep-confirmed NEVER returned (a 2nd BEGIN_DEPLOY yields 0x6F11). Distinct from AHW-006 (misleading comment on a LIVE SW) — this is unreachable code / contract drift. **Fix dir:** wire 0x6F10 to the second-BEGIN_DEPLOY case (clearer than 0x6F11), or delete both + the host mirrors. **Src:** failure-modes R4-04.

### AHW-059 · LOW · APP · OURS · VALIDATED
**Armed reveal-secret outside the session-reset surface.** `get_aztec_master_secret.c:52-54` holds `s_secret`/`s_armed` as file-static state structurally unreachable by `l4_session_reset()` (different TU). Not exploitable today (blocking-IO model + `disarm()` on entry), but that safety is an implicit io-loop property, not an enforced invariant — a future async/refactor could open a window. Distinct from AHW-038 (host heap-zeroize). **Fix dir:** call a `master_secret_disarm()` from `l4_session_reset()` so the invariant is explicit. **Src:** failure-modes R4-05.

### AHW-060 · LOW · TEST · OURS · VALIDATED
**Misleading golden-vector labels.** In `l4_outer_hashes.json` the poseidon2 smoke label `zero_hex` is `poseidon2Hash([])` (empty input), NOT `poseidon2Hash([Fr(0)])` as the name implies. Values are correct + parity-checked, but the label sends an auditor on a false "mismatch" lead (the finder hit it). Distinct from AHW-029/015. **Fix dir:** rename/annotate the label. **Src:** crypto-correctness R4-C-01.

### AHW-061 · LOW · APP · OURS · VALIDATED
**Confusing secret-scrub reads as a no-op bug.** `schnorr.c:14-20` (`schnorr_grumpkin_pubkey`) parses `priv` for a canonical check, then `gk_fq_zero`s it and signs from raw bytes — at a glance it looks like a no-op bug. It is functionally correct (a secret-scrub + policy guard; `[k]G == [k mod n]G`). Distinct from AHW-029. **Fix dir:** a clarifying comment so a reviewer doesn't flag it. **Src:** crypto-correctness R4-C-02.

**Round-4 folds** (sibling details merged into existing findings — no new ID):
- **AHW-017 += R4-01:** the session-reset fix must cover BOTH `app_main` bail-outs — the parse-fail path (`:43`) AND the dispatch-fail path (`:53`).
- **AHW-009 += R4-03:** the inflight mutex is assigned AFTER the `work` IIFE starts → a synchronous-prologue throw floats an unhandled rejection and can leave the mutex stuck; the one-statement mutex refactor closes both.
- **AHW-011 += R4-06:** `speculos-transport.ts:144-164` `fromHex` uses `Number.parseInt` with no hex validation → garbage laundered into structurally-valid zero-bytes (fail-closed in practice; the WebHID prod path has no `fromHex`).
- **AHW-043 += R4-07:** `getCaps()` never gates `connect`, so a device lacking `CAPS_GRUMPKIN` is caught only by a late opaque SW after prompting the user — no graceful degrade.

### AHW-062 · MED · DESIGN · OURS · VALIDATED
**Unsigned `txContext` fee controls → fee-burn / sponsor-drain (defense-in-depth).** The device-signed outer-hash binds ONLY `app_payload.hash()` (calls+txNonce) + (consumer, chainId, version). `gasSettings` (gasLimits/teardownGasLimits/maxFeesPerGas/maxPriorityFeesPerGas → `TxContext`), `feePaymentMethodOptions`, and `cancellable` are all OUTSIDE it; `feePayer` absent → silent `PREEXISTING_FEE_JUICE` (`base_wallet.js:135-138`); billing pays base+priority up to caps (`transaction_fee.js`); `SponsoredFPC.sponsor_unconditionally()` is UNCAPPED (the only fee path our verbs use). So a raised (unsigned) `maxPriorityFeesPerGas` could burn user fee-juice / sponsor treasury, or underprovisioned gas could grief liveness — invisible to the device review. **Severity MED not HIGH (validated decisive):** on every SHIPPED clear-signed path the fee knobs are set INTERNALLY — `transferViaRealSendTx` builds `gasSettings` from `node minFees × 2.5` (priority defaults to ZERO), `deployAccountViaEntrypoint` hard-codes EXTERNAL + cancellable=false, and `SubmitOptions` (`:139-147`) exposes NO fee param (live call sites pass `{onStep,onTxHash}` only). The only host-injection route is `internalDeps.session.sendTx({fee})` = the AHW-002 first-party bypass, not a remote dApp → defense-in-depth. **Fix dir (same guard as AHW-003):** clear-sign a fee ceiling + the fee-payer mode; reject host priority-fee/gas overrides on clear-signed flows; derive gas from simulation bound to the reviewed intent; fail closed unless the fee mode is the reviewed one. **Cross-link:** AHW-003 (root: unsigned fields), AHW-056 (sponsor display), AHW-049 (replay). **Src:** codex C4-1 (validated, HIGH→MED).

### AHW-063 · LOW · APP · OURS · VALIDATED
**Manual deploy treats PROPOSED as final.** `deployAccountViaEntrypoint` (`aztec-ledger-session.ts:415-419`) waits only for `TxStatus.PROPOSED` then reports "Account deployed," while upstream `waitForTx` defaults to `CHECKPOINTED` (`@aztec/aztec.js/dest/utils/node.js:30`; `PROPOSED < CHECKPOINTED`). A proposer-level inclusion later reorged/dropped is surfaced as success → false-finality window (callers act on an undeployed account, or retry → extra sponsor/proving exposure). NOT a replay (the constructor init-nullifier prevents duplicate-deploy). The transfer/drip path is unaffected (inherits CHECKPOINTED). Distinct from AHW-049. **Fix dir:** wait for CHECKPOINTED, or label PROPOSED provisional + retain the tx hash until checkpoint/final-failure. **Src:** codex C4-2 (validated).

## Round 5 findings (build/manifest hardening + trezor/deps — validated)

### AHW-064 · MED · APP · OURS · VALIDATED
**Loosest path gate on the most dangerous surface.** The L2 blind-sign (`sign_outer_hash.c:76-88`) + both pubkey getters (`get_public_key.c`, `get_schnorr_pubkey.c`) check only `1≤len≤10` on the BIP32 path, while all 3 L4 handlers enforce the full `m/44'/<coin>'/<acct>'/0/0`. The most dangerous surface (raw hash sign + pubkey export) has the weakest path validation. **MED — CONTINGENT:** Ledger's OS-enforced `PATH_APP_LOAD_PARAMS` bounds this to intra-Aztec scope (not cross-app key theft); if that OS scope-lock ever fails (SDK edge case / non-Ledger port) it escalates toward HIGH — the contingency travels with the finding. **Fix dir:** enforce the canonical path on the blind-sign + pubkey paths too. **Src:** build-hardening R5-01 (needs a 1-line Ledger-SDK confirmation of OS path enforcement).

### AHW-065 · LOW · BUILD · OURS · VALIDATED
**Manifest over-declares path scope.** `Makefile:38` grants a `"13'"` SLIP-0013 prefix no handler uses. Codex explicitly endorsed keeping it for forward-compat (`final-codex-critique.md:16`), so dropping it is a tradeoff → LOW. **Fix dir:** drop the unused prefix or document the deliberate forward-grant. **Src:** build-hardening R5-02 (MED→LOW).

### AHW-066 · MED · BUILD · OURS · VALIDATED
**Placeholder coin-type shipped.** Unregistered coin `1666` is hard-coded (`constants.h:34`, `Makefile:37`) and every CI build runs bare `make` (`ledger-app.yml:63`) → ships the placeholder. A prior codex pre-merge review flagged this HIGH ("don't ship the placeholder"); only half-closed. **Fix dir:** register/obtain the real Aztec SLIP-44 coin type, or gate the placeholder behind a non-default flag. **Src:** build-hardening R5-03.

### AHW-067 · LOW · BUILD · OURS · VALIDATED
**`-Werror` not enabled.** Neither `-Werror` nor `ENABLE_SDK_WERROR` is set (grep-clean); CI only checks the build exit code → warnings accumulate unenforced; violates Ledger submission guidance. **Fix dir:** `ENABLE_SDK_WERROR=1` + fix warnings. **Src:** build-hardening R5-04.

### AHW-068 · LOW · APP · MIXED · VALIDATED
**Barrier-less cmov under `-Oz`.** The constant-time point select (`point.c:69-77`) uses a bitmask cmov with no compiler barrier under `-Oz`; the optimizer could reintroduce a data-dependent branch. DISTINCT from AHW-029 (algorithmic value-dependence) — this is optimizer-de-CT. **Fix dir:** add an optimization barrier / verify emitted asm is branch-free; part of the deferred Donjon/cx_ hardening. **Src:** build-hardening R5-05.

### AHW-069 · LOW · BUILD · OURS · VALIDATED
**Toolchain unpinned for CT reproducibility.** clang version inside the (digest-pinned) builder image is unpinned/unasserted → constant-time codegen evidence can drift silently on a bump. Distinct from AHW-034/035. **Fix dir:** pin + assert clang; re-run the dudect gate on toolchain changes. **Src:** build-hardening R5-06.

### AHW-070 · LOW · APP · OURS · VALIDATED
**Canonical-path check inlined (C-side) — DEPLOY + REVEAL.** The full-path validation is inlined instead of calling the shared predicate, a security gate that can drift independently. **C2 update (F-B-2 folded here):** after AHW-064 landed the shared `az_bip32_path_is_canonical`, exactly 4 handlers call it (`begin_authwit`/`sign_outer_hash`/`get_public_key`/`get_schnorr_pubkey`); the 2 remaining inline copies are `begin_deploy_account.c:104-120` (deploy) and `get_aztec_master_secret.c:122-135` (reveal). Distinct from AHW-008/009 (TS). **Fix dir:** route both remaining sites through `az_bip32_path_is_canonical()`. **Src:** build-hardening R5-07 + C2/F-B-2.

### AHW-071 · LOW · BUILD · OURS · VALIDATED
**Empty top-level app manifest.** Root `ledger_app.toml` is 0 bytes despite the nested copy declaring itself authoritative — ambiguity about which governs. **Fix dir:** remove or populate the root toml; single source of truth. **Src:** build-hardening R5-08.

### AHW-072 · INFO · BUILD · OURS · VALIDATED
**Icon / device-matrix mismatch.** An Apex-P icon is referenced in the Makefile but `apex_p` is absent from both toml device lists + the CI matrix. **Fix dir:** align the Makefile icon set with declared target devices. **Src:** build-hardening R5-09.

### AHW-073 · MED · DESIGN · OURS · VALIDATED
**Trezor signs a non-canonical digest.** `adapter-trezor` `createAuthWitFromIntent` signs a hash from `core/intent-utils.ts computeOuterHashForIntent`, which does NOT match Aztec's canonical `EncodedAppEntrypointCalls` (drops is_public/hide_msg/is_static/tx_nonce/padding, wrong separator, args un-hashed). The Ledger adapter ABANDONED this for the canonical encoder + parity test; Trezor still uses the broken one with NO parity test. Distinct from AHW-036 (visual spoof) — here the DIGEST itself is wrong. **NB the defect lives in `packages/core` (shared) — it survives any adapter-trezor deletion.** **Fix dir:** route Trezor through `EncodedAppEntrypointCalls` + add a parity test; fix or delete `computeOuterHashForIntent`. **Src:** trezor-deps R5-02 (the one real net-new defect this round).

### AHW-074 · LOW · TEST · OURS · VALIDATED
**Trezor intent-authwit untested.** `provider.test.ts` covers only the blind path; `createAuthWitFromIntent` has zero direct unit test (why AHW-073 went unnoticed). *Scope: package recommended for deletion (AHW-078).* **Fix dir:** parity test, or delete with the package. **Src:** trezor-deps R5-03.

### AHW-075 · LOW · HOST · OURS · VALIDATED
**Trezor host doesn't verify the device signature.** The Trezor host never `secp.verify`s the returned signature against its cached pubkey (`@noble` verify is available). *Scope: AHW-078 dead-weight.* **Fix dir:** verify post-sign, or delete with the package. **Src:** trezor-deps R5-04.

### AHW-076 · LOW · HOST · OURS · VALIDATED
**Trezor subprocess-bridge desync.** The bridge matches request↔response by FIFO position only (`pendingResolvers.shift()`); one stray stdout line desyncs every subsequent call onto the wrong resolver. *Scope: AHW-078.* **Fix dir:** correlate by request id, or delete with the package. **Src:** trezor-deps R5-05.

### AHW-077 · LOW · HOST · OURS · VALIDATED
**Trezor sign-to-read pubkey.** `getPublicKeyXY` performs a real on-device sign over 32 zero bytes to read the pubkey, rather than a dedicated get-pubkey path. *Scope: AHW-078.* **Fix dir:** use a get-pubkey APDU, or delete with the package. **Src:** trezor-deps R5-06.

### AHW-078 · INFO · DESIGN · OURS · VALIDATED
**`adapter-trezor` is dead weight.** Only the dead `apps/demo` consumes it; the shipping `demo-browser` is Ledger-only. Presented as a peer of the production Ledger adapter, it inflates the audit blast radius — and its `apps/demo` path runs the broken-hash code (AHW-073). **Fix dir:** delete `adapter-trezor` (and the dead `apps/demo`, AHW-028) before audit, OR clearly mark it experimental/out-of-scope. Removing it dissolves AHW-074/075/076/077. **Src:** trezor-deps R5-07.

**Round-5 folds (merged into existing findings — no new ID):**
- **AHW-033 += R5-01 (CVE reachability triage):** reproduced `bun audit` = 12 vulns / 6 HIGH. Per-CVE verdict: 2× undici WS HIGHs are CODE-DEAD (5.29.0 hard-disables permessage-deflate; `@aztec/foundation` uses only the HTTP `Agent`); 4× systeminformation HIGHs are REAL but NODE-ONLY (via `@aztec/telemetry-client → @opentelemetry/host-metrics`, reaching only bb-prover/pxe — our code never imports telemetry); the browser bundle carries 0 HIGH (1 LOW elliptic). Remediation: bun root `overrides: { systeminformation: "^5.31.6" }` (host-metrics@0.36.2 pins 5.23.8 exactly → no transitive bump); undici needs no action.
- **AHW-051 += R5-08:** the host-supplied-decimals mis-scale also has a parallel core `formatAmount`→trezor path; net-new sub-point = unbounded `10^decimals` (no clamp) → format/DoS risk.

## Round 5 findings (privacy / metadata — codex, validated)

### AHW-079 · LOW · HOST · OURS · VALIDATED
**Pre-reveal `(seed,path)` pseudonym.** `onboarding.ts:59-74` `deviceCacheKey()` uses the raw K1 pubkey `x‖y` as a cache key, and `GET_PUBLIC_KEY` is non-confirmed by construction (`get_public_key.c:57-59` rejects `display=1`) — called on connect BEFORE any viewing-key reveal. An origin can harvest a stable `(seed,path)` pseudonym, enumerate account indices, and link ECDSA↔Schnorr at the same path. Distinct from AHW-048 (persists the secret) + AHW-064 (path-length gate). **Fix dir:** don't use approval-free pubkeys as persistent cache IDs; per-tab random handle or require a reveal. **Src:** codex CP-1 (validated).

### AHW-080 · LOW · HOST · MIXED · VALIDATED
**WebHID app-presence fingerprint.** `TransportWebHID.create()` (`webhid-transport.ts:53-63`) silently reuses an already-authorized Ledger + learns the model from `productId` (platform), and the demo probes the custom CLA-gated `INS_GET_VERSION` (ours) — success/failure distinguishes "Aztec app answering" from other/no app. Origin-scoped (not cross-origin), but a revisit/app-usage fingerprint. **Fix dir:** prefer `request()` / a privacy mode; disclose that Connect reveals Ledger + app presence. **Src:** codex CP-2 (validated, MIXED).

### AHW-081 · LOW · HOST · OURS · VALIDATED
**Default console logging of wallet metadata.** No quiet logger is passed anywhere, so Aztec's browser logger defaults to `info` and writes the registered account address + contract addresses/class-ids on connect, and tx hashes + simulation metadata on send, to `console`. Not a secret leak, but an unnecessary second activity channel. **Fix dir:** pass a silent/warn-only logger in demo/prod; scrub addresses/tx hashes from `info`. **Src:** codex CP-3 (validated).

### AHW-082 · INFO · DESIGN · OURS · VALIDATED
**Hidden third-party RPC in the default demo path.** `vite.config.ts:189-197` proxies the UI's `/aztec` to `https://rpc.testnet.aztec.beast-5.aztlanlabs.xyz`; that operator sees IP/session metadata, node polling, registered public function signatures, public-call simulations, and submitted txs/hashes. Private proving stays local — confirmed NO path sends the master secret. **Fix dir:** surface the real operator URL, default to blank/self-hosted, document exactly what the node sees. **Src:** codex CP-4 (validated).

### AHW-083 · INFO · TEST · OURS · VALIDATED
**Diagnostics persist wallet metadata.** All 4 demo panels `console.error({name,message,stack})`; a `SimulationError` stack can carry appended Aztec context (serialized `txRequest`/scopes). The Playwright harness mirrors console/page errors + success metadata to stdout. (The device `app_main.c` PRINTF is correctly debug-build-only.) CI doesn't run those Playwright files by default → mainly dev/test leakage, but it makes metadata durable. **Fix dir:** sanitize browser error logging; don't print addresses/tx hashes in tests by default. **Src:** codex CP-5 (validated).

---

## Catalog Campaign C2 (2026-06-02) — detailed findings (wave 1)

Re-audit of the merged audit-remediation (P0–P6). Target: the 31 commits the round-1 campaign predates (settings/NVM blind-sign, `path_canonical`, wire-v3 binding, the `clear-signing-entrypoint` rewrite, `secret-cache`). 3 diverse red-teamers (codex 5.5 xhigh — FW state-machine/binding; opus — FW crypto/UI/NVM; opus — TS wire host) + 1 opus validator (source-verified every claim, deduped vs AHW-001..083). **Yield: 0 CRIT · 0 HIGH · 3 MED · 7 LOW · 1 INFO + 2 folds.** Device guarantees independently re-confirmed intact (see Confirmed-clean additions below).

### AHW-084 · MED · WIRE · OURS · VALIDATED
**Poseidon2 domain-separator constants hardcoded in the host wire with no equality guard.** `l4-manifest.ts:37-40` hardcodes the four Aztec separators as literals (under a comment "must equal `l4/wire.h`"), consumed on the live signing wire at `:58`/`:72`/`:77` (the `argsHash` the device recomputes against). Verified they match `@aztec/constants@4.2.1` and `wire.h:78-80` today — but there is NO `===` assert binding them to `DomainSeparator` (upstream `@aztec/entrypoints/encoding.ts` imports the enum). An `@aztec/*` bump renumbering a separator silently desyncs the streamed `argsHash` from canonical → every clear-sign fails closed (`SW_HASH_MISMATCH`) or the parity test catches it. Fail-closed, not attacker-triggered, but a load-bearing crypto constant with no drift guard. `_AUTHWIT_OUTER` literal is already dead. **Fix dir:** import `DomainSeparator` from `@aztec/constants` or assert each literal `===` the member; drop the dead one. **Dedup:** distinct from AHW-035 (codegen) + AHW-015 (parity-anchor comment). **Src:** F-C-2.

### AHW-085 · MED · APP · OURS · VALIDATED
**Authwit FINALIZE re-hashes the cached `args_hash`, never re-derives from stored raw args.** `session.h:40-46` documents raw-args storage for "M5.2's three-pass finalize re-derivation from stored raw args," but the three passes (`finalize_and_sign.c:165-219` → `l4_compute_outer_hash`) consume the cached `call->args_hash` via `parity.c:57-58`; `l4_compute_outer_hash` (`parity.c:85-137`) never recomputes per-call `args_hash` from `call->args[]`. The cached value is written once at APPEND (`append_call.c:160-181`, double-recompute + cross-check). So a fault/glitch corrupting `slot->args_hash`/`slot->args[]` BETWEEN APPEND and FINALIZE is not caught — all three passes re-hash the same corrupted field and agree. Outer-hash 3-pass + B3 consumer-binding still hold → narrow defense-in-depth + comment-truth gap, not a host exploit. **Sev:** held MED (validator confirmed not HIGH): the code actively advertises a hardening it doesn't perform; exploitation needs a precise post-APPEND glitch. **Fix dir:** recompute each call's `args_hash` from `selector+args[]+is_public` every pass and compare before use. **Dedup:** distinct from AHW-025 (missing glitch-sim TESTS) — this is an impl/comment gap in the hardening itself. **Src:** F-A-1.

### AHW-086 · MED · APP · OURS · VALIDATED
**Call flags STATIC / HIDE_MSG_SENDER are signed but NOT rendered for MINT / DRIP / SPONSOR.** `parity.c:62-67` binds `is_public`/`hide_msg_sender`/`is_static` into the inner→outer hash for EVERY call. `append_call.c:110-146` constrains only the flag mask + `is_public` vs verb — STATIC/HIDE_MSG_SENDER unconstrained for all verbs. `verified_calls_ui.c`: `format_mode` (the only surface showing those flags, `:139-159`) is called ONLY in the TRANSFER arm (`:261`); the MINT/SPONSOR/DRIP arms emit no Flags pair. So a patched host streams a MINT/DRIP/SPONSOR call with HIDE_MSG_SENDER/STATIC; the device binds it into the approved signature but shows nothing. Bounded (still cryptographically bound — no forgery; `is_static` self-defeats a state change) but breaks "rendered == signed" for 3 of 4 verb families. **Fix dir:** emit the Flags pair for any verb when the flag is set, OR reject non-zero STATIC/HIDE_SENDER on verbs whose UI omits them. **Dedup:** distinct from AHW-040 (DRIP value pairs) + AHW-055 (mint warning); directly refines the index Confirmed-clean flags negative (which verified BINDING, not DISPLAY). **Src:** F-B-1.

### AHW-087 · LOW · WIRE · OURS · VALIDATED
**Live Ledger adapter never verifies the device's returned signature.** `provider.ts:151-167`/`:196-212` length-check `r‖s` (64B) and return; `clear-signing-entrypoint.ts:176`/`:231` wrap straight into `new AuthWitness(...)` with zero verification, though the host caches the pubkey (`auth-witness-provider.ts:79-89`) and bundles `@noble/curves`. A MITM/compromised transport returning any well-formed 64-byte blob with `sw=0x9000` is trusted; bad sig only fails late in-circuit (opaque). No fund loss (in-circuit verifier backstops) — defense-in-depth + clearer-error miss. **Fix dir:** `secp256k1.verify(r‖s, sha256(outerHash), cachedPubkey)` (+ Grumpkin-Schnorr equiv); throw on failure. **Dedup:** AHW-075 = same principle but scoped to the DELETED `adapter-trezor` (dissolved); the live sole-v0 adapter is uncovered. **Src:** F-C-3.

### AHW-088 · LOW · WIRE · OURS · VALIDATED
**`overrideAccount` mutates the shared wallet account-map every transfer/drip and is never reverted.** `aztec-ledger-session.ts:618-620` installs a fresh per-tx `BaseAccount` via `session.overrideAccount(...)`; the `finally` (`:638-642`) only nulls `inflight` — no override revert. Contrast the deploy path (`:371-396`) which uses `setEntrypointOverride(ep)` + `finally(null)`. The override outlives submission; `EmbeddedWallet.sendTx` auto-authwit harvesting routes through the overridden account. Fail-closed today (its `createAuthWit` throws, AHW-001/089), but a stale-state seam: a second account on the same session, or a future non-throwing override, inherits a permanently-installed entrypoint built for the FIRST tx's options. **Fix dir:** revert the override in `transferViaRealSendTx`'s `finally`, or build the per-tx account without mutating shared state. **Dedup:** distinct from AHW-009 (monolith/mutex) — un-reverted shared-map mutation. **Src:** F-C-4.

### AHW-089 · LOW · WIRE · MIXED · VALIDATED
**Auto-authwit fail-close (AHW-001) is silently swallowed upstream — no user signal.** `EmbeddedWallet.sendTx` derives app-authwits in `embedded_wallet.js:85-98` via `…map(async … try{createAuthWit}catch{return undefined})`, pushing only truthy. Our `createAuthWit` always throws (AHW-001 fail-close), so any tx genuinely needing an app-authwit has it dropped to `undefined` and filtered; the tx then proves WITHOUT it and fails later with an unrelated kernel/sim error — the user never sees "this flow needs an authorization the device can't clear-sign yet." Availability/observability only (live own-account flows generate no offchain auth effects, so it never fires today). **Owned MIXED:** the swallowing catch is upstream `@aztec/wallets`; the throw-with-no-signal decision is OURS. **Fix dir:** detect non-empty `offchainEffects` needing authwits BEFORE `sendTx` and raise a clear error in our wrapper. **Dedup:** AHW-001 = the capability fix; this is the new interaction observation. **Src:** F-C-5.

### AHW-090 · LOW · TEST · OURS · VALIDATED
**No host test threads `(profileId, salt)` from a non-zero-salt account through provider → entrypoint → `buildL4Manifest`.** The post-impl codex salt fix is enforced by threading through `auth-witness-provider.ts:115-123` → `aztec-ledger-session.ts:246-250` → `clear-signing-entrypoint.ts:160-167`. Verified by grep: NO `*.test.ts` references `createClearSigningEntrypoint`; manifest-builder tests construct the header by hand with no `profileId` equality assert. A regression dropping `salt`/`profileId` would compile, pass every test, and silently sign with salt=0/profile=0 → device 0x6F12 only at runtime on a non-zero-salt account. **Fix dir:** pure-TS test stubbing `LedgerProvider` to capture the `beginAuthwit(header)` arg, asserting `header.profileId`/`header.salt`. **Dedup:** AHW-026 tests the DEVICE-side lock-out; this is the untested HOST producer side. **Src:** F-C-6.

### AHW-091 · LOW · TEST · OURS · VALIDATED
**The B3 binding / finalize tail is outside the adversarial fuzz/replay envelope.** `tests/wire_host/Makefile:11-14` states the harness proves "per-APDU memory-safety + parser robustness, NOT multi-APDU session-state machines"; the deploy target fuzzes only `deploy_parse_and_validate()`, and `fuzz_deploy_parse.c:26-53` defines `account_binding_deploy_pubkey_xy`, `account_binding_deploy_partial`, `az_account_derive_from_path` as `__builtin_trap()` stubs. So B3 binding, deploy pre-sign recompute, and FINALIZE state-handling are never executed by the fuzz/differential-replay suite — regressions in the new remediation cluster can ship unhit. **Fix dir:** seeded replay/fuzz targets for `FINALIZE_AND_SIGN` + `FINALIZE_DEPLOY_AND_SIGN`, plus a host-buildable oracle that runs the binding tail instead of trapping. **Dedup:** AHW-024/025 are individual missing tests; this is the structural blind spot around the centralized binding/finalize code. **Src:** F-A-3.

### AHW-092 · LOW · APP · OURS · VALIDATED
**Shared binding helper defaults unknown constructor schemas to ECDSA; FINALIZE never re-checks schema.** `account_binding.c:57-72` (`account_binding_deploy_partial`) handles `CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY` explicitly and sends every other `arg_schema` down the ECDSA path (`:69`). Authwit FINALIZE (`finalize_and_sign.c:108-115`) re-checks only `(curve_id, profile_id)` via `l4_authwit_curve_profile_allowed`, not `profile->arg_schema`. Not exploitable with today's 2 profiles (K1↔0, GRUMPKIN↔1), but a real fail-closed hole in the new shared helper: manifest/codegen drift changing the schema behind an allowlisted profile id → B3 keeps accepting it and binds against the wrong ctor encoding instead of fail-closing. **Fix dir:** switch exhaustively on known schemas + `return -1` on default; assert `arg_schema` matches the expected curve in `b3_verify_consumer_is_this_account`. **Dedup:** novel; the closed post-impl "fail closed on unknown CURVES" left the arg_schema axis open. **Src:** F-A-2.

### AHW-093 · LOW · WIRE · OURS · VALIDATED
**No assert that deploy/tx mode matches the presence of `ledgerDeployContext`.** `clear-signing-entrypoint.ts:127` decides deploy-vs-tx purely on `(options).ledgerDeployContext`; `createTxExecutionRequest` never inspects `options` for a stray context, and `#assertClearSignPolicy:284-320` checks authWitnesses/capsules/extraHashedArgs/feeMode/cancellable but never the deploy-context presence per `kind`. The mode-select is an unauthenticated host-chosen sideband — nothing asserts "a tx MUST NOT carry a deploy context" / "a deploy MUST carry one." Fail-closed both ways today (rests on luck, not an assert); a future field/branch change could silently downgrade a deploy to a verb review. **Sev:** LOW (defense-in-depth pin only). **Fix dir:** in `#assertClearSignPolicy`, assert `kind==='deploy'` ⇔ context present; pairs with AHW-005's typed-options fix. **Dedup:** AHW-005 (PARKED) = the type annotation; this is the missing mode-consistency assert (thin, but distinct + highest-trust seam). **Src:** F-C-1.

### AHW-094 · INFO · APP · OURS · VALIDATED
**Master-secret reveal UI header docstring is stale — claims "Path: full BIP-32 path", code shows "Account #N".** `master_secret_reveal_ui.c:11-14` documents "Two pairs: Path = full BIP-32 path … Confirm = checksum," but `ui_display_master_secret_reveal` (`:64-71`) shows `Account="#N"` (masked `reveal_account_index()`, `:52-54`) + `Confirm=checksum` — no "Path" pair, the full path is never displayed (the M9 B2 change switched path→"#N" but left the docstring). No runtime effect — comment-truth defect on the most sensitive screen (privacy-root reveal); an auditor reading the header would believe the full path is shown. **Fix dir:** update the docstring to match (Account #N + Confirm checksum; note full path intentionally not shown post-M9 B2). **Dedup:** distinct from AHW-022 (dismiss status) + AHW-047 (subtitle wording). **Src:** F-B-3.

### C2 wave-1 folds (no new ID)
- **F-B-2 → AHW-070** (extended above): the reveal handler is a genuine 4th inline canonical-path copy not enumerated in AHW-070's deploy-only scope; folded for register succinctness (identical defect class + one-line fix). AHW-070 scope now "DEPLOY + REVEAL."
- **F-C-7 → AHW-010** (location updated above): same `bytesEqual` `as number` cast, relocated to `clear-signing-entrypoint.ts:82` by the rewrite — one defect, new line.

---

## Catalog Campaign C2 — Wave 2 + 10-codex Burst (2026-06-02; LOOP STOPPED per owner)

**Finders:** wave-2/3 = D/E/F/G/H/J (codex: deploy, crypto/signing, wire/codegen; opus: memsafety, modularity/tests, onboarding/attestation); a one-time **10-codex burst** K1–K10 (fault-injection · side-channel · APDU state-machine · crypto-correctness · scheme-confusion · build/supply-chain · consumer-API · privacy · fail-open · recovery/custody). **Validators:** 3 theme-split opus (V1 fault/signing/state · V2 supply-chain/API/attestation · V3 quality/sidechannel/privacy) — every claim source-verified, deduped vs AHW-001..094, consolidated within-cluster. Full per-finding blocks + fix-sketches: `audit/_raw/c2/validated-V{1,2,3}.md` (raw finder transcripts: `audit/_raw/c2/{D..J,K1..K10}*.md`).

**Consolidation was the story: ~15 raw HIGH candidates → 4 validated HIGH.** The inflation was killed honestly — K1's "5 HIGH" fault cluster collapsed (blind-sign triple G-1/K1-2/K3-1 → one AHW-095; "every confirm callback is one branch" = universal BOLOS pattern → AHW-128 INFO/PLATFORM; "widens to arbitrary children" / "reveals child's root" = factually false [B3 re-binds; emitted secret frozen] → LOW); K2's three side-channel "HIGH" → LOW/LOW/fold (leaked value is the PUBLIC sig `s`; the limb-predicate is the AHW-029 PLATFORM residual); K10-1 single-seed-vs-spec → MED (doc↔impl; runtime consequence already AHW-047).

**The 4 HIGH (all NEW):**
- **AHW-095** (FW) — blind-sign approval re-reads mutable `G_context` (`sign_ui.c:94` + `sign_outer_hash.c:126`); the ONLY signing sink that signs an unsnapshotted hash/path (authwit + deploy provably sign a fresh local recompute). Bounded by blind-sign default-OFF/NVM-sticky. Fix: sign an immutable reviewed snapshot + reject on post-review mismatch.
- **AHW-096** (BUILD) — `crossCheckDeployProfile` verifies only class-id/ctor; `sponsor_fpc_address`/`sponsor_selector_u32`/`deployer` are emitted unchecked, signed by the device, shown only as "Sponsored (testnet)". Fix: canonical-equality gate at codegen + gate the firmware build on gen-drift + render the sponsor.
- **AHW-097** (HOST) — `index.ts` root-exports `LedgerProvider.signOuterHash` (raw digest signer) outside the clear-sign entrypoint; only guard is the device toggle. Fix: drop from the root barrel / relocate behind an explicit unsafe subpath.
- **AHW-098** (DESIGN) — onboard derives the address host-side; the device attests the SECRET (reveal checksum) but never the ADDRESS, and deploy address-attestation is skipped on host-controlled `alreadyDeployed`. Fix: an approval-gated device-derived `GET_AZTEC_ADDRESS`, or an address fingerprint in the reveal pair.

**Systemic themes for the deep-plan (each = ONE work-item across sites):**
1. **Post-review mutable-state TOCTOU** — AHW-095 (live HIGH) + AHW-099 (deploy) + AHW-085 (authwit): sign/emit an immutable reviewed snapshot, never re-read globals.
2. **Host-trusted/unattested field → signing or "verified" display** — AHW-096, AHW-098, AHW-105, AHW-118; cf. AHW-084/086.
3. **Over-broad published API surface** — AHW-097 + AHW-104 + AHW-103 compose into a clear-sign bypass.
4. **Build/supply-chain provenance** (release-gate class, owner-PARKED CI) — AHW-096/101/102 + existing AHW-034/035.
5. **Untested fail-closed reject arms + anti-malleability** — AHW-108/109 + existing AHW-024/025/091 (one consolidated test item).
6. **Duplicated C security primitives** — AHW-126 (`ct_memcmp32`×5, low-S×3) + existing AHW-070/008.

**Folds into existing findings (enrich, no new ID):** AHW-029 += side-channel limb-predicate control-flow (gate on the same -Oz/dudect evidence); AHW-021 += `cxmath_spike` skips `l4_session_reset` + uncapped ≤65535 loop (dead in shipped build); AHW-025 += the concrete 0x6F06 dup-sig glitch-sim arm; AHW-093 += the `wrapExecutionPayload` branch-select test companion.

---

## Confirmed-clean — negative results (checked & robust; auditor-facing)
Recorded so the auditor doesn't re-chase, and to show the review's breadth.
- **[C2] Firmware in scope is MEMORY-SAFE** (opus, source-verified): no OOB / off-by-one / integer-overflow / stale-buffer / VLA / recursion across `dispatcher.c`, `app_main.c`, the 5 parse fns, `cxmath_spike.c`, `format.c`. Every host count capped at a compile-time constant BEFORE indexing; every BIP-32 read doubly bounded; every parser rejects trailing bytes + gates `buffer_read_*` on remaining length; `cs_format_amount` bounds-safe. The one platform reliance (BOLOS `apdu_parser` body-sizing) is AHW-124.
- **[C2] Crypto-correctness clean** (codex K4, source-verified + re-ran `poseidon2_cli`): poseidon2 / pedersen / blake2s / grumpkin + `args_hash` / `outer_hash` / padding match the Aztec canonical refs across edge cases (0, p−1, identity, point-at-∞, unreduced→reject, empty/max args); **no collision or second-preimage**; `deploy_outer_hash` matches the sponsored-deploy authwit shape.
- **[C2] Dual-scheme (ECDSA-K1 vs Schnorr-Grumpkin) confusion clean** (codex K5, source-verified): BEGIN+FINALIZE validate `curve_id`/canonical-path/allowlisted `(curve,profile)` + re-derive the bound account before AND just before signing; the "Scheme" review line is 1:1 with the signer; Schnorr nonce bound to `curve_id+pubkey+priv+msg`; deploy validates `curve_id` vs the profile `arg_schema`. (Builds on AHW-018/092.)
- **Signature malleability:** ECDSA-K low-`s` enforced; Schnorr (R,s) canonical; no malleable encoding accepted. (codex)
- **Domain separation:** device vs host separators match `@aztec/constants`; no cross-context (authwit↔deploy↔nonce↔pedersen↔poseidon) preimage collision found. (codex)
- **Clear-sign flags** (STATIC / HIDE_MSG / PUBLIC) are bound into the inner_hash (`parity.c:62-67`) — no sign-side forgery; `is_public` double-bound via the args_hash separator. **⚠ REFINED by AHW-086 (C2):** binding ≠ display — STATIC/HIDE_MSG_SENDER are rendered only in the TRANSFER arm, so MINT/DRIP/SPONSOR carry a display-vs-sign gap. (UI validator N-1)
- **Multi-call review cannot overflow/mask:** `call_count ≤ 5` (`begin_authwit.c:95`), `VC_PAIR_CAPACITY = 32`, worst case 29 pairs; all calls render. (UI validator N-2)
- **No in-allowlist token-symbol collision** today (4 distinct symbols @ distinct addresses; carries the AHW-042 codegen caveat). (UI validator N-3)
- **`cs_format_amount` arithmetic is faithful:** locale-free fixed-point, correct trailing-zero trim, high-bytes/`decimals>30` rejected — only the `decimals` SOURCE deceives (AHW-051). (UI validator N-4)
- **Frontend:** React JSX auto-escapes all node/URL/error strings (no `dangerouslySetInnerHTML`/`innerHTML`/`eval`); WASM bb-prover bundled from pinned `node_modules`, no CDN fetch; Speculos image SHA-pinned. (host/frontend)
- **The "verified on device" address pill IS genuinely device-attested** (transfer/drip via `b3_verify_consumer_is_this_account`, fail-closed 0x6F12; onboard via device-revealed secret) — no attestation spoof. (host/frontend)
- **`provider.ts` length parsers** (incl. the 64-vs-32 master-secret path) are uniformly exact-equality and fail-closed. (host/frontend)
- **Device APDU parsing** has no VLAs/`alloca`, counts capped at tiny constants, trailing-byte rejection + canonical-path enforcement on every signing path; **the device signs only what it recomputed** (never the host `claimed_outer_hash`), 3× fault-hardened, B3 two-site, M8-P6 sovereignty enforced, the point-doubling aliasing bug fixed + regression-tested. (firmware)

---

## Round-1 campaign closed (83 findings) — REOPENED by Catalog Campaign C2 (2026-06-02, now 94)
Stopped on the "repeating ourselves" condition — the 125 ceiling was deliberately NOT padded to. Rounds 4–5 (depth + every remaining unrun angle) produced **0 surviving new HIGH/CRIT**; yield collapsed to MED/LOW/INFO/hardening/dead-code/enrichments. The round-5 validators independently flagged diminishing returns in the impact profile (0-reject/0-dup, but all-LOW/INFO — the 0-reject rate was inflated by the angles being genuinely unrun, not by remaining HIGHs).

**Coverage:** 9 red-team subagents (5 opus + 4 codex xhigh) across — trust-boundary · firmware crypto-memory · quality/modularity/tests · supply-chain/CI · host-validation/frontend/codegen · protocol/crypto · UI-deception · crypto-correctness · failure-modes · build/manifest-hardening · trezor/deps · privacy/metadata — each finding run through one of 8 separate validation subagents (validated + deduped) before indexing. Raw + validation transcripts in `audit/_raw/`.

**Severity:** 1 CRITICAL · 7 HIGH · ~24 MED · ~44 LOW · ~7 INFO, plus recorded confirmed-clean negatives (malleability, domain-sep, 6/6 crypto primitives, multi-call, attestation pill, no-XSS, no-analytics, fee-ceiling-signed, sig-verifier-low-s, no-new-timing-leak).

**Fix-first cluster (CRIT + HIGH):** AHW-001 (blind-signed app-authwits) · AHW-002 (raw bypasses) · AHW-003 (tx unsigned-fields) · AHW-004 (seam untested) · AHW-030 (CI red on `main`) · AHW-040 (DRIP unrendered) · AHW-047 (reveal = privacy-root) · AHW-050 (recipient 4+4 + unverified). The **clear-signing-completeness** theme is the spine (device verifies sender + hash, but recipient / amount / app-authwits / fee are host-trusted): AHW-001/003/040/050 + the codegen pair AHW-035/042 + the fee finding AHW-062. Pre-audit hygiene quick wins: delete `adapter-trezor` + dead `apps/demo` (AHW-078/028 → dissolves AHW-073/074/075/076/077), fix CI-red (AHW-030), bump `systeminformation` (AHW-033).

**Next: deep-plan the fixes.**
