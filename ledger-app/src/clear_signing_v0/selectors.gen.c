/* Generated. DO NOT EDIT. */
#include "selectors.gen.h"

const cs_verb_entry_t CS_VERBS[CS_VERB_COUNT] = {
  { .selector_u32 = 0xd4fcf9f6u, .kind = 1, .verb = CS_VERB_TRANSFER_PRIV_PUB, .is_public = 0, .wire_arg_count = 4 },
  { .selector_u32 = 0xfe438afcu, .kind = 1, .verb = CS_VERB_TRANSFER_PRIV_PRIV, .is_public = 0, .wire_arg_count = 4 },
  { .selector_u32 = 0x0c3d0a8eu, .kind = 1, .verb = CS_VERB_TRANSFER_PUB_PRIV, .is_public = 0, .wire_arg_count = 4 },
  { .selector_u32 = 0xc47adea0u, .kind = 1, .verb = CS_VERB_TRANSFER_PUB_PUB, .is_public = 1, .wire_arg_count = 4 },
  { .selector_u32 = 0x451b5faeu, .kind = 1, .verb = CS_VERB_MINT_PUB, .is_public = 1, .wire_arg_count = 2 },
  { .selector_u32 = 0x87f0f0a4u, .kind = 1, .verb = CS_VERB_MINT_PRIV, .is_public = 0, .wire_arg_count = 2 },
  { .selector_u32 = 0x23d77f89u, .kind = 2, .verb = CS_VERB_SPONSOR, .is_public = 0, .wire_arg_count = 0 },
};

const cs_verb_entry_t *cs_verb_lookup(uint8_t kind, uint32_t selector_u32) {
    for (unsigned i = 0; i < CS_VERB_COUNT; i++) {
        if (CS_VERBS[i].kind == kind && CS_VERBS[i].selector_u32 == selector_u32) return &CS_VERBS[i];
    }
    return NULL;
}
