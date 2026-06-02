/**
 * NBGL home + settings for the Aztec app.
 *
 * Settings exposes ONE switch — "Blind signing" (default OFF), backed by NVRAM via
 * settings.c. Toggling it on-device is the ONLY way to enable the legacy
 * SIGN_OUTER_HASH raw-hash path (M-audit P3, HARD ITEM a). No APDU can flip it, so a
 * malicious host cannot silently re-enable blind-signing.
 */

#include "os.h"
#include "glyphs.h"
#include "nbgl_use_case.h"

#include "globals.h"
#include "menu.h"
#include "display.h"
#include "settings.h"

#define SETTING_INFO_NB 2
static const char *const INFO_TYPES[SETTING_INFO_NB] = {"Version", "Developer"};
static const char *const INFO_CONTENTS[SETTING_INFO_NB] = {APPVERSION, "Aztec Labs PoC"};

static const nbgl_contentInfoList_t infoList = {
    .nbInfos = SETTING_INFO_NB,
    .infoTypes = INFO_TYPES,
    .infoContents = INFO_CONTENTS,
};

/* --- Settings: a single "Blind signing" switch --------------------------- */
enum {
    BLIND_SIGNING_TOKEN = FIRST_USER_TOKEN,
};

/* Mutable: initState is refreshed from NVRAM on every home entry + after a toggle. */
static nbgl_contentSwitch_t g_switches[1];

static void settings_control_cb(int token, uint8_t index, int page) {
    UNUSED(index);
    UNUSED(page);
    if (token == BLIND_SIGNING_TOKEN) {
        /* Flip + persist to NVRAM, then re-read so the shown switch reflects truth. */
        const uint8_t next = settings_blind_signing_enabled() ? 0 : 1;
        settings_set_blind_signing(next);
        g_switches[0].initState = settings_blind_signing_enabled() ? ON_STATE : OFF_STATE;
    }
}

static const nbgl_content_t g_settings_contents[] = {
    {
        .type = SWITCHES_LIST,
        .content.switchesList =
            {
                .switches = g_switches,
                .nbSwitches = 1,
            },
        .contentActionCallback = settings_control_cb,
    },
};

static const nbgl_genericContents_t g_settings = {
    .callbackCallNeeded = false,
    .contentsList = g_settings_contents,
    .nbContents = 1,
};

static void app_quit(void) {
    os_sched_exit(-1);
}

void ui_menu_main(void) {
    /* Reflect the current NVRAM value every time we (re)enter the home screen. */
    g_switches[0].text = "Blind signing";
    g_switches[0].subText = "Allow signing a raw hash the device can't decode. Risky - keep OFF.";
    g_switches[0].token = BLIND_SIGNING_TOKEN;
    g_switches[0].tuneId = NBGL_NO_TUNE;
    g_switches[0].initState = settings_blind_signing_enabled() ? ON_STATE : OFF_STATE;

    nbgl_useCaseHomeAndSettings(APPNAME,
                                &ICON_APP_HOME,
                                NULL,
                                INIT_HOME_PAGE,
                                &g_settings,
                                &infoList,
                                NULL,
                                app_quit);
}

void ui_menu_about(void) {
    ui_menu_main();
}
