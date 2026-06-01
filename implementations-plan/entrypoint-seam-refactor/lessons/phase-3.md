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

## Status
- [x] Residue assessed — genuine → doc (not just internal notes)
- [x] `docs/aztec-js-upstream.md` written (dense, cited, no full local paths; constructive, not complaint)
- [~] codex-as-Grego review (bcdxmgj1w) → fold edits / cut WEAK asks → then it's send-ready (owner sends)
- [ ] Fold + finalize → arc DONE (all tags safe-v20..v23 pushed signed; gates green w/ documented
  exceptions; plan/index/lessons updated; closing review folded)
