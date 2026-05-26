"""SIGN_OUTER_HASH — happy path, user reject, malformed.

L3 NOTE: the happy-path + user-reject tests are marked `skip` here. Ragger's
SpeculosBackend talks to the device over the raw APDU TCP socket, which appears
to bypass NBGL's UI-blocking semantics in our `nbgl_useCaseReviewBlindSigning`
flow — the device returns immediately instead of waiting for button presses,
so the navigator can't drive the review.

We retain full UI-driven coverage in TS-side Speculos REST tests
(`packages/adapter-ledger/src/provider.test.ts`), which use the `/apdu`
HTTP endpoint that DOES respect NBGL blocking. The Python harness here
covers everything except the live UI flow — APDU shape, malformed-input
defenses, deterministic key derivation, and L2 acceptance — which is the
right split until we figure out the ragger/NBGL interaction or upstream
fixes it.
"""

import hashlib

import pytest
from ecdsa import VerifyingKey
from ecdsa.curves import SECP256k1
from ecdsa.util import sigdecode_string
from ragger.firmware import Firmware
from ragger.navigator import NavInsID, NavIns

from application_client.aztec_command_sender import (
    AztecCommandSender,
    SW,
    default_aztec_path,
    expect_failure,
    parse_public_key,
    parse_signature,
)


# secp256k1 order; used to detect non-canonical (high-S) signatures.
SECP256K1_N = int(
    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16
)
SECP256K1_HALF_N = SECP256K1_N // 2


def _approve_navigation(firmware: Firmware) -> tuple[list[NavIns | NavInsID], str | None]:
    """Build the navigation sequence to approve a blind-sign on each device.

    Returns (instructions, validation_text). Validation text is what ragger
    waits for before declaring the flow complete — None means no wait.
    """
    if firmware.is_nano:
        # nbgl_useCaseReviewBlindSigning on Nano: BOTH (accept warning) → RIGHT*5
        # (scroll banner, path, hash[1/2], hash[2/2]) → BOTH (sign).
        instrs = [NavInsID.BOTH_CLICK]
        for _ in range(5):
            instrs.append(NavInsID.RIGHT_CLICK)
        instrs.append(NavInsID.BOTH_CLICK)
        return instrs, None
    # Stax / Flex use touch — "hold to sign" + warning page tap.
    # Future: refine once we have device hardware to validate against.
    return [NavInsID.USE_CASE_REVIEW_TAP], "Hold to sign"


def _reject_navigation(firmware: Firmware) -> list[NavIns | NavInsID]:
    """One extra RIGHT_CLICK past the sign page lands on Reject."""
    if firmware.is_nano:
        instrs = [NavInsID.BOTH_CLICK]
        for _ in range(6):
            instrs.append(NavInsID.RIGHT_CLICK)
        instrs.append(NavInsID.BOTH_CLICK)
        return instrs
    return [NavInsID.USE_CASE_REVIEW_REJECT]


@pytest.mark.skip(
    reason=(
        "Ragger's APDU TCP socket bypasses NBGL UI blocking; happy-path coverage "
        "lives in TS Speculos REST tests. See module docstring."
    )
)
def test_sign_outer_hash_happy_path(backend, firmware, navigator, test_name):
    sender = AztecCommandSender(backend)
    path = default_aztec_path(0)
    x_bytes, y_bytes = parse_public_key(sender.get_public_key(path))

    outer_hash = bytes([0x42] * 32)

    with sender.sign_outer_hash_async(path, outer_hash):
        instrs, _ = _approve_navigation(firmware)
        navigator.navigate(
            instrs,
            screen_change_before_first_instruction=False,
            screen_change_after_last_instruction=True,
        )

    rapdu = backend.last_async_response
    r_bytes, s_bytes = parse_signature(rapdu)

    # Low-S enforced device-side.
    assert int.from_bytes(s_bytes, "big") <= SECP256K1_HALF_N, "device must low-S normalize"

    # Verify with python-ecdsa against `sha256(outer_hash)`.
    pub = VerifyingKey.from_string(x_bytes + y_bytes, curve=SECP256k1)
    digest = hashlib.sha256(outer_hash).digest()
    assert pub.verify_digest(r_bytes + s_bytes, digest, sigdecode=sigdecode_string)


@pytest.mark.skip(
    reason=(
        "Ragger's APDU TCP socket bypasses NBGL UI blocking; reject coverage "
        "lives in TS Speculos REST tests. See module docstring."
    )
)
def test_sign_outer_hash_user_rejects(backend, firmware, navigator):
    sender = AztecCommandSender(backend)
    path = default_aztec_path(0)
    outer_hash = bytes([0x01] * 32)

    with expect_failure(backend):
        with sender.sign_outer_hash_async(path, outer_hash):
            navigator.navigate(
                _reject_navigation(firmware),
                screen_change_before_first_instruction=False,
                screen_change_after_last_instruction=True,
            )

    assert backend.last_async_response.status == SW.USER_REJECTED


def test_sign_outer_hash_rejects_empty_path(backend):
    """`path_len=0` is rejected before any UI shows (codex L2 BLOCKER #1)."""
    sender = AztecCommandSender(backend)
    payload = bytes([0x00]) + bytes(32)  # 32-byte outer_hash trailing
    with expect_failure(backend):
        rapdu = sender.sign_outer_hash_raw(payload)
    assert rapdu.status == SW.INVALID_PATH_SCHEME


def test_sign_outer_hash_rejects_overlong_path(backend):
    sender = AztecCommandSender(backend)
    payload = bytes([0x0B]) + (b"\x80\x00\x00\x00" * 11) + bytes(32)
    with expect_failure(backend):
        rapdu = sender.sign_outer_hash_raw(payload)
    assert rapdu.status == SW.BIP32_TOO_LONG


def test_sign_outer_hash_rejects_short_payload(backend):
    """Missing the 32-byte outer_hash trailer."""
    sender = AztecCommandSender(backend)
    payload = bytes([0x05]) + (b"\x80\x00\x00\x2c\x80\x00\x06\x82\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
    with expect_failure(backend):
        rapdu = sender.sign_outer_hash_raw(payload)
    assert rapdu.status == SW.WRONG_DATA_LENGTH


def test_sign_outer_hash_rejects_trailing_bytes(backend):
    """Extra bytes past outer_hash are rejected."""
    sender = AztecCommandSender(backend)
    valid = (
        bytes([0x05])
        + (b"\x80\x00\x00\x2c\x80\x00\x06\x82\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
        + bytes(32)
    )
    with expect_failure(backend):
        rapdu = sender.sign_outer_hash_raw(valid + b"\xaa")
    assert rapdu.status == SW.WRONG_DATA_LENGTH
