# Pre-auditor quality & maintainability review — adapter-ledger / core

**Verdict:** Strong, audit-ready codebase with disciplined modularity, near-zero type-unsafety, and a crypto-parity test layer that is genuinely bidirectional (host mirror == upstream encoder, device == host mirror, both gated in CI via Speculos). The one real gap an auditor will flag: the central security seam `LedgerClearSigningEntrypoint` has **no host-side unit test** — its four fail-closed guards (incl. the plan-mandated stream-A-claim-B reject) are unexercised by any non-Speculos test, and one was explicitly promised in `plan.md`. Plus a cluster of stale comments and one load-bearing untyped sideband cast.

Scope calibration: this is a PoC heading to external audit. Findings are ranked by what an auditor/maintainer would actually flag; cosmetic nits are omitted unless they cluster.

Baseline at review time: `bun test packages/` → **141 pass / 32 skip (Speculos) / 0 fail**, 37 files.

---

## 1. Modularity / single-responsibility

### [LOW→MEDIUM] `aztec-ledger-session.ts` (649 LOC) is the one module that flirts with monolith — but it is a thin orchestrator, not a god-object
`aztec-ledger-session.ts:199-649`. It is by far the largest file (next is 288). Responsibilities it currently owns:
1. Connection/wiring factory (`connect`, 227-314) — PXE + wallet + account contract + contract registration.
2. Deploy orchestration (`deployAccountViaEntrypoint`, 328-428).
3. Transfer/drip verb dispatch (`dripUsdc`, `transferUsdc*` ×4 wrappers + `transferUsdc` dispatcher, 490-575).
4. The real-sendTx submission path (`transferViaRealSendTx`, 593-632).
5. Infra helpers (mutex, `getChainInfo` cache, `contractAt`, `sponsoredFee`, `requireMethod`).

The owner's bar is "if you can't summarize a module's purpose in one sentence, split it." You *can* summarize this one — "drive an in-browser HW-wallet session against a live node" — and every method is a verb of that sentence, so it is not a true SRP violation. But it is the obvious extraction target if it grows. **Recommended action (defer unless it grows):** extract the four demo transfer-verb wrappers + `transferUsdc`/`dripUsdc` + `requireMethod`/`contractAt`/`sponsoredFee` into a `LedgerDemoVerbs` collaborator that takes the session; that removes ~140 LOC of demo-specific surface and leaves `AztecLedgerSession` as pure connect/deploy/submit lifecycle. The mutex duplication (lines 329-333 vs 597-601, identical in-flight guard) would then live in exactly one submit primitive instead of two. **Do not split for its own sake now** — it is tested where it can be (mutex + getters in `aztec-ledger-session.test.ts`; the real flow needs testnet) and reads cleanly.

### [LOW] `clear-signing-entrypoint.ts` cohesion is fine; `#clearSignOnDevice` / `#deploySignOnDevice` duplicate the canonical-hash block
`clear-signing-entrypoint.ts:146-187` and `198-241`. The entrypoint + inner-`DefaultAccountEntrypoint` + `#consume` design is *correct and cohesive* — composing the stock entrypoint (reusing canonical encoding) and gating the in-band witness through `#consume` is exactly the right shape, and one sentence describes it. But the two private sign methods repeat the identical 8-line canonical-hash derivation (`EncodedAppEntrypointCalls.create` → `.hash()` → `computeOuterAuthWitHash` → `messageHashBytes`). **Recommended action:** extract a `#canonicalOuterHash(exec, chainInfo, nonce): Promise<{hash: Fr, bytes: Uint8Array}>` private and call it from both. ~10 LOC saved, and it removes the risk of the two hash derivations silently diverging — which would be a *security-relevant* divergence (deploy and tx signing would attest different things). This is the single highest-value modularity nit because of what it guards.

### [CLEAN] The ECDSA/Schnorr account-contract trio is a textbook shared-base
`ledger-account-contract-base.ts` (58 LOC) holds the entrypoint-override + provider plumbing; `account-contract.ts` (47) and `schnorr-account-contract.ts` (51) each provide only artifact + ctor args + curveId. The base pulls its weight — it is not leaking. The refactor's "dedup the spy/freeze across two contracts" goal landed correctly. **One naming wart (see Hygiene):** the base's provider field is typed `LedgerEcdsaKAuthWitnessProvider` even on the Schnorr path — the type name lies, though the runtime is scheme-correct.

