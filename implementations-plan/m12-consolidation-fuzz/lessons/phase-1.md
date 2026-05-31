# M12 Phase 1 — host deploy profile-id from generated metadata → `safe-v16`

Replaced the hardcoded `const deployProfileId = isSchnorr ? 1 : 0` in
`aztec-ledger-session.ts` with a typed lookup: a `DEPLOY_PROFILE_BY_SCHEME:
Record<AccountScheme, CsDeployProfileId>` map (string-union values → a codegen
rename is a COMPILE error) + `csDeployProfileLookup`, fail-closed on a miss (throws
pre-flight). Sourced from the generated `deploy_profiles.generated.ts` — the
metadata already carried `profile_index` + a typed `id`, so **no codegen change**.

**Why it's a real (small) robustness win, not cosmetics:** if the codegen ever
renumbers `profile_index` while keeping the `id`, lookup-by-id stays correct,
whereas the old literal would have silently signed the WRONG account template.
Host-only; the device still validates the (curve, profile) pair against its
firmware whitelist, so a host error fails closed (`SW_UNKNOWN_PROFILE_ID`), never a
wrong signature.

**Validation:** `gen:clear-signing-v0:check` (codegen in sync) + `bun run test`
(149 pass / 0 fail, incl. the new `deploy-profile-selection.test.ts` pinning
ECDSA-K → 0, Schnorr → 1, unknown id → undefined). **No on-chain re-run needed** —
the resolved profileId is byte-identical to the old literal (0/1), so deploy
behavior is unchanged; the regression pin + the device whitelist cover it (plan
marked the testnet smoke "optional"). Don't gold-plate.

No codex consult (trivial literal→lookup swap; the design was settled in the
consolidated plan: opus's typed map + codex's fail-closed, both adopted).

(Note: committed UNSIGNED — the 1Password SSH agent is flaking this session,
blocking both commit-signing and push auth. AFK-authorized GPG bypass; backfill
signatures + push on return / agent recovery.)
