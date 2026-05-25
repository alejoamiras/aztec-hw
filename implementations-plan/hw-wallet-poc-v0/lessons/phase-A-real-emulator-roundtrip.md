# Phase A — Real emulator round-trip (M0b green)

> **Status**: ✅ Phase A's headline goal achieved 2026-05-25.
> **Verdict line from the demo**: `Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): OK ✓`

A signature produced by a real `trezor-firmware` emulator (T2T1 / Model T, test mnemonic
`"all all all all all all all all all all all all"`) for an Aztec `outer_hash` of
`0x0000…0539` verifies under `@aztec/foundation/crypto/ecdsa.Ecdsa.verifySignature` —
the TS-equivalent of the `EcdsaKAccount` Noir circuit verifier.

## Reproduce locally

```bash
# 0. one-time
scripts/trezor-bridge/setup.sh                       # installs trezorlib in venv
docker pull ghcr.io/trezor/trezor-user-env:latest    # ~5.25 GB

# 1. start the emulator stack
docker run -d --rm --name aztec-trezor-emu \
  -p 21324:21324/udp -p 21325:21325 -p 21326:21326 -p 9001:9001 \
  ghcr.io/trezor/trezor-user-env:latest

# Wait ~5s for the controller to come up, then drive it:
scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/start-emulator.py

# 2. start the auto-confirm watcher (presses YES on every emulator confirmation)
scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/auto-confirm.py &

# 3. run the demo
TREZOR_PATH=bridge:1 AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start
```

Expected output ends with `OK ✓`. The device's `x, y` for `gpg://aztec/account/0` against the test mnemonic is:

```
x = 0x6c3383a056225de7df6b4c5e55ac0f979f096a2ddf7775802a9aced046eaa213
y = 0x0b2657d41da1a96341a0f06d3a3e1c6a74e9389c1accf2137597f953dadde85c
```

(Recorded for regression. Different mnemonic → different key. Same mnemonic + same identity → deterministic.)

## What it took (beyond the bridge code)

The bridge transport code was correct first try (codex review #2's blessing held). The extra infra was all about *getting an emulator running* and *clearing trezord sessions*:

1. **`trezor-user-env` Docker image** (`ghcr.io/trezor/trezor-user-env:latest`) — bundles the emulator, a Node-based trezord ("node-bridge"), and a Twisted WebSocket controller on port 9001.

2. **`scripts/trezor-bridge/start-emulator.py`** — sends three WebSocket commands to the controller in sequence:
   - `bridge-stop` + `emulator-stop` (clears stale state from previous runs)
   - `emulator-start` with `model: T2T1`, `wipe: true`
   - `emulator-setup` with the canonical test mnemonic + empty PIN + no passphrase
   - `bridge-start` (launches trezord inside the container, exposed via `-p 21325:21325`)

3. **`scripts/trezor-bridge/auto-confirm.py`** — parallel loop that hits `emulator-press-yes` on the controller every second. Required because the emulator displays a confirmation dialog for every `SignIdentity` call and `ClickUI` (in bridge.py) doesn't auto-press for emulator testing.

4. **`TREZOR_PATH=bridge:1`** in the demo env — tells `trezorlib.transport.get_transport` to use the `bridge:` transport (HTTP to trezord on `localhost:21325`) and address device path `1` (the only device trezord enumerates from the emulator). The UDP `udp:127.0.0.1:21324` path doesn't work because the emulator binds to the *container's* loopback — not reachable via Docker port mapping.

## Bug found + fixed during this exercise

**`FirmwareError: Signing failed` on probe sign**. The adapter's `getPublicKeyXY()` issued a probe `SignIdentity` with a 32-byte all-zero `challenge_hidden`. The real Trezor firmware rejects all-zero scalars (sanity check, never seen documented but reproducible). **Fix**: demo now calls `createAuthWit(outerHash)` *first* with a real non-zero scalar, which populates the pubkey cache as a side effect. `getPublicKeyXY()` then reads from cache — no separate probe sign needed in this flow.

The unit-test mock transport happily signs zero digests (noble doesn't reject), so this bug only surfaced with the real device.

## Carry-forwards (now lower priority)

- **`ClickUI` blocking** (codex review #2, finding #1) — only matters for Trezor One PIN entry. Documented; not blocking emulator + Safe/Model T.
- **Session leak on hard kill** — if bridge.py is SIGKILL'd, trezord retains an `acquire`d session. Mitigation: re-running `start-emulator.py` cycles bridge-stop+start, clearing it. Production adapter would use trezord's `/release/<session>` endpoint explicitly.
- **Two-confirmation flow** — removed by the createAuthWit-first reorder. One emulator press per `createAuthWit` now.
- **Pure-JS transport (Phase A.7)** — still worth doing, but not blocking M0b. Codex estimate stands: 2–4 engineer-days for emulator-only.

## Outstanding open items toward Phase A done

- Run M0a baseline (`e2e_account_contracts.test.ts` from `aztec-packages`) — separate session, requires `bun install` of the Aztec monorepo + barretenberg build.
- End-to-end test with the **actual Noir circuit verifier** (not just the TS equivalent). The TS verifier wraps barretenberg's C++ ECDSA which is what the Noir circuit ultimately delegates to, so this is high-confidence pass-by-construction — but should still be exercised before declaring Phase A done.
