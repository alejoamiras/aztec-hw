/**
 * App settings (NVM-backed) — see settings.h.
 *
 * Classic Ledger NVM pattern: a `const` struct in NVRAM (flash) read directly via a
 * PIC-deref macro, mutated only through nvm_write. A single bool doesn't warrant the
 * lib_standard_app app_storage machinery (480-byte versioned store + Makefile opt-in).
 */
#include "settings.h"

#include "os.h"

/* Zero-initialized in NVRAM → blind_signing defaults to 0 (OFF) on a fresh install. */
const app_settings_t N_app_settings_real;
#define N_app_settings (*(volatile const app_settings_t *) PIC(&N_app_settings_real))

uint8_t settings_blind_signing_enabled(void) {
    return N_app_settings.blind_signing;
}

void settings_set_blind_signing(uint8_t enabled) {
    uint8_t v = enabled ? 1 : 0;
    nvm_write((void *) &N_app_settings.blind_signing, &v, sizeof(v));
}
