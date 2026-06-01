# Round 4 — codex protocol-semantics (candidates, UNVALIDATED; codex read-only, transcribed)

## C4-1 · HIGH · DESIGN · OURS — Invisible txContext fee controls burn fee-juice / sponsor balance
Refs: `project-call-intent.ts:25-39`, `clear-signing-entrypoint.ts:151-186`, `@aztec/entrypoints/src/account_entrypoint.ts:123-141,159-205`, `@aztec/wallet-sdk/src/base-wallet/base_wallet.ts:224-260`, `@aztec/stdlib/src/fees/transaction_fee.ts:13-40`, `@aztec/stdlib/src/gas/gas_used.ts:5-22`, `@aztec/aztec.js/src/fee/sponsored_fee_payment.ts:22-40`, `SponsoredFPC` artifact.
Claim: device signs only `calls + txNonce + (consumer, chainId, version)`. `txContext.gasSettings` (gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas) are OUTSIDE that signature, and the wallet API lets the host supply them. If `feePayer` absent → upstream silently defaults to `PREEXISTING_FEE_JUICE` (account marks itself fee payer, no signed fee ceiling). `computeEffectiveGasFees` pays base+priority up to host caps → hostile host invisibly burns the user's fee-juice via raised priority fees, or griefs liveness via underprovisioned gas. Same unsigned knobs hit the sponsored path: `SponsoredFPC` has NO signed cap → invisible fee inflation burns sponsor treasury. In generic FPC flows the host CANNOT exceed the signed `max_fee` but can consume MORE of it (billing uses teardownGasLimits, not actual teardown gas).
Fix dir: clear-sign a fee summary/ceiling + the actual fee-payer mode; reject host-supplied maxPriorityFeesPerGas / manual gas overrides in clear-signed flows; derive gas from simulation bound to the reviewed intent; fail closed unless fee mode is the reviewed one.
Overlap: adjacent to AHW-003 / AHW-056 / AHW-049 but codex argues distinct = the concrete fee-accounting exploit path. **VALIDATOR MUST CHECK: does OUR actual flow (transferViaRealSendTx / deployAccountViaEntrypoint) let the HOST set these knobs, or are they internal (fixed multiplier)? That calibrates HIGH vs MED (remote vs first-party-code).**

## C4-2 · LOW · APP · OURS — Manual deploy treats PROPOSED as final
Refs: `aztec-ledger-session.ts:373-418`, `@aztec/aztec.js/src/contract/wait_opts.ts:13-20`, `@aztec/wallet-sdk/src/base-wallet/base_wallet.ts:413-446`.
Claim: manual deploy waits only for `TxStatus.PROPOSED` then reports "Account deployed", while upstream defaults to `CHECKPOINTED`. A proposer-level inclusion later dropped/reorged is surfaced as success → false-finality window; init nullifier prevents duplicate state (not a replay), but callers may act on an undeployed account or retry (extra sponsor/proving exposure). Distinct from AHW-049.
Fix dir: wait for CHECKPOINTED, or surface PROPOSED as provisional + keep the tx hash until checkpoint/final-failure.

## Codex negative results (confirm sound)
- Account contracts DO verify the same `outer_hash(app_payload)` the device computes; no "entrypoint broadens calls after signing" path beyond the known unsigned fee-mode/cancellable split.
- AHW-049 replay residue confined to pure-public flows; private note spends + deploys self-protected by note/init nullifiers; no 2nd private replay/double-spend class.
- No signature-verifier mismatch: ECDSA expects raw 64B r||s, SHA-256 of outer_hash, requires normalized low-s; Schnorr checks on-curve pubkeys + rejects zero scalars / infinity challenges.
- Private/public FPC `max_fee` IS signed into the fee call → host cannot EXCEED the ceiling (only consume within it via unsigned txContext).
- Capsules/extraHashedArgs: PXE transient-capsule shadowing TODO noted, but NO concrete exploit in reviewed flows turning injected capsules into a signed-call semantic change without a hash collision or separate contract bug.
- Normal tx finality fine (upstream sendTx waits CHECKPOINTED; only the manual deploy seam downgrades to PROPOSED).
