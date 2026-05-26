"""GET_CAPS — L4 build advertises CAPS_K1 | CAPS_CLEAR_SIGN; R1 + Grumpkin reserved."""

from application_client.aztec_command_sender import AztecCommandSender, parse_caps


CAPS_K1 = 1 << 0
CAPS_R1 = 1 << 1
CAPS_CLEAR_SIGN = 1 << 2
CAPS_GRUMPKIN = 1 << 3


def test_get_caps_l4_advertises_k1_and_clear_sign(backend):
    sender = AztecCommandSender(backend)
    caps = parse_caps(sender.get_caps())
    assert caps == (CAPS_K1 | CAPS_CLEAR_SIGN)
    assert caps & CAPS_K1
    assert caps & CAPS_CLEAR_SIGN
    assert not (caps & CAPS_R1)
    assert not (caps & CAPS_GRUMPKIN)
