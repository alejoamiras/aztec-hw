<!-- codex K7 consumer-API-misuse, read-only xhigh -->

### F-K7-1: Root-exported `LedgerProvider.signOuterHash` is a blind-sign oracle
Severity: HIGH — the public package root exposes a raw hash-sign primitive that sits completely outside `LedgerClearSigningEntrypoint`; the only guard is the device blind-signing toggle.

Owned: OURS

Category: WIRE

Location: [index.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/index.ts:54), [provider.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/provider.ts:214)

What: `@aztec-hwwallet-poc/adapter-ledger` barrel-exports `LedgerProvider`, and that class publicly exposes `signOuterHash(bip32Path, outerHash, ...)`. It accepts caller-chosen 32-byte input and sends `INS.SIGN_OUTER_HASH` directly.

Attack-impact: A hostile downstream consumer can obtain signatures over arbitrary unreviewed hashes whenever blind-signing is enabled, bypassing the clear-sign call-manifest flow entirely.

Evidence: `export { LedgerProvider ... }`; `async signOuterHash(`; `this.transport.send({ ins: INS.SIGN_OUTER_HASH, data: body }, ...)`.

Fix-sketch: Remove the raw signer from the root barrel, or move it behind an explicitly unsafe subpath/name such as `unsafeSignOuterHash` that safe consumers do not import by default.

Confidence: high

Dedup-check: Distinct from AHW-002. AHW-002 was the old `internalDeps` bypass; this is the direct published root export of the raw signer after that rewrite.

### F-K7-2: Root barrel exports the privacy-root reveal and no-prompt reread surface
Severity: HIGH — the public API exports both the approval-gated reveal and a silent in-process reread path for the same secret.

Owned: OURS

Category: DESIGN

Location: [index.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/index.ts:53), [index.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/index.ts:61), [onboarding.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/onboarding.ts:42), [onboarding.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/onboarding.ts:77), [secret-cache.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/secret-cache.ts:32), [secret-cache.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/secret-cache.ts:37)

What: The root export set includes `revealMasterSecret`, `deviceCacheKey`, `cacheSecret`, and `loadCachedSecret`. Once any component has revealed and cached the master secret, any other consumer in the same app can derive the key from approval-free `getPublicKey` and pull the `Fr` back out of the module-global map.

Attack-impact: A hostile downstream consumer can exfiltrate the path-wide privacy root during the same page lifetime without a second device approval.

Evidence: `export { deviceCacheKey ... revealMasterSecret }`; `export { cacheSecret ... loadCachedSecret }`; `return hex ? Fr.fromBuffer(Buffer.from(hex, 'hex')) : undefined`; `const pk = await new LedgerProvider(transport).getPublicKey(...)`.

Fix-sketch: Keep cache access internal to the onboarding/session layer; export only opaque handles or a presence check. If the reveal seam must stay public, move it off the default barrel into an explicit onboarding/unsafe module.

Confidence: high

Dedup-check: Distinct from AHW-047, AHW-048, and AHW-079. Those cover what the reveal discloses, storage lifetime, and the pubkey pseudonym; this is the published API composition that makes the revealed root rereadable by any downstream consumer.

### F-K7-3: Public account/entrypoint override seams let consumers route framework flows around the safe entrypoint
Severity: MED — this is not an independent signer because `createAuthWit()` fail-closes, but it is still a published policy-escape seam and becomes a full bypass when combined with F-K7-1.

Owned: OURS

Category: DESIGN

Location: [account-contract.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/account-contract.ts:24), [ledger-account-contract-base.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/ledger-account-contract-base.ts:32), [ledger-account-contract-base.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/ledger-account-contract-base.ts:39), [session-embedded-wallet.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/session-embedded-wallet.ts:81)

What: Exported contract/session classes expose `setEntrypointOverride(...)` and `overrideAccount(...)` as public mutations. `getAccount()` then wraps whatever override is installed in `BaseAccount` with no branding or allowlist.

Attack-impact: A hostile consumer can replace `LedgerClearSigningEntrypoint` with caller-controlled logic for normal `sendTx`/deploy flows; paired with the root-exported raw signer in F-K7-1, that becomes a complete clear-sign bypass inside the supported account abstraction.

Evidence: `setEntrypointOverride(entrypoint: EntrypointInterface | null)`; `return new BaseAccount(this.#entrypointOverride, ...)`; `overrideAccount(address: AztecAddress, account: Account): void`.

Fix-sketch: Make these seams internal/test-only, or restrict them to an internal branded entrypoint type rather than arbitrary `EntrypointInterface`/`Account`.

Confidence: med

Dedup-check: Related to AHW-088 but not the same. AHW-088 was the session’s shared-wallet mutation bug; this is the downstream-consumer API surface that still exposes override hooks at the published boundary.

**Confirmed clean**
- AHW-002 stays closed: `AztecLedgerSession.internalDeps` now strips `secret`, `session`, and `ledgerProvider` ([aztec-ledger-session.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/aztec-ledger-session.ts:441)).
- The supported provider path is fail-closed: `LedgerEcdsaKAuthWitnessProvider.createAuthWit()` throws instead of blind-signing ([auth-witness-provider.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/auth-witness-provider.ts:91)).
- The safe clear-sign path still enforces unsigned-field invariants at the public seam: extra `authWitnesses`, `capsules`, `extraHashedArgs`, wrong fee mode, and wrong `cancellable` values are rejected in `LedgerClearSigningEntrypoint` ([clear-signing-entrypoint.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/clear-signing-entrypoint.ts:103), [clear-signing-entrypoint.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/clear-signing-entrypoint.ts:275)).
- `packages/core` is clean for this angle: its root export is data/types/byte helpers only, with no session, raw signer, or secret-cache surface ([packages/core/src/index.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/core/src/index.ts:10), [ecdsa.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/core/src/ecdsa.ts:34), [intent.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/core/src/intent.ts:20)).