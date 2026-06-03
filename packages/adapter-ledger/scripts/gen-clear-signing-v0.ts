/**
 * Clear-signing v0 codegen — emits both device-side (C) and host-side (TS)
 * tables from a single source-of-truth manifest, plus a fail-closed cross-check
 * against the pinned aztec-standards + noir-contracts.js artifacts.
 *
 * codex final-review BLOCKER #2: shape-mismatch (selector + arg_count + visibility)
 * is fail-closed; CI must fail if the checker cannot run.
 *
 * Usage:
 *   bun run packages/adapter-ledger/scripts/gen-clear-signing-v0.ts          # write outputs
 *   bun run packages/adapter-ledger/scripts/gen-clear-signing-v0.ts --check  # CI drift-check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EcdsaKAccountContractArtifact } from '@aztec/accounts/ecdsa';
import { SchnorrAccountContractArtifact } from '@aztec/accounts/schnorr';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { FunctionSelector, getAllFunctionAbis } from '@aztec/stdlib/abi';
import { computeContractClassId, getContractClassFromArtifact } from '@aztec/stdlib/contract';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'packages/adapter-ledger/clear-signing-v0/manifest.json');

const TOKEN_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  'packages/adapter-ledger/node_modules/@defi-wonderland/aztec-standards/target/token_contract-Token.json',
);

const DRIPPER_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  'packages/adapter-ledger/node_modules/@defi-wonderland/aztec-standards/target/dripper-Dripper.json',
);

const OUT_C_DIR = resolve(REPO_ROOT, 'ledger-app/src/clear_signing_v0');
const OUT_TS_DIR = resolve(REPO_ROOT, 'packages/adapter-ledger/src/clear_signing_v0');

const CHECK_MODE = process.argv.includes('--check');

interface RegistryEntry {
  slot: number;
  kind: 'TOKEN' | 'SPONSOR' | 'DRIPPER' | 'EMPTY';
  address: string;
  symbol: string;
  decimals: number;
}

interface VerbEntry {
  verb: string;
  kind: 'TOKEN' | 'SPONSOR' | 'DRIPPER';
  artifact_source: 'TOKEN_CONTRACT' | 'SPONSORED_FPC_CONTRACT' | 'DRIPPER_CONTRACT';
  function_name: string;
  expected_selector_u32: string;
  is_public: boolean;
  args: string[];
  wire_arg_count: number;
  display_name: string;
  amount_type?: 'u64' | 'u128' | 'field';
}

interface DeployProfileEntry {
  id: string;
  profile_index: number;
  version: number;
  account_class_id: string;
  ctor_selector_u32: string;
  ctor_arg_schema: 'ecdsa_k_pubkey_xy' | 'schnorr_pubkey_xy';
  ctor_arg_byte_len: number;
  deployer: string;
  sponsor_fpc_address: string;
  sponsor_selector_u32: string;
  fee_mode: 'EXTERNAL';
  display_name: string;
}

interface Manifest {
  _meta: {
    aztec_packages_pin: string;
    aztec_standards_npm_pin: string;
  };
  registry: RegistryEntry[];
  verbs: VerbEntry[];
  deploy_profiles?: DeployProfileEntry[];
}

interface AbiParam {
  name: string;
  type: { kind: string };
}

interface AbiFunction {
  name: string;
  custom_attributes?: string[];
  abi: { parameters: AbiParam[] };
  parameters?: AbiParam[]; // SponsoredFPC artifact has parameters at top level
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;

const tokenArtifact = JSON.parse(readFileSync(TOKEN_ARTIFACT_PATH, 'utf-8')) as {
  functions: AbiFunction[];
};

const dripperArtifact = JSON.parse(readFileSync(DRIPPER_ARTIFACT_PATH, 'utf-8')) as {
  functions: AbiFunction[];
};

const sponsoredFpcArtifact = SponsoredFPCContract.artifact as {
  functions: { name: string; parameters: AbiParam[]; custom_attributes?: string[] }[];
};

/* --- Cross-check (BLOCKER #2: fail-closed) ------------------------------ */

