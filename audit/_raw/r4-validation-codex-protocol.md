# Round 4 — VALIDATION of codex protocol-semantics candidates (skeptic pass)

Validator: opus 4.8. Method: read INSTALLED 4.2.1 source + OUR shipped flows, not codex's prose. Prior context: codex's earlier deploy-replay HIGH (C-PROTO-1) was REFUTED in validation (deploy is init-nullifier-protected) → severity claims scrutinized hard here.

## Adjudication table

| Candidate | Codex sev | Verdict | FINAL sev | Dedup | Note |
|-----------|-----------|---------|-----------|-------|------|
| C4-1 fee-burn / sponsor-drain via unsigned txContext | HIGH | **VALID — mechanism confirmed; severity DOWNGRADED** | **MED** | NEW (narrow), partial-overlap AHW-003/056/049 | Fee knobs are NOT host-injectable on any shipped path — `SubmitOptions` has no fee field; gasSettings built internally (`mul(2.5)`); only `internalDeps.session.sendTx` (already AHW-002) or first-party edits reach them. Remote HIGH not substantiated → defense-in-depth MED. |
| C4-2 deploy waits PROPOSED not CHECKPOINTED | LOW | **VALID — confirmed exactly** | **LOW** | NEW, distinct from AHW-049 | `deployAccountViaEntrypoint` passes `waitForStatus: PROPOSED` (line 416) vs upstream default `CHECKPOINTED`; transfer/drip path inherits CHECKPOINTED (no downgrade). |

## Negatives spot-checked (all SOUND)

| Codex negative | Verdict | Evidence |
|----------------|---------|----------|
| Generic FPC `max_fee` IS signed → host can't EXCEED ceiling | **SOUND (with nuance)** | `private_fee_payment_method.ts:128` puts `maxFee` in `fee_entrypoint_private(maxFee,txNonce)` args → that call is in `app_payload.function_calls` → its `args_hash` is bound into the signed `app_payload.hash()` (account_entrypoint.js:104-105; AccountActions.entrypoint signs `compute_authwit_message_hash(...,app_payload.hash())`). NUANCE: `maxFee = gasSettings.getFeeLimit()`, and gasSettings is host-supplied — "can't exceed" holds vs a 3rd party, NOT vs the tx constructor. Moot for us: we use SponsoredFPC (no maxFee arg at all). |
| No signature-verifier mismatch; ECDSA raw 64B r‖s over sha256(outer_hash), low-s; Schnorr on-curve, rejects zero | **SOUND** | SchnorrAccount `is_valid_impl`: `schnorr::verify_signature(EmbeddedCurvePoint{x,y}, sig[64], outer_hash.to_be_bytes::<32>())`. EcdsaKAccount wraps the stdlib ecdsa_secp256k1 verifier over 64B authwit. Low-s / sha256 specifics are circuit-enforced (consistent with index Confirmed-clean + AHW-049 negatives); NOT independently re-derived from the verifying circuit here, but the account wrapper matches codex's claim. |
| Account verifies the SAME outer_hash the device computes; no entrypoint-broadens-calls path beyond the unsigned fee-mode/cancellable split | **SOUND** | Signed `message_hash` covers `app_payload.hash()` = `poseidon2(function_calls + tx_nonce, DOM_SEP__SIGNATURE_PAYLOAD)` only. `fee_payment_method` + `cancellable` are separate entrypoint params, NOT in the hash. This IS the C4-1 + AHW-003 surface; no broader call-mutation found. |
| Normal tx finality fine (upstream sendTx waits CHECKPOINTED); only manual deploy downgrades to PROPOSED | **SOUND** | `waitForTx` defaults `waitForStatus = TxStatus.CHECKPOINTED` (utils/node.js:30); `transferViaRealSendTx` passes no override → inherits CHECKPOINTED. Only `deployAccountViaEntrypoint` downgrades. |

Capsule/extraHashedArgs negative not re-examined (out of decisive scope; consistent with AHW-003 framing).

---

## VALID-NEW detail

### C4-1 · MED · DESIGN · OURS — Unsigned txContext fee controls (fee-burn / sponsor-drain) — defense-in-depth

**Mechanism (confirmed in installed 4.2.1, both JS and in-circuit):**
- The device-signed outer-hash binds ONLY `app_payload.hash()` = `poseidon2(function_calls + tx_nonce)` + (consumer, chainId, version). Verified in `@aztec/entrypoints/dest/account_entrypoint.js:104-105` (`#buildEntrypointCallData`: `payloadHash = encodedCalls.hash()`, `messageHash = computeOuterAuthWitHash(addr, chainId, version, payloadHash)`) AND in-circuit: SchnorrAccount `AccountActions::entrypoint` signs `compute_authwit_message_hash(this_address, chain_id, version, app_payload.hash())`.
- `gasSettings` (gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas) goes into `TxContext` (account_entrypoint.js:46), NOT the signed hash. CONFIRMED outside the device signature.
- `feePaymentMethodOptions` + `cancellable` are entrypoint ARGS (account_entrypoint.js:97-102), NOT in the signed hash. CONFIRMED unsigned.
- `feePayer` absent → `completeFeeOptions` defaults `accountFeePaymentMethodOptions = PREEXISTING_FEE_JUICE` (base_wallet.js:135-138); `wrapExecutionPayload` defaults `feePayer ?? this.address` (account_entrypoint.js:83). CONFIRMED.
- Billing uses `computeEffectiveGasFees` = base + min(priority, cap) up to `maxFeesPerGas` (transaction_fee.js:6-14). A raised `maxPriorityFeesPerGas` (unsigned) burns more fee-juice. CONFIRMED.
- `SponsoredFPC.sponsor_unconditionally()` takes ZERO args — no `max_fee`, no cap (Noir source in `sponsored_fpc_contract-SponsoredFPC.json`; `SponsoredFeePaymentMethod.getExecutionPayload` args=[], `sponsored_fee_payment.ts:32`). CONFIRMED uncapped. This is the ONLY fee path our shipped verbs use.

