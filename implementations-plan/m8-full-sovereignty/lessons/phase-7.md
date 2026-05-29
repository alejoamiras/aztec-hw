# Phase 7 — Onboarding (the Ledger IS the wallet)

**Status:** complete. 4 commits on `m8-phase-7-onboarding` (077be91 docs, e0097ae hardening, 9b886ee onboarding+salt, 718c431 OnboardPanel) + onboarding e2e.

## What shipped
- **7.0 hardening** — `grumpkin_secure_wipe` (portable volatile loop; `explicit_bzero` isn't host-portable under `-std=c11 -Werror`) clears the scalar-mult/inverse temporaries; reveal screen names the host; killed the stale pubkey-derivation docs (the code hashes the PRIVATE child key). Validated: grumpkin parity 6/6 (656 asserts) + clean nanos2 device build.
- **7.1 `revealMasterSecret`** — wraps `getAztecMasterSecret` + checksum → `{secret: Fr, checksum}`. Device-free unit 2/2.
- **7.2 deterministic salt** — `DEFAULT_ACCOUNT_SALT = Fr.ZERO` is `connect()`'s default so the SAME device reproduces the SAME account (reconnect == recovery). `secret-cache.ts` = in-memory/sessionStorage only (never disk). Secret stripped from `internalDeps` (impl-audit MAJOR). Unit 3/3.
- **7.3 OnboardPanel** — explicit "Derive viewing keys" step; `connect()` split so Connect just opens+verifies the transport and hands off to onboarding.

## Live browser validation (headless)
`e2e/onboard.e2e.ts` (headless, reuses the running Vite): load → Connect → Derive → reveal approved on Speculos → **account address rendered** (`0x0aa630…773b`). 14.1s, green. This is the in-browser counterpart to the node-level `provider.m8.test.ts` (device ACCEPTS the derived account). The slow deploy→testnet path is the P8.1 / guided run.

## Lessons / gotchas
- **Reveal approver = blind, not screen-walking.** `nbgl_useCaseReview` shows intro→subtitle→Path→Confirm→"Reveal viewing key to this computer?". Mirror `provider.m8.test.ts makeApprover(4)`: 4×right then both, after a ~1.5s render delay. The screen-walking approver races the renderer → 0x6985 (phase-6 lesson, reconfirmed). The existing `smoke.e2e.ts autoConfirmSpeculos` matches "Sign Aztec/Approve" only — it does NOT confirm the reveal screen.
- **7.3 broke `smoke.e2e.ts`.** It clicks Connect then expects Deploy; now there's a Derive step in between (Connect → `onboarding`, not `ready`). Must insert the Derive+approve step there — folded into P8.1.
- **Playwright MCP launches headed.** Use the repo's `playwright.config.ts` (`headless: true`, `reuseExistingServer`) via `bunx playwright test` instead — invisible, and it reuses a running dev server.
- **Pre-existing red:** `bun run dev`/build's `tsc -b` chokes on `state.test.ts`'s `bun:test` import (app tsconfig `include`s tests without bun types). Not from P7. Fix: exclude `*.test.ts` from the app tsconfig or add bun types. `vite build` is fine.

## For P8.1 (reconnect == recovery)
The address above is device-derived from (master secret @ defaultAztecPath, signing pubkey, salt=Fr.ZERO). Deterministic ⇒ wipe browser → reconnect → re-onboard MUST reproduce the SAME address byte-for-byte. That equality is the hero demo's headline assertion.
