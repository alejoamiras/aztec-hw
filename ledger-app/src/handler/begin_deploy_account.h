/**
 * INS_BEGIN_DEPLOY_ACCOUNT handler (M7 P3).
 *
 * Parses + validates the deploy-context payload, runs the 3-pass partial-
 * address parity recompute against the manifest-pinned profile, stores
 * the context in `G_l4_deploy_session`, and triggers the on-device review
 * UI. The UI calls `finalize_deploy_after_approval` / `finalize_deploy_rejected`.
 */
#pragma once

#include "buffer.h"

int handler_begin_deploy_account(buffer_t *cdata);