### [CLEAN] `auth-witness-provider.ts`, `l4-manifest.ts`, `preflight.ts`, `deploy-context.ts`, `apdu.ts` are all single-responsibility
`auth-witness-provider.ts` (125) is now a focused 3-method surface after the refactor stripped `createAuthWitFromIntent`/`createAuthWitForDeploy`; its `createAuthWit` Grumpkin fail-closed (89-94) is good defensive design. `l4-manifest.ts` is wire-encoding only; `preflight.ts` is allowlist-mirroring only; `apdu.ts` is the constants/encoders single-source. No splits warranted.

### Duplication map (host TS vs C parity oracles)
The host-TS/C "duplication" is **intentional and load-bearing**, not rot: the host mirrors (`deviceOuterHashForIntent`, the grumpkin/poseidon/pedersen/blake2s/schnorr `*-parity` host fns) exist *specifically* to be diffed against the device. See Test-adequacy §3 for the trustworthiness analysis — the conclusion is they are anchored to the genuine upstream encoder, not self-referential, so the duplication is a feature.

---

## 2. Type-safety at boundaries

### [MEDIUM] The `ledgerDeployContext` sideband is an untyped, name-coupled channel — the one place a rename compiles but breaks at runtime
- Reader: `clear-signing-entrypoint.ts:121` — `const deployContext = (options as ClearSignDeployOptions).ledgerDeployContext;`
- Producer: `aztec-ledger-session.ts:375-383` — `feeEntrypointOptions: { …, ledgerDeployContext: deployContext }`, on an **inferred** (un-annotated) object literal passed into `deployMethod.request({ fee: deployFee })`.

The framework types `wrapExecutionPayload`'s `options` as `DefaultAccountEntrypointOptions` (no `ledgerDeployContext`). The cast at :121 reaches into a field TypeScript cannot see, and the producer side has no type that *requires* the field name to match. Rename `ledgerDeployContext` on either side and **both still compile**; the deploy would silently fall into the non-deploy `else` branch (`#clearSignOnDevice`), skipping the M8-P6 sovereignty re-derive carrier. The device still fails closed (it independently re-derives), so it is not exploitable — but it is the textbook "wrong type compiles, breaks at runtime" smell an auditor will circle. **Recommended action:** define one shared `LedgerFeeEntrypointOptions` type (in `deploy-context.ts` or `clear-signing-entrypoint.ts`), annotate the `deployFee.feeEntrypointOptions` literal at the producer with it, and have `ClearSignDeployOptions` extend/reference the same field. Then a rename is a compile error on both ends. This is the highest-impact type finding.

### [LOW] `bytesEqual` reads bytes via `as number`
`clear-signing-entrypoint.ts:77` — `d |= (a[i] as number) ^ (b[i] as number)`. Under `noUncheckedIndexedAccess` the elements are `number | undefined`; the loop bound makes them defined, but the `as number` silences the checker rather than proving it. Benign (lengths checked at :75). Cosmetic — leave it, or mirror `ecdsa.ts:108`'s documented `biome-ignore` for consistency.

### [LOW] Transport-boundary `as` casts on untrusted JSON / wire bytes
`speculos-transport.ts:93` (`as { data?; error? }`), `:124` (`as { events: {text}[] }`), `:151`/`webhid-transport.ts:108` (`sw as ApduResponse['sw']`), `:131` (`req.ins as Ins as number`). These cast *external* data (HTTP JSON, device bytes) to internal shapes without runtime validation of the JSON shape. For a PoC against a trusted local Speculos/USB device this is acceptable, and the SW/data lengths *are* validated downstream in `provider.ts`. But the SpeculosTransport JSON casts (`as { data?; error? }`) are the kind of unvalidated-trust-boundary parse an auditor flags by reflex. **Recommended action (optional for PoC):** a 3-line shape guard on the Speculos response before the cast, or a comment explicitly scoping the trust ("Speculos is a test-only trusted local process"). Not worth a runtime-validation library at PoC stage.

