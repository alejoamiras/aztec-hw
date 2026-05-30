/**
 * M7 P3 — partial-address recomputation for clear-signed deploy.
 *
 * Mirrors `yarn-project/stdlib/src/contract/contract_address.ts` +
 * `hash.ts:computeVarArgsHash` + `abi/encoder.ts` (elementwise [u8;32]
 * flatten). Uses the sponge directly so we don't materialize a 64×32B
 * temporary for the pubkey bytes — keeps stack usage tiny on Nano S+.
 *
 * Trust model documented in deploy_address.h. v0 stops at partial_address;
 * the final Grumpkin EC step is deferred to M8.
 */
#include <stdint.h>
#include <string.h>

#include "os.h"
#include "../crypto/poseidon2/poseidon2.h"
#include "../crypto/poseidon2/poseidon2_internal.h"
#include "deploy_address.h"
#include "wire.h"

/**
 * Encode a u32 selector as a 32B BE Fr. Selectors in Aztec sit in the
 * low 4 bytes; everything above is zero. Matches the host-side
 * `FunctionSelector.toField()` round-trip.
 */
static void selector_to_fr_be(uint32_t selector, uint8_t out_fr[32]) {
    explicit_bzero(out_fr, 32);
    out_fr[28] = (uint8_t)((selector >> 24) & 0xFFu);
    out_fr[29] = (uint8_t)((selector >> 16) & 0xFFu);
    out_fr[30] = (uint8_t)((selector >> 8) & 0xFFu);
    out_fr[31] = (uint8_t)(selector & 0xFFu);
}

/**
 * Absorb a single u8 as an Fr field (BE zero-padded to 32B). Each
 * byte of the [u8;32] pubkey arrays maps to one Fr per
 * `encoder.ts:117-119`. We avoid the 2KB stack buffer by streaming
 * directly into the sponge.
 */
static int absorb_byte_as_fr(az_poseidon2_sponge_t *s, uint8_t b) {
    uint8_t fr_buf[32];
    explicit_bzero(fr_buf, 32);
    fr_buf[31] = b;
    return az_poseidon2_sponge_absorb_bytes(s, fr_buf);
}

/**
 * Compute `args_hash = computeVarArgsHash(64 byte-frs)` for the
 * ecdsa_k_pubkey_xy ctor argument schema. Streams the bytes through
 * the sponge — never holds the full 64-Fr buffer on stack.
 */
static int compute_pubkey_args_hash(
    const uint8_t signing_pubkey_x[32],
    const uint8_t signing_pubkey_y[32],
    uint8_t out_args_hash[32]) {

    az_poseidon2_sponge_t s;
    /* poseidon2HashWithSeparator: IV-encoded length is `count + 1`
     * because the separator is prepended as the first absorbed field.
     * count here is 64 byte-frs. */
    az_poseidon2_sponge_init(&s, 64ULL + 1ULL);
    az_poseidon2_sponge_absorb_u64(&s, (uint64_t)L4_SEP_FUNCTION_ARGS);

    for (int i = 0; i < 32; i++) {
        if (absorb_byte_as_fr(&s, signing_pubkey_x[i]) != 0) {
            return -1;
        }
    }
    for (int i = 0; i < 32; i++) {
        if (absorb_byte_as_fr(&s, signing_pubkey_y[i]) != 0) {
            return -1;
        }
    }

    az_poseidon2_sponge_squeeze(&s, out_args_hash);
    return 0;
}

/**
 * Shared partial-address tail (steps 2-4) — identical for every account class;
 * only the ctor `args_hash` (step 1) differs by scheme. See contract_address.ts.
 */
