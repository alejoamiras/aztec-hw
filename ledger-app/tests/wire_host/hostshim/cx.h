/* Host shim for the BOLOS `cx.h` — M12 P2b deploy-parse fuzz target only.
 *
 * `begin_deploy_account.c` #includes <cx.h> but uses NO `cx_*` symbol directly:
 * all device crypto is reached through the `account_binding_*` / `az_account_*`
 * wrappers, which are dead link-stubs in the fuzz harness (the parser seam never
 * reaches them — Option X). So this shim is intentionally empty; it exists only
 * to satisfy the #include on the off-device build. If a future edit makes the
 * handler call a `cx_*` primitive directly, the link will fail loudly — which is
 * the signal to revisit the seam, not to grow this shim. NOT vendored SDK code. */
#pragma once
