# Round 2 — opus — host input-validation robustness + frontend web-security + codegen trust

Angle: host TS parsing/validation, frontend web-sec, codegen/allowlist-poisoning trust.
NOT the sign-what-you-execute trust boundary (R1), NOT firmware memory-safety (R1).
Each finding cites `file:line`, gives concrete impact + fix direction, flags suspected AHW-### overlap.

Net-new candidate count: **9** (R2-01 … R2-09).

---

### R2-01 · HIGH · APP · OURS · DRIP_PUB is allowlisted but has NO on-device decode/render
`ledger-app/src/ui/verified_calls_ui.c:201-258` (`render_call_pairs` switch) + `:134-153` (`format_action`).

`CS_VERB_DRIP_PUB` is in the generated allowlist tables (`selectors.gen.c:13`, `selectors.gen.h:15`) so it passes ALL of `append_call.c`'s gates (registry hit, verb hit, arg-count=2, visibility=public). It then flows into the verified-calls review UI — but:
- `format_action` (`verified_calls_ui.c:138-147`) has no `case CS_VERB_DRIP_PUB` → falls to `default` → label = `"Call"` + symbol `"DRIP"` → renders literally **"Call DRIP"**, not "Drip".
- `render_call_pairs` (`:201-258`) switch handles TRANSFER_*/MINT_*/SPONSOR but **has no DRIP_PUB case** → falls to `default: break` → adds **zero** value pairs. No amount, no token identity, no recipient is shown on-device.

So a verb that the device *accepts and signs* is presented to the user with no decoded detail — the user clear-signs a "Call DRIP" with the amount/token invisible on-screen. This directly violates the project's "clear-sign everything on the allowlist" guarantee. Live impact: the demo's `dripUsdc` (`aztec-ledger-session.ts:490-501`) routes through `transferViaRealSendTx` → `LedgerClearSigningEntrypoint.#clearSignOnDevice` → this exact UI. Severity bounded by the Dripper being a faucet (mints test tokens to caller, sponsored fee), so the *financial* blast radius today is low; but as a clear-signing-integrity defect on a shipped allowlisted verb it is HIGH — an auditor will treat "signs a verb it does not render" as a clear-signing failure.

