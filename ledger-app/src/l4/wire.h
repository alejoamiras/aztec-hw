/**
 * L4 APDU wire format.
 *
 * Frozen layouts per `implementations-plan/hw-wallet-poc-ledger/l4-spec.md`
 * and the codex deep plan §2. All multi-byte fields are big-endian.
 *
 * Each command body is parsed sequentially by `buffer_read_*` helpers; we
 * never declare these structs as packed types on the parse path because
 * BOLOS `buffer_t` semantics + alignment requirements make field-by-field
 * parsing the only safe option (codex L2 review pattern).
 */
#pragma once

#include <stdint.h>

#include "../constants.h"

/* --- Constants ----------------------------------------------------------- */

/* Wire-format version bump per codex M5 final-review MAJOR #2: v1 → v2 is a
 * hard cut; the device rejects v1, the host emits v2 only. */
#define L4_MANIFEST_VERSION 2u

#define L4_CURVE_ID_K1 1u
#define L4_CURVE_ID_R1 2u        /* reserved for L4.next */
#define L4_CURVE_ID_GRUMPKIN 3u  /* reserved for L5 */

#define L4_PATH_SCHEME_DEFAULT 0u

#define L4_MAX_CALLS 5u
#define L4_MIN_BIP32_PATH 5u

/* Field/call sizes (bytes on the wire) — used in parser bounds checks. */
#define L4_FR_BYTES 32u

/* Clear-signing v0 wire extension: raw args stream alongside the host-claimed
 * args_hash so the device can recompute & verify (M5.2 enforces the recompute).
 * MAX_ARGS=4 is the ceiling for the aztec-standards FT verb set (4-arg transfer
 * family; 2-arg mint; 0-arg sponsor). Per encoder.ts:24-43 u128 is 1 Fr slot. */
#define L4_MAX_ARGS 4u

/* APPEND_CALL body layout (variable length, up to L4_APPEND_CALL_BODY_MAX bytes):
 *   args_hash[32] | selector[32] | target[32] | flags[1] | args_count[1] | args[args_count][32]
 * Max body = 32+32+32+1+1+4*32 = 226 B, well under the 255 B APDU body cap. */
#define L4_APPEND_CALL_HEADER_BYTES (3u * L4_FR_BYTES + 2u) /* args_hash+selector+target+flags+args_count = 98 */
#define L4_APPEND_CALL_BODY_MIN     L4_APPEND_CALL_HEADER_BYTES                /* 0 args */
#define L4_APPEND_CALL_BODY_MAX     (L4_APPEND_CALL_HEADER_BYTES + L4_MAX_ARGS * L4_FR_BYTES)

#define L4_FINALIZE_BODY_BYTES L4_FR_BYTES         /* claimed_outer_hash */

/* Call flag bits (`az_call_v1_t::flags`). */
#define L4_CALL_FLAG_PUBLIC          (1u << 0)
#define L4_CALL_FLAG_HIDE_MSG_SENDER (1u << 1)
#define L4_CALL_FLAG_STATIC          (1u << 2)
#define L4_CALL_FLAG_MASK            0x07u

/* Aztec domain separators (mirrored from `yarn-project/constants/.../constants.gen.ts`,
 * pinned at aztec-packages commit 2770bcb…). */
#define L4_SEP_SIGNATURE_PAYLOAD 463525807u
#define L4_SEP_AUTHWIT_OUTER     3283595782u
#define L4_SEP_PUBLIC_CALLDATA   2760353947u
/* M7 P3: deploy address chain. INITIALIZER + PARTIAL_ADDRESS + FUNCTION_ARGS
 * (the last is used by computeVarArgsHash over the ABI-encoded ctor args). */
#define L4_SEP_INITIALIZER        385396519u
#define L4_SEP_PARTIAL_ADDRESS   2103633018u
#define L4_SEP_FUNCTION_ARGS     3576554347u
#define L4_SEP_CONTRACT_ADDR_V1  1788365517u /* DomainSeparator.CONTRACT_ADDRESS_V1 */
#define L4_SEP_PUBLIC_KEYS_HASH   777457226u /* DomainSeparator.PUBLIC_KEYS_HASH (M8 P6) */
