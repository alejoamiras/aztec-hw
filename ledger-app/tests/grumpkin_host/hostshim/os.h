#pragma once
/* Host shim for the BOLOS "os.h" — the host-built device source deploy_address.c
 * pulls only `explicit_bzero` from it. macOS default headers don't expose it, so
 * provide a portable definition. Tests only — no secret-hygiene guarantee. */
#include <stddef.h>
#include <string.h>

static inline void explicit_bzero(void *p, size_t n) {
    volatile unsigned char *q = (volatile unsigned char *)p;
    while (n--) *q++ = 0;
}
