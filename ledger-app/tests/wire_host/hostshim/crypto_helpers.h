/* Host shim for the BOLOS `crypto_helpers.h` — M12 P2b deploy-parse fuzz target.
 *
 * Same posture as the `cx.h` shim: `begin_deploy_account.c` #includes it but uses
 * no symbol from it directly (the bip32/ECDSA helpers it declares are reached only
 * via the dead-stubbed `account_binding_*` wrappers, off the fuzzed parse path).
 * Intentionally empty — present only to satisfy the #include. NOT vendored. */
#pragma once
