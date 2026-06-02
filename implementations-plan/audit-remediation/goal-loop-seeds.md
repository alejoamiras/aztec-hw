# `/goal` and `/loop` seed strings — audit-remediation implementation

Pick ONE for the implementation session (they don't compose; setting one replaces the other).
`/goal` is primary (completion is transcript-observable). `/loop` is the self-paced fallback.

---

## `/goal` (primary)

```
/goal Drive implementations-plan/audit-remediation/plan.md to completion (Tier-A consolidated, codex-final GO). Phases P0→P6 each marked ✓ in the ASCII checklist in implementations-plan/audit-remediation/lessons/ with a per-phase lessons log; one branch, a signed safe-vN tag per PROVEN phase. PRESERVE every device guarantee (independent outer_hash recompute reject-on-mismatch; B3 consumer/address binding STILL fail-closed; M8-P6 self-derived pkh/address sovereignty; device-signs-only-what-it-recomputed; zero math/memory regression) — a test proves each. HARD ITEMS: (a) blind_signing NVM toggle default-OFF, sticky, device-only, no APDU writes it — Speculos tests prove reject-when-OFF + ⚠warn-when-ON; host createAuthWit fail-closed; (b) host assertClearSignPolicy rejects authWitnesses/capsules/extraHashedArgs + pins fee mode + sets cancellable=true for txs / false for deploy (closes AHW-049); (c) device renders DRIP, recipient 8+8 (+show-full, buffers audited ≥34), raw amount alongside scaled — per-verb review-content tests green; (d) B3 wire v3 carries salt+profile_id, device re-derives the account (derive-don't-trust) + binds consumer to it, reused via the deploy-binding path, ISOLATED in its own firmware-first commit with NO v2 fallback — positive non-zero-salt/profile accept + negative wrong-salt/profile reject(0x6F12) tests + regenerated M12 fuzz + differential-replay for v3 all green; (e) reveal = honest "privacy root" wording + no sessionStorage persistence (narrowing confirmed protocol-impossible). DONE = `bun run lint:all` and `bun test packages/` both exit 0 in the transcript; full Speculos+testnet matrix (deploy/drip/transfer × ECDSA+Schnorr, both toggle states) green; git grep proves adapter-trezor / apps/demo / createAuthWitFromIntent / sessionStorage-revealed-root gone; codex post-impl audit complete with high/critical findings folded; audit/index.md updated marking fixed findings. Evidence-based (Speculos/testnet proof, never assumptions); no security regression; don't gold-plate. Quality bar = pre-external-audit.
```

## `/loop` (fallback — self-paced)

```
/loop Each turn, in priority order: 1) State check: read the ASCII phase checklist in implementations-plan/audit-remediation/lessons/, run git status, and (if a PR/CI exists) gh pr checks --watch. 2) If CI/Speculos is in flight: stream it and wait before new work. 3) If a check or local run failed: triage + fix; call /codex xhigh on any non-trivial firmware/wire/crypto decision (esp. the B3 wire v3 binding); commit small/conventional/signed. 4) If the in-flight phase is green (its tests + the PRESERVED-guarantee tests + any Speculos/replay gate clean): mark it ✓, log implementations-plan/audit-remediation/lessons/phase-N.md, tag safe-vN, advance. 5) Else pick the next pending phase from plan.md (P0→P6) and execute (edit → lint → bun test → Speculos where firmware changed → commit → push). Discipline: PRESERVE every device guarantee (recompute reject / B3 fail-closed incl. non-zero-salt+profile / M8-P6 sovereignty); the B3 wire v3 is firmware-first, isolated, no v2 fallback; blind_signing default-OFF; never weaken a guarantee to land a fix; after 3 failures on one step stop+reassess with codex; keep the ASCII checklist atop every update. Continue until all phases ✓, lint+tests+matrix green, post-impl codex review folded.
```

## Notes
- Replace the abstract commands only if they drift: this project uses `bun run lint:all`, `bun test packages/` (from repo root — root bunfig preload), the `ledger-app` Makefile build + Speculos/ragger for device tests.
- The `/goal` evaluator only sees what's surfaced in the transcript — so the session must PRINT the lint/test exit codes, the Speculos/testnet results, and tick the ASCII checklist.
