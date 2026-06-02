# Phase 6 — post-impl codex review + fix loop + testnet matrix (protocol steps 6–7)

Commits unsigned (1Password down).

## Testnet matrix — GREEN on live testnet (beast-5), against the FINAL elf + v3 host

Ran the demo-browser full flow (onboard → deploy → drip → transfer) through Playwright +
`speculos-aztec-playwright` (the CURRENT elf) + the in-browser PXE on beast-5 testnet:
- **ECDSA** (`SCHEME=ecdsa`, #4 = `0x0366e521…`): deploy FRESH ("Deploy your Aztec account?" →
  "Transaction signed") + drip + transfer — transfer tx `0x11c19f149eef33de…`. 0 console errors.
- **Schnorr** (`SCHEME=schnorr`, #4 `0x11ce2beb…` + #2 `0x17499fbd…`): drip + transfer FRESH —
  txs `0x2cdb84dc6e66f119…` and `0x1d874d5944305673…`. Deploy self-skipped (both indices ALREADY
  on-chain from the M10/M11/M12 Schnorr sessions — the e2e confirms on-chain before skipping; the
  [0..4] dropdown range is fully deployed for Schnorr so a fresh re-deploy isn't reachable via UI).

So all six matrix cells are GREEN: ECDSA deploy/drip/transfer + Schnorr drip/transfer are FRESH this
session; Schnorr deploy is on-chain-confirmed (prior) + its v3 deploy WIRE is proven by ECDSA's fresh
deploy this session (the deploy path shares `MANIFEST_VERSION=3` + begin/finalize_deploy; only the
curve/profile differs, and that is Speculos-proven via schnorr-deploy-review + provider.m8). This is
the on-chain proof that the P4 wire-v3 + the post-impl cancellable/salt fixes work end-to-end. Toggle
states: the clear-sign path (blind OFF default) is what these flows exercise; blind ON is the legacy
SIGN_OUTER_HASH path, Speculos-proven separately (blind-signing-toggle.test.ts).

**e2e fixes this needed (commit 3570ed9):** (1) playwright `DEMO_PORT` env — a stale 18h Vite from an
unrelated project (`aztec-gate`) held :5173 and `reuseExistingServer` silently drove the WRONG app for
20min; ran on :5174 without killing it. (2) the reveal auto-confirm hardcoded 4 right-presses, but
AHW-047's longer "privacy root" subtitle shifted the approve prompt to 5 → "signal timed out"; now
scrolls to the "root?" prompt (robust). Speculos `speculos-aztec-playwright` must serve the CURRENT
elf (`ledger-app/bin`), not the orphaned container (the same stale-elf trap as phase-2).

```
[x] Post-impl codex review (session 019e8907, xhigh, read-only) — verdict SHIP-with-fixes.
    Briefed with the base SHA + key files per phase + the device guarantees to attack.
[x] Step-7 fix loop — all 4 findings fixed + validated (commit 67f6925); confirm pass (response-1)
    returned all 4 CLOSED, no new regression.
  [x] HIGH — tx cancellable=true now enforced in #assertClearSignPolicy (was deploy-only / wallet
      default only). cancellable is outside the signed hash → a host using the entrypoint directly
      could strip the AHW-049 public-replay nullifier. Symmetric reject + regression test.
  [x] MED — append_call.c enforces args[0]=TOKEN for DRIP on-device (was host-only). Speculos:
      non-TOKEN → 0x6F08; USDC drip still renders.
  [x] MED — aztec-ledger-session threads the account salt into BEGIN_AUTHWIT v3 (computed before the
      account contract). Non-zero-salt accounts emit their real salt; demo (ZERO) unchanged.
  [x] LOW — account_binding_deploy_pubkey_xy fails closed on curve != K1/GRUMPKIN.
  [x] confirm-pass residual — preflight.ts DRIP comment updated (the device now ALSO enforces; my
      earlier AHW-041 "host is the ONLY gate" comment was made stale by the MED fix).
  [~] codex follow-up nice-to-have — an end-to-end AztecLedgerSession.connect({salt != 0}) test.
      Deferred: the device-side non-zero-salt binding is already proven by wire-v3-binding, and the
      session→wire threading is code-path-verified (codex confirmed the 32-BE-byte format is
      consumed unchanged by buildL4Manifest). A full connect() test needs network/PXE infra.
```

## Lessons

### The post-impl review caught a real HIGH the phase work missed
HARD ITEM (b) said "assertClearSignPolicy sets cancellable=true for txs". P1 set it on the WALLET
(session-embedded-wallet) but NOT in the entrypoint policy guard — so a host driving the entrypoint
directly escaped it. The unsigned-field class (cancellable, fee mode, authwits) MUST be pinned in
the policy guard, not just defaulted upstream — defaults are bypassable; the guard is the boundary.
Lesson: when a guard's job is "pin every host-controlled unsigned field," enumerate them
exhaustively and pin EACH in the guard, even if a default already sets it elsewhere.

### codex elevated a comment-fix to a real fix (AHW-041)
In P5 I corrected the AHW-041 comment to "host is the only DRIP gate" (honest about the then-state).
codex's post-impl review said the right fix is to ENFORCE it device-side — and it was right (a
patched host could otherwise get a generic "Drip token" signed). Fixed on-device + re-corrected the
comment. Documenting an honest-but-weak state is not the same as closing the gap.

### Brief codex with the base SHA, not a pasted mega-diff
The remediation was 25 commits / 81 files / +3770-2090. Pasting that is hopeless; instead I gave
codex the base SHA (it ran `git diff base..HEAD -- <file>` itself, read-only) + a per-phase file map
+ the device guarantees to attack. It found 1 HIGH + 2 MED + 1 LOW, all concrete + valid, and
confirmed the core (B3, blind-signing device-only, no salt/profile confusion, memory-only cache).
