#!/usr/bin/env python3
"""
Trezor SignIdentity bridge for the Aztec HW-wallet PoC.

Reads JSON requests from stdin (one per line), writes JSON responses to stdout.

Each request:
    {
      "op": "sign_identity",
      "identity": {
        "proto": "gpg",
        "host": "aztec",
        "path": "/account/0",
        "index": 0
      },
      "ecdsa_curve": "secp256k1",
      "challenge_hidden_hex": "<64-char hex string for 32-byte digest>",
      "challenge_visual": "Aztec authorization (INTERNAL — DO NOT SHIP)"
    }

Each response:
    {
      "ok": true,
      "compressed_public_key_hex": "<66-char hex; 33-byte compressed key>",
      "signature_hex": "<130-char hex; 65-byte signature, byte 0 is 0x00 for gpg>"
    }
  or
    {
      "ok": false,
      "error": "<message>"
    }

Targets the trezor-firmware emulator by default (transport = `udp:127.0.0.1:21324`).
Override via the TREZOR_PATH environment variable for a physical device.
"""

import json
import os
import sys
import traceback
from typing import Any

try:
    from trezorlib import messages, misc
    from trezorlib.client import TrezorClient
    from trezorlib.transport import get_transport
    from trezorlib.ui import ClickUI
except ImportError:
    print(
        json.dumps(
            {
                "ok": False,
                "error": (
                    "trezorlib not installed. Run scripts/trezor-bridge/setup.sh first, "
                    "or activate the venv and `pip install -r scripts/trezor-bridge/requirements.txt`."
                ),
            }
        ),
        flush=True,
    )
    sys.exit(1)


def _connect() -> TrezorClient:
    path = os.environ.get("TREZOR_PATH", "udp:127.0.0.1:21324")
    transport = get_transport(path)
    return TrezorClient(transport=transport, ui=ClickUI())


def _identity_from(req: dict[str, Any]) -> messages.IdentityType:
    raw = req["identity"]
    return messages.IdentityType(
        proto=raw.get("proto"),
        user=raw.get("user") or None,
        host=raw.get("host"),
        port=raw.get("port") or None,
        path=raw.get("path"),
        index=raw.get("index", 0),
    )


def _handle(client: TrezorClient, req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op")
    if op == "sign_identity":
        identity = _identity_from(req)
        challenge_hidden = bytes.fromhex(req["challenge_hidden_hex"])
        if len(challenge_hidden) != 32:
            return {
                "ok": False,
                "error": f"challenge_hidden must be 32 bytes, got {len(challenge_hidden)}",
            }
        challenge_visual = req.get("challenge_visual", "")
        ecdsa_curve = req.get("ecdsa_curve", "secp256k1")
        signed = misc.sign_identity(
            client,
            identity,
            challenge_hidden,
            challenge_visual,
            ecdsa_curve_name=ecdsa_curve,
        )
        # signed is a SignedIdentity protobuf with .public_key (bytes) and .signature (bytes).
        return {
            "ok": True,
            "compressed_public_key_hex": signed.public_key.hex(),
            "signature_hex": signed.signature.hex(),
        }
    if op == "ping":
        return {"ok": True, "pong": True}
    return {"ok": False, "error": f"unknown op: {op}"}


def main() -> int:
    client: TrezorClient | None = None
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                sys.stdout.write(json.dumps({"ok": False, "error": f"bad json: {exc}"}) + "\n")
                sys.stdout.flush()
                continue

            try:
                # _connect() is inside the try so transport errors (wrong path, no device,
                # uninitialized emulator) surface as JSON, not as a silent child exit.
                if client is None:
                    client = _connect()
                resp = _handle(client, req)
            except Exception as exc:  # noqa: BLE001 — surface bridge errors as JSON to TS side
                resp = {
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(),
                }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
    finally:
        if client is not None:
            client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
