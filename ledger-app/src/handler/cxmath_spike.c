/**
 * M12 P3 — cx_math PROTOTYPE-SPIKE (THROWAWAY, flag-gated behind CX_MATH_SPIKE).
 *
 * NOT compiled into the shipped app: the default build defines no CX_MATH_SPIKE,
 * so types.h adds no INS and the dispatcher adds no case — the production app.elf
 * is byte-identical (the B3 empty-diff gate is unaffected). Build the spike with:
 *   make BOLOS_SDK=/opt/nanosplus-secure-sdk DEFINES_EXTRA=CX_MATH_SPIKE
 *
 * PURPOSE: get REAL numbers for the cx_math migrate-vs-accept decision
 * (cx-math-decision.md). The residual the M11 dudect flagged is the
 * VALUE-DEPENDENCE of our hand-rolled Montgomery `fr_mul` (conditional final
 * subtraction) — a power/EM side-channel concern. The candidate fix is to route
 * field multiplication through Ledger's `cx_bn_mod_mul` (the SE bignum unit).
 * This spike answers the one thing Speculos CAN settle definitively:
 *   does cx_bn_mod_mul compute the correct product mod p for BOTH of our custom
 *   254-bit moduli (BN254 Fr AND Grumpkin Fq) — i.e. does it accept an arbitrary
 *   modulus, not just a named curve? (the codex+opus "silent wrong-field
 *   reduction / named-curve-only" failure mode.)
 * It also gives a CRUDE relative latency signal (cx_bn vs native, same op, N
 * iterations) — but on Speculos that is EMULATED QEMU, NOT SE silicon, so it does
 * NOT predict real-device latency (see cx-math-decision.md caveat 2).
 *
 * APDU body: mode(1) ‖ iters_be(2) ‖ a_be(32) ‖ b_be(32).
 *   mode 0 = cx_bn_mod_mul, Fr modulus      mode 2 = native fr_mul (Fr)
 *   mode 1 = cx_bn_mod_mul, Fq modulus      mode 3 = native gk_fq_mul (Fq)
 * Computes acc=a; repeat `iters`×: acc = acc·b mod p. Returns acc_be(32).
 *   iters=1 → acc = a·b mod p (correctness vector).  iters≫1 → latency.
 */
#ifdef CX_MATH_SPIKE

#include <stdint.h>
#include <string.h>

#include "cx.h"
#include "io.h"
#include "buffer.h"

#include "cxmath_spike.h"
#include "../sw.h"
#include "../crypto/poseidon2/fr.h"
#include "../crypto/grumpkin/fq.h"

/* BE, 32-byte. Fr = BN254 scalar field (Poseidon2/Pedersen/notes);
 * Fq = BN254 base field = Grumpkin coordinate field (point x/y). */
static const uint8_t FR_MODULUS_BE[32] = {
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
};
static const uint8_t FQ_MODULUS_BE[32] = {
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
};

/* acc = a·b^iters mod p via the SE bignum unit. Returns CX_OK or the cx error. */
static cx_err_t cxbn_mul_loop(uint8_t out[32], const uint8_t a[32], const uint8_t b[32],
                              const uint8_t modulus[32], uint16_t iters) {
    cx_err_t err = cx_bn_lock(32, 0);
    if (err != CX_OK) return err;
    cx_bn_t acc, bb, nn;
    err = cx_bn_alloc_init(&nn, 32, modulus, 32);
    if (err != CX_OK) goto done;
    err = cx_bn_alloc_init(&acc, 32, a, 32);
    if (err != CX_OK) goto done;
    err = cx_bn_alloc_init(&bb, 32, b, 32);
    if (err != CX_OK) goto done;
    /* Reduce inputs mod p so mod_mul's operand precondition holds for any a,b. */
    err = cx_bn_reduce(acc, acc, nn);
    if (err != CX_OK) goto done;
    err = cx_bn_reduce(bb, bb, nn);
    if (err != CX_OK) goto done;
    for (uint16_t i = 0; i < iters; i++) {
        err = cx_bn_mod_mul(acc, acc, bb, nn);
        if (err != CX_OK) goto done;
    }
    err = cx_bn_export(acc, out, 32);
done:
    cx_bn_unlock();
    return err;
}

static void native_fr_mul_loop(uint8_t out[32], const uint8_t a[32], const uint8_t b[32],
                               uint16_t iters) {
    fr_t acc, bb;
    fr_from_bytes_be(&acc, a);
    fr_from_bytes_be(&bb, b);
    for (uint16_t i = 0; i < iters; i++) fr_mul(&acc, &acc, &bb);
    fr_to_bytes_be(out, &acc);
}

static void native_fq_mul_loop(uint8_t out[32], const uint8_t a[32], const uint8_t b[32],
                               uint16_t iters) {
    gk_fq_t acc, bb;
    gk_fq_from_bytes_be(&acc, a);
    gk_fq_from_bytes_be(&bb, b);
    for (uint16_t i = 0; i < iters; i++) gk_fq_mul(&acc, &acc, &bb);
    gk_fq_to_bytes_be(out, &acc);
}

int handler_cxmath_spike(buffer_t *cdata) {
    uint8_t mode;
    uint8_t iters_hi, iters_lo;
    uint8_t a[32], b[32];
    if (!buffer_read_u8(cdata, &mode)) return io_send_sw(SWO_WRONG_DATA_LENGTH);
    if (!buffer_read_u8(cdata, &iters_hi) || !buffer_read_u8(cdata, &iters_lo)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    if (!buffer_read_bytes(cdata, a, 32) || !buffer_read_bytes(cdata, b, 32)) {
        return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    uint16_t iters = (uint16_t)((iters_hi << 8) | iters_lo);
    if (iters == 0) return io_send_sw(SWO_WRONG_DATA_LENGTH);

    uint8_t out[32];
    switch (mode) {
        case 0:
            if (cxbn_mul_loop(out, a, b, FR_MODULUS_BE, iters) != CX_OK) return io_send_sw(SWO_UNKNOWN);
            break;
        case 1:
            if (cxbn_mul_loop(out, a, b, FQ_MODULUS_BE, iters) != CX_OK) return io_send_sw(SWO_UNKNOWN);
            break;
        case 2:
            native_fr_mul_loop(out, a, b, iters);
            break;
        case 3:
            native_fq_mul_loop(out, a, b, iters);
            break;
        default:
            return io_send_sw(SWO_WRONG_DATA_LENGTH);
    }
    return io_send_response_pointer(out, 32, SWO_SUCCESS);
}

#endif /* CX_MATH_SPIKE */
