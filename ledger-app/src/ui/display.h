#pragma once

#include <stdbool.h>

/**
 * Aztec app glyph macros — backed by `glyphs/app_aztec_*.{gif,png}`.
 * SDK transforms `app_aztec_14px.gif` → `C_app_aztec_14px` at build time.
 */
#if defined(TARGET_NANOX) || defined(TARGET_NANOS2)
#define ICON_APP_HOME    C_app_aztec_14px
#elif defined(TARGET_STAX) || defined(TARGET_FLEX)
#define ICON_APP_HOME    C_app_aztec_64px
#elif defined(TARGET_APEX_P)
#define ICON_APP_HOME    C_app_aztec_48px
#else
#define ICON_APP_HOME    C_app_aztec_64px
#endif

/**
 * Display the outer_hash + path blind-sign confirmation, then sign on approval.
 */
int ui_display_blind_sign(void);

/**
 * L4 verified-calls review. Renders per-call target / selector / mode plus the
 * device-recomputed outer_hash. Calls `finalize_after_approval` /
 * `finalize_rejected` (in `handler/finalize_and_sign.h`) on user choice.
 */
int ui_display_verified_calls(void);

/**
 * Optional public-key display flow. L2: simple confirm path → emit response.
 */
int ui_display_pubkey(void);

/**
 * M7 P3 — clear-signed deploy review. Renders the new account address
 * (8+6 hex truncation), BIP-32 path, and "Sponsored (testnet)" fee
 * notice. Calls `finalize_deploy_after_approval` / `finalize_deploy_rejected`
 * (in `handler/finalize_deploy_and_sign.h`) on user choice.
 */
int ui_display_deploy_review(void);

/**
 * M8 P4 — master-secret reveal review. Renders the BIP-32 path + a 4-hex
 * confirmation checksum with explicit "viewing not spending" wording. Calls
 * `master_secret_reveal_approved` / `master_secret_reveal_rejected` (in
 * `handler/get_aztec_master_secret.h`) on user choice.
 */
int ui_display_master_secret_reveal(void);

/**
 * Return the device to the idle home screen. Called from
 * `nbgl_useCaseReviewStatus(..., ui_menu_main)` after a successful
 * (or rejected) signing flow — without this, NBGL's review page
 * stays painted forever.
 */
void ui_menu_main(void);
