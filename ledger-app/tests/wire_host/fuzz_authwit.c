/* M12 P2a — libFuzzer target for handler_begin_authwit (BEGIN_AUTHWIT).
 *
 * Feeds raw fuzzer bytes as the APDU cdata into the REAL begin_authwit handler
 * (off-device, via the os.h/io.h/buffer shims) and asserts: no ASan/UBSan trap
 * (memory safety) + the emitted status word is a KNOWN value (a garbage/unknown
 * SW would mean state corruption). begin_authwit is a pure wire parser — no BOLOS
 * crypto — so the off-device behaviour is faithful (the buffer reader is vendored
 * verbatim; only io transport is shimmed).
 *
 *   make fuzz_authwit && ./fuzz_authwit corpus/authwit -print_final_stats=1
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "buffer.h"
#include "io.h" /* g_wire_host_last_sw */

#include "begin_authwit.h"

/* Defined here (declared extern in io.h) — the shim records the emitted SW here. */
uint16_t g_wire_host_last_sw = 0;

/* The exact set BEGIN_AUTHWIT can legitimately emit (begin_authwit.c reject sites
 * + the success path). An SW outside this set ⇒ the parser reached a state it
 * shouldn't have = a finding. (0x9000 on a *valid* header is expected; semantic
 * "accepts-malformed" divergence is caught by the Speculos differential-replay,
 * not by this set — this guards against corrupted/garbage SWs.) */
static int is_known_authwit_sw(uint16_t sw) {
    switch (sw) {
        case 0x9000: /* SWO_SUCCESS                */
        case 0x6a87: /* SWO_WRONG_DATA_LENGTH      */
        case 0x6F01: /* SW_HASH_MISMATCH (non-canonical Fr) */
        case 0x6F02: /* SW_UNKNOWN_MANIFEST_VERSION */
        case 0x6F03: /* SW_INVALID_PATH_SCHEME     */
        case 0x6F04: /* SW_INVALID_CURVE_ID        */
        case 0x6F05: /* SW_BIP32_TOO_LONG          */
            return 1;
        default:
            return 0;
    }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    /* On-device, cdata points into the fixed 260-byte G_io_apdu_buffer. Mirror
     * that: a fixed 260B array so over-read-past-`size` semantics match the device
     * (a tight malloc would let ASan flag OOB the device wouldn't hit). The slack
     * past `size` is left fuzzer-influenced via the leftover stack bytes; P2's full
     * gate seeds it explicitly — for the parser this is already faithful since
     * begin_authwit only reads within `size` (buffer_read_* bounds-check). */
    uint8_t apdu[260];
    size_t n = size > sizeof(apdu) ? sizeof(apdu) : size;
    memcpy(apdu, data, n);

    buffer_t cdata = {.ptr = apdu, .size = n, .offset = 0};
    g_wire_host_last_sw = 0xFFFF; /* sentinel: handler must emit a real SW */
    handler_begin_authwit(&cdata);

    if (!is_known_authwit_sw(g_wire_host_last_sw)) {
        __builtin_trap(); /* unknown/garbage SW from the parser = finding */
    }
    return 0;
}
