/* M12 P2a — libFuzzer target for handler_append_call (APPEND_CALL).
 *
 * append_call is the RICHEST wire parser: per-call decode (target/selector/flags/
 * args loop), the strict allowlist gates (registry miss, verb miss, arg-count
 * desync, visibility mismatch), the 4-arg-transfer `from == consumer` self-spend
 * gate, and the args_hash recompute (poseidon2). It requires a prior BEGIN_AUTHWIT,
 * so each iteration first SEEDS a valid HEADER_PARSED session expecting one call,
 * then feeds the fuzzer bytes as the APPEND_CALL body.
 *
 * Pure parser + poseidon2 (no BOLOS crypto / bip32 / cx) → faithful off-device.
 * Asserts no ASan/UBSan trap + a known status word.
 *
 *   make fuzz_append_call && ./fuzz_append_call corpus/append -print_final_stats=1
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "buffer.h"
#include "io.h" /* g_wire_host_last_sw */
#include "reservoir.h"

#include "append_call.h"
#include "session.h" /* G_l4_session, l4_session_reset, l4_state_e */
#include "wire.h"    /* L4_FR_BYTES */

uint16_t g_wire_host_last_sw = 0;

/* The set APPEND_CALL can legitimately emit (append_call.c reject sites + success).
 * Anything else = the parser reached a corrupted state = a finding. */
static int is_known_append_sw(uint16_t sw) {
    switch (sw) {
        case 0x9000: /* SWO_SUCCESS                    */
        case 0x6a87: /* SWO_WRONG_DATA_LENGTH          */
        case 0x6d00: /* SWO_INVALID_INS (wrong state)  */
        case 0x6F01: /* SW_HASH_MISMATCH (args_hash)   */
        case 0x6F08: /* SW_REGISTRY_MISS               */
        case 0x6F09: /* SW_DECODER_MISS                */
        case 0x6F0A: /* SW_DECODER_DESYNC              */
        case 0x6F0B: /* SW_VISIBILITY_MISMATCH         */
        case 0x6F0C: /* SW_DELEGATED_SPEND_UNSUPPORTED */
            return 1;
        default:
            return 0;
    }
}

/* Shared body — used by BOTH the libFuzzer entrypoint and the replay oracle
 * (replay_main.c). The seeded L4_HEADER_PARSED session is the harness's synthetic
 * precondition; the Speculos differential-replay reproduces an EQUIVALENT session
 * on-device by sending a real BEGIN_AUTHWIT first (codex Medium). For that to be
 * faithful the seeded `consumer` MUST be CANONICAL (< BN254 Fr modulus, top byte
 * < 0x30) — begin_authwit.c rejects a non-canonical consumer with SW_HASH_MISMATCH
 * (line 76), so the old 0xC0… seed was unreproducible on-device. 0x0C… is
 * canonical and reproducible. append_call reads only {state, call_count,
 * calls_received, consumer} from the session, so matching those four suffices.
 *
 * Buffer model: fixed 260B backing for the device's over-read semantics; body
 * capped at WIRE_MAX_LC=255 (device's one-byte Lc); slack poisoned 0xAA. */
#define WIRE_MAX_LC 255
uint16_t run_one(const uint8_t *data, size_t size) {
    /* Seed a minimal valid session: header parsed, expecting exactly one call. */
    l4_session_reset();
    G_l4_session.state = L4_HEADER_PARSED;
    G_l4_session.call_count = 1;
    G_l4_session.calls_received = 0;
    /* Canonical fixed consumer (top byte 0x0C < 0x30 → < Fr modulus): the fuzzer's
     * 4-arg-transfer args[0] usually differs (→ SW_DELEGATED_SPEND_UNSUPPORTED) and
     * can occasionally match (→ the from==consumer self-spend path). Reproducible
     * on-device via a BEGIN_AUTHWIT carrying the same consumer. */
    memset(G_l4_session.consumer, 0x0C, L4_FR_BYTES);

    uint8_t apdu[260];
    memset(apdu, 0xAA, sizeof(apdu));
    size_t n = size > WIRE_MAX_LC ? WIRE_MAX_LC : size;
    memcpy(apdu, data, n);
    buffer_t cdata = {.ptr = apdu, .size = n, .offset = 0};

    g_wire_host_last_sw = 0xFFFF;
    handler_append_call(&cdata);
    return g_wire_host_last_sw;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    uint16_t sw = run_one(data, size);
    reservoir_maybe_put(data, size, sw);
    if (!is_known_append_sw(sw)) {
        __builtin_trap();
    }
    return 0;
}