function findArtifactFunction(verb: VerbEntry): {
  parameters: AbiParam[];
  custom_attributes: string[] | undefined;
} {
  if (verb.artifact_source === 'TOKEN_CONTRACT') {
    const fn = tokenArtifact.functions.find((f) => f.name === verb.function_name);
    if (!fn)
      throw new Error(`[fail-closed] Token artifact missing function: ${verb.function_name}`);
    return { parameters: fn.abi.parameters, custom_attributes: fn.custom_attributes };
  }
  if (verb.artifact_source === 'DRIPPER_CONTRACT') {
    const fn = dripperArtifact.functions.find((f) => f.name === verb.function_name);
    if (!fn)
      throw new Error(`[fail-closed] Dripper artifact missing function: ${verb.function_name}`);
    return { parameters: fn.abi.parameters, custom_attributes: fn.custom_attributes };
  }
  if (verb.artifact_source === 'SPONSORED_FPC_CONTRACT') {
    const fn = sponsoredFpcArtifact.functions.find((f) => f.name === verb.function_name);
    if (!fn)
      throw new Error(
        `[fail-closed] SponsoredFPC artifact missing function: ${verb.function_name}`,
      );
    return { parameters: fn.parameters, custom_attributes: fn.custom_attributes };
  }
  throw new Error(`[fail-closed] Unknown artifact_source: ${verb.artifact_source}`);
}

async function crossCheckVerb(verb: VerbEntry): Promise<void> {
  const { parameters, custom_attributes } = findArtifactFunction(verb);

  /* Selector check — fail-closed.
   *
   * Bug 2 (M6.12): The framework's runtime call computes selectors using
   * the parameter list MINUS the auto-injected `inputs` (PrivateContextInputs).
   * The raw `target/*.json` artifact INCLUDES `inputs` for private functions,
   * so prior cross-checks computed a selector that drifted from runtime.
   * Strip `inputs` for private artifact-source functions to match runtime. */
  const isSponsorPath = verb.artifact_source === 'SPONSORED_FPC_CONTRACT';
  const selectorParams =
    !isSponsorPath && !verb.is_public ? parameters.filter((p) => p.name !== 'inputs') : parameters;
  const sel = isSponsorPath
    ? await FunctionSelector.fromSignature(`${verb.function_name}()`) // sponsored_fee_payment.ts:28 uses fromSignature
    : await FunctionSelector.fromNameAndParameters(verb.function_name, selectorParams as never);
  const selHex = sel.toString();
  if (selHex.toLowerCase() !== verb.expected_selector_u32.toLowerCase()) {
    throw new Error(
      `[fail-closed] Selector drift for verb=${verb.verb}: manifest=${verb.expected_selector_u32}, artifact-computed=${selHex}`,
    );
  }

  /* Visibility check — fail-closed.
   *
   * Token + Dripper artifacts: `custom_attributes` carries "abi_private" or "abi_public".
   * SponsoredFPC artifact: no custom_attributes for v0; hardcode the assertion
   * to match `aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:29`
   * which builds the call with FunctionType.PRIVATE. */
  const expectedAttr = verb.is_public ? 'abi_public' : 'abi_private';
  if (verb.artifact_source === 'TOKEN_CONTRACT' || verb.artifact_source === 'DRIPPER_CONTRACT') {
    const attrs = custom_attributes ?? [];
    if (!attrs.includes(expectedAttr)) {
      throw new Error(
        `[fail-closed] Visibility drift for verb=${verb.verb}: manifest is_public=${verb.is_public} → expected attr=${expectedAttr}, artifact attrs=${JSON.stringify(attrs)}`,
      );
    }
  } else if (verb.artifact_source === 'SPONSORED_FPC_CONTRACT') {
    /* Hardcoded against sponsored_fee_payment.ts:29 */
    if (verb.is_public !== false) {
      throw new Error(
        `[fail-closed] SponsoredFPC verb=${verb.verb} must be is_public=false (FunctionType.PRIVATE in sponsored_fee_payment.ts:29)`,
      );
    }
  }

  /* Wire-arg-count check — fail-closed.
   *
   * Tokens/Dripper with PRIVATE entrypoint annotation have a prepended `inputs`
   * PrivateContextInputs in their artifact parameters; the user-visible wire
   * args are `parameters.length - 1` in that case. PUBLIC entrypoints have no
   * prepended context param. SponsoredFPC has zero wire args.
   *
   * This is the corollary of the selector difference for private functions —
   * verifying it here catches both arities going stale at once. */
  let expectedWireCount: number;
  if (verb.artifact_source === 'SPONSORED_FPC_CONTRACT') {
    expectedWireCount = parameters.length;
  } else if (verb.is_public) {
    expectedWireCount = parameters.length;
  } else {
    // Private Token/Dripper entrypoint: artifact prepends `inputs` PrivateContextInputs
    const ownerLabel = verb.artifact_source === 'TOKEN_CONTRACT' ? 'Token' : 'Dripper';
    if (parameters.length === 0 || parameters[0]?.name !== 'inputs') {
      throw new Error(
        `[fail-closed] Private ${ownerLabel} verb=${verb.verb} expected first artifact param "inputs"; got ${parameters[0]?.name ?? '(none)'}`,
      );
    }
    expectedWireCount = parameters.length - 1;
  }
  if (expectedWireCount !== verb.wire_arg_count) {
    throw new Error(
      `[fail-closed] Arg count drift for verb=${verb.verb}: manifest wire_arg_count=${verb.wire_arg_count}, artifact-derived=${expectedWireCount}`,
    );
  }
}