Fix dir: add a `CS_VERB_DRIP_PUB` case to both `format_action` ("Drip") and `render_call_pairs` (Token + Amount + To), resolving decimals via the **cross-slot** TOKEN lookup (`args[0]` = token address → `cs_registry_lookup` → that slot's `decimals`), exactly as the manifest `_note` (`manifest.json:139`) and preflight (`preflight.ts:128-154`) already describe. Pairs with R2-02 (the false "device-enforced" comments) and R2-08 (no device test).

Overlap: none. Distinct from R1's firmware items (those are memory-safety / side-channel); this is a missing-decoder UI gap on a live verb.

---

### R2-02 · MEDIUM · APP · OURS · DRIP token-slot check claimed "device-side" but absent on device
`packages/adapter-ledger/src/clear_signing_v0/preflight.ts:128-131` + `clear-signing-v0/manifest.json:139`.

preflight.ts:130 comment: *"Mirrors append_call.c's M6.0 check; same SW_REGISTRY_MISS code on the device."* manifest.json:139 `_note`: *"args[0] MUST be a TOKEN-kind slot in registry (enforced device-side in append_call)."* **Neither is true.** `append_call.c` (`ledger-app/src/handler/append_call.c:126-146`) performs registry/verb/arg-count/visibility/transfer-from gates but has **no DRIP-specific arg validation** — nothing constrains `args[0]` (the drip token) to a TOKEN-kind slot, and nothing range-checks the u64 amount. The only place that constraint lives is the **host** preflight (`preflight.ts:132-154`), which the device never trusts. So the device is *less* strict than the host claims, and stale comments assert a non-existent device-side guarantee — exactly the auditor-misleading pattern R1 catalogued for firmware comments (AHW-006/019/020).

Concrete consequence: combined with R2-01, a drip whose `args[0]` is a non-TOKEN registry slot (or whose amount has garbage that `cs_format_amount` would reject) is accepted and signed by the device with no rendering and no token-kind check; only the host preflight (a non-security-authoritative dev-ergonomics layer per its own header) would catch it. Fix dir: either (a) add the DRIP token-kind gate to `append_call.c` so the comment becomes true, or (b) rewrite the comment+`_note` to state the check is HOST-ONLY and document the device-side gap as audit scope. (a) is strongly preferred given R2-01.

Overlap: thematically adjacent to AHW-006/019/020 (stale/misleading firmware comments) but distinct location + distinct claim (asserts a control that doesn't exist, vs understating one that does). Promote as net-new.

---

### R2-03 · MEDIUM · BUILD · OURS · Codegen cross-check covers selector/arity/visibility but NOT registry addresses, decimals, or symbols
`packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:142-217` (`crossCheckVerb`) + `:301-308`/`:397-402` (registry emitters).

The fail-closed cross-check (`crossCheckVerb`) verifies, against the pinned `@defi-wonderland/aztec-standards` + SponsoredFPC artifacts, only the `(selector, wire_arg_count, is_public)` tuple per verb. The **registry** rows — `address`, `symbol`, `decimals`, `kind` — are emitted verbatim from `manifest.json` with **zero verification** against any artifact, deployment, or on-chain source. The manifest itself flags this (`manifest.json:8`: deployments source is "used at codegen-time for human cross-check ONLY; NOT a build dependency"). So the device's clear-signing registry rests entirely on a manually-maintained JSON whose addresses/decimals/symbols are trusted on the maintainer's word and re-emitted into both the device C table (`registry.gen.c`) and the host TS table (`registry.generated.ts`).

Allowlist-poisoning impact: a wrong/poisoned manifest can make the device render a malicious contract as a known-good one. Two concrete vectors:
1. **Wrong `decimals`** (e.g. USDC slot 0 set to 0 instead of 6): `cs_format_amount(c->args[2], reg->decimals, …)` (`verified_calls_ui.c:210`) renders `1000000` as `"1000000.0 USDC"` instead of `"1.0 USDC"` — a 10^6 mis-display the user signs. The selector cross-check passes (decimals isn't checked), so CI is green.
2. **Wrong `address`** pointed at an attacker contract that happens to expose the same selectors: the device renders "Transfer USDC" while the call targets the attacker's token. The selector check only proves the *signature shape* matches the artifact's function; it never proves the *address* is the real USDC instance.

Note `apps/demo-browser/src/deployments.ts:50-102` DOES re-derive + assert the demo instance addresses against pins at runtime (host-side) — but that is the browser app, independent of the device's `registry.gen.c`, and is not part of the codegen cross-check. Fix dir: at codegen, recompute each registry `address` from a pinned `(artifact, salt, ctor-args, deployer)` tuple via `getContractInstanceFromInstantiationParams` (the exact pattern already in `deployments.ts`) and fail-closed on mismatch; assert `decimals` against the token artifact's constructor arg. This closes the gap between "selector verified" and "this is actually USDC at 6 decimals".

Overlap: none. R1 has no codegen/allowlist finding.

---

### R2-04 · MEDIUM · BUILD · OURS · Codegen trusts mutable `node_modules` artifacts at a non-pinned path; not part of frozen-lockfile guarantee
`packages/adapter-ledger/scripts/gen-clear-signing-v0.ts:26-34, 99-111`.

`crossCheckVerb`'s "source of truth" reads the Token/Dripper ABIs straight from `packages/adapter-ledger/node_modules/@defi-wonderland/aztec-standards/target/*.json` (`:28, :33`) via `readFileSync`. The cross-check's integrity therefore depends on whatever is on disk in `node_modules` at codegen time. The manifest pins a version string (`aztec_standards_npm_pin`, `manifest.json:6`) but the generator never asserts the installed package version equals that pin — it just reads the files. The drift-check (`--check`, `:704-743`) compares generated output to committed output, so it would catch a *changed* artifact only if someone re-runs the generator; on a normal CI run `gen:clear-signing-v0:check` (ci.yml:33) regenerates from whatever `node_modules` happens to hold (installed via `bun install --frozen-lockfile`, which does pin the tarball — good — but the generator does not itself verify the version it loaded). A poisoned/locally-patched artifact (or a future lockfile bump that silently changes a selector) is caught by the selector mismatch only if the selector actually changed; a same-selector/different-semantics artifact swap is not.

Fix dir: in the generator, assert the loaded `@defi-wonderland/aztec-standards` `package.json` `version` === `manifest._meta.aztec_standards_npm_pin` before trusting its artifacts; consider hashing the two `target/*.json` files and pinning the digests in the manifest. Mostly defense-in-depth on top of the (good) frozen-lockfile + 7-day min-age posture (`bunfig.toml`), but the cross-check advertises itself as the security authority (manifest.json:2) and should verify its own inputs.

Overlap: none.

---

### R2-05 · LOW · HOST · OURS · `getCaps()` is never called on any live path — capability negotiation is dead
`packages/adapter-ledger/src/provider.ts:51-61`; only callers are tests (`provider.test.ts`).

`getCaps()` decodes the device capability bitmask (K1 / R1 / CLEAR_SIGN / GRUMPKIN, `apdu.ts:66-71`) but grep shows it is invoked **only in tests** — never in `ConnectPanel` (which calls only `getVersion`, `ConnectPanel.tsx:51`), nor in `AztecLedgerSession.connect`, nor before selecting the Schnorr/Grumpkin scheme (`OnboardPanel.tsx`). So the host never verifies the connected device actually advertises CLEAR_SIGN or GRUMPKIN before driving those flows; it relies entirely on the device failing closed on an unsupported INS (which it does — `SWO_INVALID_INS`). Not exploitable (device is the authority), but it's a dead negotiation surface: the host will drive a Schnorr onboarding against a K1-only build and only discover it via an opaque mid-flow SW instead of a clean "device lacks GRUMPKIN capability" up front. Fix dir: call `getCaps()` in `connect()` and assert the required bits for the chosen scheme + clear-signing, or delete `getCaps` if capability negotiation is out of scope for v0.

Overlap: none.

---

### R2-06 · LOW · APP · OURS · Speculos `/events` screen text is rendered verbatim as "the device screen" (display-integrity, dev-only)
`apps/demo-browser/src/panels/SpeculosPanel.tsx:36-48, 122-123` + `speculos-transport.ts:119-126`.

`fetchScreen()` casts the Speculos `/events` JSON (`json.events as { text }[]`) with no shape guard and joins `e.text` into the on-screen "Screen" readout (`SpeculosPanel.tsx:123`). React escapes the string so this is **not XSS**, but the demo presents this text to the user as the authoritative device-screen content, while it is in fact whatever the (untrusted, proxied) Speculos HTTP endpoint returns. In a dev/demo context an attacker controlling the `/speculos` proxy target could paint a benign "Sign Aztec transfer 1 USDC" readout in the browser while the real device shows something else (or vice-versa). Strictly dev-only (Speculos is the emulator; WebHID has no equivalent screen mirror), and the real security boundary is the physical device screen + the on-device review — so LOW. Worth a note that the browser-mirrored "Screen" is advisory, not authoritative, and a shape guard on the JSON (same as the AHW-011 ask for `speculos-transport.ts`). 

Overlap: partial with AHW-011 (untyped Speculos JSON casts) — but AHW-011 is about transport-layer SW/wire casts; this is specifically the UI rendering Speculos-supplied text as trusted device-screen content. Flag for validator; promote the UI/display-integrity angle if not subsumed.

---

### R2-07 · LOW · APP · OURS · Cached-secret re-onboard shows `checksum="cached"`, suppressing the device cross-check value
`apps/demo-browser/src/panels/OnboardPanel.tsx:66-74, 197-205`.

On a fresh reveal the UI shows the real device checksum (`setChecksum(reveal.checksum)`, `:71`) so the user can compare it against the device screen (`OnboardPanel.tsx:199-204`; checksum = `SHA-256("aztec-vk-confirm-v1"‖secret)[0..1]`, matched on device at `get_aztec_master_secret.c:139-155` — the cross-check link is sound). But when the secret is loaded from the in-session cache (`loadCachedSecret`, `:65-67`), the code sets `setChecksum('cached')` and the success panel then renders the literal string `cached` where the verifiable hex checksum would be. So a re-onboard within a session presents a "✓ Viewing keys derived on-device" pill with no re-verifiable checksum — the integrity cross-check silently degrades to a label. Minor (the original reveal already verified it, and the cache is keyed by device pubkey so it can't be another device's secret — `onboarding.ts:69-75`), but it weakens the user's ability to re-confirm provenance. Fix dir: recompute + display `masterSecretChecksum(cachedSecret)` instead of the sentinel `"cached"`.

Overlap: none. (Note: I verified the broader "verified on device" trust display IS honest — transfer/drip review's "From (verified)" is bound to the device-recomputed address via `b3_verify_consumer_is_this_account` pre-UI and pre-sign at `finalize_and_sign.c:231,263`, fail-closed `0x6F12`; and the onboard address derives from the device-revealed secret. So no attestation-spoofing finding — only this checksum-display degradation.)

---

### R2-08 · MEDIUM · TEST · OURS · No device-side review-screen content test for ANY verb (why R2-01 went unnoticed)
`ledger-app/tests/` (python suite) + `apps/demo-browser/e2e/*.e2e.ts`.

The on-device NBGL review content (`render_call_pairs` pairs: action label, From, To, Amount, token) has **zero** assertion coverage. The python device tests cover dispatcher/caps/pubkey/version/sign_outer_hash (`ledger-app/tests/test_*.py`) — none snapshot or assert the verified-calls review pairs. The browser e2e drip/transfer flows (`schnorr-full-flow.e2e.ts:46-75`) only auto-confirm by regex-matching generic prompts (`Sign Aztec|Approve|Hold to sign`) and then assert the *browser* shows no error (`:144`) — they never assert the *device screen* renders the correct amount/token/recipient. This is precisely why the missing DRIP_PUB decode (R2-01) is invisible: nothing checks what the device actually displays. Fix dir: add a Speculos screenshot/pair-content test per verb (TRANSFER_* shows From/To/Amount+symbol; MINT shows WARNING+To+Amount; SPONSOR shows Via; DRIP shows Drip+Token+Amount+To) — a golden NBGL pair-list assertion. Would have caught R2-01 and will catch future decoder regressions.

Overlap: distinct from AHW-024/025/027 (those are negative/fault/fuzz tests for the wire + crypto layers); this is positive review-screen content coverage. Net-new.

---

### R2-09 · LOW · HOST · OURS · `getVersion`/`getCaps` short-response parsers don't reject over-length data
`packages/adapter-ledger/src/provider.ts:45-48, 54-55`.

`getVersion` requires `r.data.length === 3` and `getCaps` requires `=== 4` (strict equality — good). But contrast with the master-secret path the prompt highlighted: `getAztecMasterSecret` (`provider.ts:119-122`) checks `length !== FR_BYTES` then `slice(0, 32)`, and the 64-byte pubkey/sig paths check `!== 64`. These are all fail-closed on exact length — so the documented "64-vs-32 master-secret" path is correctly handled (a 64-byte response is rejected, not silently truncated). I found **no length-validation hole** here; the parsers are uniformly exact-equality and fail closed. Recording as INFO/LOW to document that this surface was audited and is clean, EXCEPT one consistency nit: `decodeApdu` (`speculos-transport.ts:144-152`) and the WebHID slicer (`webhid-transport.ts:100-108`) compute `sw` from the last 2 bytes and pass `data` of *arbitrary* length up to `provider.ts`, which is where the exact-length gate lives — so a hostile transport returning `SW=0x9000` plus wrong-length data is caught at `provider.ts`, not the transport. That layering is fine but means the transport itself trusts the device on length (already noted by AHW-011). No new bug; included so the validator can mark the master-secret length path as VERIFIED-CLEAN rather than leaving it open.

Overlap: AHW-011 (transport casts) covers the transport side; this is a "verified clean, no finding" note on the provider.ts length gates + a pointer that the exact-length authority is correctly in provider.ts. Validator may downgrade to INFO or fold into AHW-011.

---

## Summary for validator
- **Strong net-new**: R2-01 (HIGH, DRIP no on-device decode), R2-03 (MED, codegen doesn't verify registry addresses/decimals), R2-02 (MED, false "device-enforced" DRIP comment), R2-08 (MED, no review-screen content test), R2-04 (MED, codegen trusts unverified node_modules artifact version).
- **Supporting**: R2-05 (dead getCaps), R2-06 (Speculos screen display-integrity, dev-only — check vs AHW-011), R2-07 (cached checksum display).
- **Verified-clean note**: R2-09 (provider.ts length gates are sound; master-secret 64-vs-32 path fails closed).
- **Explicitly NOT findings** (audited, came back clean): React JSX auto-escapes all node/URL/error strings — no XSS sink (`grep` for dangerouslySetInnerHTML/innerHTML/eval = 0 hits); no localStorage/IndexedDB for the secret (sessionStorage only, `secret-cache.ts`, by design); WASM/bb-prover bundled from pinned node_modules, no CDN/dynamic fetch; Speculos image SHA-pinned (`vite.config.ts:46`); supply chain hardened (7-day min-age + committed `bun.lock` + frozen-lockfile CI); the "verified on device" address pill IS device-attested for transfer/drip (b3 consumer-binding) and onboard (device-revealed secret) — no attestation spoof.
