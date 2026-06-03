#include <string.h>

#include "os.h"
#include "session.h"
#include "../review_snapshot.h"
#include "../handler/get_aztec_master_secret.h"
#include "../handler/get_aztec_address.h"

l4_session_t G_l4_session;
l4_deploy_session_t G_l4_deploy_session;

void l4_session_reset(void) {
    explicit_bzero(&G_l4_session, sizeof(G_l4_session));
    explicit_bzero(&G_l4_deploy_session, sizeof(G_l4_deploy_session));
    /* AHW-059: fold the reveal module's file-static secret into the reset invariant
     * so it is explicit, not an implicit property of the blocking-IO loop. */
    master_secret_disarm();
    /* Post-impl codex MED: centralize the teardown of ALL pending review state on
     * every reset (every dispatch boundary + every reject/error calls this), so a
     * host can't force an L2 boundary mid-review and rely on a stale armed snapshot
     * surviving. Sign-from-snapshot + the verify already make a stale snapshot
     * non-exploitable; this makes "abort/reset kills pending review" explicit, not a
     * UI-behavior side-effect. Each disarm is a cheap memset of a small static. */
    review_snapshot_disarm();          /* W1 blind-sign snapshot */
    review_snapshot_disarm_identity(); /* W1 deploy/reveal + W4 address identity snapshot */
    get_aztec_address_disarm();        /* W4 armed address (s_armed/s_addr) */
}
