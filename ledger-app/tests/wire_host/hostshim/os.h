#pragma once
/* Host shim for the BOLOS "os.h" — the handler seam pulls `explicit_bzero` (and
 * memset via <string.h>). macOS default headers don't expose explicit_bzero, so
 * provide a portable definition. Tests only — NO secret-hygiene guarantee (the
 * fuzzer doesn't care; this is a memory-safety + state-machine harness). */
#include <stddef.h>
#include <string.h>

static inline void explicit_bzero(void *p, size_t n) {
    volatile unsigned char *q = (volatile unsigned char *)p;
    while (n--) *q++ = 0;
}
