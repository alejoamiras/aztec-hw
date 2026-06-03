# audit-c2-remediation — MAIN plan draft (orchestrator's independent Tier-A plan)

Scope is `scope.md` (owner-agreed: W1–W7 fix; 104/105 drop; 101/102/107 defer). This is the *main* of three parallel plans (main + codex + opus) — consolidated into `plan.md`.

## Sequencing rationale
Split by surface: firmware (W1,W2,W4,W5), host (W3), docs (W6), tests (W7). Land the cheap high-value firmware fix first (W1 — the live HIGH, and its snapshot helper is reused). Quarantine the heavy item (W4 new INS) in its own phase with a version bump and NO fallback (mirror the prior wire-v3 hard-cut). Host (W3) + docs (W6) parallel the firmware track. Tests (W7) land with the code they guard, plus the two standalone coverage gaps.

```
P0 branch + scaffold
P1 W1  immutable reviewed snapshot      (fw)            ← live HIGH, foundational helper
P2 W5  Schnorr residue scrub            (fw, small)
P3 W2  deploy fee-target render + 1-source (fw+codegen)
P4 W4  GET_AZTEC_ADDRESS INS            (fw+host+wire)  ← heavy; version bump, no fallback
P5 W3  host public-API lockdown         (host)          ∥ P1–P4
P6 W7  reject-arm + low-S tests         (Speculos/bun)  + closes AHW-087
P7 W6  recovery model truth             (docs + UI copy) ∥
P8 index update: mark fixed; record 104/105 as accepted residuals; note defers
→ post-impl codex review (step 6) + fix loop (step 7)
```

## Phases

### P1 — W1 immutable reviewed snapshot  (AHW-095 HIGH + AHW-099 MED)
- **Approach:** add a dedicated `reviewed_sign_snapshot_t { uint8_t outer_hash[32]; uint32_t path[5]; uint8_t path_len; }` in storage that is **NOT** aliased by the `pk_info`/`sign_info` union (`types.h:80-83`) — its own static, or a guarded region. At `ui_display_blind_sign()` copy `(path, outer_hash)` into it; `sign_outer_hash_after_approval()` signs ONLY the snapshot and first `ct_memcmp`s live `G_context` against it → reject (new SW, e.g. `SW_REVIEW_STATE_MISMATCH`) on any drift. Same pattern for the deploy review identity (`#N`/address) in `deploy_review_ui.c`/`finalize_deploy_and_sign.c` (AHW-099).
- **Modularize:** `ui/review_snapshot.{h,c}` — `snapshot_take()` / `snapshot_verify_or_reject()`, reused by blind-sign + deploy.
- **Files:** `ledger-app/src/ui/sign_ui.c`, `handler/sign_outer_hash.c`, `ui/deploy_review_ui.c`, `handler/finalize_deploy_and_sign.c`, `types.h`, `sw.h`, new `ui/review_snapshot.{h,c}`.
- **Test (Speculos):** approve, mutate the live slot before the approval callback (test hook), assert reject SW + no signature. Happy path still signs.
- **Adversarial:** the snapshot storage MUST be outside the union or a mid-review `GET_PUBLIC_KEY` clobbers it too (defeats the fix). The APDU-interleave vector is likely already blocked by NBGL input-blocking — verify; add a review-token cleared by any new APDU as belt-and-suspenders.

### P2 — W5 Schnorr residue scrub  (AHW-100 MED)
- **Approach:** `explicit_bzero` `pe` + `s_fq`-adjacent secret temporaries on every exit of `sign_once()` (`schnorr.c:60-74`); scrub `acc/term` in `gk_fq_from_bytes_wide_be` and `normal` in `gk_fq_to_bytes_be` (`fq.c:223-237,261-273`); audit `aztec_secret.c:93-97,138-142`. Prefer helper-level cleanup so caller `explicit_bzero` isn't the only defense.
- **Files:** `crypto/schnorr.c`, `crypto/grumpkin/fq.c`, `l4/aztec_secret.c`.
- **Test:** value-parity (signatures unchanged) via the existing Schnorr parity/replay suite; (residue isn't observable in Speculos — rely on code review + the parity that the math still matches).
- **Adversarial:** verify the compiler (`-Oz`) doesn't elide the `explicit_bzero` (it shouldn't, but confirm in `app.asm` like AHW-068 did for cmov).

