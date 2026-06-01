# Phase 3 — residual-gap assessment → upstream doc (conditional)

## Decision: there IS genuine residue → wrote the doc
After re-wiring onto the proper seam (P0/P1) the EARLIER "aztec.js gaps" doc (deleted; it was
mostly wrong-seam complaints — that codex-as-Grego review is what triggered this whole refactor)
no longer applies. What genuinely remains, from building + shipping a real Ledger clear-signing
wallet on the seam, is `docs/aztec-js-upstream.md` — 5 asks, all about discoverability/stability,
NOT new APIs:

1. **Document the clear-signing `EntrypointInterface` seam** (highest value — a competent team, us,
   built on `AuthWitnessProvider` first because it's what's discoverable; the full `ExecutionPayload`
   only arrives at the custom entrypoint).
2. **On-device encoding-stability signal** — a HW wallet re-implements `EncodedAppEntrypointCalls` +
   the domain separators in C (can't import the TS); an encoding change silently bricks it with a
   fail-closed hash-mismatch. A `PAYLOAD_ENCODING_VERSION` / stability guarantee + named separators.
3. **Publish canonical encoding test vectors** (calls+nonce+chainInfo → payloadHash + outer_hash) —
   the single highest-leverage ecosystem artifact; we built our own (l4-manifest-parity.test.ts).
4. **Type + document `feeEntrypointOptions`** (it's `unknown` and flows to `wrapExecutionPayload`;
   we carry deploy-context through it — found only by source reading).
5. **State what the app-entrypoint authwit hash commits to** (calls+txNonce+addr/chain/version, NOT
   fee-mode/cancellable/capsules) — prevents over-claiming clear-signing bugs; we enforce
   EXTERNAL+non-cancellable on deploy precisely because they're outside the signed hash.

## codex-as-Grego review (the gate before ANY send)
codex run `bcdxmgj1w` (xhigh) plays Grego (exacting aztec.js implementor): accuracy of every
claim vs installed 4.2.1, per-ask GENUINE/WEAK/WRONG triage, slop check, + a closing-pass sanity
on the arc. The doc is INTERNAL until that verdict is folded + the owner decides to send (Grego is
"a special guy — don't send slop"). This review doubles as the **closing post-impl review** of the
arc (it has the full repo + the seam files; the P1.5 codex review already did the P1 post-impl pass,
SHIP-with-fixes folded).

## codex-as-Grego verdict (session 019e8460) — SEND-WITH-EDITS, folded
Per-ask triage: 1 GENUINE (seam docs), 2 WEAK→NARROWED (separators are already named in
`@aztec/constants`; the real ask is breakage-signaling/versioning), 3 GENUINE (canonical test
vectors — best ask), 4 WEAK→DEMOTED to a "Minor" note (feeEntrypointOptions typing is an internal
doc note, not a headline; the wrapper is intentionally generic), 5 GENUINE but was INCOMPLETE→FIXED
(the authwit hash also omits authWitnesses/extraHashedArgs/gas/salt, not just fee-mode/cancellable/
capsules). Accuracy fixes folded: the "AuthWitnessProvider only sees the hash" line narrowed to the
`createAuthWit` HOOK (the higher-level account API still takes intents for app authwits); the
"sendTx picks txNonce" line corrected (generated in `createTxExecutionRequestFromPayloadAndFee`;
self-deploy we pin `feeEntrypointOptions.txNonce`); cut the sales lines (thank-you/save-weeks/
−700-LOC/etc.); grounded the testnet claim with real tx hashes (0x2b146ce0/0x1c36fd8d/0x2d5296e2).
Doc is now SEND-READY pending the owner's decision to send.

## CLOSING-PASS finding (real, outside the doc) — FIXED + Grego premise CORRECTED
Grego: `SessionEmbeddedWallet.registerExternalAccount` hard-coded walletDB `type: 'ecdsasecp256k1'`
even for Schnorr; upstream's pre-sim stub dispatches on stored `type`. Bug is REAL — FIXED:
`registerExternalAccount` now takes a scheme-correct `accountType` ('schnorr' for Schnorr); `connect`
passes `scheme === 'schnorr' ? 'schnorr' : 'ecdsasecp256k1'`.

**Verified the installed source (codex-skill rule: verify concrete claims) — Grego's "benign" premise
was WRONG, in our favor:** Grego said "sendTx happens not to simulate first, so you may get away with
it." FALSE. `EmbeddedWallet.sendTx` (embedded_wallet.js:78) UNCONDITIONALLY calls
`simulateViaEntrypoint` before the real send → `buildAccountOverrides` (:132) reads the stored `type`
to choose the stub artifact + args (:138/:146 `type === 'schnorr' ? [Fr.ZERO,Fr.ZERO] : [Buf32,Buf32]`)
and `createStubAccount(addr, type)` (:187). So the stored type is on EVERY tx's hot path. The bug was
benign not because the path wasn't hit, but because BOTH schemes share the standard `entrypoint`
selector, so an ECDSA-K stub gas-simulated a Schnorr account OK *by luck* (constructor selector
mismatch is irrelevant — constructors aren't called when simulating an already-deployed account).

**Why the fix is safe (code-decisive, not assumed):** 'schnorr' is a first-class stub type (case at
:209; ternary at :146). The Schnorr stub is constructed with `[Fr.ZERO, Fr.ZERO]` — it does NOT consume
our placeholder zero `signingKey`. And `simulateViaEntrypoint` is GAS-ESTIMATION + private-authwit
capture only (`skipTxValidation:true`, :82); the real proved/sent tx uses our registered
`BaseAccount(LedgerClearSigningEntrypoint)`, unchanged. So the fix CANNOT change what lands on-chain —
it only swaps the gas-estimation stub to the correct scheme. ECDSA path byte-identical.

Evidence: tsc+biome clean; session test 3/3; full `bun test packages/` re-run (below). The Schnorr
END-TO-END flow is already proven on-chain (0x2d5296e2, 0x171714fd) — those ran WITH the wrong-type
stub and still landed, confirming the sim is gas-only; the fix makes the gas estimate scheme-correct.
A fresh Schnorr testnet+Speculos transfer is the user-runnable final confirmation, not a correctness
gate for a code-verified host-side gas-sim fix (would be gold-plating to block DONE on it AFK).

## Status
- [x] Residue assessed — genuine → doc
- [x] `docs/aztec-js-upstream.md` written + codex-as-Grego SEND-WITH-EDITS folded (send-ready; owner sends)
- [x] Closing-pass Schnorr walletDB-type bug FIXED
- [~] Re-validate Schnorr flow on testnet (the fix touches the Schnorr sim stub path) → then arc DONE
