/**
 * App settings (NVM-backed) — M-audit P3, HARD ITEM (a).
 *
 * A single persistent flag, `blind_signing`, that gates the legacy SIGN_OUTER_HASH
 * blind-sign path. Properties (all REQUIRED by the audit):
 *   - default OFF: the const lives zero-initialized in NVRAM, so a fresh device /
 *     reinstall starts with blind-signing DISABLED.
 *   - sticky: persisted in NVRAM, survives reconnects / app restarts.
 *   - device-only: the ONLY mutator is settings_set_blind_signing(), called from the
 *     on-device Settings switch. NO APDU handler writes it — a malicious host cannot
 *     flip it; the user must physically toggle it.
 *
 * When OFF, handler_sign_outer_hash refuses with SW_BLIND_SIGN_DISABLED before any
 * UI or signing. The clear-signing verified-calls path (the primary, decoded path)
 * is unaffected and always available.
 */
#pragma once

#include <stdint.h>

typedef struct {
    uint8_t blind_signing; /* 0 = OFF (default), 1 = ON */
} app_settings_t;

/* Backing store in NVRAM (flash). Declared here, defined in settings.c; the
 * PIC-deref accessor macro lives in settings.c so includers don't need os.h. */
extern const app_settings_t N_app_settings_real;

/** True (1) iff the user has explicitly enabled blind-signing on-device. */
uint8_t settings_blind_signing_enabled(void);

/** Persist a new blind_signing value to NVRAM. On-device callers only. */
void settings_set_blind_signing(uint8_t enabled);
