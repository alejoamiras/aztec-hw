"""Dispatcher-level rejections — bad CLA / INS / P1-P2 combinations."""

from application_client.aztec_command_sender import CLA, Ins, SW, expect_failure


def test_invalid_cla(backend):
    with expect_failure(backend):
        rapdu = backend.exchange(cla=0xCA, ins=Ins.GET_VERSION, p1=0, p2=0, data=b"")
    assert rapdu.status == SW.INVALID_CLA


def test_invalid_ins(backend):
    with expect_failure(backend):
        rapdu = backend.exchange(cla=CLA, ins=0xFF, p1=0, p2=0, data=b"")
    assert rapdu.status == SW.INVALID_INS


def test_get_version_rejects_nonzero_p1(backend):
    with expect_failure(backend):
        rapdu = backend.exchange(cla=CLA, ins=Ins.GET_VERSION, p1=1, p2=0, data=b"")
    assert rapdu.status == SW.INCORRECT_P1_P2


def test_get_caps_rejects_nonzero_p2(backend):
    with expect_failure(backend):
        rapdu = backend.exchange(cla=CLA, ins=Ins.GET_CAPS, p1=0, p2=1, data=b"")
    assert rapdu.status == SW.INCORRECT_P1_P2


def test_abort_on_idle_returns_ok(backend):
    """ABORT is idempotent — clearing an already-empty session is OK (SW=9000)."""
    rapdu = backend.exchange(cla=CLA, ins=Ins.ABORT, p1=0, p2=0, data=b"")
    assert rapdu.status == SW.OK


def test_append_before_begin_rejected(backend):
    """APPEND_CALL outside an L4 session must be rejected as SW_INVALID_INS.

    State machine guard: append is only valid after BEGIN_AUTHWIT (codex L4
    deep-plan §2 "Recovery/state").
    """
    # First make sure no session is active.
    backend.exchange(cla=CLA, ins=Ins.ABORT, p1=0, p2=0, data=b"")
    # 97-byte body (args_hash + selector + target + flags) but state is wrong.
    body = b"\x00" * 32 + b"\x00" * 28 + b"\x00\x00\x00\x01" + b"\x00" * 32 + b"\x01"
    with expect_failure(backend):
        rapdu = backend.exchange(cla=CLA, ins=Ins.APPEND_CALL, p1=0, p2=0, data=body)
    assert rapdu.status == SW.INVALID_INS


def test_finalize_before_begin_rejected(backend):
    """FINALIZE_AND_SIGN outside an L4 session must be rejected as SW_INVALID_INS."""
    backend.exchange(cla=CLA, ins=Ins.ABORT, p1=0, p2=0, data=b"")
    with expect_failure(backend):
        rapdu = backend.exchange(
            cla=CLA, ins=Ins.FINALIZE_AND_SIGN, p1=0, p2=0, data=b"\x00" * 32
        )
    assert rapdu.status == SW.INVALID_INS
