/**
 * INS_FINALIZE_DEPLOY_AND_SIGN handler + UI callbacks (M7 P3).
 *
 * BEGIN_DEPLOY_ACCOUNT triggered the on-device review; the UI calls
 * one of these on user choice.
 */
#pragma once

#include "buffer.h"

int handler_finalize_deploy_and_sign(buffer_t *cdata);
int finalize_deploy_after_approval(void);
int finalize_deploy_rejected(void);
