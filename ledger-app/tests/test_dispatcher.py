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


def test_l4_instructions_reserved_with_dedicated_sw(backend):
    """BEGIN_AUTHWIT / APPEND_CALL / FINALIZE_AND_SIGN / ABORT return SW_NOT_IMPLEMENTED.

    Distinct from SW_INVALID_INS so the host can tell "wrong byte" from
    "right byte, future feature" (L4 spec freeze).
    """
    for ins in (Ins.BEGIN_AUTHWIT, Ins.APPEND_CALL, Ins.FINALIZE_AND_SIGN, Ins.ABORT):
        with expect_failure(backend):
            rapdu = backend.exchange(cla=CLA, ins=ins, p1=0, p2=0, data=b"")
        assert rapdu.status == SW.NOT_IMPLEMENTED, (
            f"INS=0x{ins:02x} should return SW_NOT_IMPLEMENTED on L2 (got 0x{rapdu.status:04x})"
        )