/* --- Emitters ----------------------------------------------------------- */

function bytesFromBe32Hex(hex: string): number[] {
  const stripped = hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (stripped.length !== 64) throw new Error(`Bad 32-byte hex: ${hex}`);
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(Number.parseInt(stripped.slice(2 * i, 2 * i + 2), 16));
  return out;
}

function fmtByteArray(bytes: number[]): string {
  return `{ ${bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')} }`;
}

function cSymbolLiteral(s: string, maxLen: number): string {
  /* Codex M5 post-impl MINOR: device-side UI uses `%s` on the symbol buffer,
   * which means it must be NUL-terminated. Reserve at least one byte for NUL
   * (so max usable length is `maxLen - 1`) and reject any non-ASCII byte —
   * the Nano S+ NBGL font is essentially Latin-1, and any UTF-8 multi-byte
   * inside a fixed-width buffer would either truncate mid-codepoint or
   * render as substitution characters. */
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length >= maxLen) {
    throw new Error(
      `symbol "${s}" length ${bytes.length} >= CS_SYMBOL_LEN=${maxLen}; reserve 1 byte for NUL`,
    );
  }
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) {
      throw new Error(`symbol "${s}" contains non-ASCII byte 0x${b.toString(16)}`);
    }
  }
  const padded: number[] = [];
  for (let i = 0; i < maxLen; i++) padded.push(i < bytes.length ? bytes[i]! : 0);
  return fmtByteArray(padded);
}

function emitRegistryC(): { header: string; impl: string } {
  const SYMBOL_LEN = 8;
  const header = `/* Generated by gen-clear-signing-v0.ts. DO NOT EDIT.
 * Source-of-truth: packages/adapter-ledger/clear-signing-v0/manifest.json
 * aztec-packages pin: ${manifest._meta.aztec_packages_pin}
 * aztec-standards pin: ${manifest._meta.aztec_standards_npm_pin}
 */
#pragma once
#include <stdint.h>

#define CS_REGISTRY_SLOTS ${manifest.registry.length}u
#define CS_SYMBOL_LEN ${SYMBOL_LEN}u

typedef enum {
    CS_KIND_EMPTY = 0,
    CS_KIND_TOKEN = 1,
    CS_KIND_SPONSOR = 2,
    CS_KIND_DRIPPER = 3,
} cs_contract_kind_e;

typedef struct {
    uint8_t  kind;                /* cs_contract_kind_e */
    uint8_t  address[32];         /* AztecAddress, 32 BE bytes */
    char     symbol[CS_SYMBOL_LEN]; /* null-padded */
    uint8_t  decimals;
    uint8_t  _reserved[3];        /* pad to 44B; alignment */
} cs_registry_entry_t;

extern const cs_registry_entry_t CS_REGISTRY[CS_REGISTRY_SLOTS];

/* Returns matching entry pointer (kind != EMPTY) or NULL. */
const cs_registry_entry_t *cs_registry_lookup(const uint8_t target[32]);
`;
  const kindToNum = (k: RegistryEntry['kind']): number => {
    switch (k) {
      case 'EMPTY':
        return 0;
      case 'TOKEN':
        return 1;
      case 'SPONSOR':
        return 2;
      case 'DRIPPER':
        return 3;
    }
  };
  const entries = manifest.registry
    .map((e) => {
      const kindNum = kindToNum(e.kind);
      const addrBytes = bytesFromBe32Hex(e.address);
      const sym = cSymbolLiteral(e.symbol, SYMBOL_LEN);
      return `  { /* slot ${e.slot} */ .kind = ${kindNum}, .address = ${fmtByteArray(addrBytes)}, .symbol = ${sym}, .decimals = ${e.decimals}, ._reserved = {0,0,0} },`;
    })
    .join('\n');

  const impl = `/* Generated. DO NOT EDIT. */
#include "registry.gen.h"
#include <stddef.h> /* NULL */
#include <string.h>

const cs_registry_entry_t CS_REGISTRY[CS_REGISTRY_SLOTS] = {
${entries}
};

const cs_registry_entry_t *cs_registry_lookup(const uint8_t target[32]) {
    for (unsigned i = 0; i < CS_REGISTRY_SLOTS; i++) {
        if (CS_REGISTRY[i].kind == CS_KIND_EMPTY) continue;
        if (memcmp(CS_REGISTRY[i].address, target, 32) == 0) return &CS_REGISTRY[i];
    }
    return NULL;
}
`;
  return { header, impl };
}

