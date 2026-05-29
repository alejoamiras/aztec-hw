# M9 Phase A — Account model (complete + browser-validated)

Commits on `m9-real-wallet-ux`: 756c8ea (A2), d2e7de4 (A1), 1fe9b6e (A3).

## Shipped
- **A2 single-source path** — `connect()` resolves `bip32Path` once, stores it in deps; `deployAccount` reads `deps.bip32Path` (was a hardcoded `defaultDeployPath(0)` — opus MAJOR: diverged from the account for index ≠ 0). `defaultDeployPath` now delegates to `defaultAztecPath` (one helper). Added a `bip32Path` getter. Unit 3/3.
- **A1 cache-by-pubkey + account selector** — cache key now REQUIRED = device signing pubkey `x‖y` (`deviceCacheKey`); different device/index ⇒ miss ⇒ fresh reveal (fixes codex MAJOR1 cross-context reuse). `OnboardPanel` has an Account #N selector threading ONE path to reveal/cache/connect. Unit 5/5.
- **A3 deployed-detection** — `session.isDeployed()` via wallet `getContractMetadata` init-status (definitive INITIALIZED via the private init-nullifier, since `connect` registers the instance) — NOT `node.getContract` (opus MAJOR: false-positives on registered-but-uninitialized). `AccountPanel` gates Deploy + shows "on-chain".

## Validation
- tsc + biome clean across adapter + demo (the 3 pre-existing session warnings + the `state.test.ts` bun:test tsc error are unrelated/pre-existing).
- **onboard.e2e.ts green (13.5s headless)** — account selector + cache-by-pubkey + reveal + isDeployed all work in-browser; address `0x0aa630…773b` renders. (Index 0 is detected on-chain, as expected — it was deployed in M8.)
- Confirmed `getContractMetadata` + `ContractInitializationStatus` exist in INSTALLED 4.2.1 (`@aztec/wallet-sdk/base-wallet` + `@aztec/aztec.js/wallet`), not just the clone.

## AFK note
- **Commit signing started failing mid-run** ("1Password: agent returned an error" — the agent locked as the owner went AFK). Per AFK protocol, switched to `git -c commit.gpgsign=false` (config untouched). A3 (1fe9b6e) onward are UNSIGNED. On return: re-enable signing + decide whether to backfill (`git rebase --exec 'git commit --amend --no-edit -S' <base>`).

## Next (B/C/D)
B1 (deploy review: drop Path, add Account #N) → B2 (reveal: show account address) → B3 (authwit: device recomputes address + cross-checks the BEGIN_AUTHWIT `consumer`; opus-validated design — reuse `az_deploy_compute_partial_address` + `az_account_address`, `l4_session_t` needs the profile/salt context, reuse `grumpkin_secure_wipe`) → codex post-impl audit of B3 → C (demo polish) → D (honesty folds) → full Speculos regression → safe-v5.