**Why MED, not HIGH — the decisive calibration (host vs internal fee control):**
On EVERY shipped clear-signed path the fee knobs are set INTERNALLY, not by the host/dApp:
- `transferViaRealSendTx` (`aztec-ledger-session.ts:614-618`): `gasSettings = GasSettings.fallback({ maxFeesPerGas: node.getCurrentMinFees().mul(2.5) })` → `session.sendTx(exec, { from, fee: { gasSettings } })`. `maxPriorityFeesPerGas` is left to upstream default `GasFees.empty()` (base_wallet.js:149) — i.e. ZERO priority fee. The host cannot raise it.
- `deployAccountViaEntrypoint` (`:397-398, 375-383`): gasSettings built the same way; `feeEntrypointOptions` HARD-CODES `feePaymentMethodOptions: EXTERNAL` + `cancellable: false`.
- The public submission API (`SubmitOptions`, `:139-147`) exposes ONLY `onStep` + `onTxHash`. **There is no fee/gasSettings parameter.** Confirmed at every live call site: `AccountPanel.tsx:107,127` and `TransferPanel.tsx:49-55` pass `{ onStep, onTxHash }` only.
- The only way to inject host-controlled gasSettings/priority-fee/fee-mode is `session.internalDeps.session.sendTx(...)` with a crafted `fee` — but that is the already-cataloged blind-sign bypass **AHW-002** (`internalDeps` exposes `session`), i.e. it requires malicious FIRST-PARTY code, exactly like the AHW-002 surface. It is not reachable by a remote dApp/host through any clear-signed public path.

So the "hostile host invisibly burns fee-juice / drains the sponsor" exploit requires either (a) first-party code change, or (b) routing through AHW-002's bypass — neither is a remote HIGH. The residual real risk is genuine but defense-in-depth: the device reviews a transfer while the (unsigned) fee envelope is whatever the adapter constructed, and nothing clear-signs a fee ceiling or the fee-payer mode. That is worth recording at **MED** (a fail-closed fee-summary/ceiling on the clear-sign path would close it), not as a remote HIGH.

**Dedup — distinct but tightly coupled:**
- **vs AHW-003** (HIGH, "tx path doesn't constrain unsigned fields — authwits/capsules/fee-mode"): AHW-003 already names "fee-mode" among the unconstrained unsigned fields on the TX clear-sign path and prescribes mirroring the deploy guards. C4-1's concrete fee-ACCOUNTING angle (priority-fee burn, teardownGasLimits billing, SponsoredFPC uncapped, feePayer→PREEXISTING_FEE_JUICE default) is the quantitative consequence of the same unsigned-fields root cause. RECOMMENDATION: fold C4-1's fee-accounting specifics into AHW-003 as an enrichment (the fix — clear-sign a fee ceiling + fee-payer mode, reject host fee overrides — is the SAME guard AHW-003 already prescribes). If the orchestrator prefers a standalone catalog entry, promote at MED and cross-link AHW-003. Either way: NOT a new HIGH.
- **vs AHW-056** (LOW, "SPONSOR renders no fee/cap"): AHW-056 is the on-device DISPLAY of the sponsor verb; C4-1 is the protocol fact that there's no signed cap to display. Adjacent, distinct, both LOW/MED.
- **vs AHW-049** (MED, public-tx replay → sponsor re-bill): AHW-049 is replay of an already-signed tx; C4-1 is single-shot unsigned-fee mutation. Distinct.

### C4-2 · LOW · APP · OURS — Manual deploy treats PROPOSED as final

**Confirmed exactly.** `deployAccountViaEntrypoint` (`aztec-ledger-session.ts:415-419`) calls `waitForTx(node, txHash, { waitForStatus: TxStatus.PROPOSED, timeout: 900 })` then `step('done', 'Account deployed …')`. Upstream `waitForTx` defaults `waitForStatus = TxStatus.CHECKPOINTED` (`@aztec/aztec.js/dest/utils/node.js:30`), and `PROPOSED < CHECKPOINTED` in `SortedTxStatuses` (`tx_receipt.ts:25-26`). So a proposer-level inclusion later reorged/dropped is reported as success → false-finality window.

- Not a replay/double-spend (the constructor `#[initializer]` init-nullifier prevents duplicate-deploy; consistent with the refuted C-PROTO-1). Pure premature-finality UX/availability defect → callers may act on an undeployed account or retry (extra sponsor/proving exposure).
- **Distinct from AHW-049** (replay/re-bill of public txs) — different mechanism, different surface. CONFIRMED distinct.
- **Severity LOW is correct:** the transfer/drip path is unaffected (inherits CHECKPOINTED), blast radius is the deploy verb's success label only, no fund loss. Fix dir: wait for CHECKPOINTED, or label PROPOSED as provisional and retain the tx hash until checkpoint/final-failure.

## One-line summary for orchestrator
C4-1: VALID mechanism, **MED not HIGH** — fees are adapter-internal on all shipped paths (no host fee knob in `SubmitOptions`); remote HIGH requires AHW-002's first-party bypass. Best folded into AHW-003. C4-2: VALID, **LOW**, distinct from AHW-049. All 4 spot-checked negatives SOUND.