### [CLEAN] Everything else is precise
Zero `: any` / `as any` / `<any>` in non-test source (grep-confirmed across `adapter-ledger` + `core`). Non-null `!` assertions are confined to tests. APDU byte handling in `provider.ts`/`l4-manifest.ts`/`deploy-context.ts` is strict: every field length-checked, every uint32 path component range-checked, encoder offset asserted (`off !== out.length` throws). `apdu.ts` const-objects + derived union types (`Ins`, `CurveId`, `StatusWord`) give exhaustive typing. The `>>> 0` unsigned coercions (`provider.ts:60`, `apdu.ts:110`) are correct and documented. The `core` package boundary (`packEcdsaSignature`, `normalizeLowS`, `ecdsaPreimage`) refuses DER/extra bytes and validates lengths — exactly the published-API rigor the owner wants.

---

## 3. Test adequacy

### Device security invariants — are they tested or just asserted?

| Invariant | Tested? | Where | CI? |
|---|---|---|---|
| Independent recompute reject (`SW_HASH_MISMATCH` 0x6F01) | **Yes, on real app.elf** | `provider.m8.test.ts:225` (deploy 6d), `wire-differential-replay` reject reservoir | Speculos CI (m8) / local (replay) |
| B3 consumer-mismatch reject (0x6F12) | **Yes, on real app.elf** | `b3-consumer-binding.test.ts:45-93` | Speculos CI |
| M8-P6 pkh sovereignty reject (0x6F0F) | **Yes, on real app.elf** | `provider.test.ts:169-188` | Speculos CI |
| M8-P6 address sovereignty reject (0x6F0E) | **Yes, on real app.elf** | `provider.m8.test.ts:151-175` | Speculos CI |
| Stream-A-claim-B reject (host `#consume`) | **NO — see gap below** | — | — |
| Deploy positive (device-derived ctx accepted) | **Yes** | `provider.m8.test.ts:177-223` | Speculos CI |

The four device-side invariants the mandate named are genuinely exercised against the real firmware, not comment-asserted. The construction is rigorous (e.g. `b3-consumer-binding.test.ts:16-19` documents *why* a returned 0x6F12 is provably the pre-UI reject and not a lookalike). This is well above PoC bar.

### [HIGH] GAP: `LedgerClearSigningEntrypoint` has zero host-side unit tests — four fail-closed guards unexercised
No test file constructs a `LedgerClearSigningEntrypoint`. `auth-witness-provider.test.ts` and `aztec-ledger-session.test.ts` only *mention* it in comments. The following pure-TS, Speculos-free guards — all added by the refactor under review — have **no test**:

1. `feePaymentMethodOptions !== EXTERNAL` → throw (`clear-signing-entrypoint.ts:127-131`). Guards an unsigned fee-mode tamper.
2. `cancellable !== false` → throw (`:132-136`). Guards unsigned cancellability tamper.
3. `DeployContext mismatches runtime (address/chain/version/nonce)` → throw (`:219-228`).
4. **`#consume` stream-A-claim-B reject** (`:245-255`) — "refusing to sign what was not reviewed."

Guard #4 is the most serious omission because **`plan.md:59` explicitly promised it**: *"A test asserts: stream calls A, claim `messageHash` for B → rejected."* That assertion was never written as a host unit test. The *device-side* B3 test covers a *different* property (consumer ≠ controlled account); it does not cover the host-side hash-binding between what was signed and what the inner entrypoint requests. An attacker model where the inner entrypoint is fed a different `messageHash` than the device signed is exactly what `#consume` defends, and it is the cheapest possible test (no device, pure JS). **Recommended action (do before audit):** add `clear-signing-entrypoint.test.ts` with a mock `LedgerProvider` (the device methods are a small interface) asserting all four guards throw, plus a happy path where `#consume` returns the stashed witness on a matching hash. ~80 LOC, closes the single biggest auditor-visible test gap and discharges the plan's own promise.

### [MEDIUM] `internalDeps` secret-stripping is asserted in a comment but not tested
`aztec-ledger-session.ts:437-440` strips `secret` from the public `internalDeps` getter (an explicit impl-audit MAJOR fix). There is no test that `session.internalDeps` lacks a `secret` key. A future refactor of the getter could reintroduce the leak silently. **Recommended action:** one assertion `expect('secret' in session.internalDeps).toBe(false)` in `aztec-ledger-session.test.ts`. Trivial, and it pins a security property that was a documented finding.

