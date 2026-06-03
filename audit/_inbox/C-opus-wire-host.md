# Wave-1 Agent C (opus) — WIRE host red-team (`packages/adapter-ledger/src/*.ts` + `core/src/{ecdsa,intent}.ts`)

Scope: TS host wire only (NOT C firmware, NOT `apps/*`). Read every priority file end-to-end + the
upstream `@aztec/{entrypoints,wallets,wallet-sdk,constants,foundation}@4.2.1` sources the host depends
on. Verified each line number by reading the file. Numbering continues from AHW-083; these are
candidate IDs for the validator (F-C-N).

**Framing recap:** the device recomputes + signs `outer_hash = computeOuterAuthWitHash(addr, chainId,
version, poseidon2(callfields..., tx_nonce, SIGNATURE_PAYLOAD))`. Host-controlled fields OUTSIDE that
hash (so the device cannot catch them) are: `cancellable`, `feePaymentMethodOptions`, `gasSettings`
(TxContext), `feePayer`, `authWitnesses`, `capsules`, `extraHashedArgs`, per-tx `salt: Fr.random()`.
`#assertClearSignPolicy` is the SOLE host guard for these. I enumerated each against the guard.

---

### F-C-1: `#assertClearSignPolicy` does not reject a `ledgerDeployContext` smuggled onto the TX path (deploy/tx mode is a host-chosen sideband, not pinned)
- Severity: LOW — no signing-integrity break (the device runs the verb flow, not the deploy flow); a stale/forged context on a tx is inert, but the mode-select is an unvalidated trust input.
- Owned: OURS
- Category: WIRE
- Location: `clear-signing-entrypoint.ts:127` (read), `:103-114` (`createTxExecutionRequest` — no context check), `:284-320` (`#assertClearSignPolicy` — no context-field check)
- What: `wrapExecutionPayload` decides deploy-vs-tx purely on the presence of `(options as ClearSignDeployOptions).ledgerDeployContext` (`:127`). `createTxExecutionRequest` never inspects `options` for a stray `ledgerDeployContext`, and `#assertClearSignPolicy` does not reject one on a `kind==='tx'` call. The deploy/tx branch is therefore a host-chosen, unauthenticated sideband: nothing asserts "a tx MUST NOT carry a deploy context" or "a deploy MUST carry one." Today fail-closed both ways (a contextless self-paid deploy hits the tx branch → `feePaymentMethodOptions!==EXTERNAL`/`cancellable!==true` reject; a context on a tx is ignored), but the invariant rests on luck, not an assert.
- Attack/impact: A hostile consumer holding the provider (`createClearSigningEntrypoint` is reachable via the exported `LedgerEcdsaKAuthWitnessProvider`) cannot currently gain anything, but the missing pin means a future field/branch change could let a deploy be silently downgraded to a verb review (or vice-versa) without a compile/runtime error — the exact failure-mode class AHW-005 warns about for the untyped sideband.
- Evidence: `:127` `const deployContext = (options as ClearSignDeployOptions).ledgerDeployContext;` is the only mode discriminator; `#assertClearSignPolicy(:284)` checks authWitnesses/capsules/extraHashedArgs/feeMode/cancellable but never the presence/absence of a deploy context per `kind`.
- Fix sketch: in `#assertClearSignPolicy`, assert `kind==='deploy'` ⇔ a `ledgerDeployContext` is present, and reject a context on the tx path. Pairs with AHW-005's shared typed-options fix.
- Confidence: high
- Dedup-check: AHW-005 is the untyped-sideband (rename-compiles) finding; AHW-003 is the unsigned-field guard. Distinct: this is the missing *mode-consistency* assert in the new entrypoint (AHW-005 is the *type annotation*, AHW-003 is the *payload-field* set). Novel sub-point.

---

