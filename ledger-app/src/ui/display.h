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
 * Optional public-key display flow. L2: simple confirm path → emit response.
 */
int ui_display_pubkey(void);