### P3 — W2 deploy fee-target render + single-source  (AHW-096 MED)
- **Approach:** (a) render the sponsor FPC **address (8+6) + selector** on the deploy review (`deploy_review_ui.c`) — a new pair, like the recipient pair. (b) **single-source** the sponsor: the host's `sponsoredFpcAddress` is the one source; the codegen (`gen-clear-signing-v0.ts`) derives `deploy_profiles.gen.*` sponsor fields FROM that source (or asserts equality at codegen) so the device table can't independently drift. Runtime already fails closed on host↔device hash mismatch; this adds display + removes the silent-drift seam.
- **Files:** `ledger-app/src/ui/deploy_review_ui.c`, `l4/deploy_outer_hash.c` (expose the sponsor for render), `clear_signing_v0/deploy_profiles.gen.*`, `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts`, the sponsor config source.
- **Test (Speculos):** deploy review shows the configured sponsor address + selector; codegen test asserts the gen table sponsor == the single source.
- **Adversarial:** a poisoned build still wins (separate, AHW-034/102 deferred) — the render is the real defense (human verifies). Don't claim a "canonical" check (none exists).

### P4 — W4 GET_AZTEC_ADDRESS INS  (AHW-098 HIGH)  — the heavy item
- **Approach:** new **approval-gated** INS. Device: validate canonical path + curve → derive `public_keys_hash` + `address` from its OWN secret/pubkey (reuse `deploy_address.c` / `account_binding_*`) → render the address 8+6 on-screen for the user to confirm → return the device-derived address bytes. Host (`onboarding.ts`/`aztec-ledger-session.ts`): call it during onboard, use the **device-attested** address as the receive identity; stop trusting the host-computed address and stop letting host `alreadyDeployed` suppress attestation.
- **Wire/version:** additive INS, but bump the manifest/version (mirror wire-v3 discipline); NO v(n-1) fallback for the onboard-attestation path. Allocate a new `INS_GET_AZTEC_ADDRESS`; domain-separate (own CLA/INS); the INS only RETURNS a derived value (does not sign) so cross-path replay risk is low — but ensure it can't be coerced to confirm a host-supplied address (device derives, never echoes host input).
- **Files:** `ledger-app/src/apdu/dispatcher.c`, new `handler/get_aztec_address.c` + `ui`, reuse `l4/deploy_address.c`; `packages/adapter-ledger/src/{apdu.ts,provider.ts,onboarding.ts,aztec-ledger-session.ts}`.
- **Test:** Speculos — the device renders + returns its derived address; host uses it; a host attempting to substitute a different receive address is detectable (the device screen shows the real one). bun test for the host threading.
- **Adversarial (the crux):** does this *actually* close AHW-098 or just relocate trust? It closes it iff the user confirms the address **on the device screen** (same trust as the recipient pill) and the host uses that exact value as the receive target — the device becomes the source of truth, the host can't substitute. Residual: the user must look (universal HW-wallet assumption). Fail-closed on non-canonical path/curve. The version bump must not strand already-onboarded accounts (the INS is additive; signing unaffected).

