/* Generated. DO NOT EDIT. */
#pragma once
#include <stdint.h>
#include "registry.gen.h"

typedef enum {
    CS_VERB_NONE = 0,
    CS_VERB_TRANSFER_PRIV_PUB = 1,
    CS_VERB_TRANSFER_PRIV_PRIV = 2,
    CS_VERB_TRANSFER_PUB_PRIV = 3,
    CS_VERB_TRANSFER_PUB_PUB = 4,
    CS_VERB_MINT_PUB = 5,
    CS_VERB_MINT_PRIV = 6,
    CS_VERB_SPONSOR = 7,
    CS_VERB_DRIP_PUB = 8,
    CS_VERB__MAX = 9,
} cs_verb_e;

typedef struct {
    uint32_t selector_u32;        /* canonical Aztec selector */
    uint8_t  kind;                /* cs_contract_kind_e (must match registry hit) */
    uint8_t  verb;                /* cs_verb_e */
    uint8_t  is_public;           /* 1 = public, 0 = private */
    uint8_t  wire_arg_count;      /* expected number of 32B args on the wire */
} cs_verb_entry_t;

#define CS_VERB_COUNT 8u
extern const cs_verb_entry_t CS_VERBS[CS_VERB_COUNT];

/* Match a (kind, selector_u32) against the verb table. NULL on miss. */
const cs_verb_entry_t *cs_verb_lookup(uint8_t kind, uint32_t selector_u32);