### [LOW] The host-vs-device oracle (`deviceOuterHashForIntent`) is a TRUSTWORTHY double — anchored to upstream, not self-referential
The mandate's sharpest question. Analysis:
- `l4-manifest-parity.test.ts:141-147` (runs in CI, **not** Speculos-gated) compares `deviceOuterHashForIntent` (host mirror of `parity.c`'s 31-field payload) against `canonicalOuterHash` (`:61-65`), which calls the **genuine** `EncodedAppEntrypointCalls.create` + `computeOuterAuthWitHash` from the installed `@aztec/*` 4.2.1. So the mirror is pinned to the real upstream encoder — **this is not testing the re-implementation against itself.** Good.
- The *device's actual* `parity.c` == the host mirror is proven by the Speculos suite (`b3-consumer-binding` uses `deviceOuterHashForIntent` as the claimed hash the device must independently reproduce; the m8/provider deploy tests verify device recompute). Per `ledger-app.yml:125-128`, the full `adapter-ledger` suite **runs against Speculos in CI**, so device==mirror IS CI-gated.
- Therefore the loop closes in CI: mirror == upstream (`l4-manifest-parity`) **and** device == mirror (Speculos suite). The strongest bidirectional gate (`wire-differential-replay`, host-oracle-vs-device) is local-only because it needs compiled fuzz binaries + a harvested reject reservoir — this is correctly documented (`wire-differential-replay.test.ts:30-39`) and is a reasonable cost tradeoff, not a hidden gap.

The residual risk: if someone edits `parity.c` and `deviceOuterHashForIntent` *together* in a divergent way, `l4-manifest-parity` would still catch it (mirror would stop matching upstream) *unless the edit also matched a co-incident upstream change*. That is a narrow, low-probability class. **No action required** — but worth a one-line comment in `l4-manifest.ts` near `deviceOuterHashForIntent` stating the anchor is upstream (`EncodedAppEntrypointCalls`), so a future maintainer doesn't mistake it for a self-test and delete the "redundant" parity assert.

### [CLEAN] The crypto-parity layer is exemplary
`poseidon2`/`pedersen`/`blake2s`/`grumpkin-*`/`schnorr-*`/`master-secret`/`grumpkin-account` parity tests each diff a host implementation against golden vectors (CI) and the device (Speculos). `grumpkin-point-add-edge.test.ts` specifically targets the cmov-select exceptional cases — the right instinct (edge cases over volume). `golden-vectors.stability.test.ts` pins the vectors. Negative wire paths are covered on the real handler (`wire-negative.test.ts`). This is the smallest-set-that-proves-correctness philosophy executed well.

---

## 4. Auditor-readiness hygiene

### [MEDIUM] Stale "reserved" comments on actively-used status words — contradicts the code
`apdu.ts:224-225`:
```
DEPLOY_ADDRESS_MISMATCH: 0x6f0e, // reserved: M8 Grumpkin lift
DEPLOY_PUBKEY_HASH_MISMATCH: 0x6f0f, // reserved: M8
```
Neither is reserved. `0x6F0E` is asserted live in `provider.m8.test.ts:174`; `0x6F0F` in `provider.test.ts:188`, `wire-differential-replay.test.ts:53`, and is the device's primary deploy-sovereignty reject. An auditor reading "reserved" will assume the address/pkh gates are unimplemented and either waste time or miss that they are the *core* sovereignty guards. **Recommended action:** change both comments to describe the live gate (e.g. `// M8-P6: expected_address != device-derived (begin_deploy_account.c)` and `// M8-P6: public_keys_hash != device-derived`). This is the highest-impact hygiene fix — it actively misleads about a security-critical mechanism.

### [LOW] `deploy-context.ts:8` wire-layout comment says `curve_id : 1 B (= K1)` — stale post-Schnorr
The `curveId?: CurveId` field (`:39`) now carries `GRUMPKIN` for Schnorr deploys (set in `aztec-ledger-session.ts:346`). The doc-comment hardcodes `= K1`. Minor, but it is exactly the "comment contradicts code" class the mandate is hunting. **Action:** `curve_id : 1 B (K1 / GRUMPKIN per scheme)`.

### [LOW] Type name `LedgerEcdsaKAuthWitnessProvider` is used for Schnorr accounts — the name lies
`ledger-account-contract-base.ts:26,55`, `schnorr-account-contract.ts:31`. The provider is genuinely scheme-generic (curveId-driven), and every *comment* says so, but the *type name* still says "EcdsaK". A maintainer grepping for the Schnorr signing path won't find it under this name. **Action (optional, churn-y):** rename to `LedgerAuthWitnessProvider` (it is exported from `index.ts:35`, so this is a public-API rename — defer to a deliberate version bump, but flag it). At minimum the base-class field name reinforces the lie and could be commented.

### [LOW] `console.warn` in transport — acceptable but flag it
`speculos-transport.ts:75-76`. Documented as diagnostic-only on an autoConfirm throw. Fine for a test transport. Confirm it is not reachable from the WebHID (production) path — it is not (`webhid-transport.ts` has none). No action.

### [CLEAN] No dead code, no TODO/FIXME/XXX/HACK, no `@ts-ignore`, no leftover debug instrumentation
Grep-confirmed across non-test source. The previously-flagged pre-simulation comment is fixed and now *consistent* across both sites (`session-embedded-wallet.ts:51` "ALWAYS pre-simulates" / `aztec-ledger-session.ts:586` "pre-simulates via a stub account, no device prompt") — no contradiction remains. The single `biome-ignore` (`ecdsa.ts:108`) is justified and documented.

### [CLEAN] The `index.ts` public surface is intentional
`adapter-ledger/src/index.ts:13-85` exports exactly the consumer-facing classes/types (session, account contracts, provider, transports, APDU constants, onboarding, secret-cache). No internal helpers leak: `clear-signing-entrypoint.ts`, `l4-manifest.ts`, `project-call-intent.ts`, `preflight.ts`, the generated `clear_signing_v0/*`, and the `oracle/*` derivation internals are all kept private to the package. `LedgerClearSigningEntrypoint` is *not* exported — correct, it is constructed via the provider's factory. One stale **header doc**: `index.ts:1-11` still says "Actual provider class lands once the C app is buildable" / "scaffolded" — the app is built and proven on testnet. Update the file header (it is the first thing an auditor reads). The `internalDeps` getter exposing contract instances (not the secret) is intentional and documented for UI rendering.

### [LOW] `secret-cache.ts` browser-storage cast
`secret-cache.ts:26` — `(globalThis as { sessionStorage: Storage }).sessionStorage`. Standard browser-env access pattern; the file header documents the XSS threat model honestly. No action.

---

## Genuinely clean / well-modularized (credit where due)

- **`core/ecdsa.ts`** — published-API rigor: length-checked, DER-refusing, documented curve constants, correct low-S. The reference an auditor wants to see.
- **`apdu.ts`** — single-source-of-truth constants with derived union types; strict env parsing (`AZTEC_COIN_TYPE` rejects `"1666junk"`, `"0x10"`); `assertCanonicalAztecPath` fails fast host-side instead of bouncing an opaque device SW.
- **`ledger-account-contract-base.ts` + the two subclasses** — correct shared-base; the refactor's dedup goal landed.
- **`preflight.ts`** — clean mirror of device allowlist gates with typed `PreflightError.deviceSwCode`; ergonomic errors, device-remains-authority discipline stated.
- **`deploy-context.ts` encoder** — every field validated, offset-asserted, `defaultDeployPath` correctly delegates to the single path impl (kills the prior two-helper drift).
- **`session-embedded-wallet.ts`** — the subclass-with-getters over `as unknown as` downcast is the *right* call and is documented as such; type-safe across upstream protected-field renames.
- **The crypto-parity test suite** — bidirectional (golden-vector + on-device), edge-case-targeted, CI-gated via Speculos. Model test design.
- **`l4-manifest.ts` encoders** — exhaustive length/offset assertions on every wire field.

---

## Priority queue for the maintainer (do these before the external audit)

1. **[HIGH]** Add `clear-signing-entrypoint.test.ts` covering the 4 guards + `#consume` happy path (discharges `plan.md:59`'s promised stream-A-claim-B test). ~80 LOC, no device.
2. **[MEDIUM]** Fix the "reserved" comments on `apdu.ts:224-225` (0x6F0E/0x6F0F are live sovereignty gates).
3. **[MEDIUM]** Type the `ledgerDeployContext` sideband end-to-end so a field rename is a compile error (`clear-signing-entrypoint.ts:121` + `aztec-ledger-session.ts:375`).
4. **[LOW]** Add the `internalDeps` no-secret assertion; update the stale `index.ts:1-11` header; fix `deploy-context.ts:8` curve comment.
5. **[LOW/defer]** Extract `#canonicalOuterHash` in the entrypoint (kills the duplicated hash block — security-relevant); consider the `LedgerDemoVerbs` extraction only if the session file grows.
