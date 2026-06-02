# Phase 4 — B3 wire v3: host-selected (profile_id, salt), derive-don't-trust (AHW-018)

Commits unsigned (1Password down). Firmware-first: `871eb69` (fw) then `ff495e4` (host+tests).

```
[x] P4 — B3 wire v3 — COMPLETE (codex GO-with-edits; all edits folded; proven on app.elf)
  [x] Wire v3: BEGIN_AUTHWIT carries profile_id + salt (after the path). L4_MANIFEST_VERSION
      2→3, a HARD cut shared with deploy (deploy emits v3 too; layout unchanged). No v2 fallback.
  [x] B3 rewritten profile/salt-driven via the SAME account_binding_* helpers the deploy path
      uses (single source — the hard-coded zero-salt/profile-0 branch copy is gone). Derive-don't-
      trust: host selects WHICH account; device re-derives the address from its own keys + binds
      consumer to it.
  [x] codex High — explicit authwit allowlist l4_authwit_curve_profile_allowed (K1↔0, GRUMPKIN↔1):
      a future deploy profile is NOT authwit-signable for free. Checked at BEGIN + re-checked at
      FINALIZE (codex Med).
  [x] codex Med — review shows a "Scheme" line (ECDSA-K/Schnorr).
  [x] codex Med — host threads salt+profileId as explicit account properties (LedgerProviderOptions
      → entrypoint → buildL4Manifest); Schnorr contract declares profileId 1. NOT inferred from curve.
  [x] Tests (Speculos, real app.elf): wire-v3-binding (unknown profile + curve/profile mismatch →
      0x6F0D; NON-ZERO salt accepts; wrong salt → 0x6F12) · differential-replay + wire-negative (oracle
      rebuilt from v3 source) · provider deploy + sign round-trip · b3 + verified-calls round-trip.
  [x] Fuzz regen: fuzz_authwit allowed-SW += SW_UNKNOWN_PROFILE_ID; 3.7M-run v3 campaign, 0 crashes.
```

## Lessons

### Codex consult (session 019e88d0, xhigh) — GO-with-edits, all folded
Verdict GO-with-edits. Verified each claim against the code before folding (2 profiles; the
differential-replay field order; the fuzz allowed-SW). The High edit (explicit profile allowlist)
matters: `account_binding_deploy_partial` is generic over ANY `cs_deploy_profile_t`, so without an
allowlist a future DEPLOY profile would silently become authwit-signable. Pinned to {K1↔0, GRUMPKIN↔1}.

### The shared MANIFEST_VERSION is the operational footgun (codex Low, confirmed)
`L4_MANIFEST_VERSION` gates BOTH begin_authwit AND begin_deploy. Bumping it to 3 for the authwit
layout change ALSO requires deploy to emit v3 (its layout is unchanged) — host `deploy-context.ts`
already uses the shared constant, so it tracked automatically; provider deploy tests stayed green.
Miss this and every deploy 0x6F02's.

### Regenerating the differential-replay oracle after P3
The `replay_*` oracle binaries LINK the real firmware parser compiled host-side, so they had to be
rebuilt from the v3 source (`make replay-all`). My P3 changes added two deps the harness didn't
compile: `az_bip32_path_is_canonical` (AHW-064 → add `path_canonical.c` to the sources, faithful)
and `master_secret_disarm` (AHW-059, via session.c → a no-op hostshim stub, faithful since disarm
can't change a parse SW). The committed deploy CORPUS is v2-era and now rejects at the version gate,
so I seeded a crafted valid v3 deploy body to keep a parse-accept case for the seam test.

### outer_hash is unaffected by salt/profile
salt/profile are NOT authwit-message fields — they bind via `consumer` (the salt-derived address,
already in outer_hash). So `deviceOuterHashForIntent` needed no change; the negative wrong-salt test
passes the hash gate then fails B3 (0x6F12), which is exactly the intended order.

### Pre-existing lint debt (NOT P4): lint:all currently exits 1 from apps/demo-browser/e2e
useTemplate (unsafe-fix) + 1 stale biome-ignore + 55 noNonNullAssertion warnings — all pre-date this
session (last touched in an M9 commit) and are deferred per the owner's "don't care about CI". My new
TS files are biome-clean. (Earlier "lint:all exit=0" readings were the piped `tail` exit, not lint's.)
