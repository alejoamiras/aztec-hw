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
 * Return the device to the idle home screen. Called from
 * `nbgl_useCaseReviewStatus(..., ui_menu_main)` after a successful
 * (or rejected) signing flow — without this, NBGL's review page
 * stays painted forever.
 */
void ui_menu_main(void);
