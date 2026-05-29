/**
 * INS_GET_AZTEC_MASTER_SECRET (M8 P4) — reveal the 32-byte Aztec master secret
 * (Fr) for a BIP-32 path after a high-friction on-device confirmation.
 *
 * Derivation (host reference: packages/adapter-ledger/src/master-secret.ts):
 *   secret = SHA-512(DOMAIN || pubkey_x || pubkey_y) mod Fr
 *   DOMAIN = "aztec-master-secret-v1" + one NUL byte (23 bytes)
 *
 * Flow mirrors the deploy review: the handler derives + arms the secret and
 * shows the NBGL reveal screen, returning 0 (response deferred). The UI's
 * confirm/reject callback then calls back into the *_approved/*_rejected
 * functions to emit the response.
 */
#pragma once

#include "buffer.h"

/** Parse path, derive the master secret, arm it, show the reveal UI. */
int handler_get_aztec_master_secret(buffer_t *cdata);

/** UI confirm callback — emit the armed 32-byte secret, then wipe it. */
int master_secret_reveal_approved(void);

/** UI reject callback — wipe the armed secret, emit SW_USER_REJECTED. */
int master_secret_reveal_rejected(void);

/** Read the 4-hex confirmation checksum (NUL-terminated) for the UI to show.
 * Not secret — it is a SHA-256 prefix the host can independently recompute so
 * the user can cross-check the device against the host-displayed value. */
const char *master_secret_checksum_str(void);
