/**
 * Minimal NBGL home screen for the Aztec L2 baseline app.
 *
 * No NVM-backed settings — L2 is K1-only blind-sign, nothing to toggle.
 * Settings UI returns in L4 (clear-signing toggles) per plan-final.md.
 */

#include "os.h"
#include "glyphs.h"
#include "nbgl_use_case.h"

#include "globals.h"
#include "menu.h"
#include "display.h"

#define SETTING_INFO_NB 2
static const char *const INFO_TYPES[SETTING_INFO_NB] = {"Version", "Developer"};
static const char *const INFO_CONTENTS[SETTING_INFO_NB] = {APPVERSION, "Aztec Labs PoC"};

static const nbgl_contentInfoList_t infoList = {
    .nbInfos = SETTING_INFO_NB,
    .infoTypes = INFO_TYPES,
    .infoContents = INFO_CONTENTS,
};

static void app_quit(void) {
    os_sched_exit(-1);
}

void ui_menu_main(void) {
    nbgl_useCaseHomeAndSettings(APPNAME,
                                &ICON_APP_HOME,
                                NULL,
                                INIT_HOME_PAGE,
                                NULL,
                                &infoList,
                                NULL,
                                app_quit);
}

void ui_menu_about(void) {
    ui_menu_main();
}