static int partial_from_args_hash(const uint8_t args_hash[32], uint32_t ctor_selector_u32,
                                  const uint8_t salt[32], const uint8_t deployer[32],
                                  const uint8_t account_class_id[32], uint8_t out_init_hash[32],
                                  uint8_t out_partial_address[32]) {
    /* 2. init_hash = poseidon2WithSeparator([selector_as_fr, args_hash], INITIALIZER). */
    uint8_t init_payload[2 * 32];
    selector_to_fr_be(ctor_selector_u32, &init_payload[0]);
    memcpy(&init_payload[32], args_hash, 32);
    if (az_poseidon2_hash_with_separator(init_payload, 2, L4_SEP_INITIALIZER, out_init_hash) != 0) {
        explicit_bzero(init_payload, sizeof(init_payload));
        return -1;
    }
    explicit_bzero(init_payload, sizeof(init_payload));

    /* 3. salted_init = poseidon2WithSeparator([salt, init_hash, deployer], PARTIAL_ADDRESS). */
    uint8_t salted_payload[3 * 32];
    memcpy(&salted_payload[0], salt, 32);
    memcpy(&salted_payload[32], out_init_hash, 32);
    memcpy(&salted_payload[64], deployer, 32);
    uint8_t salted_init[32];
    if (az_poseidon2_hash_with_separator(salted_payload, 3, L4_SEP_PARTIAL_ADDRESS, salted_init) !=
        0) {
        explicit_bzero(salted_payload, sizeof(salted_payload));
        explicit_bzero(salted_init, 32);
        return -1;
    }
    explicit_bzero(salted_payload, sizeof(salted_payload));

    /* 4. partial_address = poseidon2WithSeparator([class_id, salted_init], PARTIAL_ADDRESS). */
    uint8_t partial_payload[2 * 32];
    memcpy(&partial_payload[0], account_class_id, 32);
    memcpy(&partial_payload[32], salted_init, 32);
    explicit_bzero(salted_init, 32);
    if (az_poseidon2_hash_with_separator(partial_payload, 2, L4_SEP_PARTIAL_ADDRESS,
                                         out_partial_address) != 0) {
        explicit_bzero(partial_payload, sizeof(partial_payload));
        return -1;
    }
    explicit_bzero(partial_payload, sizeof(partial_payload));
    return 0;
}

int az_deploy_compute_partial_address(
    const uint8_t signing_pubkey_x[32],
    const uint8_t signing_pubkey_y[32],
    uint32_t ctor_selector_u32,
    const uint8_t salt[32],
    const uint8_t deployer[32],
    const uint8_t account_class_id[32],
    uint8_t out_args_hash[32],
    uint8_t out_init_hash[32],
    uint8_t out_partial_address[32]) {

    /* 1. args_hash = computeVarArgsHash(64 byte-frs over pubkey x || y).
     * Streamed — see compute_pubkey_args_hash. Exposed via out_args_hash
     * so the deploy session can stash it for the FINALIZE-stage outer_hash
     * binding (codex audit MAJOR #1: BEGIN commits all semantics). */
    if (compute_pubkey_args_hash(signing_pubkey_x, signing_pubkey_y, out_args_hash) != 0) {
        explicit_bzero(out_args_hash, 32);
        return -1;
    }

    /* Steps 2-4 (init_hash / salted_init / partial_address) are scheme-
     * independent — shared with the Schnorr ctor via partial_from_args_hash. */
    return partial_from_args_hash(out_args_hash, ctor_selector_u32, salt, deployer,
                                  account_class_id, out_init_hash, out_partial_address);
}

int az_schnorr_compute_partial_address(const uint8_t pubkey_x[32], const uint8_t pubkey_y[32],
                                       uint32_t ctor_selector_u32, const uint8_t salt[32],
                                       const uint8_t deployer[32],
                                       const uint8_t account_class_id[32],
                                       uint8_t out_partial_address[32]) {
    /* SchnorrAccount ctor = (signing_pub_key_x, signing_pub_key_y) → 2 Fr args,
     * so args_hash = computeVarArgsHash([P.x, P.y]) (vs the ECDSA 64 byte-frs). */
    uint8_t args_payload[2 * 32];
    memcpy(&args_payload[0], pubkey_x, 32);
    memcpy(&args_payload[32], pubkey_y, 32);
    uint8_t args_hash[32];
    if (az_poseidon2_hash_with_separator(args_payload, 2, L4_SEP_FUNCTION_ARGS, args_hash) != 0) {
        explicit_bzero(args_payload, sizeof(args_payload));
        return -1;
    }
    explicit_bzero(args_payload, sizeof(args_payload));

    uint8_t init_hash[32];
    int rc = partial_from_args_hash(args_hash, ctor_selector_u32, salt, deployer, account_class_id,
                                    init_hash, out_partial_address);
    explicit_bzero(args_hash, 32);
    explicit_bzero(init_hash, 32);
    return rc;
}
