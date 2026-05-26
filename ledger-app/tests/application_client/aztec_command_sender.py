"""
Typed APDU client for the Aztec Ledger app. Mirrors the TS
`packages/adapter-ledger/src/apdu.ts` constants; if either side drifts the
ragger tests catch the drift before it ships.
"""

from dataclasses import dataclass
from enum import IntEnum
from typing import Iterable

from contextlib import contextmanager

from ragger.backend import BackendInterface
from ragger.backend.interface import RAPDU, RaisePolicy


CLA = 0xE0


class Ins(IntEnum):
    GET_VERSION = 0x01
    GET_CAPS = 0x02
    GET_PUBLIC_KEY = 0x03
    SIGN_OUTER_HASH = 0x04
    BEGIN_AUTHWIT = 0x05  # L4
    APPEND_CALL = 0x06  # L4
    FINALIZE_AND_SIGN = 0x07  # L4
    ABORT = 0x08  # L4


class SW(IntEnum):
    OK = 0x9000
    USER_REJECTED = 0x6985  # CONDITIONS_NOT_SATISFIED
    WRONG_DATA_LENGTH = 0x6A87
    INCORRECT_P1_P2 = 0x6A86
    INVALID_INS = 0x6D00
    INVALID_CLA = 0x6E00
    UNKNOWN = 0x6F00
    HASH_MISMATCH = 0x6F01
    UNKNOWN_MANIFEST_VERSION = 0x6F02
    INVALID_PATH_SCHEME = 0x6F03
    INVALID_CURVE_ID = 0x6F04
    BIP32_TOO_LONG = 0x6F05
    DUP_SIG_MISMATCH = 0x6F06


@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int


def encode_bip32_path(path: Iterable[int]) -> bytes:
    """Encode a BIP-32 path as `len(1) || components(4 each BE)`. Strict uint32 validation."""
    components = list(path)
    if not 1 <= len(components) <= 10:
        raise ValueError(f"BIP-32 path length must be 1..10, got {len(components)}")
    out = bytes([len(components)])
    for i, v in enumerate(components):
        if not isinstance(v, int) or v < 0 or v > 0xFFFFFFFF:
            raise ValueError(f"BIP-32 component {i} must be uint32, got {v!r}")
        out += v.to_bytes(4, "big")
    return out


def hardened(index: int) -> int:
    """Mark a BIP-32 component as hardened. Validates uint31 input."""
    if not 0 <= index <= 0x7FFFFFFF:
        raise ValueError(f"hardened: index must be uint31, got {index}")
    return 0x80000000 | index


# Aztec SLIP-44 placeholder; mirrors device-side AZTEC_COIN_TYPE default.
AZTEC_COIN_TYPE = 1666


def default_aztec_path(account: int = 0) -> list[int]:
    """`m/44'/AZTEC_COIN_TYPE'/{account}'/0/0`."""
    return [hardened(44), hardened(AZTEC_COIN_TYPE), hardened(account), 0, 0]


@contextmanager
def expect_failure(backend: BackendInterface):
    """Context manager that lets ragger return error SWs instead of raising."""
    previous = backend.raise_policy
    backend.raise_policy = RaisePolicy.RAISE_NOTHING
    try:
        yield
    finally:
        backend.raise_policy = previous


class AztecCommandSender:
    """Thin APDU send/recv shim. Tests own the navigation themselves via ragger."""

    def __init__(self, backend: BackendInterface):
        self.backend = backend

    def get_version(self) -> RAPDU:
        return self.backend.exchange(cla=CLA, ins=Ins.GET_VERSION, p1=0, p2=0, data=b"")

    def get_caps(self) -> RAPDU:
        return self.backend.exchange(cla=CLA, ins=Ins.GET_CAPS, p1=0, p2=0, data=b"")

    def get_public_key(self, path: list[int]) -> RAPDU:
        return self.backend.exchange(
            cla=CLA, ins=Ins.GET_PUBLIC_KEY, p1=0, p2=0, data=encode_bip32_path(path)
        )

    def get_public_key_raw(self, payload: bytes, p1: int = 0, p2: int = 0) -> RAPDU:
        """Escape hatch for malformed-APDU tests."""
        return self.backend.exchange(cla=CLA, ins=Ins.GET_PUBLIC_KEY, p1=p1, p2=p2, data=payload)

    def sign_outer_hash(self, path: list[int], outer_hash: bytes) -> RAPDU:
        if len(outer_hash) != 32:
            raise ValueError(f"outer_hash must be 32 bytes, got {len(outer_hash)}")
        body = encode_bip32_path(path) + outer_hash
        return self.backend.exchange(
            cla=CLA, ins=Ins.SIGN_OUTER_HASH, p1=0, p2=0, data=body
        )

    def sign_outer_hash_async(self, path: list[int], outer_hash: bytes):
        """Async variant for the sign flow that needs user confirmation."""
        if len(outer_hash) != 32:
            raise ValueError(f"outer_hash must be 32 bytes, got {len(outer_hash)}")
        body = encode_bip32_path(path) + outer_hash
        return self.backend.exchange_async(
            cla=CLA, ins=Ins.SIGN_OUTER_HASH, p1=0, p2=0, data=body
        )

    def sign_outer_hash_raw(self, payload: bytes, p1: int = 0, p2: int = 0) -> RAPDU:
        return self.backend.exchange(
            cla=CLA, ins=Ins.SIGN_OUTER_HASH, p1=p1, p2=p2, data=payload
        )


def parse_version(rapdu: RAPDU) -> Version:
    if rapdu.status != SW.OK:
        raise ValueError(f"GET_VERSION returned SW=0x{rapdu.status:04x}")
    if len(rapdu.data) != 3:
        raise ValueError(f"GET_VERSION expected 3 bytes, got {len(rapdu.data)}")
    return Version(major=rapdu.data[0], minor=rapdu.data[1], patch=rapdu.data[2])


def parse_caps(rapdu: RAPDU) -> int:
    if rapdu.status != SW.OK:
        raise ValueError(f"GET_CAPS returned SW=0x{rapdu.status:04x}")
    if len(rapdu.data) != 4:
        raise ValueError(f"GET_CAPS expected 4 bytes, got {len(rapdu.data)}")
    return int.from_bytes(rapdu.data, "big")


def parse_public_key(rapdu: RAPDU) -> tuple[bytes, bytes]:
    """Returns `(x, y)` as 32-byte BE buffers."""
    if rapdu.status != SW.OK:
        raise ValueError(f"GET_PUBLIC_KEY returned SW=0x{rapdu.status:04x}")
    if len(rapdu.data) != 64:
        raise ValueError(f"GET_PUBLIC_KEY expected 64 bytes (X||Y), got {len(rapdu.data)}")
    return rapdu.data[:32], rapdu.data[32:]


def parse_signature(rapdu: RAPDU) -> tuple[bytes, bytes]:
    """Returns `(r, s)` as 32-byte BE buffers."""
    if rapdu.status != SW.OK:
        raise ValueError(f"SIGN_OUTER_HASH returned SW=0x{rapdu.status:04x}")
    if len(rapdu.data) != 64:
        raise ValueError(f"SIGN_OUTER_HASH expected 64 bytes (r||s), got {len(rapdu.data)}")
    return rapdu.data[:32], rapdu.data[32:]
