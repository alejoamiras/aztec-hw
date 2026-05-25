#!/usr/bin/env bash
# Sets up a Python virtualenv with trezorlib for the bridge script.
# Run once after cloning the repo, before invoking the bridge.
#
# Usage:
#     scripts/trezor-bridge/setup.sh
#
# Then start the bridge with:
#     scripts/trezor-bridge/venv/bin/python scripts/trezor-bridge/bridge.py
# (the TS-side TrezorlibSubprocessTransport spawns this automatically).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 not on PATH. Install Python 3.10+ first." >&2
  exit 1
fi

if [ ! -d "$DIR/venv" ]; then
  python3 -m venv "$DIR/venv"
  echo "Created venv at $DIR/venv"
fi

"$DIR/venv/bin/pip" install --upgrade pip
"$DIR/venv/bin/pip" install -r "$DIR/requirements.txt"

echo ""
echo "trezor-bridge venv ready at $DIR/venv"
echo "Try:"
echo "  $DIR/venv/bin/python $DIR/bridge.py"
echo "  (expects JSON requests on stdin; see bridge.py header)"
