# Post-implementation codex review — audit-c2-remediation

Codex session `019e8e5e-2a05-7352-93ad-7569372abb96` (xhigh, read-only). Prompt focused on the
W4 INS + the snapshot reuse + W2 single-source + the marker migration. Verdict: **fix-first**
("the W4 primitive is mostly sound, but the shipped host flow still bypasses it, so AHW-098 is
not actually closed end-to-end").

## Findings + disposition

| sev | finding | disposition |
|-----|---------|-------------|
| CRITICAL | none | — |
| **HIGH** | W4 opt-in; the only real onboarding flow (`OnboardPanel.tsx:79`) never opts in → a non-attested address can still be displayed (original AHW-098 failure mode). | **FIXED** (c5b8b54). `connect()` now attests the receive address ON-DEVICE **by default** + fail-closes on mismatch / missing cap; `attestReceiveAddress:false` opts out (headless only). Codex's own suggested fix #2 (attested-by-default + explicit headless opt-out). The out-of-scope frontend inherits enforcement with no frontend code change (real device prompts a tap). |
| **MED** | reset/reject didn't tear down pending review state (blind/identity/W4 snapshots survive `l4_session_reset`; blind-sign reject never disarmed). | **FIXED** (c5b8b54). `l4_session_reset` now disarms all review statics (`review_snapshot_disarm` + `_identity` + new `get_aztec_address_disarm`); `sign_outer_hash_rejected` disarms the blind snapshot. Was defense-in-depth (sign-from-snapshot + verify already made a stale snapshot non-exploitable) — now the "abort/reset kills pending review" invariant is explicit. |
| LOW | `getLedgerProvider()` exposed the full `LedgerProvider`. | **FIXED** (c5b8b54). Narrowed to delegating `getCaps()` + `attestReceiveAddress()` on the authwit provider (least-privilege). |
| LOW | marker migration incomplete — `provider.test` / `blind-signing-toggle` / `ecdsa-k-account` still hardcode press counts. | **ACCEPTED / documented.** P0 deliberately SCOPED the migration to the deploy/reveal/address walkers — the ones W2 (sponsor pair) + W4 (new review) actually shift. The blind-sign page count is stable, so those fixed-count walkers don't drift. Full migration is a low-value nice-to-have. |

## Codex "looks sound" (confirmed by an independent reviewer)
- W4 device parsing strict: exact curve/profile pairing, exact canonical `m/44'/AZTEC'/<acct>'/0/0`, canonical salt, no trailing bytes (`get_aztec_address.c:65-113`).
- W4 approval returns the address FROM the out-of-band snapshot, not live mutable state.
- Host fail-closed when W4 is used: missing cap + any mismatch hard-fail (`receive-address-verify.ts`).
- W2 single-sourcing fail-closed: deployer zero, exactly one sponsor slot, sponsor selector tied to the artifact (`gen-clear-signing-v0.ts:478-572`); only the acknowledged build-gate residual (AHW-102) remains.

## Net
1 HIGH + 1 MED + 1 LOW folded; 1 LOW accepted-with-reason. No CRITICAL. Re-verified green
(provider.m8 10, provider.test 9, wire-reject-arms 4; firmware-native exit 0; lint+test+tsc 0).
Response transcript: codex session above (`response.md` in the run dir).