function emitSelectorsC(): { header: string; impl: string } {
  const verbEnum = [
    '    CS_VERB_NONE = 0,',
    ...manifest.verbs.map((v, i) => `    CS_VERB_${v.verb} = ${i + 1},`),
    `    CS_VERB__MAX = ${manifest.verbs.length + 1},`,
  ].join('\n');

  const header = `/* Generated. DO NOT EDIT. */
#pragma once
#include <stdint.h>
#include "registry.gen.h"

typedef enum {
${verbEnum}
} cs_verb_e;

typedef struct {
    uint32_t selector_u32;        /* canonical Aztec selector */
    uint8_t  kind;                /* cs_contract_kind_e (must match registry hit) */
    uint8_t  verb;                /* cs_verb_e */
    uint8_t  is_public;           /* 1 = public, 0 = private */
    uint8_t  wire_arg_count;      /* expected number of 32B args on the wire */
} cs_verb_entry_t;

#define CS_VERB_COUNT ${manifest.verbs.length}u
extern const cs_verb_entry_t CS_VERBS[CS_VERB_COUNT];

/* Match a (kind, selector_u32) against the verb table. NULL on miss. */
const cs_verb_entry_t *cs_verb_lookup(uint8_t kind, uint32_t selector_u32);
`;

  const verbKindToNum = (k: VerbEntry['kind']): number => {
    switch (k) {
      case 'TOKEN':
        return 1;
      case 'SPONSOR':
        return 2;
      case 'DRIPPER':
        return 3;
    }
  };
  const entries = manifest.verbs
    .map((v) => {
      const kindNum = verbKindToNum(v.kind);
      const sel = v.expected_selector_u32;
      return `  { .selector_u32 = ${sel}u, .kind = ${kindNum}, .verb = CS_VERB_${v.verb}, .is_public = ${v.is_public ? 1 : 0}, .wire_arg_count = ${v.wire_arg_count} },`;
    })
    .join('\n');

  const impl = `/* Generated. DO NOT EDIT. */
#include <stddef.h> /* NULL */
#include "selectors.gen.h"

const cs_verb_entry_t CS_VERBS[CS_VERB_COUNT] = {
${entries}
};

const cs_verb_entry_t *cs_verb_lookup(uint8_t kind, uint32_t selector_u32) {
    for (unsigned i = 0; i < CS_VERB_COUNT; i++) {
        if (CS_VERBS[i].kind == kind && CS_VERBS[i].selector_u32 == selector_u32) return &CS_VERBS[i];
    }
    return NULL;
}
`;
  return { header, impl };
}

function emitRegistryTs(): string {
  const entries = manifest.registry
    .map((e) => {
      return `  /* slot ${e.slot} */ { kind: ${JSON.stringify(e.kind)}, address: ${JSON.stringify(e.address)}, symbol: ${JSON.stringify(e.symbol)}, decimals: ${e.decimals} },`;
    })
    .join('\n');

  return `/* Generated by gen-clear-signing-v0.ts. DO NOT EDIT.
 * Single source of truth: clear-signing-v0/manifest.json
 */

export type CsContractKind = 'EMPTY' | 'TOKEN' | 'SPONSOR' | 'DRIPPER';

export interface CsRegistryEntry {
  readonly kind: CsContractKind;
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

export const CS_REGISTRY: readonly CsRegistryEntry[] = [
${entries}
] as const;

export function csRegistryLookup(addressHex: string): CsRegistryEntry | undefined {
  const lower = addressHex.toLowerCase();
  const normalized = lower.startsWith('0x') ? lower : \`0x\${lower}\`;
  return CS_REGISTRY.find((e) => e.kind !== 'EMPTY' && e.address.toLowerCase() === normalized);
}
`;
}

