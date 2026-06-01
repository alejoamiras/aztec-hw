# R2 validation — host input-validation + frontend web-sec + codegen trust

Validator pass over `r2-opus-host-frontend.md` (R2-01..R2-09). Every cited `file:line`
re-read against the committed tree; absence-claims confirmed by reading the code that
would contain the control. Dedup vs `index.md` (AHW-001..029) and cross-batch vs
`r2-opus-supplychain-ci.md` (NEW-R2-*).

## Adjudication table

| Cand | Verdict | Final Sev/Cat/Owned | Note |
|------|---------|---------------------|------|
| R2-01 | VALID-NEW | HIGH / APP / OURS | DRIP_PUB signed but not decoded/rendered on-device. CONFIRMED decisively. |
| R2-02 | VALID-NEW | MEDIUM / APP / OURS | preflight + manifest comments falsely assert a device-side DRIP token-kind gate that does not exist. CONFIRMED. |
| R2-03 | VALID-NEW | MEDIUM / BUILD / OURS | Codegen cross-check omits registry address/decimals/symbol verification. CONFIRMED. |
| R2-04 | DUP-of-supplychain-NEW-R2-06 | (folds in) | Same root issue: codegen trusts mutable node_modules without asserting the version pin. See canonical framing below. |
| R2-05 | VALID-NEW | LOW / HOST / OURS | `getCaps()` only called in tests; no live capability negotiation. CONFIRMED. |
| R2-06 | PARTIAL-DUP of AHW-011 | LOW / APP / OURS | Distinct display-integrity angle (UI renders Speculos text as authoritative screen); keep, narrowed. |
| R2-07 | VALID-NEW | LOW / APP / OURS | Cached re-onboard renders literal `"cached"` instead of the verifiable checksum hex. CONFIRMED. |
| R2-08 | VALID-NEW | MEDIUM / TEST / OURS | Zero positive review-screen content tests (device or e2e). CONFIRMED; explains R2-01. |
| R2-09 | REJECT (record as VERIFIED-CLEAN/INFO) | INFO / HOST / OURS | provider.ts length gates are exact-equality + fail-closed; no bug. Master-secret 64-vs-32 path rejects, not truncates. |

Counts: **VALID-NEW 6** · **DUP 1** (R2-04) · **PARTIAL-DUP 1** (R2-06) · **REJECT/INFO 1** (R2-09).

---

## VALID-NEW tightened details

