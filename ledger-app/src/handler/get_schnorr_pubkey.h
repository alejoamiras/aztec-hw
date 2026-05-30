#pragma once

#include "buffer.h"

/**
 * INS_GET_SCHNORR_PUBKEY (M10) — derive the Grumpkin Schnorr signing public key
 * P = priv·G for the BIP-32 path and return 64 bytes (X || Y), which the host
 * feeds to the SchnorrAccount constructor. Non-sensitive (public key); no
 * on-device confirmation, mirroring INS_GET_PUBLIC_KEY (K1).
 */
int handler_get_schnorr_pubkey(buffer_t *cdata);
