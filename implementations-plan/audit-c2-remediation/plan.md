# audit-c2-remediation — CONSOLIDATED PLAN (Tier A)

Remediation of the C2 catalog HIGH+MED findings. Scope: `scope.md` (owner-agreed). Triangulated from three independent plans — `plan-main.md` (orchestrator), `plan-opus.md`, `plan-codex.md` (codex session 019e8d54). This file is the authoritative plan; the three drafts hold full per-file detail.

**Branch:** `audit-c2-remediation` off `main`. **Quality bar:** pre-external-audit. **Validation:** docker `ledger-app-builder-lite` firmware build + `ghcr.io/ledgerhq/speculos` on a CLEAN port (NOT the orphaned :5001); `bun test`; signed commits; PR for owner review (no merge without approval).

## Two refinements the audits insisted on (deviations from `scope.md`, adopted with reasoning)
1. **W4 mechanism — NOT a `MANIFEST_VERSION` bump.** Both codex and opus independently rejected reusing `L4_MANIFEST_VERSION` for the new address INS. Adopt instead: **a new `GET_AZTEC_ADDRESS` INS + a new `GET_CAPS` capability bit (`CAPS_ATTEST_ADDRESS`) + an app-version bump**; the host **hard-fails if the capability is absent**, with **no fallback** to host-derived address. Reason: an explicit capability contract is a cleaner hard-cut than overloading the wire-manifest version (which is about call-encoding, not feature negotiation), and it makes "device attestation present?" a first-class, testable gate.
2. **W1 — sign FROM the snapshot, not after a compare.** `scope.md`'s phrasing ("compare live `G_context` … reject on mismatch") is necessary but not sufficient. The signature/render input MUST be the immutable snapshot; the compare-back is only a secondary fault-detector. (Opus's #1 correction; codex concurs.)

## Codex final review (session 019e8d62) — GO-WITH-EDITS (folded)
The required final pass returned **GO-WITH-EDITS**; all six edits are folded into the phases below:
- **[BLOCKING] W2 hidden `deployer`** → P3 fail-closes `deployer`, derives it from the single sponsor slot, removes `sponsoredFpcAddress` as a runtime trust input.
- **[BLOCKING] P5 must reuse W1's snapshot** → P5 snapshots the address-INS inputs+derived address out-of-band and returns from the snapshot (else a fresh AHW-095-class sink).
- **[BLOCKING] W4 suppression-path tests** → P5/P7 add: `alreadyDeployed=true` still attests; missing `CAPS_ATTEST_ADDRESS` fails closed (no fallback); wrong `(curve/profile/path/salt)` rejects pre-session.
- **[MED] P0 scoped** to deploy/reveal/address-review walkers only.
- **[MED] W4 ordering** → caps + address-attest BEFORE the privacy-root reveal.
- **[MED] W2 single-slot** → collapse the duplicated manifest sponsor literals to one config slot.
Codex confirmed sound: W4 capability-bit (not `MANIFEST_VERSION`); W1 sign-from-snapshot + the firmware-native reject harness; W3 root-surface lockdown; W7's exact-SW reject + low-S/`secp.verify` as real proofs.

## Phase plan

### P0 — branch + de-brittle the test harness
Branch off `main`. Bring up Speculos on a clean port. **Pre-req migration (codex):** move the brittle fixed-count auto-approvers (`provider.m8.test.ts` and peers that press a hard-coded number of times) to **marker-based screen-walking** — W2/W4 add review lines and will shift page counts; do this BEFORE adding lines or the suite goes red for the wrong reason. **SCOPED (codex-final MED):** target ONLY the deploy/reveal/address-review walkers (`provider.m8.test.ts:71`, `provider.test.ts:31`), not a blanket migration.

