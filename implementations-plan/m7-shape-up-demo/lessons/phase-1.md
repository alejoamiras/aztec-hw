# Phase 1 — Structured-step phase emission

**Status:** in progress
**Owner:** main agent
**Exit criteria:** `SubmitStep` carries typed `phase`; `StatusBar` has no regex inference; click Deploy → timeline shows Sign while device waits (truth-test of the timeline accuracy fix even though deploy is still blind-signed at this point); `bun run lint:all && bun test` clean; dev-mode throws on backwards phase movement.

## Approach

Per plan §4 + §6 Phase 1:

1. New `packages/adapter-ledger/src/types.ts` exporting `PhaseId` and `SubmitStepHandler`. Re-export from package root.
2. Update `SubmitOptions.onStep` signature in `aztec-ledger-session.ts` from `(label: string) => void` to `SubmitStepHandler`.
3. Refactor every `step('…')` call in adapter to `step('phase', '…')` per the emission map in plan §4.2.
4. Update `apps/demo-browser/src/state.ts::SubmitStep` to `{ phase, label, at }`.
5. Drop `inferPhaseIndex` + `activePhase` from `StatusBar.tsx`. Read `phase` directly from steps.
6. Update `AccountPanel.tsx` + `TransferPanel.tsx` step closures to new signature.
7. Add hard-throw on backwards phase movement (codex audit MINOR #1) inside the reducer.
8. Vitest unit test for the backwards-phase throw.

## Log

**Completed** — `bun run lint` clean, `bun test` 107 pass / 0 fail / 1 skip (+7 new tests for `assertMonotonicPhase`).

Notable design notes:

- The env probe in `assertMonotonicPhase` had to be portable: Vite browser builds have `import.meta.env.PROD`, but `bun:test` runs without Vite globals. Used a defense-in-depth check that returns "is production" only when explicitly set — defaults to dev/throw. This keeps the assertion behavior consistent across both runners.
- Promoted `PHASE_ORDER` + `assertMonotonicPhase` to `state.ts` rather than a separate `phase.ts` because they're shared between StatusBar (reading) + AccountPanel/TransferPanel (writing) + the test. Centralizing in `state.ts` avoids cross-package import churn.
- Re-exported `PhaseId` from the adapter package root so the demo can `import type { PhaseId } from '@aztec-hwwallet-poc/adapter-ledger'`. Saved a separate `types.ts` for the moment — if the adapter starts accreting other public types we can split.
- `deployAccount()` still goes through the framework's `BaseWallet.sendTx` (Phase 4 replaces this with `deployAccountClearSigned`). For now its emissions are deliberately sparse: `build` → `sign` → `done`. The middle phases (prove/submit/include) all collapse inside the framework's `deployMethod.send()` black box. After Phase 4 lands, deploy gets the full 9-phase sequence.
- `runRecipe`'s 9 phase emissions now match plan §4.2 exactly. Drip + transfer both go through this path.
