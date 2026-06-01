/* M12 P3 — cx_math prototype-spike (THROWAWAY, flag-gated). See cxmath_spike.c. */
#pragma once

#ifdef CX_MATH_SPIKE
#include "buffer.h"
int handler_cxmath_spike(buffer_t *cdata);
#endif