function emitSelectorsTs(): string {
  const entries = manifest.verbs
    .map((v) => {
      return `  { verb: ${JSON.stringify(v.verb)}, kind: ${JSON.stringify(v.kind)}, selector_u32: ${v.expected_selector_u32}, is_public: ${v.is_public}, wire_arg_count: ${v.wire_arg_count}, display_name: ${JSON.stringify(v.display_name)}, args: ${JSON.stringify(v.args)} },`;
    })
    .join('\n');

  return `/* Generated by gen-clear-signing-v0.ts. DO NOT EDIT. */

export type CsVerb =
${manifest.verbs.map((v) => `  | '${v.verb}'`).join('\n')};

export interface CsVerbEntry {
  readonly verb: CsVerb;
  readonly kind: 'TOKEN' | 'SPONSOR' | 'DRIPPER';
  readonly selector_u32: number;
  readonly is_public: boolean;
  readonly wire_arg_count: number;
  readonly display_name: string;
  readonly args: readonly string[];
}

export const CS_VERBS: readonly CsVerbEntry[] = [
${entries}
] as const;

export function csVerbLookup(
  kind: 'TOKEN' | 'SPONSOR' | 'DRIPPER',
  selectorU32: number,
): CsVerbEntry | undefined {
  return CS_VERBS.find((v) => v.kind === kind && v.selector_u32 === selectorU32);
}
`;
}

/* --- Deploy profile cross-check + emitters (M7 P2) --------------------- */

/**
 * Fail-closed cross-check for the deploy profile. M7 P2 — verifies that
 * the manifest-pinned values match what the SDK derives independently:
 *
 *   - account_class_id MUST equal computeContractClassId(EcdsaKAccountContractArtifact)
 *   - ctor_selector_u32 MUST equal FunctionSelector.fromNameAndParameters('constructor',
 *     getAllFunctionAbis(EcdsaKAccountContractArtifact).find(f=>f.name==='constructor').parameters)
 *
 * If the upstream artifact changes (Aztec rev bump), one of these checks
 * fails closed at codegen time before any output gets written. The device
 * never sees a stale class id.
 */
