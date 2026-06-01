/* M12 P2b — libFuzzer target for the deploy wire-parser (Option X).
 *
 * Fuzzes `deploy_parse_and_validate()` — the parse+validate seam extracted from
 * begin_deploy_account.c (manifest/profile/curve-pairing/path/Fr-canonical gates).
 * It calls the parse fn DIRECTLY with a reset (L4_IDLE) session, so NO BOLOS crypto
 * is on the fuzzed path (the recompute/binding tail is never reached) — exactly the
 * Option-X posture: fuzz the parse, not a full handler with a faked crypto tail.
 *
 *   make fuzz_deploy_parse && ./fuzz_deploy_parse corpus/deploy -print_final_stats=1
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "buffer.h"
#include "io.h" /* g_wire_host_last_sw — reject() records the SW here */

#include "begin_deploy_account.h" /* deploy_parse_and_validate */
#include "session.h"              /* l4_session_reset, G_l4_session */

#include "deploy_profiles.gen.h" /* cs_deploy_profile_t (via -I$(CS)) */

uint16_t g_wire_host_last_sw = 0;

/* --- Dead crypto link-stubs -------------------------------------------------
 * begin_deploy_account.c's HANDLER tail (the B3 binding: Parity passes +
 * az_account_derive_from_path) references these three symbols, so the real
 * handler .c needs them defined to LINK on the host. The fuzzer calls
 * deploy_parse_and_validate() DIRECTLY and returns before the tail, so they are
 * never executed by construction (Option X: crypto off the fuzz path). They
 * __builtin_trap rather than return a value: if a future regression ever let the
 * parse seam fall through into the binding tail, libFuzzer would crash HERE,
 * surfacing the broken invariant instead of silently fuzzing faked crypto. */
int account_binding_deploy_pubkey_xy(uint8_t curve_id, const uint32_t *bip32_path,
                                     size_t bip32_path_len, uint8_t out_x[32], uint8_t out_y[32]) {
    (void)curve_id; (void)bip32_path; (void)bip32_path_len; (void)out_x; (void)out_y;
    __builtin_trap();
}
int account_binding_deploy_partial(const cs_deploy_profile_t *profile, const uint8_t pubkey_x[32],
                                   const uint8_t pubkey_y[32], const uint8_t salt[32],
                                   uint8_t out_args_hash[32], uint8_t out_init_hash[32],
                                   uint8_t out_partial_address[32]) {
    (void)profile; (void)pubkey_x; (void)pubkey_y; (void)salt;
    (void)out_args_hash; (void)out_init_hash; (void)out_partial_address;
    __builtin_trap();
}
int az_account_derive_from_path(const uint32_t *bip32_path, size_t bip32_path_len,
                                const uint8_t partial_address[32], uint8_t out_pkh[32],
                                uint8_t out_addr[32]) {
    (void)bip32_path; (void)bip32_path_len; (void)partial_address; (void)out_pkh; (void)out_addr;
    __builtin_trap();
}

#define SW_OK 0x9000 /* SWO_SUCCESS — parse fn's success sentinel (no io_send) */

/* The set deploy_parse_and_validate can legitimately emit (its reject sites; the
 * SW_DEPLOY_CONTEXT_WRONG_STATE state-check stays in the handler, not here). */
static int is_known_deploy_parse_sw(uint16_t sw) {
    switch (sw) {
        case 0x9000: /* SWO_SUCCESS                 */
        case 0x6a87: /* SWO_WRONG_DATA_LENGTH       */
        case 0x6F01: /* SW_HASH_MISMATCH (non-canon Fr) */
        case 0x6F02: /* SW_UNKNOWN_MANIFEST_VERSION */
        case 0x6F03: /* SW_INVALID_PATH_SCHEME      */
        case 0x6F04: /* SW_INVALID_CURVE_ID         */
        case 0x6F05: /* SW_BIP32_TOO_LONG           */
        case 0x6F0D: /* SW_UNKNOWN_PROFILE_ID       */
            return 1;
        default:
            return 0;
    }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    l4_session_reset(); /* L4_IDLE; the parse populates the deploy session */
    const cs_deploy_profile_t *profile = NULL;

    uint8_t apdu[260];
    size_t n = size > sizeof(apdu) ? sizeof(apdu) : size;
    memcpy(apdu, data, n);
    buffer_t cdata = {.ptr = apdu, .size = n, .offset = 0};

    g_wire_host_last_sw = 0xFFFF;
    int prc = deploy_parse_and_validate(&cdata, &profile);

    /* On success the fn returns SWO_SUCCESS without io_send (g_wire_host_last_sw
     * stays the sentinel); on a reject, reject() io_send'd the real SW. */
    uint16_t sw = (prc == SW_OK) ? (uint16_t)SW_OK : g_wire_host_last_sw;
    if (!is_known_deploy_parse_sw(sw)) {
        __builtin_trap(); /* unknown/garbage SW from the parser = finding */
    }
    /* A successful parse must have resolved a profile (the pairing gate ran). */
    if (prc == SW_OK && profile == NULL) {
        __builtin_trap();
    }
    return 0;
}