### P1 — W1 immutable reviewed snapshot  (AHW-095 HIGH + AHW-099 MED + fold AHW-112 LOW)  [firmware]
- **Shared module** `ui/review_snapshot.{h,c}` owning: `epoch arm/invalidate`, canonical-path copy/compare, 32-byte compare. Storage is **out-of-band** — its own static, NOT inside `G_context` / the `pk_info`/`sign_info` union (`types.h:80-83`) and NOT in `G_l4_deploy_session`; the whole point is to stop depending on the union after review.
- Blind-sign (`sign_ui.c`, `sign_outer_hash.c`): at review-draw, snapshot `(canonical path, path_len, outer_hash, epoch)`; the approval callback **signs the snapshot** and compares live `G_context` back to it, rejecting on mismatch (`SW_HASH_MISMATCH` or a dedicated SW). Deploy review (`deploy_review_ui.c`, `finalize_deploy_and_sign.c`): snapshot `(#N, address_local, epoch)`, render from snapshot (AHW-099).
- **Request-epoch:** any new APDU (incl. `ABORT`, dispatched in `dispatcher.c`/`abort_authwit.c`) invalidates the armed epoch → a mid-review interleave can't approve a stale snapshot.
- **Fold AHW-112 (reveal `#N`):** same display-skew class; ~10 LOC once the helper exists — snapshot the reveal account index too. (Both auditors recommend; in if cheap, else documented.)
- **Test:** happy path in Speculos; the **reject-on-mismatch branch needs a small firmware-native harness** (mutate live state between review-draw and approval — Speculos can't honestly inject a mid-review RAM fault); plus an APDU-interleave test (ABORT/pubkey mid-review → original request returns the reject SW).

### P2 — W5 Schnorr key-residue scrub  (AHW-100 MED)  [firmware]
- Add **helper-level wipe primitives** for `gk_fq_t` (`fq.h`/`fq.c`) and use them everywhere secret-derived field elements / stack byte buffers persist across exits. `schnorr.c`: scrub `pe`, `s_fq`, `e_fq`, `priv_fq`, `k_fq` + derived byte arrays on every path. `fq.c`: wipe `acc/c256/term/tmp/normal` inside the conversion helpers so callers can't forget. `aztec_secret.c`: keep caller scrubs over the now-clean helper layer.
- **Test:** Schnorr parity + deploy/authwit happy paths stay green (value-preserving); confirm `-Oz` doesn't elide the wipes (inspect `app.asm`, as AHW-068 did for cmov). Residue isn't black-box observable — honest validation = source review + parity.

### P3 — W2 deploy fee-target render + single-source  (AHW-096 MED)  [firmware + codegen]
- **Single source = ONE sponsor slot in `manifest.json`** — it currently DUPLICATES the sponsor address (`:28` and `:152`); collapse to one config slot (codex-final MED), don't just compare duplicated literals. Codegen (`gen-clear-signing-v0.ts`) recomputes `sponsor_selector_u32` from `sponsor_unconditionally()` and **derives `sponsor_fpc_address` AND `deployer` from that one slot** — **`deployer` is fail-closed too** (`== ZERO` for these profiles, or manifest-derived; **codex-final BLOCKING** — the merged AHW-096 covered the hidden `deployer`, not only the sponsor). Emit ONE host helper; **remove `sponsoredFpcAddress` as a runtime trust input** in session construction — `AztecLedgerSession` derives the sponsor from the generated single source (no runtime dep, no compare-a-supplied-address path).
- Render the sponsor **FPC address (8+6) + selector hex** on the deploy review (`deploy_review_ui.c`) instead of bare "Sponsored (testnet)".
- **Scope boundary:** the *codegen-side* assert is in W2; gating the firmware **build job** on gen-drift is the **deferred CI** part (AHW-102). Residual (poisoned checked-in `.gen.c`) is therefore documented, not closed here.
- **Test:** deploy-review content test (modeled on `verified-calls-content.test.ts`) — drive to Reject, assert sponsor `8+6` + selector present; codegen test asserts gen sponsor == manifest single-source.

### P4 — W3 host public-API lockdown  (AHW-097 HIGH + AHW-103 MED)  [host]  ← precedes/with P5
- Split package exports: root **drops `signOuterHash`** (and the raw provider surface) → relocate behind an explicit **`./unsafe`** subpath; update `package.json` `exports`. Remove cache-reread helpers (`loadCachedSecret`) from the root barrel; onboarding/session keep cache access internal and expose only `hasCachedSecret` / an opaque handle.
- **Test:** API-shape test asserting the root barrel no longer exports `signOuterHash`/`loadCachedSecret`; clear-sign entrypoint still works; `./unsafe` still reaches the raw path if retained.
- **Sequencing:** W4's host fail-closed assert lives in `aztec-ledger-session.ts`, so this lockdown is a soundness precondition for P5 (opus + codex).
- AHW-104 (override seams) DROPPED — verify it's defanged once the raw signer is gone (an override entrypoint can now only drive clear-sign) and document that reasoning for the auditor.

### P5 — W4 device-attested receive address: `GET_AZTEC_ADDRESS` INS  (AHW-098 HIGH)  [firmware + host + caps]  ← the heavy item
- **Firmware:** new **approval-gated** `INS_GET_AZTEC_ADDRESS` with a minimal request body `(curve_id, profile_id, path_scheme, path, salt)` — nothing host-chosen beyond that. Reuse the deploy/account-binding derivation (`l4/account_binding.c`, `l4/account_derive.c`, `deploy_address.c`) to compute partial address → public-keys-hash → final address **on-device**; render `Account #N`, `Scheme`, receive address `8+6`; **return only the 32-byte address after approval — NOT a signed certificate blob** (codex: a signed blob is replayable + expands surface + doesn't improve the human comparison). **MUST reuse the W1 snapshot helper (codex-final BLOCKING):** snapshot `(curve/profile/path/salt, derived address, #N, scheme, epoch)` out-of-band before render and return from the snapshot only — else this is a fresh AHW-095-class deferred-approval sink.
- **Compatibility (the adopted refinement):** new `GET_CAPS` bit `CAPS_ATTEST_ADDRESS` + app-version bump in `ledger-app/Makefile`. **No `MANIFEST_VERSION` reuse. No fallback.** Host hard-fails if the cap is absent.
- **Host:** `onboarding.ts` gains `attestReceiveAddress(...)`; `OnboardPanel` calls it for **every** account (deployed or not); `AztecLedgerSession.connect()` computes `AccountManager.create(...).address` and **`===`-asserts it equals the device-returned address, fail-closed on mismatch**. After that the displayed receive address IS the device-attested one; `alreadyDeployed` may still skip the on-chain deploy but is **no longer part of receive-identity trust**. **Ordering (codex-final MED):** call `GET_CAPS` + `GET_AZTEC_ADDRESS` BEFORE revealing/caching the privacy root, so an unsupported app fails closed before the more-sensitive reveal.
- **Allowlist/canonical only:** exact `(curve_id, profile_id)` allowlist, canonical path only, canonical salt; fail-closed otherwise; domain-separated opcode.
- **Test:** Speculos round-trip — reveal secret, derive expected address from the real oracle host-side, call `GET_AZTEC_ADDRESS`, assert device-displayed `8+6` == returned full address == host oracle; host-only test that `connect()` rejects when host-derived ≠ device-attested. **+ regression (codex-final BLOCKING):** (a) `alreadyDeployed=true` STILL calls `GET_AZTEC_ADDRESS` and never reverts to host trust; (b) missing `CAPS_ATTEST_ADDRESS` fails closed with NO fallback; (c) wrong `(curve/profile/path/salt)` rejects pre-session.

### P6 — W6 recovery model truth  (AHW-106 MED)  [docs + UI copy]  ∥
Rewrite `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md` (research repo) + `ConnectPanel.tsx`/`OnboardPanel.tsx` copy to state the **actual single-seed model**: the Ledger seed determines signing authority AND the privacy root for the path; seed compromise is catastrophic; seed loss strands the account; browser memory is not a backup. Remove all 2-of-2 / passphrase claims. (Not building 2-of-2.)

### P7 — W7 regression tests  (AHW-108 MED + AHW-109 MED; closes AHW-087)
- **Reject arms (AHW-108):** raw-APDU / `buildL4Manifest` Speculos cases hitting each APPEND_CALL arm with its exact SW — unknown selector → `0x6F09`, bad arg count → `0x6F0A`, visibility flip → `0x6F0B`, `from != consumer` on transfer → `0x6F0C`.
- **Low-S + verify (AHW-109, closes AHW-087):** extend blind-sign + deploy happy-path Speculos tests to assert `s <= half_n` AND `@noble/secp256k1.verify(...) === true` — the concrete anti-malleability proof.
- Land the W2 review-content + W4 round-trip + W3 API-shape + device-mismatch-fail-closed tests here if not already with their phases.

### P8 — register update
Mark AHW-087/095/096/097/098/099/100/103/106/108/109 FIXED in `audit/index.md`; record **AHW-104/105 as accepted residuals** with reasoning (104 defanged by 097; 105 subsumed by 098); note **AHW-101/102/107 DEFERRED**; note AHW-112 folded into W1 (or documented).

→ **Step 6 post-impl codex review** (diff + adversarial ask) → **Step 7 fix loop**.

## Security & Adversarial Considerations
- **Threat model:** malicious/buggy host; for W1 a physical fault attacker; MITM transport; poisoned build (mostly out-of-scope — AHW-034/102 deferred — stated honestly, not silently).
- **W4 — does it really close AHW-098?** Materially yes **iff onboarding is forced through it + the host `===` assert is fail-closed**: the device authors the address, so the host can only lie by hoping the user ignores the device screen — the same trust model as a hardware-wallet recipient confirmation (acceptable; the current secret-checksum model is not). The social residual (user must read the screen) is irreducible and gets **documented**. Keep the INS minimal (address only, not a signed blob); exact allowlist/canonical-only; new capability bit; no fallback.
- **W1** — separate immutable snapshot + sign-from-snapshot removes the ordinary mutable-global TOCTOU AND the union-clobber path from the approval sink; it forces an attacker to corrupt BOTH live state and the separate snapshot (or the compare itself) — the right app-level bar against single-fault. Snapshot storage outside the union is load-bearing.
- **W2** — rendering the FPC is the last line, not the only line (users won't memorize an FPC address); the real control is **single-sourcing + fail-closed equality** so there is exactly one sponsor source.
- **W3** — closing the raw-signer root export is the actual AHW-097 fix; leaving `LedgerProvider.signOuterHash` public does NOT fix it. Least-privilege at the package boundary.
- **W5** — zeroization must survive `-Oz` (verify asm); not black-box testable → source review + parity.
- **Supply chain / least privilege:** no new deps; signed commits; `bun.lock` frozen in CI; the new INS is the only added wire capability — read-only (returns, never signs).

## Provenance (which source drove what)
- **Phase shape / W1-as-foundation / W2+W4 share derivation primitives:** codex + main.
- **W1 sign-from-snapshot correction:** opus (#1), codex concurs.
- **W4 capability-bit-not-manifest-version + no-signed-blob + force-onboarding-through-it + host `===` assert:** codex (firmest) + opus (version-4/caps bit).
- **W4 input set `(curve_id,profile_id,path_scheme,path,salt)`:** opus + codex (device can't derive from path alone).
- **W3→W4 precondition:** opus + codex.
- **De-brittle auto-approvers (P0 pre-req), firmware-native harness for W1 reject branch:** codex.
- **Fold AHW-112 into W1:** opus + codex.
- **Rejected:** building 2-of-2 for W6 (owner chose align-to-reality); `MANIFEST_VERSION` reuse for W4 (auditors rejected → capability bit).

## Risks / open questions
- **W1 reject-branch proof** is the hardest — budget one small firmware-native test harness; black-box Speculos alone is insufficient.
- **W4 compatibility:** capability-bit hard-gate + app-version bump must not strand already-onboarded accounts (additive INS; signing unaffected — verify negotiation). The failure mode to avoid: `GET_AZTEC_ADDRESS` degrading into "just another derivation helper" or the host silently falling back → the remediation would be fake.
- **W2/W4 pagination** shifts review screens — P0's marker-based migration must land first.
- **W2 single-source** mechanics: confirm `manifest.json` is the authoritative sponsor source and the host construction reads from it.

## /goal and /loop seeds
See `goal-loop-seeds.md` (delivered with the approval gate).