async function crossCheckDeployProfile(profile: DeployProfileEntry): Promise<void> {
  /* profile.id → the SDK artifact + the schema/byte-len it MUST carry. Both the
   * ECDSA-K (64 byte-frs) and Schnorr (2 Frs) ctors ABI-encode to 64 bytes, but
   * the schema string MUST match the id so the device's per-scheme partial fn is
   * selected correctly. Adding a profile means adding a row here (fail-closed). */
  const specs = {
    DEPLOY_ACCOUNT_ECDSAK_V1: {
      artifact: EcdsaKAccountContractArtifact,
      schema: 'ecdsa_k_pubkey_xy',
      byteLen: 64,
    },
    DEPLOY_ACCOUNT_SCHNORR_V1: {
      artifact: SchnorrAccountContractArtifact,
      schema: 'schnorr_pubkey_xy',
      byteLen: 64,
    },
  } as const;
  const spec = specs[profile.id as keyof typeof specs];
  if (!spec) {
    throw new Error(`[fail-closed] Unknown deploy profile id: ${profile.id}`);
  }
  if (profile.ctor_arg_schema !== spec.schema) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: ctor_arg_schema must be '${spec.schema}'; got '${profile.ctor_arg_schema}'`,
    );
  }

  const cls = await getContractClassFromArtifact(spec.artifact);
  const computedClassId = (await computeContractClassId(cls)).toString();
  if (computedClassId.toLowerCase() !== profile.account_class_id.toLowerCase()) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: account_class_id drift. manifest=${profile.account_class_id}, computed=${computedClassId}`,
    );
  }

  const ctor = getAllFunctionAbis(spec.artifact).find((f) => f.name === 'constructor');
  if (!ctor) {
    throw new Error(`[fail-closed] ${profile.id} artifact missing 'constructor' function`);
  }
  const computedSel = (
    await FunctionSelector.fromNameAndParameters('constructor', ctor.parameters as never)
  ).toString();
  if (computedSel.toLowerCase() !== profile.ctor_selector_u32.toLowerCase()) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: ctor_selector_u32 drift. manifest=${profile.ctor_selector_u32}, computed=${computedSel}`,
    );
  }

  if (profile.ctor_arg_byte_len !== spec.byteLen) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: ctor_arg_byte_len must be ${spec.byteLen} for schema '${spec.schema}'; got ${profile.ctor_arg_byte_len}`,
    );
  }

  /* AHW-096 (W2): the sponsor + deployer were emitted from the manifest but never
   * cross-verified — a poisoned profile could bake a hidden sponsor/deployer the
   * device signs while the review showed only "Sponsored". There is no CANONICAL
   * sponsored-FPC address to anchor against (it is instance/network-specific), so
   * we SINGLE-SOURCE within the manifest and fail closed:
   *   - deployer MUST be ZERO (universal deploy); a non-zero deployer is a hidden
   *     party the review must not omit.
   *   - sponsor_fpc_address MUST equal the one SPONSOR-kind registry slot, so there
   *     is exactly one sponsor source — not an independent literal per profile.
   *   - sponsor_selector_u32 MUST equal the artifact-verified SPONSOR verb selector
   *     (crossCheckVerb already tied that to the SponsoredFPC artifact).
   * The device ALSO renders the sponsor 8+6 (deploy_review_ui.c) so a user/auditor
   * can compare it to the known FPC — the irreducible last line. (The residual that
   * a poisoned checked-in *.gen.c bypasses codegen is the deferred CI build-gate,
   * AHW-102 — documented, not closed here.) */
  if (BigInt(profile.deployer) !== 0n) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: deployer must be ZERO (universal); got ${profile.deployer}`,
    );
  }
  const sponsorSlots = manifest.registry.filter((r) => r.kind === 'SPONSOR');
  if (sponsorSlots.length !== 1) {
    throw new Error(
      `[fail-closed] Expected exactly ONE SPONSOR registry slot (single sponsor source); found ${sponsorSlots.length}`,
    );
  }
  if (BigInt(profile.sponsor_fpc_address) !== BigInt(sponsorSlots[0]!.address)) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: sponsor_fpc_address ${profile.sponsor_fpc_address} != the SPONSOR registry slot ${sponsorSlots[0]!.address} (single-source the sponsor)`,
    );
  }
  const sponsorVerb = manifest.verbs.find((v) => v.kind === 'SPONSOR');
  if (!sponsorVerb) {
    throw new Error('[fail-closed] No SPONSOR verb to anchor sponsor_selector_u32 against');
  }
  if (BigInt(profile.sponsor_selector_u32) !== BigInt(sponsorVerb.expected_selector_u32)) {
    throw new Error(
      `[fail-closed] Deploy profile ${profile.id}: sponsor_selector_u32 ${profile.sponsor_selector_u32} != SPONSOR verb selector ${sponsorVerb.expected_selector_u32}`,
    );
  }
}

