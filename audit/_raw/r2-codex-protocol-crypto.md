# Round 2 — codex protocol / cryptography adversarial review (candidates, UNVALIDATED)

Codex ran read-only (could not write here directly); transcribed by orchestrator from the response.
Codex checked ECDSA low-s, Schnorr output shape, and device/host domain-separator parity and found
NO substantiated net-new malleability/separator issue. 3 net-new candidates:

## C-PROTO-1 · HIGH · DESIGN · OURS — Replayable deploy sponsor authwit drains SponsoredFPC
Possible overlap: tangential to AHW-003 (distinct: post-approval REPLAY of a valid deploy witness, not an unsigned-field mutation).
Files: `aztec-ledger-session.ts:372-390`; `clear-signing-entrypoint.ts:204-240`; `@aztec/entrypoints/src/account_entrypoint.ts:128-141`; `@aztec/entrypoints/src/encoding.ts:52-57,74-84`; `@aztec/entrypoints/src/default_entrypoint.ts:10-41`; `SponsoredFPC` artifact.
Claim: self-deploy signs `computeOuterAuthWitHash(account,chainId,version,encodedCalls.hash())` and requires `cancellable=false`. In Aztec's account entrypoint, `tx_nonce` is consumed into a nullifier ONLY when `cancellable=true`; otherwise it is just signed data. `SponsoredFPC` is unconditional. So a hostile host can retain the deploy-time authwit, wait until the account exists, and later resubmit the same private call to the account `entrypoint` via `DefaultEntrypoint` — the witness still verifies, the sponsor pays again, no new device approval. Sponsor-fund griefing/drain (not user funds).
Fix dir: make sponsor authorization one-shot (sponsor-side nullifier keyed by (account,txNonce)/deployment hash; bind to a one-time deployment state transition; or stop using an unconditional replayable SponsoredFPC for onboarding).

## C-PROTO-2 · HIGH · DESIGN · OURS — "Reveal viewing key" exports a path-wide privacy ROOT across chains + schemes
Possible overlap: none seen (distinct from AHW-016 rate-limit + AHW-022 reveal-UI-wording).
Files: `ledger-app/src/l4/aztec_secret.c:15-18,28-61`; `onboarding.ts:9-16,59-75`; `aztec-ledger-session.ts:238-250`; `@aztec/stdlib/src/keys/derivation.ts:29-44,95-123`; `account-contract.ts:33-45`; `schnorr-account-contract.ts:39-49`; `master_secret_reveal_ui.c:79-85`; `OnboardPanel.tsx:188-193`.
Claim: revealed secret = `SHA-512("aztec-master-secret-v1\0" || secp256k1 child privkey) mod Fr`, scoped only by BIP-32 path. Upstream expands that one Fr into ALL privacy master keys (NHK_M, IVSK_M, OVSK_M, TSK_M), not a minimal note-reading capability. Address derivation excludes chainId; both ECDSA and Schnorr account paths consume the SAME revealed secret. UI markets it as "Account #N viewing keys / lets this computer see your notes." Reality: one approval gives the host material to derive+monitor the user's Aztec privacy state for that Ledger path across chains AND both schemes, and correlate them as one identity.
Fix dir: stronger domain separation of exported viewing material by purpose (and if protocol-compatible, by scheme/chain); OR fix the reveal UX to state it exports the Aztec privacy ROOT for that path and may expose activity across networks/schemes.

## C-PROTO-3 · MEDIUM · HOST · OURS — Revealed privacy root persisted in sessionStorage
Possible overlap: distinct from AHW-038 (forget-zeroize) and AHW-045 (cached-checksum display).
Files: `secret-cache.ts:8-15,38-65`; `OnboardPanel.tsx:63-74`; `onboarding.ts:59-75`.
Claim: after one approved reveal, the full Aztec master secret is in JS memory AND `sessionStorage`, surviving reloads within the tab. Any later same-origin XSS / injected script / extension with storage access exfiltrates the privacy root with NO new Ledger prompt. Cache key is only device-path scoped, so switching ECDSA↔Schnorr at the same path silently reuses the secret with no second approval.
Fix dir: don't persist the root in sessionStorage; memory-only, shortest lifetime, or re-reveal after reload; if persisted, explicit opt-in + warning.
