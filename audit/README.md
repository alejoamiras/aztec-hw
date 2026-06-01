# /audit — pre-external-audit findings register

Hardening pass before sending the Aztec Ledger hardware-wallet PoC to a professional auditor.
We are **cataloging, not fixing**. Once we hit **50–75 validated findings** (or we start repeating
ourselves), we stop and deep-plan the fixes.

## The loop
1. Spawn diverse red-team subagents — **opus 4.8** + **codex xhigh** — ≤3 concurrent, each on a
   **non-overlapping** angle. Each reads `index.md` first and reports only NET-NEW issues.
2. Each writes raw candidates to `_raw/`.
3. A **separate validation subagent** confirms each candidate is REAL (against the code) and NOT a
   duplicate of an existing index entry, before anything is promoted.
4. Validated, non-duplicate findings are promoted into `index.md` with full detail (location, impact,
   fix direction) so we can deep-plan from them later.
5. Repeat with fresh angles until 50–75 or repetition → STOP → deep-plan.

## Categories
- **HOST** — our TypeScript host adapter (`packages/adapter-ledger`, `packages/core`). **OURS.**
- **APP** — our BOLOS C app (`ledger-app/src/`). **OURS** — we wrote the Ledger app.
- **PLATFORM** — Ledger BOLOS OS / SDK / Secure Element constraints. **NOT ours** — document +
  mitigate only. We are a Ledger *app*, not Ledger firmware.
- **DESIGN** — architectural choice; fixing needs a design decision, not just a patch.
- **BUILD** — build / CI / supply-chain hygiene.
- **TEST** — missing coverage (no bug, but a proof gap an auditor will probe).

## Owned-by
- **OURS** — fixable in this repo.
- **LEDGER** — platform constraint; document for the auditor, can't change.
- **MIXED** — root cause is platform (e.g. no certified constant-time primitive), but we own a
  mitigation (e.g. rate-limiting around it).

## Status
`VALIDATED` (confirmed against code) · `PROPOSED` (from a report, pending validation-subagent) ·
`DUP` · `REJECTED`.

## Count
**83 — LOOP STOPPED at diminishing returns (ceiling was 125, not padded to).** Round 1 (29): trust-boundary +
firmware-C + quality/modularity/tests. Round 2 (+17): supply-chain/CI (10) + host-frontend/codegen
(7). Round 2 protocol/crypto (+3, codex). Round 3 (+7): on-device UI-deception. Produced by 7
red-team subagents (4 opus + 3 codex) + 5 separate validation subagents — all diverse (opus 4.8 +
codex xhigh). Severity: **1 CRITICAL · 7 HIGH · ~18 MEDIUM · ~26 LOW · ~4 INFO.** Plus a recorded
set of confirmed-clean negative results (see `index.md`). Raw red-team + validation transcripts in
`audit/_raw/`; round-1 source reports in `implementations-plan/audit-pre-auditor/`.
**Stopped because:** ≥50 reached AND all distinct angles exercised (last round yielded downgrades +
negatives — diminishing returns). **Next:** deep-plan the fixes, HIGH/CRITICAL cluster first.