### R2-01 · HIGH · APP · OURS — DRIP_PUB is allowlisted + signed but has NO on-device decode/render
**Location:** `ledger-app/src/ui/verified_calls_ui.c` — `format_action` (138-147) and `render_call_pairs` switch (201-258).
**Verified facts:**
- `CS_VERB_DRIP_PUB` = verb 8 in the allowlist (`selectors.gen.c:13`: kind=3/DRIPPER, selector `0xbe46ea53`, is_public=1, wire_arg_count=2; enum `selectors.gen.h:15`). Registry slot 3 (`registry.gen.c:10`) kind=3, symbol bytes `0x44 0x52 0x49 0x50` = "DRIP".
- A DRIP_PUB call passes EVERY `append_call.c` gate (lines 128-146): registry hit (slot 3), verb hit (kind=3+selector), arg-count=2, visibility=public. The `from==consumer` gate (142-145) only fires for 4-arg transfers (`verb_is_4arg_transfer`, 71-81) so it is skipped for DRIP. Device accepts and proceeds to sign.
- `format_action` (138-147) has cases for TRANSFER_*/MINT_*/SPONSOR only; no `CS_VERB_DRIP_PUB` → `default: break` → base="Call" → renders **"Call DRIP"** (symbol appended at 148-152), not "Drip".
- `render_call_pairs` (201-258) switches TRANSFER_*/MINT_*/SPONSOR; no DRIP_PUB case → `default: break` (256-257) → **zero** value pairs. No token, no amount, no recipient on-device.
- Live path CONFIRMED: `aztec-ledger-session.ts:490-501` `dripUsdc` builds `Dripper.drip_to_public(USDC, amount)` and routes through `transferViaRealSendTx` → real sendTx + entrypoint → FINALIZE_AND_SIGN → `ui_display_verified_calls` → this exact render path.
**Impact:** the device signs a verb it does not decode — direct violation of "clear-sign everything on the allowlist." Financial blast radius is bounded (Dripper is a sponsored faucet that mints test tokens to the caller), but a shipped allowlisted verb that renders no amount/token/recipient is a clear-signing-integrity defect an external auditor will read as "signs without showing" → HIGH (not downgraded to faucet-only LOW: the defect is the missing decoder on a live signed verb, not the dollar value).
**Fix dir:** add a `CS_VERB_DRIP_PUB` case to both `format_action` ("Drip") and `render_call_pairs` (Token + Amount + To), resolving display decimals via the cross-slot TOKEN lookup (`args[0]` token address → `cs_registry_lookup` → that slot's `decimals`), as `manifest.json:139` and `preflight.ts:128-154` already describe. Add the device test from R2-08. Pairs with R2-02.
**Dedup:** no AHW overlap (grep-confirmed: index has no DRIP-render finding; AHW-001's "drip" mention is incidental; AHW-027 is `cs_format_amount` fuzz, a different routine).

### R2-02 · MEDIUM · APP · OURS — DRIP token-slot check claimed "device-side" but absent on device
**Location:** `packages/adapter-ledger/src/clear_signing_v0/preflight.ts:129` + `packages/adapter-ledger/clear-signing-v0/manifest.json:139`.
**Verified facts:**
- preflight.ts:129 comment: *"Mirrors append_call.c's M6.0 check; same SW_REGISTRY_MISS code on the device."* manifest.json:139 `_note`: *"args[0] MUST be a TOKEN-kind slot in registry (enforced device-side in append_call)."* Both quoted verbatim — claims CONFIRMED present.
- `append_call.c:126-146` gates: registry hit, verb hit, arg-count, visibility, and `from==consumer` for 4-arg transfers ONLY. There is **no** DRIP-specific arg validation — nothing constrains DRIP `args[0]` to a TOKEN-kind slot, nothing range-checks the u64 amount. Absence CONFIRMED.
- The token-kind constraint lives ONLY in the host preflight (`preflight.ts:132-154`, which the file header at 1-9 explicitly calls non-authoritative). Device never trusts it.
**Impact:** dangerous direction — the comments assert MORE security than exists (distinct from R1's AHW-019/020 which UNDERSTATE existing hardening). Combined with R2-01, a DRIP whose `args[0]` is a non-TOKEN registry slot is accepted + signed with no rendering and no token-kind gate; only the non-authoritative host preflight would catch it.
**Fix dir:** preferred (a) add the DRIP token-kind gate to `append_call.c` so the comment becomes true (also satisfies R2-01's decimals cross-slot lookup); or (b) rewrite the comment + `_note` to state the check is HOST-ONLY and log the device-side gap as audit scope.
**Dedup:** thematically adjacent to AHW-006/019/020 (stale firmware comments) but distinct location (host TS + manifest, not firmware C) and distinct claim-direction (asserts a non-existent control). Net-new.

### R2-03 · MEDIUM · BUILD · OURS — Codegen cross-check covers selector/arity/visibility but NOT registry address/decimals/symbol
**Location:** `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts` — `crossCheckVerb` (142-217) + registry emitters (`emitRegistryC` 256-328, `emitRegistryTs` 397-427).
**Verified facts:**
- `crossCheckVerb` verifies only `(selector, visibility, wire_arg_count)` per verb against the pinned Token/Dripper/SponsoredFPC artifacts (selector 145-163, visibility 165-186, arg-count 188-216).
- Registry rows (`address`/`symbol`/`decimals`/`kind`) are emitted verbatim from `manifest.json` with NO artifact/deployment/on-chain verification. CONFIRMED — the emitters interpolate `e.address`/`e.symbol`/`e.decimals` directly.
- Contrast `crossCheckDeployProfile` (478-531) DOES recompute `account_class_id` (via `computeContractClassId`) and `ctor_selector_u32` and fail closed — so deploy profiles are verified, registry rows are not. The asymmetry is real.
- Supporting contrast CONFIRMED: `apps/demo-browser/src/deployments.ts:12-59` already re-derives USDC/Dripper/SponsoredFPC instance addresses via `getContractInstanceFromInstantiationParams` and `throw`s on pin mismatch — the exact pattern R2-03's fix proposes, but it lives in the browser app (host) and is independent of the device's `registry.gen.c`.
**Impact:** allowlist-poisoning. Two vectors: (1) wrong `decimals` (e.g. USDC=0 not 6) → `cs_format_amount(args[2], reg->decimals,…)` (`verified_calls_ui.c:210`) mis-displays the amount by 10^6 with a green selector cross-check; (2) wrong `address` → device renders "Transfer USDC" while targeting an attacker contract exposing the same selectors. The cross-check proves signature shape, never address identity or decimals.
**Fix dir:** at codegen, recompute each registry `address` from a pinned `(artifact, salt, ctor-args, deployer)` tuple (reuse the `deployments.ts` pattern) and fail closed on mismatch; assert `decimals` against the token artifact's ctor arg.
**Dedup:** distinct from R2-04 (see canonical framing). No AHW overlap (R1 has no codegen finding).

### R2-05 · LOW · HOST · OURS — `getCaps()` is dead; capability negotiation never happens
**Location:** `packages/adapter-ledger/src/provider.ts:51-61`.
**Verified facts:** grep across all non-node_modules `.ts`/`.tsx`: `getCaps` appears only at `provider.ts:51` (def) and `provider.test.ts:64` (test). `ConnectPanel.tsx:51` calls only `getVersion`; no `getCaps` in `AztecLedgerSession` or `OnboardPanel`. CONFIRMED dead.
**Impact:** host never verifies the device advertises CLEAR_SIGN/GRUMPKIN before driving those flows; relies on the device failing closed on an unsupported INS (`SWO_INVALID_INS`). Not exploitable (device is authority) — a dead negotiation surface that surfaces capability mismatches as opaque mid-flow SWs instead of a clean up-front error. LOW is correct.
**Fix dir:** call `getCaps()` in `connect()` and assert the required bits for the chosen scheme + clear-signing, or delete `getCaps` if negotiation is out of v0 scope.
**Dedup:** none.

### R2-07 · LOW · APP · OURS — Cached re-onboard shows `checksum="cached"`, suppressing the device cross-check value
**Location:** `apps/demo-browser/src/panels/OnboardPanel.tsx:66-74`.
**Verified facts:** fresh reveal sets `setChecksum(reveal.checksum)` (71); cached path sets `setChecksum('cached')` (67). The success panel renders that value where the verifiable hex checksum belongs. CONFIRMED.
**Impact:** a re-onboard within a session shows a "viewing keys derived on-device" confirmation with the literal string "cached" instead of a re-verifiable checksum — the integrity cross-check degrades to a label. Minor (the original reveal already verified it; the cache is keyed by device pubkey so it cannot be another device's secret) → LOW.
**Fix dir:** recompute + display `masterSecretChecksum(cachedSecret)` instead of the sentinel.
**Dedup:** none. (Distinct from AHW-022, which is a device-side reveal-dismiss wording bug.)

### R2-08 · MEDIUM · TEST · OURS — No device-side review-screen content test for ANY verb
**Location:** `ledger-app/tests/` (python) + `apps/demo-browser/e2e/*.e2e.ts`.
**Verified facts:**
- Python suite = `test_dispatcher/get_caps/get_public_key/get_version/sign_outer_hash.py`. None assert the verified-calls review pairs (`render_call_pairs` content). Only `test_sign_outer_hash.py` references screenshots, and that is the blind outer_hash path, not the verified-calls pair list.
- e2e flows (`smoke.e2e.ts:61`, `schnorr-full-flow.e2e.ts:70`) auto-confirm by regex-matching generic prompts (`/Sign Aztec|Approve|Hold to sign/i`) and walk past screens; they never assert the device renders the correct amount/token/recipient pairs. CONFIRMED zero positive coverage.
**Impact:** the on-device NBGL review content has no assertion coverage — exactly why the missing DRIP decode (R2-01) is invisible. MEDIUM (a missing test class on the security-critical render path, not a live exploit).
**Fix dir:** add a Speculos golden NBGL pair-list assertion per verb (TRANSFER_* → From/To/Amount+symbol; MINT → WARNING+To+Amount; SPONSOR → Via; DRIP → Drip+Token+Amount+To). Would have caught R2-01 and guards future decoder regressions.
**Dedup:** distinct from AHW-024 (malformed-frame-mid-stream), AHW-025 (glitch-sim), AHW-027 (`cs_format_amount` fuzz) — those are negative/fault/fuzz on wire + crypto layers; this is positive review-screen content. Net-new.

---

## PARTIAL-DUP

### R2-06 · LOW · APP · OURS — Speculos `/events` text rendered as authoritative "device screen" (display-integrity, dev-only)
**Verdict:** PARTIAL-DUP of AHW-011 — KEEP, narrowed.
**Location:** `apps/demo-browser/src/panels/SpeculosPanel.tsx:40` (cast) + `:123` (render). (Finding's line cites were ~36-48/122-123; actual cast is at :40 in the committed file — close enough, claim holds.)
**Verified facts:** `fetchScreen` casts `(await res.json()) as { events: ScreenEvent[] }` with no shape guard (40) and joins `e.text` into the on-screen "Screen" readout, rendered via JSX `{screen}` at 123 (React-escaped → NOT XSS, confirmed). Separately, `speculos-transport.ts:124` (`getEvents`) has its OWN cast `as { events: { text: string }[] }` — that transport cast is what AHW-011 already covers.
**Why keep:** AHW-011 is scoped to transport-layer SW/wire casts in `speculos-transport.ts`/`webhid-transport.ts`. R2-06 is a distinct concern in a different file: the UI presents proxied Speculos text to the user as the authoritative device-screen content, when a compromised `/speculos` proxy target could paint a benign readout while the real device shows otherwise. Dev-only (Speculos is the emulator; WebHID has no screen mirror) and the physical device screen is the real boundary → LOW.
**Recommendation:** fold the *transport cast* half into AHW-011; promote ONLY the display-integrity note (the browser-mirrored "Screen" is advisory, not authoritative) as the net-new slice. If the orchestrator prefers a single entry, append it as a sub-point to AHW-011 rather than a standalone ID.

---

## REJECT / VERIFIED-CLEAN

### R2-09 · INFO · HOST · OURS — provider.ts short-response length gates are sound (no bug)
**Verdict:** REJECT as a finding; record as VERIFIED-CLEAN/INFO (or fold the pointer into AHW-011).
**Verified facts:** `getVersion` requires `=== 3` (45), `getCaps` requires `=== 4` (54), pubkey/sig paths require `=== 64` (68/87/162/207/228), and `getAztecMasterSecret` checks `!== FR_BYTES` then `slice(0,32)` (119-122). All exact-equality, all fail-closed. A 64-byte master-secret response is REJECTED (`!== FR_BYTES`), NOT silently truncated — the "64-vs-32" path the prompt flagged is correctly handled. The transport decoders (`speculos-transport.ts:144-152`, webhid slicer) compute SW from the last 2 bytes and pass arbitrary-length `data` upward; the exact-length authority correctly lives in `provider.ts`. That layering is fine; the transport-trusts-length note is already AHW-011.
**Recommendation:** no new finding. Optionally annotate AHW-011 with "provider.ts length gates VERIFIED-CLEAN (exact-equality, fail-closed); master-secret 64-vs-32 path rejects not truncates."

---

## Codegen overlap — canonical framing (R2-03 / R2-04 / supplychain NEW-R2-06)

Three candidates touch the codegen trust model. They are NOT one issue — there are exactly **two distinct root problems**, and R2-04 collapses into the supply-chain batch:

1. **WHAT is verified (semantic-coverage gap).** R2-03 is genuinely distinct: even with a perfectly-pinned, untampered artifact, the cross-check simply *does not look at* registry `address`/`decimals`/`symbol`. Promote R2-03 as the canonical "codegen verifies verb shape but not registry identity/decimals" finding (MEDIUM/BUILD).

2. **WHETHER the verified inputs are trustworthy (input-provenance gap).** R2-04 (this batch) and NEW-R2-06 (supply-chain batch) are the **same** root issue, described twice: the generator reads artifacts from mutable `node_modules/@defi-wonderland/aztec-standards/target/*.json` and never asserts the installed package version === `manifest._meta.aztec_standards_npm_pin` (nor a content hash). Same file, same lines (26-34), same fix (assert version + pin SHA-256). **Promote ONE: keep supply-chain NEW-R2-06 as canonical** (it is the more complete write-up — it also reasons about `bun.lock` re-point protection and the "pins are comments not enforcement" angle) and mark this batch's **R2-04 as DUP-of-NEW-R2-06**. Do not promote both.

Net for the index from the codegen cluster: **two** findings — R2-03 (coverage gap) + NEW-R2-06 (provenance gap). They are complementary, not redundant: R2-06's fix (assert the version pin) does NOT close R2-03 (a correctly-pinned artifact still never verifies the registry addresses/decimals), and R2-03's fix (recompute addresses) does NOT close R2-06 (it would still read a same-selector/different-semantics artifact for the verb checks).
