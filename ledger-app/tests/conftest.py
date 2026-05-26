"""
Ragger-based pytest harness for the Aztec Ledger app — L3 plan-final.md §216.

Runs the same APDU flow that `packages/adapter-ledger/src/provider.test.ts`
covers, but from the Python side, using Ledger's official `ragger` framework
so reviewers / auditors can re-run the test matrix with conventional tooling.

Backend: Speculos for both `nanos+` (nanosp) and `nanox`. Device selection is
driven by Ragger's standard `--device` flag.
"""

from ragger.conftest import configuration

# Default backend = speculos. Override via `--backend ledgerwallet` for HID.
# Per-function scope so the sign-with-UI tests get a fresh device state each
# time — session scope tripped over the NBGL review state machine.
configuration.OPTIONAL.BACKEND_SCOPE = "function"

# `find_application(project_root / "build" / "<device>" / "bin" / "app.elf")`
# is the default lookup, which matches `Makefile.standard_app` output.
# No `MAIN_APP_DIR` override needed.

# This is the standard ragger pytest plugin hook — pulling in all of ragger's
# fixtures (firmware, backend, navigator, etc.).
pytest_plugins = ("ragger.conftest.base_conftest",)