### F-C-2: Domain-separator constants are hardcoded magic numbers in the host wire, not imported from `@aztec/constants`, with no compile/test equality assert
- Severity: MED — correctness-drift risk on an SDK bump; mitigated (fail-closed + parity-tested) but load-bearing for the args_hash the device consumes.
- Owned: OURS
- Category: WIRE
- Location: `l4-manifest.ts:37-40` (`SIGNATURE_PAYLOAD=463525807`, `_AUTHWIT_OUTER=3283595782`, `PUBLIC_CALLDATA=2760353947`, `FUNCTION_ARGS=3576554347`), consumed at `:58` (`paddingArgsHash`), `:72`/`:77` (`encodeRealCall` argsHash), `:186` (`deviceOuterHashForIntent` inner-hash)
- What: The host hardcodes the four Aztec poseidon2 domain separators as literals "must equal the device-side constants in `l4/wire.h`" (`:36`). Upstream canonical encoding (`@aztec/entrypoints/encoding.ts:117`) instead imports `DomainSeparator.SIGNATURE_PAYLOAD` from `@aztec/constants`. I verified the literals MATCH `@aztec/constants@4.2.1` exactly (`constants.gen.ts:527/528/532/543`) — so no live mismatch today. The defect is that there is no `===` assertion binding `l4-manifest.ts`'s literals to `DomainSeparator`; an `@aztec/*` bump that re-numbers a separator silently desyncs the host's *streamed* `argsHash` (which the device's recompute consumes) from canonical.
- Attack/impact: Not attacker-triggered. On an SDK bump: `encodeRealCall`'s `argsHash` (hardcoded `PUBLIC_CALLDATA`) would diverge from canonical → the device's outer_hash recompute mismatches the host's canonical signed hash → every clear-sign breaks with `SW_HASH_MISMATCH` (availability), OR the parity test (`l4-manifest-parity.test.ts`) catches it first. Fail-closed, but a hardcoded crypto constant in the signing wire with no drift guard is a latent correctness hole on a hardware wallet.
- Evidence: `l4-manifest.ts:37` `const SIGNATURE_PAYLOAD = 463525807;` (+ `:38-40`); upstream `encoding.ts:1` `import { DomainSeparator } from '@aztec/constants'`, `:117` uses the enum. The `_AUTHWIT_OUTER` literal is even dead (prefixed `_`, never used — `computeOuterAuthWitHash` is imported and handles it), so the mirror is already partially stale-by-design.
- Fix sketch: import `DomainSeparator` from `@aztec/constants` instead of literals, or add a tiny test asserting each literal `===` the matching `DomainSeparator` member (fails the build on an upstream renumber); drop the dead `_AUTHWIT_OUTER`.
- Confidence: high
- Dedup-check: AHW-035 is codegen *artifact* provenance (`registry`/verb metadata from `node_modules`); AHW-015 is the parity-anchor comment on `deviceOuterHashForIntent`. Distinct: this is the *domain-separator literals* in the live wire path (not codegen, not a comment). Novel.

---

### F-C-3: Ledger host never verifies the device's returned ECDSA/Schnorr signature against the account's known pubkey
- Severity: LOW — Aztec's in-circuit verifier checks the sig against the constructor pubkey, so a bad/MITM signature only fails the proof (no forged tx); pure defense-in-depth + a clearer-error miss.
- Owned: OURS
- Category: WIRE
- Location: `provider.ts:151-167` (`finalizeAndSign`), `:196-212` (`finalizeDeployAndSign`), consumed at `clear-signing-entrypoint.ts:172-177` / `:225-232` (wrap as `AuthWitness` with zero verification)
- What: `finalizeAndSign`/`finalizeDeployAndSign` length-check `r||s` (64 B) and return it; `LedgerClearSigningEntrypoint` wraps it straight into `AuthWitness(messageHash, packEcdsaSignature(r,s))`. The host has the account's pubkey (`getPublicKeyXY`, cached at `auth-witness-provider.ts:79-89`) and bundles `@noble/curves`, but never `verify(sig, sha256(outer_hash), pubkey)`. A malicious or MITM `LedgerTransport` returning any well-formed 64-byte blob with `sw=0x9000` is trusted as a signature.
- Attack/impact: MITM transport (or a compromised `@ledgerhq/*` shim) feeds a garbage signature → the host proves a tx whose authwit won't verify in-circuit → the prove/submit fails late with an opaque error instead of an immediate "device signature invalid." No fund loss (circuit is the backstop), but the host trusts an untrusted channel where a cheap local check exists.
- Evidence: `provider.ts:162-166` returns `{r,s}` after only `requireOk` + length check; `clear-signing-entrypoint.ts:176` `wit: new AuthWitness(messageHash, Array.from(packEcdsaSignature(sig.r, sig.s)))` — no verify between. `ecdsaPreimage` (`core/src/ecdsa.ts:34`) exists and would give the exact signed digest for a `secp.verify`.
- Fix sketch: after finalize, `secp256k1.verify(r‖s, sha256(outerHashBytes), cachedPubkey)` (and the Grumpkin-Schnorr equivalent); throw on failure. Cheap, turns a MITM into an immediate local reject.
- Confidence: high
- Dedup-check: AHW-075 is the SAME principle but explicitly scoped to the DELETED `adapter-trezor` package ("Trezor host doesn't verify the device signature"). The Ledger (live, sole-v0) adapter has the identical omission and AHW-075's scope note says "delete with the package" — so the live-adapter instance is uncovered. Distinct by package + live status.
- Dedup-NB for validator: if you'd rather fold this into AHW-075, re-scope AHW-075 to "both adapters" — but the trezor one is dissolved, so the live gap needs its own tracked ID.

---

### F-C-4: `overrideAccount` permanently mutates the shared wallet account-map on every transfer/drip and is never reverted
- Severity: LOW — fail-closed (the installed account's `createAuthWit` throws); state-management hygiene, not exploitable today.
- Owned: OURS
- Category: WIRE
- Location: `aztec-ledger-session.ts:618-620` (`transferViaRealSendTx`: build entrypoint → `BaseAccount` → `session.overrideAccount(...)`), `session-embedded-wallet.ts:81-83` (`overrideAccount` set, no clear), contrast `aztec-ledger-session.ts:372`/`:395` (deploy uses `setEntrypointOverride(ep)` + `finally setEntrypointOverride(null)`)
- What: Each `transferViaRealSendTx` installs a fresh `BaseAccount` (around a new `LedgerClearSigningEntrypoint`) into `SessionEmbeddedWallet.externalAccounts` via `overrideAccount` and NEVER reverts it (unlike the deploy path's `try/finally`). The override outlives the submission. `EmbeddedWallet.sendTx`'s auto-authwit harvesting then routes `createAuthWit(onBehalfOf)` through `getAccountFromAddress` → this overridden account for self-authwits.
- Attack/impact: No direct exploit — `LedgerEcdsaKAuthWitnessProvider.createAuthWit` is fail-closed (`auth-witness-provider.ts:91-105`) and `EmbeddedWallet.sendTx` swallows the throw in a `catch{}` (`embedded_wallet.ts:139-149`), dropping the witness. But the un-reverted override is a stale-state seam: a future change that makes the override account's authwit non-throwing, or a second account on the same session, inherits a permanently-installed entrypoint built for the FIRST tx's options.
- Evidence: `aztec-ledger-session.ts:620` `session.overrideAccount(this.address, account);` has no matching clear in the `finally` at `:638-642` (which only nulls `this.inflight`). `session-embedded-wallet.ts:81` `overrideAccount` is a bare `Map.set`.
- Fix sketch: revert the override in `transferViaRealSendTx`'s `finally`, or build the per-tx account without mutating shared wallet state (pass it through a scoped path).
- Confidence: high
- Dedup-check: AHW-009 is the session monolith + duplicated mutex (`:329-333`≈`:597-601`). Distinct: this is the un-reverted shared-map mutation, a different state-lifetime defect. Novel.

---

### F-C-5: Auto-authwit fail-close (AHW-001) is silently swallowed upstream — a legitimately-needed app-authwit is dropped, not surfaced, producing an opaque downstream failure
- Severity: LOW — correct fail-closed posture (no blind sign), but the UX/observability is a footgun: "blind signing disabled" never reaches the user.
- Owned: MIXED — the swallowing `try/catch` is in upstream `@aztec/wallets` (LEDGER-PLATFORM-adjacent: we can't edit it); the decision to throw with no out-of-band signal is OURS.
- Category: WIRE
- Location: `auth-witness-provider.ts:91-105` (`createAuthWit` throws), upstream `embedded_wallet.ts:138-150` (`offchainEffects.map(... try{createAuthWit}catch{return undefined} )`)
- What: `EmbeddedWallet.sendTx` derives app-level authwits from offchain effects and calls `this.createAuthWit(...)` per effect inside `try{...}catch{return undefined}`. Our provider's `createAuthWit` ALWAYS throws (AHW-001 fail-close). So any tx that genuinely needs an app-authwit has it silently dropped to `undefined` and filtered out; the tx then proceeds to prove WITHOUT the witness and fails later (kernel/simulation) with an unrelated error. The user never sees "this flow needs an authorization the device can't clear-sign yet."
- Attack/impact: Availability/observability only — the live transfer/drip/deploy flows generate no offchain auth effects (own-account), so it never fires today. A future verb that needs an app-authwit would fail confusingly. Not a signing hole (the witness is genuinely never produced).
- Evidence: `embedded_wallet.ts:140-149` catches and `return undefined`; `:151-155` pushes only truthy witnesses; our `createAuthWit` (`auth-witness-provider.ts:101`) `throw new Error('createAuthWit: blind ... disabled ...')` is thus invisible.
- Fix sketch: cannot stop upstream swallowing; instead detect non-empty `offchainEffects` requiring authwits BEFORE `sendTx` (or surface a wallet-level pre-check) and raise a clear "needs clear-signing entrypoint, not auto-authwit" error in our session wrapper.
- Confidence: high
- Dedup-check: AHW-001 is the blind-sign capability itself (fixed by fail-close). This is the NEW observation that the fix's error is swallowed by upstream → no user signal. Distinct (interaction finding), novel.

---

### F-C-6: No host unit test that `(profileId, salt)` actually thread from a non-zero-salt account through provider → entrypoint → `buildL4Manifest` header on the TX path
- Severity: LOW — the device-side binding is well-tested; the HOST threading that feeds it is not unit-covered (the post-impl codex MED area).
- Owned: OURS
- Category: TEST
- Location: `auth-witness-provider.ts:115-123` (`createClearSigningEntrypoint` threads `salt`/`profileId`), `aztec-ledger-session.ts:246-250` (salt → contract → provider options), `clear-signing-entrypoint.ts:160-167` (entrypoint → `buildL4Manifest({salt, profileId})`); tests: `clear-signing-entrypoint.test.ts` (policy only), `wire-v3-binding.test.ts` (builds the manifest MANUALLY, device-side), `aztec-ledger-session.test.ts` (shape+mutex only)
- What: The post-impl codex MED "a non-zero-salt account must emit its REAL salt" is enforced by threading `salt`/`profileId` through three hops. The device-side binding for a given header is Speculos-tested (`wire-v3-binding.test.ts`), but that test builds `buildL4Manifest({salt, profileId})` by hand. NO test asserts that `LedgerSchnorrAccountContract`(profileId=1)/a non-zero `connect({salt})` actually produces a header with the matching `profileId`/`salt` via the real `provider.createClearSigningEntrypoint(addr)` → `#clearSignOnDevice` chain. A regression that drops `salt`/`profileId` from `createClearSigningEntrypoint` (`auth-witness-provider.ts:116-122`) would compile, pass every existing test, and silently sign with salt=0/profile=0 → device 0x6F12 only on a non-zero-salt account at runtime.
- Attack/impact: Regression exposure: the host-threading is the exact thing the post-impl codex MED fixed, and it has no guard test. A maintainer removing one of the four threaded fields reintroduces the lock-out/wrong-account bug undetected by CI.
- Evidence: grep over `*.test.ts` for `createClearSigningEntrypoint` + `salt`/`profileId` assertions: `wire-v3-binding.test.ts` calls `buildL4Manifest` directly (not the provider); `auth-witness-provider.test.ts` covers only `createAuthWit` fail-close + `getPublicKeyXY`. No assertion on the threaded header.
- Fix sketch: pure-TS test: build `LedgerSchnorrAccountContract`/`LedgerEcdsaKAccountContract` with a non-zero salt, get the provider, `createClearSigningEntrypoint(addr)`, stub the `LedgerProvider` to capture the `beginAuthwit(header)` arg, assert `header.profileId`/`header.salt` match. No Speculos.
- Confidence: high
- Dedup-check: AHW-026 is "B3 non-default-salt lock-out untested" at the DEVICE (0x6F12) level. Distinct: this is the untested HOST threading (provider→entrypoint→manifest), the producer side of what AHW-026 tests as a consumer. Novel.

---

### F-C-7: `bytesEqual` `as number` cast in the deploy-context cross-check (un-proven indexed access)
- Severity: INFO — benign (lengths are equal by construction), flagged only for completeness in the new entrypoint code.
- Owned: OURS
- Category: WIRE
- Location: `clear-signing-entrypoint.ts:79-84` (`bytesEqual`), used at `:206-209` (`#deploySignOnDevice` ctx pre-check)
- What: `d |= (a[i] as number) ^ (b[i] as number)` casts indexed bytes `as number` under `noUncheckedIndexedAccess` rather than proving definedness (loop is `i < a.length` after a length-equality guard, so safe). Same family as AHW-010 but a SECOND occurrence introduced by the new entrypoint rewrite (AHW-010 cited the OLD `:77`; this is the relocated `:82`).
- Attack/impact: none (constant-time-ish equality used only as a host pre-check; the device re-derives regardless).
- Evidence: `:80` `if (a.length !== b.length) return false;` then `:82` casts.
- Fix sketch: `const x = a[i]; const y = b[i]; if (x === undefined || y === undefined) return false; d |= x ^ y;` or a documented `biome-ignore`.
- Confidence: high
- Dedup-check: AHW-010 (same pattern, prior line number, pre-rewrite). This is the same finding surviving the rewrite at a new location — fold into AHW-010 unless tracking the rewrite separately. Near-dup, flagged for honesty.

---

## Confirmed clean — tried to break, could not (auditor-facing negatives)

- **`#assertClearSignPolicy` unsigned-field completeness (the core host duty):** I enumerated every field the device does NOT recompute against the guard. `authWitnesses` (`:289`), `capsules` (`:294`), `extraHashedArgs` (`:299`) → reject-if-non-empty; `feePaymentMethodOptions` → must be `EXTERNAL` (`:304`); `cancellable` → tx must be `true` (AHW-049 nullifier, `:314`), deploy must be `false` (`:309`). The only host-controlled, non-recomputed fields NOT pinned are `gasSettings` (= AHW-062, accepted residual, MED) and `feePayer` (`wrapExecutionPayload` uses `feePayer ?? this.address`, encoding.ts:111 — but flipping it on a sponsored flow needs the victim's authorization elsewhere; same accepted-residual class as AHW-062). **No NEW unsigned-field slips the guard** like the post-impl `cancellable` gap did.
- **`cancellable=true` actually reaches the entrypoint on the live tx path:** traced `transferViaRealSendTx` → `session.sendTx` → upstream `BaseWallet.createTxExecutionRequestFromPayloadAndFee` (`base_wallet.ts:163` `cancellable: this.cancellableTransactions`), and `SessionEmbeddedWallet.createEphemeral` sets `wallet.cancellableTransactions = true` (`session-embedded-wallet.ts:123`). The pre-simulation uses a STUB account (`embedded_wallet.ts:253`), so the device is invoked exactly once on the real prove. Consistent — no throw, no silent `cancellable=false`.
- **Auto-authwit harvesting cannot smuggle a blind-signed witness:** upstream `sendTx` pushes auto-authwits into `executionPayload.authWitnesses` BEFORE the entrypoint runs (`embedded_wallet.ts:151-155`); our `createAuthWit` is fail-closed (throws, swallowed → none created) AND `#assertClearSignPolicy` rejects any non-empty `authWitnesses`. Double-guarded (the AHW-001/003 pairing holds end-to-end).
- **`salt`/`profileId` wire format is exactly 32-BE / u8:** `encodeBeginAuthwitBody` (`l4-manifest.ts:263-270`) range-checks `profileId` to u8 and asserts `salt.length===FR_BYTES`; `normalizeTxNonce` (reused for salt, `:227`) enforces 32 bytes for a `Uint8Array` and routes a `bigint` through `new Fr(v)` which THROWS on `>= MODULUS` (`@aztec/foundation field.ts:63`) — no silent truncation/overflow. Schnorr threads `profileId=1`+`curveId=GRUMPKIN` (`schnorr-account-contract.ts:34-38`), ECDSA defaults `profileId=0` (`account-contract.ts:26`, undefined→0). No curve/profile confusion; `connect()` computes `salt` BEFORE the account contract (`aztec-ledger-session.ts:246`) so it threads correctly.
- **`secret-cache.ts` is genuinely memory-only:** a bare module-level `Map<string,string>` (`:29`), zero `sessionStorage`/`localStorage`/`IndexedDB`/disk references (grep-clean across the package). `SessionEmbeddedWallet` forces `ephemeral:true` (`session-embedded-wallet.ts:108`) so PXE/wallet-DB are in-memory too. The scheme-blind cache key is correct-by-design (one privacy root per path, scheme-independent — matches AHW-047/048's resolution). The "lives only for the page lifetime" claim is true.
- **`#consume` stream-A-claim-B:** the device witness is keyed by the CANONICAL `messageHash` hex and one-shot (`#pending` nulled on read, `:246`); the inner `DefaultAccountEntrypoint` re-derives the same hash and only gets the witness on an exact match (`:243-252`). No replay/cross-tx reuse window found.
- **Host signs the CANONICAL hash, device is the backstop:** production outer_hash = `computeOuterAuthWitHash(addr, chainId, version, EncodedAppEntrypointCalls.create(calls, nonce).hash())` (`clear-signing-entrypoint.ts:258-273`) — identical construction to upstream `DefaultAccountEntrypoint.#buildEntrypointCallData` (`account_entrypoint.ts:131-140`). `deviceOuterHashForIntent` is a TEST-only mirror; it does NOT gate production signing (the device recompute does). No host↔device silent-disagreement path beyond the hardcoded-separator drift (F-C-2).
- **`core/src/ecdsa.ts`:** `packEcdsaSignature` strictly rejects non-32B r/s (no DER, no `v`); `normalizeLowS` correct per BIP-66; `ecdsaPreimage` enforces 32-byte input + SHA-256 (not Keccak/EIP-191) — matches the project's stated Aztec verifier contract. `bigIntToBeBytes` throws on overflow/negative. Clean.
- **`core/src/intent.ts`:** pure type definitions; `isPadding` documented as device-must-count (T6). No logic to break.
- **Transport `as` casts on untrusted bytes (`speculos-transport.ts:151`, `webhid-transport.ts:108` `sw as ApduResponse['sw']`):** an out-of-table SW is just a number that fails `requireOk`'s `!== SW.OK` (`provider.ts:266`) → throws; every device-response length is exact-equality checked in `provider.ts` (64B sig, 64B pubkey, 32B secret, 3B version, 4B caps). A MITM transport feeding bad lengths/SWs fails closed (= the AHW-011 scope, no NEW escalation beyond F-C-3's missing sig-verify).
- **`master-secret.ts`/`onboarding.ts`:** reference/spec only (the prod host has no privkey, calls the INS); `Fr.fromBuffer` asserts `< MODULUS` (canonical-secret invariant); `deviceCacheKey` residual is exactly AHW-079 (no new angle). No persistence, no zeroization claim that's false (the cache comment correctly says the live value is RAM-readable + not zeroized — consistent with AHW-038).
