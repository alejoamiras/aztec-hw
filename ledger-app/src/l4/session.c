#include <string.h>

#include "os.h"
#include "session.h"
#include "../handler/get_aztec_master_secret.h"

l4_session_t G_l4_session;
l4_deploy_session_t G_l4_deploy_session;

void l4_session_reset(void) {
    explicit_bzero(&G_l4_session, sizeof(G_l4_session));
    explicit_bzero(&G_l4_deploy_session, sizeof(G_l4_deploy_session));
    /* AHW-059: fold the reveal module's file-static secret into the reset invariant
     * so it is explicit, not an implicit property of the blocking-IO loop. */
    master_secret_disarm();
}
