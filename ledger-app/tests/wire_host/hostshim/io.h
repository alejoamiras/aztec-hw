#pragma once
/* Host shim for the BOLOS "io.h" — on-device these write the APDU response over
 * USB and return the status word; off-device we CAPTURE the SW into a global the
 * fuzz target reads back after each handler call. Faithful in the sense that the
 * handler's control flow (which SW it emits, and that it returns) is identical;
 * only the transport is replaced. The fuzz target asserts the captured SW is a
 * KNOWN value — an unknown SW (or 0x9000 on garbage) is itself a finding. */
#include <stddef.h>
#include <stdint.h>

/* Defined in the fuzz target TU. */
extern uint16_t g_wire_host_last_sw;

static inline int io_send_sw(uint16_t sw) {
    g_wire_host_last_sw = sw;
    return 0;
}

static inline int io_send_response_pointer(const uint8_t *ptr, size_t size, uint16_t sw) {
    (void)ptr;
    (void)size;
    g_wire_host_last_sw = sw;
    return 0;
}
