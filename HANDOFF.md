# Handoff — Phase A status + next session

> Snapshot at 2026-05-25 after an autonomous build session.
> **🎉 M0b green**: signature from a real `trezor-firmware` emulator verifies through Aztec's reference ECDSA verifier.
> 12+ commits, all checks pass locally.

## What works right now

End-to-end pipeline proves correctness against Aztec's reference verifier:

```bash
bun run --cwd apps/demo start
# → Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): OK ✓
```

This runs against an in-process Trezor-faithful fake transport that mimics the real device's wire format byte-for-byte (per codex's review of `sign_identity.py`). The fact that it verifies under `@aztec/foundation/crypto/ecdsa.Ecdsa.verifySignature` means the adapter pipeline is correct: when wired to a real device, the same flow should produce verifier-accepted signatures.

### The flow (and where each piece lives)

```
                                                  packages/adapter-trezor/
                                                  src/
                                                  ┌──────────────────────┐
                                                  │ TrezorEcdsaK         │
   outer_hash (Fr)  ──→  ecdsaPreimage  ─────────→│ AuthWitness          │
   (32-byte BE)          (SHA-256)                │ Provider             │
                         (packages/core/          │                      │
                          src/ecdsa.ts)           │   identity.ts        │
                                                  │   → IdentityType     │
                                                  │     proto='gpg'      │
                                                  │     host='aztec'     │
                                                  │     path='/account/N'│
                                                  │                      │
                                                  │   transport.ts       │
                                                  │   → signIdentity()   │
                                                  │     {compressed PK,  │
                                                  │      signature 65B}  │
                                                  │                      │
                                                  │   provider.ts        │
                                                  │   → decompress PK    │
                                                  │     strip marker     │
                                                  │     low-s normalize  │
                                                  │     pack as          │
                                                  │     AuthWitness      │
                                                  └──────────────────────┘
                                                            │
                                                            ▼
                                                  Aztec EcdsaKAccount
                                                  verifier accepts ✓
```

### Transports

- `apps/demo/src/fake-transport.ts` — uses `@noble/secp256k1` to sign `challenge_hidden` directly. Byte-faithful to real Trezor `proto='gpg'` semantics. Pipeline verification done.
- `packages/adapter-trezor/src/trezorlib-subprocess-transport.ts` — real transport. Spawns `scripts/trezor-bridge/bridge.py` (Python `trezorlib`) over line-delimited JSON. Plumbing smoke-tested; not yet run against a real emulator.

## Next session — pick up here

### 1. Re-run the M0b emulator round-trip (✅ already done once)

```bash
# One-time:
scripts/trezor-bridge/setup.sh                            # venv with trezorlib
docker pull ghcr.io/trezor/trezor-user-env:latest         # ~5.25 GB

# Each run:
docker run -d --rm --name aztec-trezor-emu \
  -p 21324:21324/udp -p 21325:21325 -p 21326:21326 -p 9001:9001 \
  ghcr.io/trezor/trezor-user-env:latest

scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/start-emulator.py
scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/auto-confirm.py &
TREZOR_PATH=bridge:1 AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start
```

Last verified output: `Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): OK ✓`. Full play-by-play in [`lessons/phase-A-real-emulator-roundtrip.md`](implementations-plan/hw-wallet-poc-v0/lessons/phase-A-real-emulator-roundtrip.md).

### 2. Phase 0 — M0a baseline locally

The research recommended verifying `e2e_account_contracts.test.ts` from `aztec-packages` passes locally before declaring Phase A done. The aztec-packages monorepo bootstrap is heavy (yarn install + barretenberg build), so this needs a dedicated session. Skipped this run.

```bash
cd ~/Projects/aztec-packages
# Follow bootstrap.sh — likely 30-60 min on a fresh machine.
# Then run:
yarn test --workspace=@aztec/end-to-end e2e_account_contracts
```

### 3. Phase A.7 — pure-JS transport (after M0b is green)

Replace the Python subprocess with `@trezor/transport` + `@trezor/protobuf`. Codex flagged this as "the lowest JS-only escape hatch" — non-trivial. See `lessons/phase-A-codex-review-1.md` finding #4 for details.

## Where decisions live

- `docs/roadmap.md` — phase status, decisions log
- `implementations-plan/hw-wallet-poc-v0/lessons/` — codex reviews + design pivots
- `CLAUDE.md` — project conventions (inherits global `~/.claude/CLAUDE.md`)
- `../aztec-hardware-wallet/architectures/` — the upstream research that informed all of this

## How to verify everything works (locally)

```bash
bun install --frozen-lockfile     # or just `bun install` for local dev
bun run lint:all                  # biome + actionlint
bun run typecheck                 # tsc -b
bun test                          # 26/26 unit tests
bun run --cwd apps/demo start     # the headline demo
```

CI does the same in `.github/workflows/ci.yml`.

## Git state

10 commits, lowest-to-highest:

```
d17f31c chore: scaffold PoC project per my-stack
52ce71d feat(core): shared types + ECDSA helpers + Option A interface shape
ea9e0d7 feat(adapter-trezor): signidentity-based provider skeleton + slip-0013 identity
bac9576 chore: gitignore tsbuildinfo (accidentally committed)
e47ab3f feat(demo): phase-A CLI proves adapter round-trips through aztec's verifier
f5125d2 refactor(adapter-trezor): pivot to IdentityType + compressed pubkey per codex review
525d291 ci: add github actions workflow
0d7982b feat(adapter-trezor): real transport via python trezorlib subprocess bridge
d18c894 docs: add HANDOFF.md + update README with status
19a8042 fix(adapter-trezor): apply codex review #2 fixes to bridge transport
```

(`git log --oneline` may show one more for the plan.md addition.)

No remote configured. Push to a new GitHub repo when ready:

```bash
gh repo create aztec-hardware-wallet-poc --private --source=. --push
```

## Reviews captured

- `implementations-plan/hw-wallet-poc-v0/lessons/phase-A-codex-review-1.md` — adapter architecture, 8 findings, all applied (commit `f5125d2`).
- `implementations-plan/hw-wallet-poc-v0/lessons/phase-A-pivot-after-codex.md` — before/after table for review 1.
- `implementations-plan/hw-wallet-poc-v0/lessons/phase-A-bridge-codex-review-2.md` — bridge transport, 3 findings, all applied (commit `19a8042`).
- `implementations-plan/hw-wallet-poc-v0/plan.md` — post-hoc plan summary tying everything together.
