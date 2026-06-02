# Phase 6 — post-implementation codex review + fix loop (protocol steps 6–7)

Commits unsigned (1Password down).

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
