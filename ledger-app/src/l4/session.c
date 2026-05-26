#include <string.h>

#include "os.h"
#include "session.h"

l4_session_t G_l4_session;

void l4_session_reset(void) {
    explicit_bzero(&G_l4_session, sizeof(G_l4_session));
}
