/**
 * Aztec outer_hash recomputation — the device-side parity oracle.
 *
 * Reproduces the Aztec authwit hash exactly as `yarn-project/entrypoints/src/
 * encoding.ts` + `auth_witness.ts` do, using our Poseidon2 port. Padding for
 * unused call slots is synthesized on-device (codex deep plan §3); the host
 * never streams padding bytes.
 *
 * Constant-time discipline: NOT required. All inputs to this code path are
 * PUBLIC (manifest data). The signing key is never touched here. Same audit
 * bar as L2 ECDSA.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "session.h"
#include "wire.h"

/**
 * Compute `outer_hash` from the current `G_l4_session`. Writes 32 BE bytes
 * into `out`. Internally:
 *   - synthesizes (L4_MAX_CALLS - call_count) canonical padding calls,
 *   - builds the 31-field signature payload,
 *   - hashes with SIGNATURE_PAYLOAD → inner_hash,
 *   - hashes [consumer, chain_id, protocol_version, inner_hash] with
 *     AUTHWIT_OUTER → outer_hash.
 *
 * Also writes the intermediate `inner_hash` into `out_inner` (UI uses it).
 *
 * Returns true on success, false on Fr canonicality error (input >= p).
 */
bool l4_compute_outer_hash(uint8_t out_outer[L4_FR_BYTES],
                           uint8_t out_inner[L4_FR_BYTES]);
