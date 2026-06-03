# audit-c2-remediation — AGREED SCOPE (owner-confirmed 2026-06-03)

Remediation of the C2 catalog HIGH+MED findings (see `audit/index.md` AHW-095..129; full evidence + fix-sketches in `audit/_raw/c2/validated-V{1,2,3}.md`). Owner walked through each finding fix/drop. **This file is the canonical scope for the Tier-A parallel planners (main + codex + opus) and the implementation.**

**Quality bar:** pre-external-audit (fix the real holes to a defensible, tested state; document residuals for the auditor). **Branch:** `audit-c2-remediation` off `main`. **Validation:** firmware = docker `ledger-app-builder-lite` build → `ghcr.io/ledgerhq/speculos` on a CLEAN port (NOT the orphaned :5001); host = `bun test`. Signed commits (1Password back). Modularize the systemic fixes into shared helpers.

## FIX — 9 work items

### W1 — Immutable reviewed snapshot  [AHW-095 HIGH + AHW-099 MED]  (firmware)
The blind-sign approval callback re-reads mutable `G_context` (`sign_ui.c:94` + `sign_outer_hash.c:126`) instead of an immutable snapshot → a post-review fault signs ≠ what was shown. Deploy review (`deploy_review_ui.c` + `finalize_deploy_and_sign.c`) has the same display-identity TOCTOU (AHW-099). The clear-sign authwit/deploy *signing* paths already sign a fresh local recompute — this is specifically the blind-sign sink + the deploy *review display*.
**Fix:** snapshot the reviewed `(path, outer_hash)` (and deploy `#N`/address) into a dedicated immutable struct at review-draw; sign/render ONLY the snapshot; on approval compare live `G_context` to the snapshot and reject on mismatch. Consider the `types.h:80-83` `pk_info`/`sign_info` union-clobber surface. Add a live request-token any new APDU (incl. ABORT) clears (defends the APDU-interleave vector, though NBGL input-blocking likely already does). **Extract a reusable snapshot/compare-back helper.**

### W2 — Deploy fee-target clear-signing  [AHW-096 MED]  (firmware + codegen)
The device signs `sponsor_unconditionally()` to a specific FPC address but the deploy screen shows only "Sponsored (testnet)" — the fee-authorization target is hidden. (No canonical FPC exists; the human is the check.)
**Fix:** render the sponsor FPC **address (8+6) + selector** on the deploy review (clear-sign the fee target, like a recipient). **Single-source** the sponsor address so the device table (`deploy_profiles.gen.*`) and the host (`SponsoredFeePaymentMethod`) read ONE configured value (display == sign == config; can't drift). Runtime already fails closed on host↔device hash mismatch — this closes the display gap + removes the independent-copy drift.

### W3 — Host public-API lockdown  [AHW-097 HIGH + AHW-103 MED]  (host)
- AHW-097: `index.ts` root-exports `LedgerProvider.signOuterHash` (raw 32-byte-digest signer) outside the clear-sign entrypoint. **Fix:** remove from the root barrel / relocate behind an explicit `…/unsafe` subpath normal consumers don't import.
- AHW-103: the root also exports the reveal + `loadCachedSecret` reread of the privacy root (same-origin/in-process; cache is memory-only). **Fix:** keep cache access internal to the onboarding/session layer; export only a presence check / opaque handle.
(AHW-104 override seams DROPPED — defanged once the raw signer is gone; document.)

### W4 — Device-attested receive address: new GET_AZTEC_ADDRESS INS  [AHW-098 HIGH]  (firmware + host + wire)  ← the heavy item
Onboard derives the address host-side; the device attests the SECRET (reveal checksum) but NEVER the address, and deploy address-attestation is skipped on host-controlled `alreadyDeployed`. **Fix:** add a new **approval-gated** `GET_AZTEC_ADDRESS` INS — the device derives the receive address from its own secret+salt+pubkey (reuse the deploy-path `account_binding_*`/`deploy_address.c` derivation), renders it 8+6 for the user to confirm, and returns it; the host uses the device-attested address as the receive identity (stop trusting the host-derived address / the `alreadyDeployed` suppression). **Wire/version implications:** new INS + likely a manifest/version bump (mirror the prior wire-v3 discipline). Adversarial musts: domain-separate the new INS, no replay into other paths, fail-closed on non-canonical path/curve.

### W5 — Schnorr key-residue scrub  [AHW-100 MED]  (firmware)
Schnorr sign leaves `pe = priv·e` (and derive/serialize temporaries in `fq.c`/`aztec_secret.c`) un-scrubbed; with public `e`, leftover `pe` → `priv`. **Fix:** `explicit_bzero` `pe` + all secret-derived locals on every exit path (`schnorr.c:30-74`, `fq.c:223-237,261-273`, `aztec_secret.c:93-97,138-142`); prefer helper-level cleanup so caller-level scrubbing isn't the only line of defense.

### W6 — Recovery model truth  [AHW-106 MED]  (docs + UI copy)
Code derives the master secret from the HW seed (single-seed) while the recovery spec mandates a 2-of-2 split-brain and the UI says "the seed is your backup." NOT a runtime exploit (consequence already AHW-047). **Fix (align-to-reality):** rewrite `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md` (research repo) + the `ConnectPanel`/onboarding copy to declare the actual single-seed model + consequence (seed compromise = path-wide privacy root; seed loss strands the account). NOT building the 2-of-2 scheme.

### W7 — Test coverage: reject arms + low-S  [AHW-108 MED + AHW-109 MED]  (test / Speculos)
- AHW-108: APPEND_CALL strict-allowlist reject arms (0x6F09/0A/0B/0C incl. the delegated-spend gate) have only membership-fuzz coverage. **Fix:** Speculos tests feeding each arm its bad input, asserting the EXACT SW (like the 0x6F08 case).
- AHW-109: device low-S anti-malleability is asserted by no test (host test exercises a different impl). **Fix:** a test asserting returned `s ≤ n/2`; ideally a Speculos test that also `secp256k1.verify`s the sig — **which also closes AHW-087** (host never verifies the device sig).

## DROP (accept as residual — document in audit/index.md for the auditor)
- **AHW-104** override seams — bite came from pairing with the raw signer (AHW-097), which is being removed.
- **AHW-105** pubkey read-twice cross-check — subsumed once AHW-098 device-attests the address.

## DEFER (out of this plan)
- **AHW-101, AHW-102** → CI/release-gate pass (with the parked AHW-034 firmware-provenance).
- **AHW-107** → frontend pass (the fix is in `apps/demo-browser`, outside this plan's firmware+wire scope).

## Systemic groupings (modularize)
- W1 = the "immutable reviewed snapshot, never re-read globals" pattern (shared helper) — also the spirit of AHW-085.
- W3 = public-API surface lockdown.
- W7 = the fail-closed/anti-malleability regression-test item (relates to parked AHW-024/025/091).
