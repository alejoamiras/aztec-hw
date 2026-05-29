#pragma once

#include "status_words.h"

/**
 * Aztec-specific status words.
 *
 * Allocated from the proprietary 6Fxx range (per ISO 7816-4) to avoid collisions
 * with the SDK's ISO-standard `SWO_*` codes in `include/status_words.h`.
 */
#define SW_HASH_MISMATCH                  0x6F01
#define SW_UNKNOWN_MANIFEST_VERSION       0x6F02
#define SW_INVALID_PATH_SCHEME            0x6F03
#define SW_INVALID_CURVE_ID               0x6F04
#define SW_BIP32_TOO_LONG                 0x6F05
#define SW_DUP_SIG_MISMATCH               0x6F06
#define SW_NOT_IMPLEMENTED                0x6F07  // INS reserved for a future phase
/* Clear-signing v0 strict-allowlist rejections (codex final-review §4). */
#define SW_REGISTRY_MISS                  0x6F08  // target address not in CS_REGISTRY
#define SW_DECODER_MISS                   0x6F09  // (kind, selector) not in CS_VERBS
#define SW_DECODER_DESYNC                 0x6F0A  // wire arg_count != verb's expected
#define SW_VISIBILITY_MISMATCH            0x6F0B  // flags.is_public != verb's is_public
#define SW_DELEGATED_SPEND_UNSUPPORTED    0x6F0C  // 4-arg transfer with from != consumer
/* M7 P3 — clear-signed deploy (DEPLOY_ACCOUNT_ECDSAK_V1). */
#define SW_UNKNOWN_PROFILE_ID             0x6F0D  // profile_index out of range / not allowlisted
#define SW_DEPLOY_ADDRESS_MISMATCH        0x6F0E  // reserved: fires when M8 Grumpkin EC lift lands
#define SW_DEPLOY_PUBKEY_HASH_MISMATCH    0x6F0F  // reserved: fires under §7 lift
#define SW_DEPLOY_CONTEXT_TWICE           0x6F10  // BEGIN_DEPLOY_ACCOUNT sent twice in one session
#define SW_DEPLOY_CONTEXT_WRONG_STATE     0x6F11  // BEGIN_DEPLOY before GET_VERSION or after auth
/* M9 B3 — device-verified `From` on authwit. The device recomputes its OWN
 * account address from the signing path (partial) + viewing keys (pkh) and
 * cross-checks it against the signed `consumer`. Fires when they differ.
 * v0 SCOPE CAVEAT (codex post-impl MEDIUM): the recompute assumes the sole
 * supported account template — CS_DEPLOY_PROFILES[0] (EcdsaKAccount) with
 * salt = Fr.ZERO. So this SW means EITHER "consumer is not the account this key
 * controls" OR "the account uses a non-default template/salt this device build
 * cannot verify". The device cannot tell the two apart (it has no per-account
 * template oracle), so both fail closed here. Every demo account is profile-0 /
 * zero-salt, so in practice this only fires on a genuine consumer mismatch. */
#define SW_AUTHWIT_CONSUMER_MISMATCH      0x6F12
#define SW_USER_REJECTED                  0x6985
