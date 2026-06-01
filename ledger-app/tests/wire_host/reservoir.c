/* M12 P2 — reject-reservoir capture (see reservoir.h). Test scaffolding, not
 * vendored. Linked into the fuzz binaries; active only under WIRE_RESERVOIR. */
#include "reservoir.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define RES_MAX_BUCKETS 128
#define RES_CAP_PER_BUCKET 12 /* enough variety per (sw,len) without bloating the gate */

static int g_state = -1; /* -1 = uninit, 0 = disabled, 1 = enabled */
static const char *g_dir = NULL;

struct bucket {
    uint16_t sw;
    uint8_t len_bucket;
    uint16_t count;
};
static struct bucket g_buckets[RES_MAX_BUCKETS];
static size_t g_nbuckets = 0;

/* Coarse length strata — enough to separate "empty / tiny header / mid / near-max"
 * so the reservoir isn't dominated by one size. */
static uint8_t len_bucket_of(size_t size) {
    if (size == 0) return 0;
    if (size <= 4) return 1;
    if (size <= 16) return 2;
    if (size <= 64) return 3;
    return 4;
}

static struct bucket *find_or_add(uint16_t sw, uint8_t lb) {
    for (size_t i = 0; i < g_nbuckets; i++) {
        if (g_buckets[i].sw == sw && g_buckets[i].len_bucket == lb) return &g_buckets[i];
    }
    if (g_nbuckets >= RES_MAX_BUCKETS) return NULL; /* reservoir saturated; ignore new keys */
    struct bucket *b = &g_buckets[g_nbuckets++];
    b->sw = sw;
    b->len_bucket = lb;
    b->count = 0;
    return b;
}

void reservoir_maybe_put(const uint8_t *data, size_t size, uint16_t sw) {
    if (g_state < 0) {
        g_dir = getenv("WIRE_RESERVOIR");
        g_state = (g_dir != NULL && g_dir[0] != '\0') ? 1 : 0;
        if (g_state == 1) mkdir(g_dir, 0755); /* best-effort; EEXIST is fine */
    }
    if (g_state == 0) return;

    uint8_t lb = len_bucket_of(size);
    struct bucket *b = find_or_add(sw, lb);
    if (b == NULL || b->count >= RES_CAP_PER_BUCKET) return;

    char path[512];
    int n = snprintf(path, sizeof(path), "%s/sw%04x_l%u_%03u.bin", g_dir, sw, lb, b->count);
    if (n <= 0 || (size_t)n >= sizeof(path)) return;

    FILE *f = fopen(path, "wb");
    if (f == NULL) return;
    if (size > 0) fwrite(data, 1, size, f);
    fclose(f);
    b->count++;
}
