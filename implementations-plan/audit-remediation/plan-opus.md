# Audit Remediation — Implementation Plan (opus, INDEPENDENT / Tier-A)

> Independent plan for triangulation. Author: opus subagent. Scope: the 83-finding
> register (`audit/index.md`) = **1 CRIT · 7 HIGH · ~24 MED · cheap LOW/INFO**.
> Owner's locked decisions are designed in; where I think one is wrong I say so in
> §"Pushback on locked decisions" — I do **not** silently relitigate.

## TL;DR opinion (read this first)

The audit's own spine is right: **clear-signing completeness** is the real disease,
and everything else is hygiene. The device today proves *sender* and *outer_hash*
but **trusts the host for recipient, amount, app-authwits, and fee** — and the host
SDK (`@aztec/wallets` `EmbeddedWallet.sendTx`) will **blind-sign auto-derived
app-authwits before our entrypoint ever runs** (AHW-001, the lone CRIT). Fixes split
cleanly into:

1. **Stop the bleeding host-side, fail-closed** (CRIT + 3 HIGH) — cheap, no firmware, ship first.
2. **Un-red the build** (AHW-030/033) — the project's own gate is merged-around; nothing else is trustworthy until green.
3. **Firmware hardening with one wire change** (B3-salt, NVM rate-limit, blind_signing toggle, cmov barrier) — the expensive, risky tier; sequence it last and behind a hard cut.
4. **Display honesty** (recipient 8+8, DRIP render, reveal scope) — device UX, do it with the firmware rebuild.
5. **Dead-code amputation + provenance** — delete `adapter-trezor`/`apps/demo`, pin firmware/codegen.

My single biggest divergence from what I expect the other plans to say: **I would NOT
ship the `blind_signing` ON path at all for a PoC** (see §Pushback). The owner locked
it; I implement it, but I argue the safer default is *remove `signOuterHash` from the
device entirely* and re-add it only when a real app-authwit flow needs it. Second
divergence: the **B3-salt wire change is the highest-regression-risk item in the whole
plan** and I sequence it dead-last, behind everything else green, with a kill-switch.

---

## ASCII status tracker

```
[ ] Phase 0  Pre-flight: un-red CI, delete dead code, provenance (AHW-030/031/032/033/028/078/073…)
[ ] Phase 1  Host fail-closed: kill the CRIT + HIGH bypasses (AHW-001/002/003/004/062/057)
[ ] Phase 2  Host correctness + privacy hygiene (AHW-005/007/008/009/047-host/048/049/063/079/081/083/082)
[ ] Phase 3  Firmware infra: NVM settings store + blind_signing toggle + rate-limit (AHW-016/064/017/059/021)
[ ] Phase 4  Firmware display honesty (AHW-050/040/051/052/053/054/055/041/022)
[ ] Phase 5  B3-salt WIRE CHANGE (AHW-018) — last, behind a hard cut
[ ] Phase 6  Codegen provenance + coverage (AHW-035/042/066/067/069)
[ ] Phase 7  Test backfill + comment-truth sweep (AHW-024/025/026/027/046/006/013/014/019/020/023/058/060/061/070/012)
[ ] Phase 8  Docs (recovery/custody, residual-risk register) (AHW-038/029/044/045/080/065/071/072)
[ ] Validation gate (Speculos + testnet matrix, fuzz, differential-replay, lint+tests, git-grep)
```

---

## Architecture facts established by reading the code (citations)

These ground every fix; cited so the consolidation step can verify against the repo.

- **CRIT root is upstream, not ours.** `@aztec/wallets` `EmbeddedWallet.sendTx`
  (`…/@aztec/wallets/dest/embedded/embedded_wallet.js:69-128`) pre-simulates, maps each
  offchain effect to `CallAuthorizationRequest.fromFields`, calls
  `this.createAuthWit(onBehalfOf, {consumer, innerHash})` (`:88`), and pushes the
  result into the **caller-owned** `executionPayload.authWitnesses` (`:96-100`) —
  **all before** `createTxExecutionRequest`/`LedgerClearSigningEntrypoint` runs. Our
  account's `createAuthWit` resolves to the provider's `signAndWrap` →
  `inner.signOuterHash` (`auth-witness-provider.ts:82-97,115-124`), a HASH-ONLY blind
  sign. So the device blind-signs authorizations the user never reviewed, and the
  witnesses survive in the caller array even if clear-sign later fails. The shipped
  transfer/drip/deploy flows generate **no** offchain auth effects, so it's latent —
  but it is a real "clear-sign everything" hole.

- **The clear-sign seam is sound where it runs.** `LedgerClearSigningEntrypoint`
  (`clear-signing-entrypoint.ts`) independently computes the canonical
  `computeOuterAuthWitHash` over `EncodedAppEntrypointCalls` (`:155-164`), streams the
  wire to the device, and `#consume` (`:245-255`) enforces stream-A-claim-B. The
  **deploy** path (`wrapExecutionPayload`, `:122-137`) already rejects non-EXTERNAL fee
  + `cancellable!==false`. The **tx** path (`#clearSignOnDevice`, `:146-187`) does
  **not** guard `authWitnesses`/`capsules`/`extraHashedArgs`/fee mode — that's AHW-003.

- **`internalDeps` leaks the bypasses.** `aztec-ledger-session.ts:437-440` returns
  `Omit<deps,'secret'>` which still exposes `session` (a `SessionEmbeddedWallet` whose
  `sendTx` blind-signs via the default account) and `ledgerProvider` (whose
  `createAuthWit` is the blind path). Grep-confirmed: no external consumer today
  (AHW-002).

- **Device "From" is genuinely device-attested; recipient is not.**
  `finalize_and_sign.c:112-183` (`b3_verify_consumer_is_this_account`) recomputes this
  account's address from the signing path + viewing keys and cross-checks it against
  the signed `consumer` (fail-closed `SW_AUTHWIT_CONSUMER_MISMATCH` / 0x6F12). But it
  **hard-codes `B3_ZERO` salt + profile 0** (`:113,148,157`). `append_call.c:142-146`
  binds only `from == consumer` for 4-arg transfers and places **zero** constraint on
  `args[1]` (the recipient). `verified_calls_ui.c:82-94` renders recipient at 4+4
  (`short_hex_field`), weaker than deploy's 8+6 (`deploy_review_ui.c:66-79`). That's
  AHW-050 + AHW-018.

- **DRIP is signed but unrendered.** `render_call_pairs` (`verified_calls_ui.c:201-258`)
  has cases for TRANSFER/MINT/SPONSOR but **no DRIP case**; `dripUsdc`
  (`aztec-ledger-session.ts:490-501`) routes through `transferViaRealSendTx`. Device
  shows "Call DRIP" with zero value pairs (AHW-040). Severity bounded to the faucet but
  the integrity principle is broken.

- **No NVM/settings infra exists.** `menu_nbgl.c:4` — *"No NVM-backed settings."*
  `grep` for `nvm_write`/`N_storage` in `src/` is empty. So `blind_signing` AND the
  rate-limit counter must **build the persistent-storage layer from scratch** (a
  `NVM_PIC`-qualified struct + `nvm_write`). This is more work than the brief implies.

- **Reveal exports the privacy ROOT.** `get_aztec_master_secret.c:78-164` derives
  `SHA-512("aztec-master-secret-v1\0" || secp256k1 child priv) mod Fr` scoped only by
  BIP-32 path; upstream `@aztec/stdlib derivation.ts` expands that one Fr into ALL four
  master keys (NHK/IVSK/OVSK/TSK). Address excludes chainId; ECDSA+Schnorr consume the
  same secret. UI/host under-state scope (AHW-047). Cached in `sessionStorage`
  (`secret-cache.ts:38-41`), scheme-blind key (AHW-048).

- **Deploy waits PROPOSED, no abort-on-throw.** `deployAccountViaEntrypoint`
  (`:415-418`) waits `TxStatus.PROPOSED`; `#deploySignOnDevice`
  (`clear-signing-entrypoint.ts:198-241`) has neither pre-abort nor try/catch — a
  mid-flight disconnect parks the device in `L4_DEPLOY_CONTEXT` and the next deploy hits
  0x6F11 (AHW-057/063).

- **CI is red + swallows vulns.** `.github/workflows/ci.yml:36` typechecks the **dead**
  `apps/demo` (and `adapter-trezor`), not `demo-browser`/e2e; `:42` `bun audit
  continue-on-error: true` with no summary (AHW-030/031/033).

- **Salt already on the deploy wire, not the authwit wire.** `begin_deploy_account.c`
  reads `salt` (`:140-143`) and the host encoder sends it (`deploy-context.ts:44,
  97-107`). `begin_authwit.c` does **not** carry salt — that's the wire change.

---

# Phase 0 — Pre-flight: un-red CI, amputate dead code, provenance

**Findings:** AHW-030, AHW-031, AHW-032, AHW-033, AHW-028, AHW-078, AHW-073, AHW-074,
AHW-075, AHW-076, AHW-077, AHW-036, AHW-034, AHW-039, AHW-037, AHW-021(build half),
AHW-066, AHW-067, AHW-069, AHW-071, AHW-072.

> **AHW-036 (trezor blind-sign + spoofable `createAuthWitFromIntent`) is dissolved by
> the `adapter-trezor` deletion** below, alongside AHW-073/074/075/076/077 — no separate
> fix; the package and its API-lie cease to exist.

**Why first:** Nothing downstream is trustworthy while the project's own quality gate is
merged-around (AHW-030) and `bun audit` is silent (AHW-033). Deleting `adapter-trezor`
+ `apps/demo` *dissolves* 6 findings (AHW-073/074/075/076/077 + the `apps/demo` half of
AHW-028) and shrinks the audit blast radius before anyone re-reviews. Pure-deletion +
config; lowest risk, highest leverage.

### Fix design

1. **Delete dead code.** Remove `apps/demo/` and `packages/adapter-trezor/` entirely.
   - **First** verify nothing live imports them: `git grep -nE "adapter-trezor|apps/demo|@aztec-hwwallet-poc/adapter-trezor|createAuthWitFromIntent"` across `packages/`, `apps/demo-browser/`, `ledger-app/tests/`, `scripts/`, root `package.json` workspaces, `tsconfig*.json` references, and both CI workflows. Expectation from the audit: only `apps/demo` references them.
   - **AHW-073 caveat (load-bearing):** the broken-digest `computeOuterHashForIntent` lives in `packages/core/src/intent-utils.ts`, which **survives** the trezor deletion. The live Ledger path uses the canonical `EncodedAppEntrypointCalls`, not this. Decision: **delete `computeOuterHashForIntent` + `intent.ts`/`intent-utils.ts` if and only if** `git grep` shows no live importer after the trezor/demo deletion; otherwise gut its body to `throw new Error('non-canonical; removed')` and keep the export so a stale import fails loud, not silently. Verify with `git grep -n "computeOuterHashForIntent\|intent-utils\|from './intent'"`.
   - Remove the workspace entries from root `package.json` and any `tsconfig` project refs.

