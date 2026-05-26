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
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { FunctionSelector } from '@aztec/stdlib/abi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'packages/adapter-ledger/clear-signing-v0/manifest.json');

const TOKEN_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  'packages/adapter-ledger/node_modules/@defi-wonderland/aztec-standards/target/token_contract-Token.json',
);

const OUT_C_DIR = resolve(REPO_ROOT, 'ledger-app/src/clear_signing_v0');
const OUT_TS_DIR = resolve(REPO_ROOT, 'packages/adapter-ledger/src/clear_signing_v0');

const CHECK_MODE = process.argv.includes('--check');

interface RegistryEntry {
  slot: number;
  kind: 'TOKEN' | 'SPONSOR' | 'EMPTY';
  address: string;
  symbol: string;
  decimals: number;
}

interface VerbEntry {
  verb: string;
  kind: 'TOKEN' | 'SPONSOR';
  artifact_source: 'TOKEN_CONTRACT' | 'SPONSORED_FPC_CONTRACT';
  function_name: string;
  expected_selector_u32: string;
  is_public: boolean;
  args: string[];
  wire_arg_count: number;
  display_name: string;
}

interface Manifest {
  _meta: {
    aztec_packages_pin: string;
    aztec_standards_npm_pin: string;
  };
  registry: RegistryEntry[];
  verbs: VerbEntry[];
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

  /* Selector check — fail-closed. */
  const isSponsorPath = verb.artifact_source === 'SPONSORED_FPC_CONTRACT';
  const sel = isSponsorPath
    ? await FunctionSelector.fromSignature(`${verb.function_name}()`) // sponsored_fee_payment.ts:28 uses fromSignature
    : await FunctionSelector.fromNameAndParameters(verb.function_name, parameters as never);
  const selHex = sel.toString();
  if (selHex.toLowerCase() !== verb.expected_selector_u32.toLowerCase()) {
    throw new Error(
      `[fail-closed] Selector drift for verb=${verb.verb}: manifest=${verb.expected_selector_u32}, artifact-computed=${selHex}`,
    );
  }

  /* Visibility check — fail-closed.
   *
   * Token artifact: `custom_attributes` carries "abi_private" or "abi_public".
   * SponsoredFPC artifact: no custom_attributes for v0; hardcode the assertion
   * to match `aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:29`
   * which builds the call with FunctionType.PRIVATE. */
  const expectedAttr = verb.is_public ? 'abi_public' : 'abi_private';
  if (verb.artifact_source === 'TOKEN_CONTRACT') {
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
   * Tokens with PRIVATE entrypoint annotation have a prepended `inputs`
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
    // Private Token entrypoint: artifact prepends `inputs` PrivateContextInputs
    if (parameters.length === 0 || parameters[0]?.name !== 'inputs') {
      throw new Error(
        `[fail-closed] Private Token verb=${verb.verb} expected first artifact param "inputs"; got ${parameters[0]?.name ?? '(none)'}`,
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
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length > maxLen) throw new Error(`symbol too long: "${s}"`);
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
  const entries = manifest.registry
    .map((e) => {
      const kindNum = e.kind === 'EMPTY' ? 0 : e.kind === 'TOKEN' ? 1 : 2;
      const addrBytes = bytesFromBe32Hex(e.address);
      const sym = cSymbolLiteral(e.symbol, SYMBOL_LEN);
      return `  { /* slot ${e.slot} */ .kind = ${kindNum}, .address = ${fmtByteArray(addrBytes)}, .symbol = ${sym}, .decimals = ${e.decimals}, ._reserved = {0,0,0} },`;
    })
    .join('\n');

  const impl = `/* Generated. DO NOT EDIT. */
#include "registry.gen.h"
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

  const entries = manifest.verbs
    .map((v) => {
      const kindNum = v.kind === 'TOKEN' ? 1 : 2;
      const sel = v.expected_selector_u32;
      return `  { .selector_u32 = ${sel}u, .kind = ${kindNum}, .verb = CS_VERB_${v.verb}, .is_public = ${v.is_public ? 1 : 0}, .wire_arg_count = ${v.wire_arg_count} },`;
    })
    .join('\n');

  const impl = `/* Generated. DO NOT EDIT. */
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

export type CsContractKind = 'EMPTY' | 'TOKEN' | 'SPONSOR';

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
  const normalized = addressHex.toLowerCase().startsWith('0x')
    ? addressHex.toLowerCase()
    : '0x' + addressHex.toLowerCase();
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
  readonly kind: 'TOKEN' | 'SPONSOR';
  readonly selector_u32: number;
  readonly is_public: boolean;
  readonly wire_arg_count: number;
  readonly display_name: string;
  readonly args: readonly string[];
}

export const CS_VERBS: readonly CsVerbEntry[] = [
${entries}
] as const;

export function csVerbLookup(kind: 'TOKEN' | 'SPONSOR', selectorU32: number): CsVerbEntry | undefined {
  return CS_VERBS.find((v) => v.kind === kind && v.selector_u32 === selectorU32);
}
`;
}

/* --- Main --------------------------------------------------------------- */

async function main(): Promise<void> {
  /* Cross-check every verb FIRST (fail-closed before any output). */
  for (const verb of manifest.verbs) {
    await crossCheckVerb(verb);
  }

  const { header: regH, impl: regC } = emitRegistryC();
  const { header: selH, impl: selC } = emitSelectorsC();
  const regTs = emitRegistryTs();
  const selTs = emitSelectorsTs();

  const targets: { path: string; content: string }[] = [
    { path: join(OUT_C_DIR, 'registry.gen.h'), content: regH },
    { path: join(OUT_C_DIR, 'registry.gen.c'), content: regC },
    { path: join(OUT_C_DIR, 'selectors.gen.h'), content: selH },
    { path: join(OUT_C_DIR, 'selectors.gen.c'), content: selC },
    { path: join(OUT_TS_DIR, 'registry.generated.ts'), content: regTs },
    { path: join(OUT_TS_DIR, 'selectors.generated.ts'), content: selTs },
  ];

  if (CHECK_MODE) {
    /* Drift detector: compare existing files against fresh-generated. */
    let drift = false;
    for (const { path, content } of targets) {
      try {
        const existing = readFileSync(path, 'utf-8');
        if (existing !== content) {
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
}

await main();
