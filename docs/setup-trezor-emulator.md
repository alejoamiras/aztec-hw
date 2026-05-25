# Setup — Trezor emulator + real bridge

Goal: run the Phase-A demo against the real `trezor-firmware` emulator (or a physical device), not the in-process fake transport.

## Prerequisites

- Python 3.10+ (verified working: Python 3.14.4 on macOS).
- A running `trezor-firmware` emulator on `udp:127.0.0.1:21324`, OR a physical Trezor Safe/Model T connected.

## One-time install — Python bridge

```bash
scripts/trezor-bridge/setup.sh
```

Creates `scripts/trezor-bridge/venv/` and installs `trezor==0.13.10` + transitive deps. Pinning is intentional (mirrors the JS-side 7-day npm gate for supply-chain hygiene).

Smoke test the bridge talks to the device (will fail with `No Trezor device found` if nothing's connected):

```bash
echo '{"op":"ping"}' | scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/bridge.py
```

## Start the emulator

Two paths:

### Option A — build from source (most flexible)

```bash
# In a separate clone, NOT the PoC repo:
git clone https://github.com/trezor/trezor-firmware
cd trezor-firmware
# Follow trezor-firmware/core/docs/build/embedded.md for emulator build.
# Quick path on macOS:
brew install scons protobuf sdl2 sdl2_image
make -C core build_unix
core/build/unix/trezor-emu-core
```

The emulator listens on `udp:127.0.0.1:21324` by default — matches `TrezorlibSubprocessTransport`'s default `TREZOR_PATH`.

### Option B — Docker image (fastest)

```bash
docker run -it -p 21324:21324/udp ghcr.io/trezor/trezor-firmware/trezor-emu:latest
```

(Confirm the image tag against https://github.com/trezor/trezor-firmware/pkgs/container/trezor-firmware%2Ftrezor-emu before relying on it.)

## Run the demo against the real transport

```bash
AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start
```

The demo will:

1. Spawn `scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/bridge.py`.
2. Send a `sign_identity` JSON request for `gpg://aztec/account/0` + a zero digest (probe sign for pubkey).
3. Send a real `sign_identity` request for `sha256(outer_hash.to_be_bytes())`.
4. Decompress the 33B pubkey to 64B `x ‖ y`.
5. Strip the 0x00 marker byte from the signature.
6. Low-s normalize.
7. Pack as `AuthWitness`.
8. Verify against Aztec's TS `Ecdsa.verifySignature` — should print `OK ✓`.

If anything fails, the bridge's traceback comes back as JSON in the demo's stderr. Inspect with `--inspect-brk` on the Bun side or run the Python script standalone.

## Pointing at a physical device instead of the emulator

```bash
TREZOR_PATH=usb AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start
```

(or `bridge:` to go through `trezord`, etc. — see `trezorlib.transport.get_transport` for the URI grammar.)

## Limitations of this transport

- **Python dependency**. The pure-JS alternative is a `@trezor/transport` + `@trezor/protobuf` client; see roadmap Phase A.7.
- **Single-process bridge**. One spawn per `TrezorlibSubprocessTransport` instance; the demo reuses one bridge for both the pubkey probe and the real sign.
- **stderr inherited**. Python tracebacks print to the parent's stderr. Acceptable for the PoC; would be a structured JSON channel for a production adapter.
- **No PIN / passphrase UI**. The bridge uses `trezorlib.ui.ClickUI` which prompts on the device + CLI for PIN entry. For the emulator with no PIN set, this is transparent.