function emitDeployProfilesC(): { header: string; impl: string } {
  const profiles = manifest.deploy_profiles ?? [];
  const header = `/* Generated by gen-clear-signing-v0.ts. DO NOT EDIT.
 * Source-of-truth: packages/adapter-ledger/clear-signing-v0/manifest.json
 *
 * M7 P2: reviewed deploy profiles. NOT the same shape as CS_VERBS — verbs are
 * selector-matched runtime calls; profiles are deploy-time templates pinning
 * class id, constructor selector, fee path, and the rendering schema for the
 * on-device review screen.
 */
#pragma once
#include <stdint.h>

#define CS_DEPLOY_PROFILE_COUNT ${profiles.length}u

typedef enum {
    CS_DEPLOY_ARG_SCHEMA_ECDSA_K_PUBKEY_XY = 1,  /* [u8;32] x || [u8;32] y → 64 Frs */
    CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY = 2,  /* Field x || Field y → 2 Frs */
} cs_deploy_arg_schema_e;

typedef enum {
    CS_FEE_MODE_EXTERNAL = 0,
} cs_fee_mode_e;

typedef struct {
    uint8_t  account_class_id[32];     /* Fr BE */
    uint32_t ctor_selector_u32;        /* low-4-bytes selector */
    uint8_t  arg_schema;               /* cs_deploy_arg_schema_e */
    uint16_t ctor_arg_byte_len;        /* total bytes of ABI-encoded ctor args */
    uint8_t  deployer[32];             /* Fr BE; ZERO for universal */
    uint8_t  sponsor_fpc_address[32];  /* Fr BE */
    uint32_t sponsor_selector_u32;
    uint8_t  fee_mode;                 /* cs_fee_mode_e */
    uint8_t  _reserved[2];             /* pad */
} cs_deploy_profile_t;

extern const cs_deploy_profile_t CS_DEPLOY_PROFILES[CS_DEPLOY_PROFILE_COUNT];

/* Returns NULL if profile_index is out of range. */
const cs_deploy_profile_t *cs_deploy_profile_lookup(uint8_t profile_index);
`;
  const entries = profiles
    .map((p) => {
      const classBytes = bytesFromBe32Hex(p.account_class_id);
      const deployerBytes = bytesFromBe32Hex(p.deployer);
      const sponsorBytes = bytesFromBe32Hex(p.sponsor_fpc_address);
      const schemaEnum =
        p.ctor_arg_schema === 'ecdsa_k_pubkey_xy'
          ? 'CS_DEPLOY_ARG_SCHEMA_ECDSA_K_PUBKEY_XY'
          : p.ctor_arg_schema === 'schnorr_pubkey_xy'
            ? 'CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY'
            : '0';
      const feeEnum = p.fee_mode === 'EXTERNAL' ? 'CS_FEE_MODE_EXTERNAL' : '0';
      return `  { /* ${p.id} v${p.version} */
    .account_class_id = ${fmtByteArray(classBytes)},
    .ctor_selector_u32 = ${p.ctor_selector_u32}u,
    .arg_schema = ${schemaEnum},
    .ctor_arg_byte_len = ${p.ctor_arg_byte_len}u,
    .deployer = ${fmtByteArray(deployerBytes)},
    .sponsor_fpc_address = ${fmtByteArray(sponsorBytes)},
    .sponsor_selector_u32 = ${p.sponsor_selector_u32}u,
    .fee_mode = ${feeEnum},
    ._reserved = {0, 0},
  },`;
    })
    .join('\n');

  const impl = `/* Generated. DO NOT EDIT. */
#include "deploy_profiles.gen.h"
#include <stddef.h>

const cs_deploy_profile_t CS_DEPLOY_PROFILES[CS_DEPLOY_PROFILE_COUNT] = {
${entries}
};

const cs_deploy_profile_t *cs_deploy_profile_lookup(uint8_t profile_index) {
    if (profile_index >= CS_DEPLOY_PROFILE_COUNT) return NULL;
    return &CS_DEPLOY_PROFILES[profile_index];
}
`;
  return { header, impl };
}

function emitDeployProfilesTs(): string {
  const profiles = manifest.deploy_profiles ?? [];
  const entries = profiles
    .map((p) => {
      return `  {
    id: ${JSON.stringify(p.id)},
    profile_index: ${p.profile_index},
    version: ${p.version},
    account_class_id: ${JSON.stringify(p.account_class_id)},
    ctor_selector_u32: ${p.ctor_selector_u32},
    ctor_arg_schema: ${JSON.stringify(p.ctor_arg_schema)},
    ctor_arg_byte_len: ${p.ctor_arg_byte_len},
    deployer: ${JSON.stringify(p.deployer)},
    sponsor_fpc_address: ${JSON.stringify(p.sponsor_fpc_address)},
    sponsor_selector_u32: ${p.sponsor_selector_u32},
    fee_mode: ${JSON.stringify(p.fee_mode)},
    display_name: ${JSON.stringify(p.display_name)},
  },`;
    })
    .join('\n');

  const ids = profiles.map((p) => `  | '${p.id}'`).join('\n');
  return `/* Generated by gen-clear-signing-v0.ts. DO NOT EDIT.
 *
 * M7 P2: reviewed deploy profiles. Cross-checked at codegen against the live
 * EcdsaKAccountContractArtifact — fail-closed on class-id or ctor-selector drift.
 */

export type CsDeployProfileId =
${ids};

export interface CsDeployProfile {
  readonly id: CsDeployProfileId;
  readonly profile_index: number;
  readonly version: number;
  readonly account_class_id: string;
  readonly ctor_selector_u32: number;
  readonly ctor_arg_schema: 'ecdsa_k_pubkey_xy' | 'schnorr_pubkey_xy';
  readonly ctor_arg_byte_len: number;
  readonly deployer: string;
  readonly sponsor_fpc_address: string;
  readonly sponsor_selector_u32: number;
  readonly fee_mode: 'EXTERNAL';
  readonly display_name: string;
}

export const CS_DEPLOY_PROFILES: readonly CsDeployProfile[] = [
${entries}
] as const;

export function csDeployProfileLookup(
  id: CsDeployProfileId,
): CsDeployProfile | undefined {
  return CS_DEPLOY_PROFILES.find((p) => p.id === id);
}
`;
}

