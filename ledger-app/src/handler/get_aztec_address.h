#pragma once

#include <stdint.h>

#include "buffer.h"

/**
 * AHW-098 (W4) — INS_GET_AZTEC_ADDRESS. Approval-gated, CAPS_ATTEST_ADDRESS-gated.
 *
 * The device DERIVES the Aztec account address on-device from a minimal request
 * `(profile_id, curve_id, path_scheme, path, salt)` using the SAME partial→pkh→
 * address chain the deploy uses (account_binding_* + az_account_derive_from_path),
 * renders it for the user to confirm (Account #N, Scheme, receive address 8+6), and
 * returns the **32-byte address ONLY** after approval — never a signed certificate
 * (a signed blob is replayable, expands the surface, and doesn't improve the human
 * comparison) and never with a host fallback.
 *
 * Closes the host-derived-receive-address gap (AHW-098): onboarding/receive can now
 * be device-attested, and the host MUST equality-check its own derivation against the
 * device's answer (fail-closed; no fallback to host-derived).
 *
 * NOTE: deliberately does NOT carry / reuse L4_MANIFEST_VERSION — feature negotiation
 * is the new CAPS_ATTEST_ADDRESS capability bit + the app-version bump, not the
 * call-encoding manifest version (auditors rejected overloading MANIFEST_VERSION).
 */
int handler_get_aztec_address(buffer_t *cdata);

/* NBGL review entry — renders the derived address + arms the identity snapshot. */
int ui_display_aztec_address_review(void);

/* Post-impl codex MED: public disarm of the armed address state, called from
 * l4_session_reset so every dispatch boundary / reject / error tears down a pending
 * W4 attestation (no stale `s_armed` surviving an L2 boundary forced mid-review). */
void get_aztec_address_disarm(void);

/* UI choice callbacks (ui/address_review_ui.c routes approve/reject here). */
int aztec_address_review_approved(void);
int aztec_address_review_rejected(void);

/* Accessors for the review UI (the address is derived + cached by the handler). */
const uint8_t *aztec_address_bytes(void);   /* 32-byte device-derived address */
uint32_t aztec_address_account_index(void); /* path[2] & 0x7FFFFFFF, for "Account #N" */
uint8_t aztec_address_curve_id(void);       /* L4_CURVE_ID_* → "Scheme" line */
