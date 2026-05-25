#!/usr/bin/env python3
"""
Parallel helper: poll the trezor-user-env controller and press "yes" whenever the
emulator is waiting for confirmation. Run in the background while the demo executes.

Usage:
    scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/auto-confirm.py &
    AZTEC_HW_TRANSPORT=trezorlib TREZOR_PATH=bridge:1 bun run --cwd apps/demo start

Press Ctrl-C (SIGINT) to stop. Prints each successful press to stdout.
"""

import asyncio
import json
import sys
import time
from typing import Any

import websockets

CONTROLLER_URL = "ws://localhost:9001"


async def call(ws: Any, request: dict[str, Any]) -> dict[str, Any]:
    request_with_id = {"id": str(time.time_ns()), **request}
    await ws.send(json.dumps(request_with_id))
    while True:
        raw = await ws.recv()
        msg = json.loads(raw)
        if msg.get("id") == request_with_id["id"]:
            return msg


async def main() -> int:
    print(f"auto-confirm: connecting to {CONTROLLER_URL}", file=sys.stderr)
    async with websockets.connect(CONTROLLER_URL, max_size=2**24) as ws:
        # Drain welcome.
        try:
            await asyncio.wait_for(ws.recv(), timeout=2.0)
        except asyncio.TimeoutError:
            pass

        print("auto-confirm: armed; pressing 'yes' every 1s while a prompt is pending", file=sys.stderr)
        while True:
            try:
                resp = await call(ws, {"type": "emulator-press-yes"})
                if resp.get("success", True) and resp.get("response"):
                    print(f"auto-confirm: pressed yes ({resp['response']})", file=sys.stderr)
            except Exception as exc:
                # Most likely: no prompt currently pending. Quiet.
                pass
            await asyncio.sleep(1.0)


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
