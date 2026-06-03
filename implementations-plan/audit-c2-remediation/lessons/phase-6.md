# Phase 6 (W6) — recovery-model truth — DONE ✅

AHW-106 (MED). Doc-only (no firmware/Speculos). Not a runtime exploit — the runtime consequence is already AHW-047. This is a doc↔impl truth fix.

## The mismatch
`../aztec-hardware-wallet/architectures/03-recovery-and-backup.md` (research repo) describes a **split-brain 2-of-2** model: "two secrets, both required," "back up the protocol secret separately from the HW device," recommends **Design C (passphrase + HW 2-of-2)**, and explicitly says **"Do not derive `sk` from the HW seed."** But the shipped PoC is **single-seed**: `master-secret.ts` derives the Aztec master secret deterministically from the HW seed (`SHA-512(DOMAIN ‖ child-privkey) mod Fr`) and feeds it into `deriveKeys()`. The doc would mislead an auditor/integrator about the real compromise boundary.

## The fix (align doc to reality — NOT build 2-of-2)
- Added **§0 "⚠ v0 IMPLEMENTATION REALITY — single-seed (read this first)"** at the top: states what actually ships, the consequence (seed compromise = full account + privacy-root compromise for that path = AHW-047; seed loss strands the account; browser memory is not a backup), and marks the split-brain/Designs A–D as the **TARGET/future**, not v0.
- Annotated the contradicting line (§"Do not derive `sk` from the HW seed") with a **[v0 REALITY (AHW-106)]** note that the PoC does derive from the seed by design for v0, accepted + documented.

## Notable
- The **UI was already honest** — `ConnectPanel.tsx` says "the device (its seed) is the backup; there's nothing extra to save," which is the correct single-seed statement. So W6 needed NO UI change; only the research doc lied. (Avoided gold-plating a UI rewrite.)
- The recovery doc lives in the **research repo** (`../aztec-hardware-wallet/`), outside the poc git — corrected there in place; the poc branch records AHW-106 → FIXED + this lesson.
- Owner chose "align docs to reality" over building the 2-of-2 scheme (large crypto/UX) — the honest, scoped fix.