2. **Fix the typecheck gate (AHW-030/031/032).** Re-point `ci.yml:36` at the **live**
   surface and make it blocking:
   - New scope: `packages/core packages/adapter-ledger apps/demo-browser` (drop the deleted projects).
   - Fix the net-new type errors the validator reproduced: `noUncheckedIndexedAccess` in `grumpkin-point-add-edge.test.ts:30` and `wire-differential-replay.test.ts:158` (prove definedness or `// biome-ignore`/non-null with comment — these are test files, looseness is acceptable but must compile), plus `cxmath_spike/measure.ts` and `gen-poseidon2-constants.ts` (exclude spike/codegen scratch from the gate or fix). AHW-032: prefer per-project `tsc --noEmit` over `tsc -b` on non-composite projects, OR add `"composite": true` + project refs. I recommend **per-project `--noEmit`** (less config churn for a PoC).
   - Add `apps/demo-browser` + the Playwright e2e to the gate (AHW-031).

3. **Surface `bun audit` (AHW-033).** Keep advisory (`continue-on-error: true`) per
   house policy, but **write findings to `$GITHUB_STEP_SUMMARY`** (`bun audit --json |
   tee` → format). Apply the validated remediation: root `package.json`
   `"overrides": { "systeminformation": "^5.31.6" }` (host-metrics@0.36.2 pins 5.23.8
   exactly, so no transitive break). The 2× undici WS HIGHs are code-dead (5.29.0
   disables permessage-deflate); document, no action. Re-run `bun audit` to confirm the
   6 HIGH clear from the surfaced count.

4. **Freeze discipline (AHW-039).** Assert `bun install --frozen-lockfile` in **every**
   CI install step (already present in `ci.yml:30`; add to `ledger-app.yml` if it
   installs JS deps). One-line audit.

5. **Firmware provenance (AHW-034).** `ledger-app/` is embedded with an orphan nested
   `.git` (0 commits). Decision: **commit the firmware source into the parent repo as
   plain tracked files** (delete the nested `.git`) and record the built `app.elf`
   sha256 in `ledger-app/README.md` + a `ledger-app/PROVENANCE.txt` regenerated by CI.
   A submodule is cleaner long-term but adds CI clone friction for a PoC; tracked-source
   + elf-hash is the pragmatic pin. Remove/populate the 0-byte root `ledger_app.toml`
   (AHW-071) — single source of truth is `ledger-app/ledger_app.toml`.

