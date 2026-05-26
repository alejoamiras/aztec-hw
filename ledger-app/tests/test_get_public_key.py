"""GET_PUBLIC_KEY tests — Aztec K1 path returns 64B X||Y."""

from ecdsa.curves import SECP256k1
from ecdsa.ellipticcurve import Point

from application_client.aztec_command_sender import (
    AztecCommandSender,
    SW,
    default_aztec_path,
    expect_failure,
    parse_public_key,
)


def test_get_public_key_aztec_path_is_on_secp256k1(backend):
    sender = AztecCommandSender(backend)
    x_bytes, y_bytes = parse_public_key(sender.get_public_key(default_aztec_path(0)))
    assert len(x_bytes) == 32
    assert len(y_bytes) == 32
    # Verify on-curve: instantiates only if (x, y) satisfies y² = x³ + 7 (mod p).
    x = int.from_bytes(x_bytes, "big")
    y = int.from_bytes(y_bytes, "big")
    Point(SECP256k1.curve, x, y)


def test_get_public_key_deterministic_under_speculos_default_seed(backend):
    """Speculos boots with a fixed seed, so this is a stable golden vector."""
    sender = AztecCommandSender(backend)
    x_bytes, y_bytes = parse_public_key(sender.get_public_key(default_aztec_path(0)))
    # Pinned for path `m/44'/1666'/0'/0/0` under Speculos default seed.
    assert x_bytes.hex() == (
        "01f24e6b309b2f8ceea2a0ddd34e70d822ad1cdf717310fda1ff163ca8c29711"
    )
    assert y_bytes.hex() == (
        "a34d08d19ae279b8b01d9558d43cc8ee57ee2735d36b1dd8c8dfbeba17df71c0"
    )


def test_get_public_key_rejects_empty_path(backend):
    """`path_len=0` is a malformed-APDU defense (codex L2 BLOCKER #1)."""
    sender = AztecCommandSender(backend)
    with expect_failure(backend):
        rapdu = sender.get_public_key_raw(bytes([0x00]))  # just the length byte
    assert rapdu.status == SW.INVALID_PATH_SCHEME


def test_get_public_key_rejects_overlong_path(backend):
    """`path_len > 10` returns SW_BIP32_TOO_LONG (distinct from invalid-scheme)."""
    sender = AztecCommandSender(backend)
    payload = bytes([0x0B]) + (b"\x80\x00\x00\x00" * 11)
    with expect_failure(backend):
        rapdu = sender.get_public_key_raw(payload)
    assert rapdu.status == SW.BIP32_TOO_LONG


def test_get_public_key_rejects_trailing_bytes(backend):
    """Padding after the path is rejected (defense vs. host framing bugs)."""
    sender = AztecCommandSender(backend)
    valid = bytes([0x05]) + (b"\x80\x00\x00\x2c\x80\x00\x06\x82\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
    payload = valid + b"\xaa\xaa"
    with expect_failure(backend):
        rapdu = sender.get_public_key_raw(payload)
    assert rapdu.status == SW.WRONG_DATA_LENGTH


def test_get_public_key_rejects_p1_display_mode(backend):
    """L2 build rejects the display-mode flag (L4 will implement it)."""
    sender = AztecCommandSender(backend)
    valid = bytes([0x05]) + (b"\x80\x00\x00\x2c\x80\x00\x06\x82\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
    with expect_failure(backend):
        rapdu = sender.get_public_key_raw(valid, p1=1)
    assert rapdu.status == SW.INCORRECT_P1_P2