### P5 — W3 host public-API lockdown  (AHW-097 HIGH + AHW-103 MED)  ∥
- **Approach:** AHW-097 — remove `LedgerProvider`'s raw `signOuterHash` (and the raw provider) from `index.ts` root; relocate behind `@…/unsafe` subpath (or make internal, exposed only to the session layer). AHW-103 — move privacy-root cache access (`loadCachedSecret`) internal to onboarding/session; root exports only a presence check / opaque handle.
- **Files:** `packages/adapter-ledger/src/index.ts`, `provider.ts`, `secret-cache.ts`, `onboarding.ts`.
- **Test:** bun — assert the root barrel no longer exports `signOuterHash`/`loadCachedSecret`; the clear-sign entrypoint still works; an `/unsafe` import still reaches the raw path (if kept).
- **Adversarial:** confirm no internal caller breaks; AHW-104 (override seams) is DROPPED — verify it's truly defanged once the raw signer is gone (the override entrypoint can only drive clear-sign), and document that reasoning for the auditor.

### P6 — W7 reject-arm + low-S tests  (AHW-108 MED + AHW-109 MED, closes AHW-087)
- **Approach:** AHW-108 — Speculos tests feeding each APPEND_CALL reject arm (0x6F09/0A/0B/0C incl. delegated-spend) its bad input, asserting the EXACT SW (template off the existing 0x6F08 case). AHW-109 — a Speculos test that signs and `secp256k1.verify`s the returned sig AND asserts `s ≤ n/2` (closes AHW-087's host-verify gap too).
- **Files:** `packages/adapter-ledger/src/*.test.ts` (Speculos), maybe `ledger-app/tests/`.
- **Adversarial:** these are the regression guards for the clear-sign-not-blind-sign promise + malleability — make them assert REJECT/low-S, not just membership.

### P7 — W6 recovery model truth  (AHW-106 MED)  ∥
- **Approach:** rewrite `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md` (research repo) + `apps/demo-browser` ConnectPanel/onboarding copy to declare the actual **single-seed** model + consequence (seed compromise = path-wide privacy root for that path; seed loss strands the account). NOT building 2-of-2.
- **Files:** research-repo doc + `apps/demo-browser` copy.
- **Adversarial:** the doc must not overstate — state the real compromise boundary plainly for the auditor.

### P8 — register update
Mark AHW-095/096/097/098/099/100/103/106/108/109 (+087) FIXED in `audit/index.md`; record AHW-104/105 as **accepted residuals** with the reasoning (104 defanged by 097; 105 subsumed by 098); note AHW-101/102/107 DEFERRED.

## Security & Adversarial Considerations (consolidated)
- **Threat model:** malicious/buggy host + (for W1) a physical fault attacker; MITM transport; poisoned build (mostly out-of-scope, AHW-034/102 deferred — note honestly).
- **W4 is the new attack surface** — minimize it: approval-gated, device-derives-only, domain-separated INS, fail-closed on bad path/curve, version-bumped, no fallback. The honest residual: device attestation works only if the user reads the screen (universal).
- **W1 union-clobber** is the subtle correctness trap — snapshot storage must not alias the pk/sign union.
- **Crypto:** W5 zeroization must survive `-Oz` (verify asm); W7 proves low-S (anti-malleability) with a real verify.
- **Least privilege / supply chain:** no new deps; signed commits; `bun.lock` frozen in CI; the new INS adds the only new wire capability — keep it read-only (returns, never signs).
- **Audit prompts (codex + opus) explicitly asked:** what could go wrong, attacker targets, supply-chain/crypto/least-privilege/domain-separation — see plan-codex.md / plan-opus.md.

## Risks / open questions
- W4 manifest/version bump: confirm it doesn't strand already-onboarded accounts (additive INS; signing unaffected — but verify negotiation).
- W2 single-source mechanics: is the sponsor address a build-time config or runtime? Decide the one source.
- W1: exact non-union storage for the snapshot on the constrained Nano memory.
- W4 trust-relocation critique (does it really close AHW-098?) — pressure-tested above; codex/opus to challenge.

## Validation gate
`bun run lint:all && bun test packages/` exit 0; Speculos green for W1/W2/W4/W6-tests; firmware builds via docker `ledger-app-builder-lite`. Branch `audit-c2-remediation`, signed commits, PR for owner review (no merge without approval).
