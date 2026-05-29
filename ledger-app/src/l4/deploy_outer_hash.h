/**
 * M8 Phase 6d — device-side recomputation of the DEPLOY authwit outer_hash.
 *
 * The self-paid deploy's authwit (the only object the device signs) is the
 * account entrypoint wrapping a SINGLE app call: `sponsor_unconditionally()`
 * (PRIVATE, 0 args) to the sponsor FPC. It uses the same SIGNATURE_PAYLOAD /
 * AUTHWIT_OUTER construction as a normal transfer authwit (parity.c), with:
 *
 *   call 0:    args_hash=Fr(0), selector=sponsor_selector, target=sponsor_fpc,
 *              is_public=false, hide_msg_sender=false, is_static=false
 *   calls 1-4: canonical padding (args_hash=poseidon2([0],PUBLIC_CALLDATA),
 *              selector=0, target=0, is_public=true, others false)
 *   consumer = the new account address (device-verified address_local)
 *
 * Traced from @aztec 4.2.1 (DeployAccountMethod.request deployer===ZERO ->
 * AccountEntrypointMetaPaymentMethod -> DefaultAccountEntrypoint.wrapExecution-
 * Payload([sponsor_unconditionally], EXTERNAL)). Cross-checked with a golden
 * vector computed offline from the real entrypoint (deploy-outer-hash-parity).
 *
 * Pure poseidon2 (no BOLOS) so it builds + golden-tests host-side.
 */
#pragma once

#include <stdint.h>

/**
 * @param consumer          32-byte account address (= device-verified address_local).
 * @param chain_id          32-byte Fr.
 * @param protocol_version  32-byte Fr.
 * @param tx_nonce          32-byte Fr (the framework authwit nonce — must be
 *                          the deterministic value the host pinned).
 * @param sponsor_fpc       32-byte sponsor FPC address (call target).
 * @param sponsor_selector  sponsor_unconditionally() selector (u32).
 * @param out_outer_hash    32-byte BE outer_hash.
 * @return 0 on success, negative on poseidon2 failure.
 */
int az_deploy_compute_outer_hash(const uint8_t consumer[32], const uint8_t chain_id[32],
                                 const uint8_t protocol_version[32], const uint8_t tx_nonce[32],
                                 const uint8_t sponsor_fpc[32], uint32_t sponsor_selector,
                                 uint8_t out_outer_hash[32]);