6. **Build-hardening quick wins** (bundle here; they touch the Makefile/CI once):
   - **AHW-021 (build half):** add `_Static_assert`/`#error` in `dispatcher.c` /
     `cxmath_spike.h` that fails the build if `CX_MATH_SPIKE` is defined alongside a
     release marker; **delete the spike entirely before submission** (it's throwaway).
   - **AHW-066:** coin-type `1666` is a placeholder shipped by every CI `make`. Gate it
     behind a non-default flag: `AZTEC_COIN_TYPE` has no default → CI must pass it
     explicitly, and a `#error "set AZTEC_COIN_TYPE"` if unset for a release target. (Or
     register the real SLIP-44; out of our control, so gate.)
   - **AHW-067:** `ENABLE_SDK_WERROR=1` + fix the warnings it surfaces.
   - **AHW-069:** pin + assert clang version in the builder (record in PROVENANCE; the
     dudect CT-evidence is only valid for a known compiler).
   - **AHW-037:** dedupe `@noble/*` (esp. the `@noble/hashes` v1↔v2 split) via overrides.
   - **AHW-072:** align the Makefile icon set with the toml device list (drop apex_p
     icon or add apex_p to the matrix). INFO; cosmetic.

### Files by layer
- **build/CI:** `.github/workflows/ci.yml`, `.github/workflows/ledger-app.yml`, root
  `package.json` (workspaces + overrides), `tsconfig.json`, `ledger-app/Makefile`,
  `ledger-app/ledger_app.toml`, root `ledger_app.toml` (delete/populate),
  `ledger-app/README.md` + `PROVENANCE.txt`.
- **C:** `ledger-app/src/apdu/dispatcher.c`, `cxmath_spike.{c,h}` (delete),
  `types.h` (drop `INS_CXMATH_SPIKE`).
- **TS (delete):** `packages/adapter-trezor/`, `apps/demo/`; conditional
  `packages/core/src/intent.ts`/`intent-utils.ts`.

### Test plan
- **Success:** `bun run lint` + `bunx tsc --noEmit` (new scope) exit 0 locally; `bun
  test` green after deletions; `make` builds with `-Werror` + explicit coin-type.
- **Failure-case:** add a CI assertion that `git grep -q CX_MATH_SPIKE
  ledger-app/Makefile` (shipped build) **fails** the pipeline; a deliberate `tsc` error
  in a tracked file must turn the gate red (prove it's blocking, not advisory).
- **Regression guard:** `git grep` for the deleted symbols must return nothing in live code.

### UX impact
None (build/CI/dead-code only). `demo-browser` unaffected.

### Risk + rollback
- **Risk:** deleting `intent-utils.ts` breaks a hidden importer. **Mitigation:** the
  `git grep` gate + the "gut, don't delete, if referenced" fallback.
- **Risk:** `-Werror` surfaces warnings that block the build. **Mitigation:** fix or
  scope `-Werror` to our `src/` (not SDK). Time-boxed; if it explodes, land
  `ENABLE_SDK_WERROR` in a follow-up and keep the rest of Phase 0.
- **Rollback:** every item is an isolated commit; revert individually. Dead-code
  deletion reverts cleanly (it's dead).

---

# Phase 1 — Host fail-closed: kill the CRIT + the HIGH bypasses

**Findings:** AHW-001 (CRIT), AHW-002, AHW-003, AHW-004, AHW-062, AHW-057.

**Why second:** This neutralizes the entire CRIT+HIGH host cluster with **pure TS, no
firmware, no Speculos** — fastest path to "the dangerous capability is gone." It is also
the defense-in-depth half of the `blind_signing` locked decision (the device half lands
in Phase 3). Independent of the firmware rebuild, so it ships while the C work is in
flight.

### Fix design

1. **AHW-001 — fail-close `createAuthWit` for ALL curves.** In
   `auth-witness-provider.ts`, `createAuthWit` currently throws only for GRUMPKIN
   (`:89-94`) and blind-signs for K1 (`:95-96`). Change: **throw for every curve** —
   the live flow has no legitimate caller (grep-confirmed), and the entrypoint is the
   only sanctioned authwit path. Keep `signAndWrap` private; the blind `signOuterHash`
   APDU stays reachable *only* if Phase 3's `blind_signing=ON` device gate permits it,
   but the **host provider stops offering it** on the auto-authwit path.
   - This directly defeats the `EmbeddedWallet.sendTx:88` call: `this.createAuthWit(…)`
     now throws, the `try/catch` at `embedded_wallet.js:86-94` swallows it
     (`return undefined`), and no witness is pushed → fail-closed. **Verify** this is
     the actual behavior with a unit test (the `catch` makes it silent, which is fine —
     the witness simply never materializes).

2. **AHW-003 + AHW-062 — guard the tx clear-sign path.** Mirror the deploy guards onto
   `#clearSignOnDevice` (`clear-signing-entrypoint.ts:146`). Before signing, reject:
   - `exec.authWitnesses?.length` non-zero (a clear-signed tx must carry **no**
     pre-seeded authwits — they're unsigned by the device),
   - `exec.capsules?.length` non-zero,
   - `exec.extraHashedArgs?.length` non-zero,
   - and in `createTxExecutionRequest`, reject `options.feePaymentMethodOptions !==
     EXTERNAL` and `options.cancellable !== false` (the tx path today applies neither;
     deploy does at `:127-136`). This closes the fee-mode-omission / sponsor-drain vector
     (AHW-062, the unsigned `txContext` knobs) at the host boundary.
   - Throw clear TS errors (not opaque) — these are first-party-caller bugs or hostile
     hosts; either way the tx must not proceed.

3. **AHW-002 — stop exposing the raw bypasses.** `internalDeps`
   (`aztec-ledger-session.ts:437-440`) must drop `session` and `ledgerProvider` (not
   just `secret`). The demo verbs (`dripUsdc`/`transfer`/deploy) already go through
   `transferViaRealSendTx`/`deployAccountViaEntrypoint` on the session itself, so
   nothing external needs the raw handles. If a future caller genuinely needs them,
   re-expose under an explicit `unsafe_` prefix — but default-deny. Cache the
   clear-signing `BaseAccount`/entrypoint at connect so the legit path doesn't need
   `ledgerProvider` reachable.

4. **AHW-057 — abort-on-throw for deploy.** `#deploySignOnDevice` must mirror
   `#clearSignOnDevice`'s discipline: **pre-abort** (`await this.device.abortAuthwit()`
   — note: deploy uses a separate session, confirm the abort clears
   `L4_DEPLOY_CONTEXT`; if not, add an explicit deploy-abort or reuse `abortAuthwit`
   which `l4_session_reset`s both structs per `dispatcher.c` + `begin_deploy_account.c:178`)
   at entry, and **wrap** the `beginDeployAccount`+`finalizeDeployAndSign` in a
   try/catch that calls the abort on throw. Prevents the wedge (device parked → 0x6F11).

### Files by layer
- **TS:** `packages/adapter-ledger/src/auth-witness-provider.ts`,
  `packages/adapter-ledger/src/clear-signing-entrypoint.ts`,
  `packages/adapter-ledger/src/aztec-ledger-session.ts`.

### Test plan (this is also AHW-004 — the missing seam test)
New `clear-signing-entrypoint.test.ts` with a **mock `LedgerProvider`** (no Speculos):
- **Success:** a clean transfer payload (no authwits/capsules/extra, EXTERNAL fee,
  `cancellable=false`) clear-signs and `#consume` returns the witness for the matching
  hash.
- **Failure (must reject):**
  - `exec.authWitnesses=[someWit]` → throws (AHW-003).
  - `exec.capsules=[…]` / `exec.extraHashedArgs=[…]` → throws.
  - `feePaymentMethodOptions !== EXTERNAL` on tx path → throws (AHW-062).
  - `cancellable !== false` on tx path → throws.
  - `#consume` with a hash ≠ the signed hash → throws stream-A-claim-B (the
    `plan.md:59`-promised test, never written).
  - DeployContext runtime mismatch → throws (`:219-228`).
- **AHW-001:** `createAuthWit` throws for K1 **and** GRUMPKIN; assert the
  `EmbeddedWallet.sendTx` simulation path yields **empty** `authWitnesses` when offchain
  effects are present (mock `simulateViaEntrypoint` to emit one effect; assert no
  witness pushed because `createAuthWit` threw and the `catch` dropped it).
- **AHW-002:** `expect('session' in session.internalDeps).toBe(false)` and same for
  `ledgerProvider` and `secret` (AHW-007 folds in here).
- **AHW-057:** mock the transport to throw mid-`finalizeDeployAndSign`; assert
  `abortAuthwit` was called.

### UX impact
- **Demo:** none for the shipped flows (they never produced auto-authwits or seeded
  capsules). If any demo verb *did* rely on the blind path, it now fails loud with a
  clear error — that's the intent (the PoC should not blind-sign).
- **Copy:** the thrown errors are developer-facing; keep them precise ("clear-signed tx
  must not carry pre-seeded authWitnesses").

### Risk + rollback
- **Risk:** over-tight guard breaks a legitimate future app-authwit flow. **Mitigation:**
  the guard is scoped to the *tx clear-sign* path; genuine app-authwits would go through
  a (future) reviewed entrypoint, not pre-seeding `exec.authWitnesses`. Documented.
- **Risk:** `EmbeddedWallet.sendTx`'s silent `catch` means a *legitimate* authwit need
  would now silently produce no witness and the tx would fail at prove/submit, not at
  sign. **Mitigation:** acceptable for PoC (fail-closed > blind-sign); documented as a
  known limitation in the residual-risk register (Phase 8).
- **Rollback:** revert the provider/entrypoint commits; pure TS, no state.

---

# Phase 2 — Host correctness, quality, privacy hygiene

**Findings:** AHW-005, AHW-007 (covered in P1 test), AHW-008, AHW-009, AHW-047 (host/UX
half), AHW-048, AHW-049, AHW-063, AHW-079, AHW-081, AHW-083, AHW-082, AHW-043, AHW-010,
AHW-011, AHW-045.

**Why here:** all pure TS/frontend, no firmware, parallelizable with the C work. Groups
the "tighten the host" residue.

### Fix design (grouped)

**Type-safety / drift:**
- **AHW-005:** one shared `LedgerFeeEntrypointOptions` type annotated on **both** the
  producer (`aztec-ledger-session.ts:375-383`) and reader
  (`clear-signing-entrypoint.ts:121`) so a rename becomes a compile error (today both
  sides compile and deploy silently falls into `#clearSignOnDevice`).
- **AHW-008:** extract `#canonicalOuterHash(exec, chainInfo, nonce)` —
  `clear-signing-entrypoint.ts:155-164` ≈ `205-213` are duplicated; drift = tx and
  deploy attest different things. Closes the AHW-005 drift surface too.
- **AHW-010/011:** prove definedness in `bytesEqual` (`:77`) or documented
  `biome-ignore`; add a 3-line shape guard on the Speculos JSON
  (`speculos-transport.ts:93/124/144-164` — incl. the `fromHex`/`Number.parseInt`
  no-validation sub-point from R4-06) or a trust-scoping comment. LOW; do the guard.

**Modularity (defer unless cheap):**
- **AHW-009:** `aztec-ledger-session.ts` is 649 LOC. **Decision: do the cheap half
  (collapse the duplicated in-flight mutex `:329-333` ≈ `:597-601` into ONE
  `#submitExclusive(work)` primitive, fixing the R4-03 unhandled-rejection where
  `inflight` is assigned *after* the IIFE starts), and defer the `LedgerDemoVerbs`
  extraction** — it's not an SRP violation and the extraction risks destabilizing the
  proven submit path mid-audit. Log the deferral.

**Privacy / metadata (codex CP cluster — mostly LOW but cheap):**
- **AHW-048:** make `secret-cache.ts` **memory-only by default** (drop `sessionStorage`
  write unless an explicit opt-in flag) and make the cache key **scheme-aware**
  (`${path}:${curveId}` not just path) so an ECDSA↔Schnorr switch re-prompts. This is
  the meaningful one — `sessionStorage` survives reload and any same-origin XSS reads
  the privacy root with no new Ledger prompt.
- **AHW-047 (host/UX half — firmware half in Phase 4):** rewrite the host + onboard copy
  to state the truth: *"This exports the viewing ROOT for this account path — it lets
  this computer (and anyone it shares it with) see your notes across networks and both
  account types. It does NOT export spend authority."* (`OnboardPanel.tsx`). The
  crypto-narrowing question is answered in §Security (it's **not** protocol-possible to
  scope by purpose without re-deriving on-device; honest wording is the fix).
- **AHW-079:** stop using the approval-free `GET_PUBLIC_KEY` `x‖y` as a persistent cache
  ID (`onboarding.ts:59-74` `deviceCacheKey`). Use a per-tab random handle, or gate the
  pseudonym behind a reveal. LOW but real (origin can enumerate account indices +
  link ECDSA↔Schnorr).
- **AHW-081/083:** pass a **warn-only logger** into the embedded wallet in demo/prod
  (Aztec defaults to `info`, which logs account/contract/tx metadata to console); scrub
  addresses/tx-hashes from the 4 panel `console.error` calls.
- **AHW-082:** surface the real RPC operator URL in the UI + default the `/aztec` proxy
  target to blank/self-hosted with a doc of exactly what the node sees
  (`vite.config.ts:189-197`). INFO; transparency.
- **AHW-043:** wire `getCaps()` into `connect()` so a device lacking
  `CAPS_GRUMPKIN`/`CAPS_CLEAR_SIGN` degrades gracefully instead of failing on a late
  opaque SW (folds R4-07). Or remove the dead getter — I prefer **wire it in** (it's the
  honest capability negotiation the manifest claims).

**Protocol residue:**
- **AHW-049:** public clear-signed txs (drip, public self-transfer) emit no replay
  nullifier → an unconditional `SponsoredFPC` can be re-billed. **Decision: set
  `cancellable=true` for clear-signed PUBLIC-only flows** so the account entrypoint
  emits the tx-nonce nullifier (`account.nr:75-78`). BUT — this collides with the
  Phase-1 `cancellable !== false` guard. **Resolution:** the guard becomes "cancellable
  must equal the *reviewed* value," and `cancellable` becomes a **device-displayed,
  signed-intent** field for public flows (or, simpler for PoC: keep `cancellable=false`
  + accept the sponsor-griefing residual and document it, since it's sponsor-fund-only,
  not user-fund). I lean **document-and-accept for PoC** (it's a faucet/testnet sponsor)
  and flag the cleaner sponsor-side one-shot-nullifier as the production fix. **This is a
  genuine design fork → codex consult.**
- **AHW-063:** wait for `CHECKPOINTED` (or label PROPOSED provisional + retain tx hash
  until checkpoint/final-failure) in `deployAccountViaEntrypoint:415-418`. The transfer
  path already inherits CHECKPOINTED. Fixes the false-finality window.
- **AHW-045:** render the real device-revealed checksum on cached re-onboard instead of
  the literal `"cached"` string (suppresses the user's cross-check).

### Files by layer
- **TS:** `auth-witness-provider.ts` (n/a here), `clear-signing-entrypoint.ts`,
  `aztec-ledger-session.ts`, `secret-cache.ts`, `onboarding.ts`,
  `speculos-transport.ts`, `provider.ts` (caps), `deploy-context.ts` (none).
- **frontend:** `apps/demo-browser/src/OnboardPanel.tsx`, the 4 panel components
  (logger/error scrub), `apps/demo-browser/vite.config.ts`.

### Test plan
- **AHW-005:** a rename of the sideband field is a `tsc` error (compile-time; assert via
  a type test or just rely on the shared type).
- **AHW-008:** `#canonicalOuterHash` unit test — tx and deploy produce identical hashes
  for the same `(exec, chain, nonce)`.
- **AHW-048:** cache write does **not** touch `sessionStorage` by default; a
  scheme-switch at the same path returns `undefined` (re-prompt). XSS-sim: a script
  reading `sessionStorage` after a reveal finds nothing.
- **AHW-049:** integration — a replayed public drip is rejected by the nonce nullifier
  (if we adopt `cancellable=true`), OR a documented `describe.skip` with the rationale
  (if we accept-and-document).
- **AHW-063:** mock `waitForTx` to resolve PROPOSED-then-dropped; assert the session does
  not report final success.
- **AHW-043:** `connect()` against a mock device returning caps without `CAPS_GRUMPKIN`
  degrades gracefully (clear error before prompting).
- **AHW-081/083:** assert the demo passes a non-`info` logger; assert error scrubbing
  strips addresses (snapshot the scrubbed message).

### UX impact
- **Onboard copy** changes materially (AHW-047) — honest scope. The owner is wary of
  over-sharing; this is *accuracy*, not over-sharing, and it's the single most
  user-protective copy change in the plan.
- **Cached re-onboard** now shows a hex checksum the user can cross-check (AHW-045).
- **RPC transparency** (AHW-082) surfaces the operator URL — a settings/info line.

### Risk + rollback
- **Risk:** the AHW-049 `cancellable` flip interacts with the Phase-1 guard and the
  device's unsigned-field model. **Mitigation:** codex consult; default to
  document-and-accept for PoC if the interaction is messy.
- **Risk:** scheme-aware cache key invalidates existing in-tab sessions on deploy.
  **Mitigation:** acceptable (re-prompt is the safe direction).
- **Rollback:** per-item commits; all reversible TS.

---

# Phase 3 — Firmware infra: NVM settings, `blind_signing` toggle, rate-limit, path gates

**Findings:** AHW-016 (rate-limit), AHW-064 (path gate on blind-sign + pubkey),
AHW-017 (session reset on malformed APDU), AHW-059 (reveal-secret disarm in reset),
AHW-021 (app half — `#error` guard, done in Phase 0; the spike deletion lands here too),
and the **device half of the locked `blind_signing` decision**.

**Why here (and why this is the first firmware phase):** This builds the **NVM
persistent-storage layer that does not yet exist** (`menu_nbgl.c:4`). Both the
`blind_signing` setting and the rate-limit counter need it. Doing it before the display
work (Phase 4) and the wire change (Phase 5) means one firmware rebuild establishes the
settings/NVM foundation, then later phases layer on top. **First firmware rebuild +
Speculos re-validation happens here** (the "firmware reopened" gate).

### Fix design

1. **NVM settings store (new infra).** Add a `NVM_PIC`-qualified persistent struct:
   ```c
   typedef struct {
       uint8_t initialized;     // magic/version
       uint8_t blind_signing;   // 0 = OFF (default), 1 = ON
       // rate-limit counters (see §3)
       uint32_t derive_fail_count;
       uint32_t derive_epoch;   // monotonic-ish, see counter design
   } app_storage_t;
   const app_storage_t N_app_storage_real;
   #define N_app_storage (*(volatile app_storage_t *)PIC(&N_app_storage_real))
   ```
   Write via `nvm_write` (the SDK primitive). **Default `blind_signing = 0`** on
   first-run/uninitialized (Ledger Ethereum/Solana pattern). Add a Settings page to
   `menu_nbgl.c` (`nbgl_useCaseHomeAndSettings` already scaffolds the slot) with a
   toggle switch for "Blind signing" + the info list.

2. **`blind_signing` gates the device blind path (locked decision).**
   `handler_sign_outer_hash` (`sign_outer_hash.c`) is the hash-only device path. New
   behavior:
   - `blind_signing == 0` (default) → **REJECT** with a new `SW_BLIND_SIGNING_DISABLED`
     (so the host-side `createAuthWit`, if ever called, fails-closed at the device too —
     belt-and-suspenders with Phase 1). The auto-created app-authwit path is dead at
     both layers.
   - `blind_signing == 1` → sign, but the review screen shows a **persistent setting
     indicator** ("Blind signing enabled" on home) **and a per-sign "⚠ Blind signing"
     warning page** the user must acknowledge before the raw 32-byte hash is signed.
   - **My pushback (see §): I would delete `signOuterHash` from the device for the PoC
     entirely.** But honoring the lock, I implement the toggle.

3. **Canonical path gate on the loosest surfaces (AHW-064).**
   `handler_sign_outer_hash` (`sign_outer_hash.c:~76`), `handler_get_public_key`
   (`get_public_key.c`), and `handler_get_schnorr_pubkey` currently check only `len !=
   0` / `1≤len≤10`. The L4 handlers enforce the full `m/44'/AZTEC'/<acct>'/0/0`.
   **Extract `assert_canonical_aztec_path(path, len)`** (also closes AHW-070, the ×3
   C-side duplication) and apply it to the blind-sign + both pubkey paths.
   - **Caveat travels with the finding:** AHW-064 is MED-contingent on Ledger's OS
     `PATH_APP_LOAD_PARAMS` already bounding key derivation to `44'/coin'`. Confirm with
     a 1-line SDK reference that the OS scope-lock holds; the gate is defense-in-depth on
     top of it. **But** — `get_public_key` is called approval-free on connect for *any*
     account index, so the gate must still allow varying `path[2]` (the account index)
     while pinning the prefix + `/0/0` suffix. Don't over-tighten to a single account.

4. **Session-reset hardening (AHW-017 + R4-01 fold).** `app_main.c`: add
   `l4_session_reset()` alongside **both** `explicit_bzero(&G_context,…)` calls — the
   parse-fail path (`:43`) AND the dispatch-fail path (`:53`). Today the parse failure
   short-circuits before the dispatcher, leaving `G_l4_session`/`G_l4_deploy_session`
   live (violates the "any non-9000 zeroes the L4 session" invariant). One line each.

5. **Reveal-secret disarm reachable from reset (AHW-059).** Add a
   `master_secret_disarm()` (exported from `get_aztec_master_secret.c`) and call it from
   `l4_session_reset()` so the armed `s_secret`/`s_armed` (`get_aztec_master_secret.c:52-54`)
   invariant is *enforced*, not an implicit io-loop property. Defensive against a future
   async refactor opening a window.

6. **NVM rate-limit on the derivation surface (AHW-016).** This is the
   anti-amplification control for the accepted non-constant-time portable C (AHW-029).
   **Counter design (critical — see §Security for the adversarial analysis):**
   - A **monotonic fail/attempt counter in NVM** on the derivation INSes
     (`get_aztec_master_secret`, the deploy/authwit `az_derive_*` paths, pubkey
     getters). NOT a simple "increment on every call" (that wears NVM and bricks
     legit users on a busy session).
   - Design: increment a **persistent fail counter only on a *rejected/faulted*
     derivation** (a successful, user-approved reveal does **not** increment). Add an
     **escalating cooldown** (e.g. after N consecutive failures, impose an
     RTC/uptime-based delay before the next derivation is accepted). The cooldown clock
     uses the device uptime, **not** wall-clock the host controls.
   - **Power-cycle resistance:** the fail counter is in NVM, so it survives reboot —
     but the *cooldown timer* is RAM/uptime-based, which a power-cycle resets. **This is
     the key adversarial gap (see §).** Mitigation: persist a "penalty floor" in NVM
     that the cooldown must clear; a power-cycle resets the live timer but the penalty
     floor (a count) persists, so the attacker still pays the per-failure NVM-write
     latency and the floor doesn't drop. Reset the floor only on a *successful
     user-approved* operation.
   - **NVM write-endurance protection:** cap NVM writes — only write on a *state
     transition* (entering/leaving penalty, not every attempt), and bound the counter so
     it can't be spun to wear out the page. Document the endurance budget.
   - **Brick-avoidance:** the penalty is a *delay*, never a permanent lock; a legitimate
     user waiting out the cooldown always recovers. No PIN-counter-style wipe.

7. **Delete the cx_math spike (AHW-021 app half).** Remove `handler/cxmath_spike.{c,h}`,
   the dispatcher case, and `INS_CXMATH_SPIKE` from `types.h` (the build guard from
   Phase 0 is the safety net during transition).

### Files by layer
- **C (new):** `ledger-app/src/app_storage.{c,h}` (NVM struct + accessors),
  `ledger-app/src/l4/rate_limit.{c,h}` (counter/cooldown logic),
  `ledger-app/src/l4/path_canonical.{c,h}` (the extracted `assert_canonical_aztec_path`).
- **C (edit):** `app_main.c`, `dispatcher.c`, `sign_outer_hash.c`, `get_public_key.c`,
  `get_schnorr_pubkey.c`, `get_aztec_master_secret.c`, `l4/session.c` (call disarm +
  rate-limit hooks), `ui/menu_nbgl.c` (settings page + persistent blind-sign indicator),
  `ui/sign_ui.c` (per-sign blind-sign warning page), `sw.h`
  (`SW_BLIND_SIGNING_DISABLED`, `SW_RATE_LIMITED`), `types.h` (drop spike).
- **C (delete):** `handler/cxmath_spike.{c,h}`.
- **TS (mirror):** `apdu.ts` (new SWs), `provider.ts` (handle `SW_BLIND_SIGNING_DISABLED`
  / `SW_RATE_LIMITED` with clear errors), `webhid-transport.ts` (none).
- **build:** `Makefile` (settings need `ENABLE_NBGL_*` already set; confirm NVM is
  available on all target devices).

### Test plan (Speculos + host-compiled unit)
- **`blind_signing` (Speculos):**
  - Default-OFF: `INS_SIGN_OUTER_HASH` → `SW_BLIND_SIGNING_DISABLED` (rejected, no sign).
  - Toggle ON via settings → `INS_SIGN_OUTER_HASH` shows the ⚠ warning page → on confirm,
    signs; assert the persistent home indicator is present (ragger screen-text).
  - Toggle persists across app close (write NVM, restart Speculos with the same NVRAM,
    assert state survives) — **AHW footgun test: confirm reset-on-close behavior matches
    the decision (see §Security; I recommend it does NOT auto-reset, matching
    Eth/Solana, but the toggle is sticky in NVM).**
- **Rate-limit (Speculos + host unit):**
  - N consecutive *failed* derivations (feed a path that faults, or a glitch-sim)
    triggers the cooldown; the next derivation within the window is `SW_RATE_LIMITED`.
  - A *successful approved* reveal does **not** increment the fail counter / resets the
    penalty floor.
  - Power-cycle mid-penalty: restart Speculos NVRAM; assert the penalty floor persists
    (attacker doesn't get a free reset).
  - NVM-write budget: assert writes occur only on state transitions (instrument a write
    counter in a debug build).
- **Path gate (AHW-064):** `get_public_key` with a non-canonical path
  (unhardened account, wrong suffix) → `SW_INVALID_PATH_SCHEME`; with a valid path at a
  **different account index** → success (don't over-tighten).
- **Session reset (AHW-017/024):** `BEGIN_AUTHWIT(count=1)` → inject a raw
  under/over-length APPEND frame (the parse-fail path) → the next well-formed
  `APPEND_CALL` returns wrong-state (`SWO_INVALID_INS`), proving the session was zeroed.
  This is the AHW-024 test (no test for malformed-frame-mid-stream exists today).
- **Disarm (AHW-059):** host-compiled — arm the reveal secret, call `l4_session_reset()`,
  assert `s_armed == false` and `s_secret` zeroed.

### UX impact
- **New Settings page** with a "Blind signing" toggle (default OFF). Persistent home
  indicator when ON. Per-sign ⚠ warning. Matches the Ethereum/Solana pattern the user
  knows.
- **Rate-limit:** a legitimate user effectively never sees it (it triggers on *failed*
  derivations). A wait-it-out delay, never a brick.
- **Path gate:** invisible to legit flows; an out-of-policy path now fails fast.

### Risk + rollback
- **Risk (HIGH):** NVM is new infra; a botched `nvm_write` struct layout or a write in a
  hot path could wear NVM or corrupt state. **Mitigation:** version/magic field, writes
  only on transitions, host-unit-test the counter logic before flashing, Speculos NVRAM
  persistence test.
- **Risk:** the rate-limit cooldown bricks a legit user via a bug. **Mitigation:** it's
  a delay not a lock; cap the penalty; manual override path = wait. Extensive
  failure-case tests.
- **Risk:** the path gate over-tightens and breaks approval-free pubkey reads for
  non-zero account indices. **Mitigation:** explicit test at a different account index;
  the gate pins prefix+suffix, not the account component.
- **Rollback:** the NVM struct is additive; `blind_signing` defaulting OFF is the safe
  state. If the toggle UI breaks, the device simply rejects blind-sign (fail-closed). The
  rate-limit can be feature-flagged off in the Makefile if it misbehaves, falling back to
  the AHW-029 "documented, no compensating control" posture.

---

# Phase 4 — Firmware display honesty

**Findings:** AHW-050 (HIGH — recipient 4+4), AHW-040 (HIGH — DRIP unrendered),
AHW-051, AHW-052, AHW-053, AHW-054, AHW-055, AHW-041, AHW-022, AHW-056.

**Why here:** Same firmware rebuild as Phase 3; the device-display fixes cluster. These
are "the device must not deceive the user" — the second half of clear-signing
completeness.

### Fix design

1. **AHW-050 — recipient 8+8 (locked decision).** Replace `short_hex_field` (4+4,
   `verified_calls_ui.c:82-94`) with an **8+8 renderer** for the recipient `To` field
   (`:208`, `:232,244`), plus an **optional "show full address" sub-screen** (NBGL
   detail page rendering all 32 bytes / 64 hex). Apply 8+8 to the `From` line too for
   consistency (it's device-verified, so display width is cosmetic there, but uniformity
   prevents the "verified field shown stronger than unverified" inversion the audit
   flags). **Never render the unverified recipient more weakly than the verified
   sender** — that's the core defect. Residual ~2^64 spoof is accepted + documented
   (§Security quantifies it).
   - The "show full address" sub-screen also satisfies AHW-053 (full outer_hash on the
     paranoia screen — render 32 bytes there, not 4+4).

2. **AHW-040 — render DRIP (or remove it).** Add a `CS_VERB_DRIP_*` case to
   `render_call_pairs` (`verified_calls_ui.c:201`) + `format_action` (`:134-153`)
   showing token + amount + recipient (the 2-arg public verb, selector `0xbe46ea53`).
   **Decision: render it** (the demo uses the faucet). If the faucet is dropped from the
   demo, remove DRIP from the allowlist (`selectors.gen.c`) instead — but rendering is
   the honest fix. Pairs with AHW-046 (the missing content test that let this hide).

3. **AHW-041 — fix the false "enforced device-side" comment.** `preflight.ts:129` +
   `manifest.json:139` claim the DRIP token-kind check is enforced in `append_call.c`,
   but it isn't. **Either** add the device-side arg validation to `append_call.c` (a
   real gate) **or** correct the comment to state the host preflight is the only gate. I
   recommend **add the device gate** (it's cheap and the comment shouldn't lie about
   security). Dangerous direction (claims MORE than exists).

4. **AHW-051 — render the RAW amount alongside the scaled one.** `decimals` comes from
   host codegen (`registry.gen.c:7-11`) with no device ground-truth; a wrong `decimals`
   mis-scales display by 10^N. Render **both** the human-scaled value (current) AND the
   raw integer (`verified_calls_ui.c:210,234`) so a skewed `decimals` can't hide
   magnitude. Pairs with the codegen pin (Phase 6, AHW-042). Also clamp `10^decimals`
   (R5-08 fold — unbounded format/DoS).

5. **AHW-052 — ASCII ellipsis.** Replace the U+2026 `…` marker (`verified_calls_ui.c:90-93`,
   `deploy_review_ui.c:76`) with `..` (two ASCII dots) — the app's own comment
   (`:135-137`) says the font lacks non-ASCII glyphs, so `…` may render blank/box and
   merge the two address halves into a deceptively "short complete" address.

6. **AHW-054 — scope the "verified" halo.** `"From (verified)"` (`:278`) implies the
   whole screen is verified. Change to label **only the From line** as verified and add
   an "as provided by host" qualifier on recipient/amount/symbol (or a section header).
   The owner is wary of over-sharing — this is *precision*, a one-word scoping, not
   clutter.

7. **AHW-055 — salient mint banner.** `WARNING: MINTER action` is an inline pair
   (`:240-243`). Promote to a prominent banner / explicit-acknowledgement page for the
   privileged mint action.

8. **AHW-022 — "Viewing key revealed" status.** `master_secret_reveal_approved`
   (`get_aztec_master_secret.c:181`) + `master_secret_reveal_ui.c` reuse
   `STATUS_TYPE_TRANSACTION_SIGNED` ("Transaction signed") on the reveal success page.
   Add a custom "Viewing key revealed" status so the user doesn't misremember they
   exported viewing capability. Pairs with the AHW-047 reveal-scope copy (Phase 2 host /
   here device).
   - **AHW-047 firmware half:** the reveal *confirm* screen copy should say it exports
     the **privacy root for this account, across networks and both account types**
     (`master_secret_reveal_ui.c`), not "Account #N viewing keys."

9. **AHW-056 — sponsor fee display.** SPONSOR renders `Via: Testnet FPC` with no fee/cap
   (`:248-254`). `arg_count=0` so there's nothing to hide today (honest omission); add a
   fee-terms line **if/when** the sponsor verb carries a cap. LOW; comment for now.

### Files by layer
- **C:** `ledger-app/src/ui/verified_calls_ui.c` (8+8, DRIP case, raw amount, ASCII
  ellipsis, verified-halo scope, mint banner), `ledger-app/src/ui/deploy_review_ui.c`
  (ASCII ellipsis), `ledger-app/src/ui/master_secret_reveal_ui.c` (reveal-scope copy),
  `ledger-app/src/handler/get_aztec_master_secret.c` (status type),
  `ledger-app/src/handler/append_call.c` (DRIP arg gate for AHW-041),
  `ledger-app/src/clear_signing_v0/format.c` (clamp `10^decimals`),
  `ledger-app/src/clear_signing_v0/selectors.gen.c` (DRIP verb, if regenerated).
- **TS:** `clear_signing_v0/preflight.ts` (AHW-041 comment), `manifest.json` (comment).

### Test plan (Speculos ragger content assertions — this is AHW-046)
The audit's root-cause of AHW-040 was **zero positive review-screen content tests**.
Add **per-verb screen-text assertions** (ragger snapshot / text extraction):
- **AHW-050:** the `To` field shows 8 leading + 8 trailing hex chars (16+16=32 hex
  visible); the "show full address" sub-screen renders all 64 hex. Assert recipient is
  **not** rendered more weakly than sender.
- **AHW-040:** a DRIP call renders token + amount + recipient pairs (not bare "Call
  DRIP" with zero pairs).
- **AHW-051:** a transfer with `decimals=18` shows BOTH the scaled and the raw integer
  amount; a deliberately-wrong `decimals` still exposes magnitude via the raw line.
- **AHW-052:** the truncation marker is ASCII (`..`), renders on the Nano font.
- **AHW-054:** "verified" appears only on the From line.
- **AHW-055:** the mint banner is a distinct acknowledgement page.
- **AHW-022:** the reveal success status reads "Viewing key revealed."
- **AHW-053:** the tail outer_hash paranoia screen shows the full 32 bytes.
- **Failure-case:** a call whose host-claimed `args_hash` disagrees with the
  device-recompute still rejects (regression — display changes must not weaken the
  recompute gate in `append_call.c:160-165`).

### UX impact
- **Recipient now 8+8** (was 4+4) + optional full-address drill-down. More bytes, but
  the owner's locked design — and the right call (4+4 = ~2^32 eyeball collision is
  cheap; see §). The "show full" sub-screen keeps the main screen uncluttered.
- **Raw amount** alongside scaled — slightly busier, but defeats the 10^N deception.
- **Reveal copy** is honest about scope (the biggest user-protection win on-device).
- **Mint banner** is louder — appropriate for a privileged action.
- Copy stays plain, no jargon; "as provided by host" is the only new qualifier.

### Risk + rollback
- **Risk:** NBGL string-buffer overflow from wider fields (8+8 = 34 bytes incl. marker;
  the existing `g_call_to[24]` buffer is **too small** — must grow to ≥34). **Mitigation:**
  audit every `g_call_*` buffer size against the new field widths; the
  `deploy_review_ui.c` 8+6 path already uses a 34-byte buffer as the template. Static
  buffers, bounds-checked `snprintf`.
- **Risk:** adding a DRIP render case desyncs from the allowlist if the verb table
  changes. **Mitigation:** the codegen coverage check (Phase 6) + the content test.
- **Risk:** display changes accidentally touch the recompute/parity path. **Mitigation:**
  display code is read-only over `G_l4_session`; the parity gates are untouched; the
  failure-case test guards it.
- **Rollback:** display is presentation-only; revert the UI commit and the device still
  signs the same recomputed hash. The buffer-size changes are the only memory-touching
  bit — covered by the math/memory regression suite.

---

# Phase 5 — B3-salt WIRE CHANGE (do this LAST, behind a hard cut)

**Finding:** AHW-018 (MED). **Folds:** AHW-026 (the non-default-salt lock-out test).

**Why dead-last:** This is the **single highest-regression-risk change in the plan**. It
mutates the `BEGIN_AUTHWIT` wire (host encoder + device parser + the
differential-replay vectors), and it touches the **B3 consumer-binding** — a MUST-PRESERVE
guarantee. Every other phase must be green and Speculos-validated before this lands, so
that if B3 regresses we know it's this change. It gets its own manifest-version bump and
a kill-switch.

### The problem (precisely)

`b3_verify_consumer_is_this_account` (`finalize_and_sign.c:112-183`) hard-codes
`B3_ZERO` salt (`:113`) into both the Schnorr (`:135-137`) and ECDSA-K (`:157-159`)
partial-address recompute. The salt is **never on the authwit wire** — the device
*assumes* `Fr.ZERO` (the demo's `DEFAULT_ACCOUNT_SALT`). Consequences:
- Fail-closed (good): a non-zero-salt account recomputes to a different address →
  `SW_AUTHWIT_CONSUMER_MISMATCH` (0x6F12). Not a hole.
- **But** any legitimately-deployed non-zero-salt account is **permanently locked out**
  of clear-signed authwits with a misleading 0x6F12, and the "from==consumer==this
  account" guarantee only holds for the assumed salt.

Note the **deploy** path already carries salt on its wire
(`begin_deploy_account.c:140-143`, `deploy-context.ts:44`), so this generalizes the
authwit path to match.

### Fix design — salt must be COMMITTED, never blindly trusted

The owner's locked decision: *"make salt a BEGIN-committed, displayed field the
recompute consumes (salt-agnostic binding)."* The adversarial crux (§Security): **if the
device blindly trusts a host-supplied salt, the binding weakens** — a hostile host could
supply a salt that makes *some other* account's address recompute to equal `consumer`.

**Why it stays fail-closed:** The salt is an *input to the address recompute*, and the
recompute is then cross-checked against `consumer` (which is bound into `outer_hash`,
re-verified at pass 3). So a wrong/hostile salt produces a *different recomputed address*
that **won't match `consumer`** → reject. The salt cannot create a false accept because
it doesn't bypass the `addr == consumer` equality; it only parameterizes one side of it.
**The invariant preserved:** `address(path, viewing_keys, salt_host) == consumer_signed`
AND `consumer_signed` is bound into the signed `outer_hash`. The host controls both
`salt` and `consumer`, but `consumer` is what the *relying party* (the token contract)
will check against the on-chain account — so the host can only make the device sign an
authwit for an account whose address it correctly computed from a salt **that the user's
real account actually used**. If the host lies about the salt, the recomputed address ≠
the real account's address ≠ what the contract expects → the authwit is useless
on-chain. **Fail-safe, not just fail-closed.**

**Belt-and-suspenders (the real hardening):**
1. **Display the salt** (or an account-disambiguator derived from it) on the review
   screen so the user can spot a wrong-account authwit. For a single-account-per-device
   PoC, display "Account #N" derived from path (already done) AND surface salt as a
   detail line.
2. **Bind salt into a committed value.** Add `salt` to the `BEGIN_AUTHWIT` body
   (canonical-Fr checked, like every other field), store it in `G_l4_session.salt`, and
   have `b3_verify_consumer_is_this_account` read `G_l4_session.salt` instead of
   `B3_ZERO`. Because `consumer` (the equality target) is itself committed into
   `outer_hash`, the salt is transitively constrained by the fail-closed equality —
   it is **not** "blindly trusted" in the sense that matters (it can't forge a match).
3. **Keep the `Fr.ZERO`-salt default working byte-stable** — the encoder sends
   `salt=Fr.ZERO` for the demo's `DEFAULT_ACCOUNT_SALT`, so the recompute is identical to
   today for the proven path. The change *generalizes*, never weakens.

### Sequencing within the phase (minimize the half-migrated window)
1. **Manifest version bump** (`L4_MANIFEST_VERSION 2u → 3u` in `wire.h`) — a **hard
   cut**, matching the existing v1→v2 precedent (`wire.h:20-22`). Device rejects the old
   version, host emits the new one only. There is **no** window where a v2 device talks
   to a v3 host or vice-versa — version mismatch → `SW_UNKNOWN_MANIFEST_VERSION`.
2. Land the **device parser** (read+canonical-check salt in `begin_authwit.c`, store in
   session) **and** the **host encoder** (`buildL4Manifest`/`l4-manifest.ts` add salt to
   the header) **in the same commit** as the version bump, so the wire is never
   half-defined.
3. Land the **recompute change** (`finalize_and_sign.c` reads `G_l4_session.salt`) in the
   same commit.
4. Update the **differential-replay vectors** (`wire-differential-replay.test.ts`) +
   `b3-consumer-binding.test.ts` in the same commit.

### Files by layer
- **C:** `ledger-app/src/l4/wire.h` (version bump, body-size constant),
  `ledger-app/src/l4/session.h` (add `salt[32]` to `l4_session_t` — note deploy session
  already has it), `ledger-app/src/handler/begin_authwit.c` (parse+canonical+store salt),
  `ledger-app/src/handler/finalize_and_sign.c` (`b3_verify_*` reads `G_l4_session.salt`),
  `ledger-app/src/ui/verified_calls_ui.c` (optional salt detail line).
- **TS:** `packages/adapter-ledger/src/l4-manifest.ts` (encode salt into the authwit
  header), `packages/adapter-ledger/src/apdu.ts` (`MANIFEST_VERSION` bump),
  `packages/adapter-ledger/src/aztec-ledger-session.ts` (pass the account salt into the
  manifest build — it already holds `this.deps.salt`).
- **vectors:** `wire-differential-replay.test.ts`, `b3-consumer-binding.test.ts`,
  golden vectors if the wire bytes are pinned.

### Test plan (fuzz + differential-replay are MANDATORY here)
- **Success (Speculos + testnet):**
  - `Fr.ZERO`-salt account: byte-stable with today — same authwit, same 0x9000, same
    on-chain acceptance (the proven path must not move).
  - **Non-zero-salt account** (AHW-026, untested today): deploy with a non-zero salt,
    then clear-sign an authwit → **succeeds** (no longer the misleading 0x6F12 lock-out).
    On-chain acceptance confirmed on testnet.
- **Failure-case (the adversarial core):**
  - **Wrong salt vs consumer:** host supplies `salt = X` but `consumer = address(salt
    Y)` → recompute ≠ consumer → `SW_AUTHWIT_CONSUMER_MISMATCH` (fail-closed preserved).
  - **Hostile salt forge attempt:** host picks a salt trying to make a *different*
    account's address equal `consumer` → still rejects (the equality target is the
    signed `consumer`, and the path/viewing-keys are device-derived, so the only salt
    that matches is the real one).
  - **Non-canonical salt:** `SW_HASH_MISMATCH` (canonical-Fr gate, like every field).
  - **v2 (old) manifest against v3 device:** `SW_UNKNOWN_MANIFEST_VERSION` (hard cut).
- **M12 fuzz:** re-run the `wire_host` libFuzzer corpus against the new
  `begin_authwit` body (the corpus must be regenerated for the new field — add salt
  bytes to the seed). Assert no crash, no false-accept.
- **Differential-replay:** the wire-differential-replay vectors must be regenerated and
  pass (device-recompute == host-canonical for the new wire). This is the regression net
  for "device signs only what it recomputed."

### UX impact
- For the demo's `Fr.ZERO`-salt account: **zero visible change**.
- For non-zero-salt accounts: they now *work* (previously locked out). An optional salt
  detail line on the review (drill-down, not main screen — owner's over-sharing concern).

### Risk + rollback
- **Risk (HIGHEST in the plan):** a parser/recompute bug regresses B3 (a MUST-PRESERVE
  guarantee) or the differential-replay parity. **Mitigation:** dead-last sequencing
  (everything else green first), the byte-stable `Fr.ZERO` regression test, mandatory
  fuzz + differential-replay, and the hard manifest cut (no half-migrated wire).
- **Risk:** the salt detail line clutters the review. **Mitigation:** drill-down only.
- **Rollback / kill-switch:** revert the single commit (version bump + parser + encoder +
  recompute + vectors are one atomic change) → back to v2 / `B3_ZERO`. Because it's a
  hard cut, reverting the device + host together is clean; there's no persisted state to
  migrate. The `Fr.ZERO` path is byte-identical, so a revert is provably safe for the
  demo account.

---

# Phase 6 — Codegen provenance + coverage

**Findings:** AHW-035, AHW-042, AHW-066 (coin-type, if not fully closed in P0), AHW-051
(codegen pin half), AHW-021 (build guard, done P0).

**Why here:** independent of the firmware rebuild; can run parallel to Phases 3-5. The
device renders host-codegen'd `address`/`decimals`/`symbol` as authoritative — a dep
bump or wrong manifest field silently changes what the device treats as canonical.

### Fix design
1. **AHW-035 — codegen provenance.** `gen-clear-signing-v0.ts:26-34` cross-checks against
   the **mutable** `node_modules/@defi-wonderland/aztec-standards` artifact; `_meta`
   pins are comments. **Assert at codegen: installed package version + artifact
   content-hash == the `_meta` pin; fail on mismatch.** A dep bump that changes the
   canonical surface now turns CI red instead of silently re-canonicalizing.
2. **AHW-042 — codegen coverage.** The cross-check verifies verb `(selector, arg_count,
   visibility)` but **never** the registry `address`/`decimals`/`symbol` emitted into
   `registry.gen.c` + `registry.generated.ts`. **Add the registry identity fields to the
   cross-check** (against the artifact and/or chain). A wrong `decimals` mis-displays by
   10^N (paired with the Phase-4 raw-amount render); a wrong `address` renders an
   attacker contract as "USDC" — with green CI today.
3. **AHW-066 (if open):** ensure the coin-type gate from Phase 0 is enforced in the
   codegen/build provenance record.

### Files by layer
- **TS/build:** `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts`,
  `packages/adapter-ledger/clear-signing-v0/manifest.json` (`_meta` pins become
  assertions), `.github/workflows/ci.yml` (the `gen:clear-signing-v0:check` step already
  runs — extend it).

### Test plan
- **Success:** `gen:clear-signing-v0:check` passes against the pinned artifact.
- **Failure-case:** a deliberately-bumped `@defi-wonderland/aztec-standards` version (or
  a tampered artifact hash) **fails** the check (provenance); a wrong
  `decimals`/`address`/`symbol` in `manifest.json` vs the artifact **fails** the
  coverage check. Both must turn CI red.

### UX impact
None (build-time).

### Risk + rollback
- **Risk:** over-strict hashing breaks CI on a legit dep bump. **Mitigation:** the
  failure is *intended* (manual review of the new canonical surface is the point);
  bumping the `_meta` pin is the sanctioned unblock. Rollback: relax to version-only
  pin if hashing is too brittle for the PoC.

---

# Phase 7 — Test backfill + comment-truth sweep

**Findings:** AHW-024 (P3), AHW-025, AHW-026 (P5), AHW-027, AHW-046 (P4), AHW-006,
AHW-013, AHW-014, AHW-019, AHW-020, AHW-023, AHW-058, AHW-060, AHW-061, AHW-070 (P3),
AHW-012, AHW-015.

**Why here:** the residue — tests that prove the fault-injection arms work, and the
comment-truth sweep (stale comments that *understate* or *overstate* hardening, both
dangerous to an auditor). Cheap, do after the behavior is settled so comments describe
the final reality.

### Fix design
- **AHW-025 — fault-injection negative test.** Host-compiled unit stubbing a *second*
  derivation/recompute to differ, asserting the mismatch branch rejects (the 3×
  recompute, dual-derive, dup-sig arms have only happy-path parity tests today). Prove
  the reject fires.
- **AHW-027 — `cs_format_amount` fuzz/parity.** Table-driven host test: u128 max, all-9s,
  `decimals=30`, high-bytes-set reject, the clamp from Phase 4.
- **AHW-046 — per-verb content tests.** Largely landed in Phase 4; consolidate the suite.
- **Comment-truth sweep (do AFTER behavior is final so comments are accurate):**
  - **AHW-019/020:** rewrite the stale side-channel / "single-pass" comments to describe
    the **branch-free / dual-derived** reality — **but only after confirming against the
    `dudect` result + `aztec_secret.c`** (overstating side-channel resistance is the
    worst direction; verify before writing).
  - **AHW-006:** rewrite the `// reserved: M8` comments on the LIVE deploy-sovereignty SWs
    (`apdu.ts:224-225`).
  - **AHW-013/014:** fix the stale `curve_id = K1` wire comment (`deploy-context.ts:8`)
    and the "scaffolded / lands once buildable" package header (`index.ts:1-11`).
  - **AHW-023:** comment the authwit "claim present" state-gate mechanism.
  - **AHW-061:** clarifying comment on `schnorr.c:14-20` (parse-then-zero priv reads as a
    no-op bug; it's a secret-scrub + policy guard).
  - **AHW-060:** rename/annotate the misleading `zero_hex` golden-vector label.
  - **AHW-058:** wire `0x6F10` to the second-BEGIN_DEPLOY case (clearer than 0x6F11) OR
    delete both dead SWs + host mirrors. I prefer **wire it** (better diagnostics).
  - **AHW-012:** rename `LedgerEcdsaKAuthWitnessProvider` → `LedgerAuthWitnessProvider`
    (it's scheme-generic, handles Schnorr; the name lies). Public-API rename → version
    bump. Do this with the other renames so consumers churn once.
  - **AHW-015:** add the upstream-anchor comment on `deviceOuterHashForIntent` so a
    future maintainer doesn't delete the parity assert as a "self-test."

### Files by layer
- **C:** `mul_generator.c`, `point.h`, `point.c`, `finalize_and_sign.c`,
  `finalize_deploy_and_sign.c`, `schnorr.c`, `sw.h`, golden vectors JSON.
- **TS:** `apdu.ts`, `deploy-context.ts`, `index.ts`, the provider rename across
  `account-contract.ts`/`ledger-account-contract-base.ts`/`schnorr-account-contract.ts`,
  `l4-manifest.ts` (anchor comment), new/updated test files.
- **tests:** host-compiled fault-injection + `cs_format_amount` tables.

### Test plan
- Fault-injection negatives reject; `cs_format_amount` table passes incl. reject rows;
  the rename compiles across all consumers; `git grep` for the old type name returns
  nothing.

### UX impact
None (tests + comments + a type rename).

### Risk + rollback
- **Risk:** the comment-truth sweep *overstates* CT hardening (AHW-019/020) if written
  without re-confirming the `dudect`/`aztec_secret.c` reality. **Mitigation:** the fix
  design gates the rewrite on verification. **This is the one place a "fix" (a comment)
  can make things WORSE** — a comment claiming more CT resistance than exists is a trap
  for the next auditor. Treat with the same care as code.
- **Rollback:** comments + tests revert trivially; the rename is mechanical.

---

# Phase 8 — Docs: recovery/custody + residual-risk register

**Findings:** AHW-038, AHW-029, AHW-044, AHW-045 (P2), AHW-080, AHW-065, AHW-071 (P0),
AHW-072 (P0), AHW-047 (doc the residual), AHW-018 (doc the salt model), AHW-050 (doc the
2^64 residual).

### Fix design
- **AHW-038 — zeroize on forget + custody doc.** Explicit heap-zeroize on the
  logout/"Forget" path (today drops references; GC timing leaves secrets); write the
  **recovery/custody threat-model doc** for the "Ledger seed IS the backup" claim
  (`docs/`). The deterministic-salt + device-derived-address design means recovery needs
  no sidecar — document that explicitly.
- **AHW-029 — document the accepted platform constraint.** The portable-C field/EC layer
  is NOT certified constant-time; `dudect` closes the control-flow leak, the
  value-dependent `fr_mul` residual is non-gating; the certified `cx_`/Donjon path is
  deferred. **Document as accepted PoC constraint, paired with the Phase-3 rate-limit as
  the compensating control.** (The cmov barrier, AHW-068, lands as a code fix — see
  below.)
- **AHW-068 — cmov optimization barrier (the one CT *code* fix in scope).**
  `point.c:69-77` uses a bitmask cmov with no compiler barrier under `-Oz`; the optimizer
  could reintroduce a data-dependent branch. **Add an optimization barrier** (e.g. an
  inline-asm `"" : "+r"` clobber on the mask, or the SDK's CT barrier macro) AND verify
  the emitted asm is branch-free at `-Oz`. This is in the MUST-PRESERVE "touch nothing in
  the math except the cmov barrier" carve-out — it's the *only* sanctioned math touch.
  Re-run `dudect` after. **I place the code fix here but it must be built+validated in the
  Phase-3/4 firmware rebuild**; the doc is here.
- **AHW-044/080/065/082:** label the Speculos panel as emulator-only / not
  device-attested (AHW-044); disclose that Connect reveals "Ledger + Aztec app present"
  (AHW-080, prefer `request()` over silent reuse); document the deliberate `"13'"`
  forward-grant (AHW-065) or drop it; surface the RPC operator (AHW-082, done P2).
- **Residual-risk register** (`docs/residual-risk.md`): the accepted residuals — 8+8
  address ~2^64 spoof (quantified), AHW-029 CT residual, AHW-049 sponsor-griefing (if
  accepted), the `blind_signing=ON` footgun, the upstream-`sendTx`-silent-catch
  limitation from Phase 1.

### Files by layer
- **C:** `ledger-app/src/crypto/grumpkin/point.c` (cmov barrier — built in P3/P4 rebuild),
  forget/zeroize path (host `aztec-ledger-session.ts` + any device-side).
- **docs:** `docs/recovery-custody.md`, `docs/residual-risk.md`, `ledger-app/README.md`.
- **frontend:** `SpeculosPanel.tsx` (emulator-only label), connect flow (AHW-080).

### Test plan
- `dudect` re-run after the cmov barrier confirms no new branch reintroduced; the math
  parity suite stays green (no value regression). Forget-zeroize: assert the secret
  buffer is zeroed after forget (host test).

### UX impact
- Speculos panel labeled emulator-only (dev). Connect disclosure copy (AHW-080).

### Risk + rollback
- **Risk:** the cmov barrier changes codegen and perturbs the proven math. **Mitigation:**
  it's a barrier, not an algorithm change; `dudect` + the parity suite are the net.
- **Rollback:** docs revert freely; the cmov barrier is one isolated commit gated on
  `dudect`.

---

# Security & Adversarial Considerations — "could a fix make it WORSE?"

This section answers the brief's adversarial asks head-on.

### 1. Where could a fix regress a PRESERVED guarantee?
- **B3-salt change (Phase 5)** is the prime suspect — it touches the B3 binding (a
  MUST-PRESERVE) and the differential-replay parity ("device signs only what it
  recomputed"). Mitigation: dead-last sequencing, byte-stable `Fr.ZERO` regression test,
  mandatory fuzz + differential-replay regen, hard manifest cut, atomic revert.
- **Phase-4 display buffer widening (8+8)** is a memory touch on a device with a proven
  zero-memory-regression posture. The existing `g_call_to[24]` buffer is **too small for
  8+8** (needs ≥34, matching the deploy 8+6 path). Mitigation: audit every `g_call_*`
  size, bounds-checked `snprintf`, the math/memory regression suite.
- **Phase-7 comment sweep** can *overstate* CT hardening (AHW-019/020) — a comment is a
  fix that makes the audit WORSE if it claims more resistance than exists. Mitigation:
  gate the rewrite on re-confirming `dudect`/`aztec_secret.c`.
- **Phase-8 cmov barrier** is the only sanctioned math touch; `dudect` + parity net.

### 2. B3-salt WIRE CHANGE — failure mode if the device trusts a host salt?
**The salt is NOT blindly trusted in the way that matters.** It parameterizes one side of
the `address(path, viewing_keys, salt) == consumer_signed` equality, and `consumer` is
bound into the signed `outer_hash` (re-verified at pass 3, `finalize_and_sign.c:250`).
- A wrong/hostile salt → a *different* recomputed address → **≠ consumer → reject**
  (`SW_AUTHWIT_CONSUMER_MISMATCH`). Fail-closed preserved.
- It is also **fail-SAFE**: even if a salt somehow matched on-device, the relying token
  contract checks against the *real* on-chain account address, which derives from the
  *real* salt — so a lie produces an authwit that's useless on-chain. The device can only
  be made to sign for an account whose address it correctly recomputed from the path's
  *device-derived* viewing keys + the supplied salt; the host cannot substitute a
  *different* account's keys (those are device-derived from the seed).
- **Keeping it committed:** salt is canonical-Fr checked on the wire, stored in session,
  consumed by the recompute, and **displayed** (drill-down) so a user can spot a
  wrong-account authwit. Confidence: **high** that this is fail-closed; the only residual
  is the same ~2^address-space brute-force as any address binding (infeasible).

### 3. `blind_signing` toggle — footgun? Sticky? Reset-on-close?
- **Can a malicious host flip it?** No — it's set only via the **on-device Settings UI**
  (NBGL toggle), never over APDU. A host cannot write NVM. (If any APDU could set it,
  that would be the footgun — the design must have **no** such APDU.) Confidence: high,
  contingent on not adding a set-blind-signing APDU.
- **Social engineering** ("enable blind signing to use this dApp")? This is the **real
  residual footgun** — same as Ethereum/Solana. Mitigations: default OFF, a **persistent
  home indicator** when ON, a **per-sign ⚠ warning page** that shows the full 32-byte
  hash, and honest copy. The owner accepts the pattern; I accept it *with* those
  mitigations.
- **Sticky vs per-session / reset-on-close?** The locked decision follows Eth/Solana =
  **sticky in NVM** (survives app close). I **agree** it should be sticky (a per-session
  re-enable trains users to flip it reflexively, which is *worse*). The persistent
  indicator + per-sign warning are the guardrails. **My stronger position (see §Pushback):
  don't ship the ON path at all for a PoC.**
- **Defense-in-depth:** Phase 1 makes the *host* `createAuthWit` fail-closed regardless
  of the device toggle, so even `blind_signing=ON` doesn't re-open the AHW-001 auto-authwit
  hole (that path is dead host-side). The toggle only affects an *explicit, manual*
  blind-sign the user deliberately invokes. Good — the CRIT can't be re-enabled by a
  setting.

### 4. 8+8 address — quantify the residual spoofability honestly
- **4+4 (today):** 8 hex shown = 32 bits. A vanity/address-poisoning attacker brute-forces
  a contract address (or a recipient) matching the 4-byte prefix **and** 4-byte suffix:
  ~2^32 work split across two anchors. Prefix-only eyeball collision (users often glance
  at the prefix) is ~2^16-2^32 depending on how many leading chars the user actually
  checks. **Cheap** — minutes-to-hours on commodity hardware for a prefix match.
- **8+8 (locked):** 16 leading + 16 trailing hex = **64 bits shown**. Brute-forcing a
  collision on both anchors is ~2^64 work — **infeasible** for address-poisoning
  (~$ millions of GPU-years). The residual is the **24 *middle* bytes never shown**: an
  attacker who controls those (and matches the 16 visible) still can't, because matching
  the 16 visible hex *is* the 2^64 barrier. So the honest residual is **~2^64 to forge a
  visually-identical address** — accepted for PoC, documented. Confidence: high.
- **The deeper point the audit nails:** the *recipient* (theft-enabling, device-UNverified)
  must never be shown weaker than the *sender* (device-verified). 8+8 on both + the
  device-verified `From` halo (scoped to From only, AHW-054) fixes the inverted budget.
  The full-address drill-down lets a paranoid user check all 32 bytes.

### 5. NVM rate-limit — brick / wear / power-cycle bypass? Safe counter design.
- **Brick a legit user?** No — the penalty is a **delay, never a permanent lock**, and it
  increments on **failed/faulted** derivations, not successful approved ones. A legit user
  effectively never triggers it; if they do, waiting clears it. **No PIN-style wipe.**
  Confidence: high (with the failure-case tests).
- **NVM write-endurance?** The danger: writing on *every* derivation wears the page
  (~100k-write endurance). Design: **write only on state transitions** (enter/leave
  penalty), bound the counter, document the endurance budget. An attacker can't spin the
  counter to wear NVM because writes are gated to transitions. Confidence: moderate
  (needs the write-budget instrumentation test to confirm).
- **Power-cycle bypass?** This is **the** adversarial gap. A RAM/uptime cooldown timer
  resets on reboot → an attacker power-cycles to skip the delay and resume fast
  re-derivation (the EM/power side-channel amplification the finding is about).
  **Mitigation:** persist a **penalty floor (a count) in NVM** that survives reboot; the
  live timer resets but the floor doesn't, so each failure still costs the NVM-write
  latency and the attacker can't get a *free* fast loop. The floor drops only on a
  successful **user-approved** operation (which an attacker doing EM probing can't
  produce). **Honest limitation:** a determined attacker with physical possession can
  still power-cycle between single derivations, paying only the NVM-write + boot latency
  per derivation — this *slows* amplification (raises the per-trace cost) but doesn't
  *eliminate* it. The true fix is the certified constant-time `cx_` path (AHW-029,
  deferred). **The rate-limit is a mitigation, not a cure — document it as such.**
  Confidence: moderate that it meaningfully raises attacker cost; **low** that it fully
  closes amplification (it can't, given AHW-029).

### 6. Reveal narrowing (AHW-047) — is purpose-scoped viewing-key derivation POSSIBLE?
**No — not without re-architecting on-device key derivation, which is out of PoC scope.**
- Aztec derives all four master keys (NHK_M/IVSK_M/OVSK_M/TSK_M) from **one** secret Fr
  via `@aztec/stdlib derivation.ts`. The device exports that **one Fr** (the privacy
  root); the host expands it. There is no protocol-defined "incoming-only" or
  "tag-only" sub-secret you can export while withholding the others — they're all
  deterministic functions of the same root.
- **Could the device derive and export only, say, IVSK_M?** In principle the device could
  run `deriveKeys` *itself* and export only one of the four — but (a) that moves the
  entire key-expansion into the C app (significant new attack surface + the
  non-constant-time concern AHW-029 now applies to *more* derivations), and (b) the host
  needs multiple of the four for normal note discovery/decryption, so exporting one
  doesn't serve the use case. (c) Chain-scoping: address derivation **excludes chainId**,
  so you can't even narrow by chain at the address layer.
- **Honest fallback (the fix):** fix the **UX wording** to state the truth — "this
  exports the privacy ROOT for this account path; it lets this computer see your notes
  across networks and both account types; it does NOT export spend authority." Plus
  Phase 2's memory-only + scheme-aware cache. Confidence: **high** that purpose-scoping
  is not protocol-possible for a PoC; the honest-wording fallback is correct.

### 7. Does deleting `adapter-trezor` / `apps/demo` break anything still referenced?
- **`git grep` gate in Phase 0** is the verification. Audit says only the dead `apps/demo`
  consumes `adapter-trezor`, and `apps/demo` is a workspace member nothing depends on
  (CI only typechecks it). **The one survivor: `computeOuterHashForIntent` in
  `packages/core` (AHW-073)** — it lives in the *shared* core, not in trezor, so deletion
  must check `packages/core` importers and either delete the function (if unused live) or
  gut its body to throw. The `demo-browser` is Ledger-only. Confidence: high pending the
  grep.

### 8. Sequencing — which ordering minimizes the half-migrated window?
- **Host-only fixes (Phases 1-2) first** — no device state, instantly revertible, kills
  the CRIT without touching firmware.
- **One firmware rebuild for infra+display (Phases 3-4)** — NVM/settings foundation then
  display layered on; a single Speculos re-validation pass.
- **The wire change (Phase 5) DEAD LAST, behind a hard manifest cut** — the only change
  that can leave a device/host wire-incompatible. The hard cut (`v2→v3`, device rejects
  old) means there is **no** half-migrated wire state: a mismatched pair fails closed
  with `SW_UNKNOWN_MANIFEST_VERSION`. Host + device land atomically. This is the
  minimal-window ordering.
- **Codegen (Phase 6) parallel** to 3-5 (independent). **Tests/docs (7-8) last** so they
  describe final behavior.

### Additional adversarial notes (supply-chain / least-privilege)
- **Supply chain:** the codegen provenance (Phase 6) closes the "mutable node_modules
  becomes canonical" hole; the `systeminformation` override (Phase 0) closes the surfaced
  HIGHs; `--frozen-lockfile` everywhere; the 7-day min-age stays.
- **Least privilege:** CI keeps `contents: read`; the path gate (AHW-064) tightens
  on-device key-derivation scope; `internalDeps` (AHW-002) stops over-exposing.
- **The cmov barrier (AHW-068)** is the only sanctioned crypto-code change; everything
  else in the math layer is verified-clean and untouched.

---

# Pushback on the locked decisions (with reasoning)

The owner said "don't relitigate unless dangerous." Two I'd push on; one I'd refine.

1. **`blind_signing` ON path — I would NOT ship it for a PoC at all (moderate-strength
   pushback).** The Eth/Solana toggle exists because those ecosystems have *real* dApps
   that legitimately need blind-signing (complex contract calls the device can't decode).
   This PoC has **no such flow** — the live transfer/drip/deploy verbs all clear-sign,
   and Phase 1 makes the host `createAuthWit` fail-closed regardless. So the *only* thing
   `blind_signing=ON` enables is a manual, deliberate raw-hash sign that **nothing in the
   PoC uses**. That's pure attack surface (the social-engineering footgun) for zero PoC
   utility. **Safer: delete `signOuterHash` from the device entirely for the PoC**, and
   re-introduce the toggle in the milestone that actually ships an app-authwit flow. I'll
   implement the toggle as locked, but I'd raise this at the approval gate. *Reasoning:
   least-privilege — don't ship a dangerous capability with no consumer.*

2. **8+8 with "optional show-full" — I'd make show-full one tap, not buried (refinement,
   low-strength).** 8+8/2^64 is genuinely safe against poisoning, so this is minor — but
   the recipient is the *device-unverified, theft-enabling* field, and address-poisoning
   is the #1 real-world wallet attack. I'd put "show full address" as a **prominent single
   action** on the recipient line, not a deep drill-down, so a careful user reaches all 32
   bytes in one tap. Doesn't add clutter to the default view. *Reasoning: the unverified
   field deserves the easiest path to full verification.*

3. **Implement-ALL-FW-now including the B3-salt wire change — agree on scope, push on
   *coupling* (low-strength).** Doing all firmware now is right (the rebuild is the
   expensive part; amortize it). But I'd **decouple the B3-salt wire change into its own
   PR/commit behind the hard manifest cut**, not merged with the display/NVM work, so its
   (highest) regression risk is isolated and independently revertible. The brief implies
   one big firmware push; I'd split the wire change out. *Reasoning: blast-radius
   isolation for the single riskiest change.*

Everything else in the locked decisions I'd ship as specified — the 8+8 width, the
default-OFF toggle mechanics, the fail-closed host defenses (AHW-002/003), the
salt-committed binding, the rate-limit-as-mitigation framing. The reveal-narrowing
"honest wording" fallback is correct (purpose-scoping isn't protocol-possible).

---

# Validation gate (run before declaring done)

**Local (< 2 min) — every phase:**
- `bun run lint` (Biome) + `bunx tsc --noEmit` (live scope) → exit 0 in transcript.
- `bun test` → green; new seam/fault/content tests present and passing.
- `git grep` sweeps return empty: deleted symbols (`adapter-trezor`, `apps/demo`,
  `createAuthWitFromIntent`, `INS_CXMATH_SPIKE`, old `LedgerEcdsaKAuthWitnessProvider`
  name), stale comments where rewritten.

**Firmware (Speculos) — Phases 3-5:**
- `make` builds with `-Werror`, explicit `AZTEC_COIN_TYPE`, no `CX_MATH_SPIKE`.
- Speculos suite: `blind_signing` OFF-rejects / ON-warns + persists; rate-limit
  triggers on failed derivations + survives power-cycle (NVRAM persistence); path gate
  rejects non-canonical + allows other account indices; session-reset zeroes on
  malformed-frame-mid-stream; per-verb **content** assertions (8+8 recipient, DRIP
  rendered, raw amount, ASCII ellipsis, scoped verified-halo, mint banner, "Viewing key
  revealed", full outer_hash on paranoia screen).
- **M12 fuzz:** `wire_host` libFuzzer corpus regenerated for the new `begin_authwit`
  body (salt) → no crash, no false-accept.
- **Differential-replay:** `wire-differential-replay.test.ts` regenerated for the v3
  wire → device-recompute == host-canonical (the "signs only what it recomputed" net).
- **`dudect`** re-run after the cmov barrier → control-flow leak stays closed, no new
  branch.
- **B3 regression:** `Fr.ZERO`-salt account byte-stable with pre-change; non-zero-salt
  account now succeeds (AHW-026); wrong-salt-vs-consumer fails closed.

**Testnet matrix — Phases 1, 4, 5:**
- Live clear-signed transfer + drip + deploy on testnet (beast-5 RPC) for **both** ECDSA-K
  and Schnorr accounts → on-chain accepted.
- Non-zero-salt account: deploy + clear-signed authwit accepted on-chain (proves the wire
  change works end-to-end, not just in Speculos).
- Deploy mid-flight disconnect → device recovers (no 0x6F11 wedge), AHW-057.

**CI (the gate that must stay green) — Phase 0:**
- Typecheck blocking on the live scope; `bun audit` findings surfaced in step summary
  with the 6 HIGH cleared; codegen provenance + coverage checks fail-closed on a tampered
  artifact/manifest; `--frozen-lockfile` asserted.

**Post-implementation codex review** (per the plan protocol §6): diff + summary to codex
with the explicit adversarial ask — "what could go wrong, what would an attacker target,
what are we trusting that we shouldn't, where are the supply-chain/crypto/least-privilege
weaknesses" — focused on the B3-salt change, the rate-limit power-cycle gap, and the
`blind_signing` footgun. Triage + fix loop until high/critical findings (incl.
modularity) are closed.

---

## Dependency graph (phase ordering)

```
Phase 0 (CI/dead-code/provenance) ──┬─> Phase 1 (host fail-closed, CRIT) ──> Phase 2 (host residue)
                                    │
                                    ├─> Phase 6 (codegen) ───────────────────────────┐
                                    │                                                 │
                                    └─> Phase 3 (FW infra: NVM/toggle/rate-limit) ──> Phase 4 (FW display) ──> Phase 5 (B3-salt wire, LAST)
                                                                                                                       │
                                                                       Phase 7 (tests/comments) + Phase 8 (docs/cmov) ─┘ (describe final behavior)
```

- Phase 0 unblocks everything (green CI).
- Phases 1-2 (host) and Phase 6 (codegen) are independent of the firmware rebuild — run
  in parallel.
- Phases 3→4→5 are the single firmware sequence; 5 is the hard-cut wire change, last.
- Phases 7-8 land after behavior is final (comments/docs must describe the shipped state;
  the cmov barrier builds in the 3/4 rebuild but its doc is Phase 8).
