/* M12 P2 — off-device replay oracle for the bidirectional differential-replay
 * gate (codex Critical/High). Reads each file on argv, runs it through the
 * target's run_one() — the SAME shared body the fuzzer measured (the REAL
 * compiled handler, not a reimplementation) — and prints `<basename> <sw_4hex>`
 * to stdout, one line per input. The TS differential test (`wire-differential-
 * replay.test.ts`) parses this and compares each SW to the Speculos device SW for
 * the same bytes, asserting same-class agreement bidirectionally.
 *
 * Linked WITHOUT -fsanitize=fuzzer (it provides its own main); the fuzz file's
 * LLVMFuzzerTestOneInput is then dead code. ASan/UBSan stay on.
 *
 *   make replay_deploy_parse && ./replay_deploy_parse corpus/deploy/<f> reservoir/deploy/<f>
 */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* Provided by the linked fuzz_<target>.c. */
extern uint16_t run_one(const uint8_t *data, size_t size);

static const char *basename_of(const char *p) {
    const char *slash = p;
    for (const char *c = p; *c; c++) {
        if (*c == '/') slash = c + 1;
    }
    return slash;
}

int main(int argc, char **argv) {
    static uint8_t buf[4096]; /* >> the 255-byte max body run_one consumes */
    for (int i = 1; i < argc; i++) {
        FILE *f = fopen(argv[i], "rb");
        if (f == NULL) {
            fprintf(stderr, "replay: cannot open %s\n", argv[i]);
            return 2;
        }
        size_t n = fread(buf, 1, sizeof(buf), f);
        fclose(f);
        uint16_t sw = run_one(buf, n);
        printf("%s %04x\n", basename_of(argv[i]), sw);
    }
    return 0;
}