/* --- Main --------------------------------------------------------------- */

async function main(): Promise<void> {
  /* Cross-check every verb + deploy profile FIRST (fail-closed before any output). */
  for (const verb of manifest.verbs) {
    await crossCheckVerb(verb);
  }
  for (const profile of manifest.deploy_profiles ?? []) {
    await crossCheckDeployProfile(profile);
  }

  const { header: regH, impl: regC } = emitRegistryC();
  const { header: selH, impl: selC } = emitSelectorsC();
  const { header: depH, impl: depC } = emitDeployProfilesC();
  const regTs = emitRegistryTs();
  const selTs = emitSelectorsTs();
  const depTs = emitDeployProfilesTs();

  const targets: { path: string; content: string }[] = [
    { path: join(OUT_C_DIR, 'registry.gen.h'), content: regH },
    { path: join(OUT_C_DIR, 'registry.gen.c'), content: regC },
    { path: join(OUT_C_DIR, 'selectors.gen.h'), content: selH },
    { path: join(OUT_C_DIR, 'selectors.gen.c'), content: selC },
    { path: join(OUT_C_DIR, 'deploy_profiles.gen.h'), content: depH },
    { path: join(OUT_C_DIR, 'deploy_profiles.gen.c'), content: depC },
    { path: join(OUT_TS_DIR, 'registry.generated.ts'), content: regTs },
    { path: join(OUT_TS_DIR, 'selectors.generated.ts'), content: selTs },
    { path: join(OUT_TS_DIR, 'deploy_profiles.generated.ts'), content: depTs },
  ];

  if (CHECK_MODE) {
    /* Drift detector: compare existing files against fresh-generated.
     * For TS files, the on-disk version is biome-formatted post-write
     * (see the format step at the end of main()), so we must pipe the
     * fresh content through biome to compare apples-to-apples. */
    const { spawnSync } = await import('node:child_process');
    const formatStdin = (filePath: string, src: string): string => {
      const r = spawnSync('bunx', ['biome', 'format', `--stdin-file-path=${filePath}`], {
        input: src,
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      });
      if (r.status !== 0) {
        throw new Error(
          `biome format --stdin failed for ${filePath}: ${r.stderr ?? '(no stderr)'}`,
        );
      }
      return r.stdout;
    };
    let drift = false;
    for (const { path, content } of targets) {
      const expected = path.endsWith('.ts') ? formatStdin(path, content) : content;
      try {
        const existing = readFileSync(path, 'utf-8');
        if (existing !== expected) {
          console.error(`DRIFT: ${path}`);
          drift = true;
        }
      } catch {
        console.error(`MISSING: ${path}`);
        drift = true;
      }
    }
    if (drift) {
      console.error('\nRun without --check to regenerate.');
      process.exit(1);
    }
    console.log('Generated outputs are in sync with manifest.json.');
    return;
  }

  /* Ensure directories exist (mkdir -p). */
  for (const { path } of targets) {
    const dir = dirname(path);
    try {
      // biome-ignore lint/correctness/noUndeclaredDependencies: node builtin
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }
  for (const { path, content } of targets) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }

  /* Format generated TS files so they match biome's expectations.
   * C files are not biome-formatted; only .ts outputs need this pass. */
  const tsTargets = targets.filter((t) => t.path.endsWith('.ts')).map((t) => t.path);
  if (tsTargets.length > 0) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('bunx', ['biome', 'format', '--write', ...tsTargets], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      throw new Error('biome format --write failed on generated TS files');
    }
  }
}

await main();
