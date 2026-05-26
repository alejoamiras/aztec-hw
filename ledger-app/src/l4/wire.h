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

#define L4_MANIFEST_VERSION 1u

#define L4_CURVE_ID_K1 1u
#define L4_CURVE_ID_R1 2u        /* reserved for L4.next */
#define L4_CURVE_ID_GRUMPKIN 3u  /* reserved for L5 */

#define L4_PATH_SCHEME_DEFAULT 0u

#define L4_MAX_CALLS 5u
#define L4_MIN_BIP32_PATH 5u

/* Field/call sizes (bytes on the wire) — used in parser bounds checks. */
#define L4_FR_BYTES 32u
#define L4_CALL_BODY_BYTES (3u * L4_FR_BYTES + 1u) /* args_hash + selector + target + flags = 97 */
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
