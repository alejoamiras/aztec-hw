"""GET_VERSION smoke test."""

from application_client.aztec_command_sender import (
    AztecCommandSender,
    parse_version,
)


def test_get_version_returns_major_minor_patch(backend):
    sender = AztecCommandSender(backend)
    v = parse_version(sender.get_version())
    # Mirror APPVERSION in ledger-app/Makefile — bump both together.
    assert (v.major, v.minor, v.patch) == (0, 0, 1)
