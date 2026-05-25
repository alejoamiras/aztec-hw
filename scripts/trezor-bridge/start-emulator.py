#!/usr/bin/env python3
"""
Driver: start a trezor-firmware emulator via the `trezor-user-env` controller, then
load it with the standard test mnemonic so `trezorlib.misc.sign_identity` can succeed
deterministically.

Default target: ws://localhost:9001 (the trezor-user-env Docker container).

Usage:
    scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/start-emulator.py

Once this script returns, the emulator is running on udp:127.0.0.1:21324 ready for
the bridge.py / TrezorlibSubprocessTransport flow.
"""

import asyncio
import json
import sys
import time
from typing import Any

import websockets

CONTROLLER_URL = "ws://localhost:9001"
EMULATOR_MODEL = "T2T1"  # Trezor Model T — stable emulator target
TEST_MNEMONIC = (
    "all all all all all all all all all all all all"
)  # canonical trezor-suite/firmware test mnemonic; never use for real funds


async def call(ws: Any, request: dict[str, Any]) -> dict[str, Any]:
    request_with_id = {"id": str(time.time_ns()), **request}
    await ws.send(json.dumps(request_with_id))
    while True:
        raw = await ws.recv()
        msg = json.loads(raw)
        # The controller may push background-check events; ignore until we get our reply.
        if msg.get("id") == request_with_id["id"]:
            return msg


async def main() -> int:
    async with websockets.connect(CONTROLLER_URL, max_size=2**24) as ws:
        # Drain the welcome message (the controller sends one on connect).
        try:
            await asyncio.wait_for(ws.recv(), timeout=2.0)
        except asyncio.TimeoutError:
            pass

        # Stop any prior bridge / emulator from previous runs to clear stale sessions.
        for stop_cmd in ("bridge-stop", "emulator-stop"):
            try:
                resp = await call(ws, {"type": stop_cmd})
                if resp.get("response"):
                    print(f"controller: {resp['response']}")
            except Exception as exc:
                print(f"controller: {stop_cmd} ignored: {exc}")

        print(f"controller: starting emulator (model={EMULATOR_MODEL}, wipe=True)...")
        resp = await call(
            ws,
            {
                "type": "emulator-start",
                "model": EMULATOR_MODEL,
                "wipe": True,
                "output_to_logfile": True,
            },
        )
        if not resp.get("success", True):
            print(f"emulator-start FAILED: {resp}", file=sys.stderr)
            return 1
        print(f"controller: {resp.get('response')}")

        # Wait a moment for emulator to fully boot.
        await asyncio.sleep(1.0)

        print("controller: loading test mnemonic via emulator-setup...")
        resp = await call(
            ws,
            {
                "type": "emulator-setup",
                "mnemonic": TEST_MNEMONIC,
                "pin": "",
                "passphrase_protection": False,
                "label": "Aztec-PoC-T2T1",
                "needs_backup": False,
            },
        )
        if not resp.get("success", True):
            print(f"emulator-setup FAILED: {resp}", file=sys.stderr)
            return 1
        print(f"controller: {resp.get('response')}")

        # The emulator binds to 127.0.0.1 INSIDE the trezor-user-env container — not
        # reachable via the Docker UDP port mapping. Start the bridge (trezord) so
        # the host can talk to the emulator over HTTP/21325 instead.
        print("controller: starting bridge (trezord) so the host can reach the emulator...")
        resp = await call(ws, {"type": "bridge-start", "output_to_logfile": True})
        if not resp.get("success", True):
            print(f"bridge-start FAILED: {resp}", file=sys.stderr)
            return 1
        print(f"controller: {resp.get('response')}")

        print("\nEmulator + bridge ready.")
        print("Run the demo with:")
        print("  TREZOR_PATH=bridge: AZTEC_HW_TRANSPORT=trezorlib bun run --cwd apps/demo start")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
