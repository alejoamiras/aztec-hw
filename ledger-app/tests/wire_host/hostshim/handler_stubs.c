/**
 * Host-shim stubs for firmware symbols the wire-parser oracle links transitively but
 * does NOT exercise.
 *
 * `l4_session_reset()` (l4/session.c) calls `master_secret_disarm()` (AHW-059) to fold
 * the reveal module's secret into the reset invariant. The reveal module
 * (get_aztec_master_secret.c) is crypto-heavy and irrelevant to wire PARSING, so the
 * oracle does not compile it. A no-op disarm is faithful here: it cannot change any
 * parse accept/reject SW — the only thing the differential-replay measures.
 */
void master_secret_disarm(void) {
    /* no-op: no reveal secret exists in the parser oracle */
}
