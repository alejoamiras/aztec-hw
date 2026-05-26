/**
 * Generate Poseidon2 round constants + Montgomery parameters for the
 * Ledger app's BN254 Fr backend.
 *
 * Source-of-truth:
 *   /Users/alejoamiras/Projects/aztec-packages/barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_params.hpp
 *
 * Audit pin (from that file's AUDIT STATUS comment): barretenberg commit
 *   `dd03c4a23ab067274b4964cacb36d1545f73fb14`.
 * Local aztec-packages tree pinned to commit `2770bcb82d40323060c2f9c71aaf293b640efbef`
 * (matches L4 plan and golden-vector generator).
 *
 * Output: `ledger-app/src/crypto/poseidon2/constants.{h,c}`.
 *
 * What we emit (all in Montgomery form, little-endian 64-bit limbs):
 *   - 16 round constants for the 4 leading FULL rounds (4 lanes each)
 *   - 56 round constants for the PARTIAL rounds (lane 0 only — other lanes are
 *     algorithmically 0, per `poseidon2_permutation.hpp:147`)
 *   - 16 round constants for the 4 trailing FULL rounds (4 lanes each)
 *   - 4 `internal_matrix_diagonal_minus_one` constants
 *   - `TEST_VECTOR_INPUT` + `TEST_VECTOR_OUTPUT` (4 each, used as raw-permutation
 *     smoke test in host parity tests — bypasses sponge layer)
 *   - Montgomery `R²` (for to-Montgomery conversion of runtime inputs)
 *
 * Compaction rationale (`92 fields ≈ 2944 bytes`): partial-round lanes 1..3
 * carry no information because `matrix_multiplication_internal` immediately
 * sums them into one accumulator anyway. We assert at codegen that those
 * slots are exactly zero in the source.
 *
 * Run via: `bun run packages/adapter-ledger/scripts/gen-poseidon2-constants.ts`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AZTEC_PACKAGES_DIR = '/Users/alejoamiras/Projects/aztec-packages';
const PARAMS_HPP = join(
  AZTEC_PACKAGES_DIR,
  'barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_params.hpp',
);
const OUT_DIR = join(__dirname, '../../../ledger-app/src/crypto/poseidon2');

const ROUNDS_F = 8;
const ROUNDS_P = 56;
const T = 4;

// BN254 Fr prime (the scalar field used by Poseidon2 in Aztec).
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MASK64 = (1n << 64n) - 1n;
const R = (1n << 256n) % P;
const R2 = (R * R) % P;

function modInverse(a: bigint, m: bigint): bigint {
  // Extended Euclidean: returns x with a*x ≡ 1 (mod m).
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) {
    throw new Error('modInverse: not coprime');
  }
  return ((oldS % m) + m) % m;
}

// Montgomery helper: mu = -p^{-1} mod 2^64. CIOS uses this to clear the
// low limb in each reduction step.
const P_LIMB0 = P & MASK64;
const MU = ((1n << 64n) - modInverse(P_LIMB0, 1n << 64n)) & MASK64;

function toLimbsLE(x: bigint): bigint[] {
  const limbs: bigint[] = [];
  let v = x;
  for (let i = 0; i < 4; i++) {
    limbs.push(v & MASK64);
    v >>= 64n;
  }
  if (v !== 0n) {
    throw new Error(`toLimbsLE: value ${x.toString(16)} > 2^256`);
  }
  return limbs;
}

function toMont(x: bigint): bigint {
  return (x * R) % P;
}

function limbsLiteral(limbs: bigint[]): string {
  return `{{ ${limbs.map((l) => `0x${l.toString(16).padStart(16, '0')}ULL`).join(', ')} }}`;
}

function frLiteral(x: bigint): string {
  return limbsLiteral(toLimbsLE(toMont(x)));
}

const hpp = readFileSync(PARAMS_HPP, 'utf-8');

// Capture every literal of the form `FF(std::string("0x..."))` in source order.
// The file structure (verified at run time below) is:
//   1. internal_matrix_diagonal_minus_one[4]
//   2. internal_matrix[4][4]  ← we don't use these directly; assert structure
//   3. round_constants[rounds_f + rounds_p][t] = 64 × 4 = 256 entries
//   4. TEST_VECTOR_INPUT[4]
//   5. TEST_VECTOR_OUTPUT[4]
const ffRegex = /FF\(std::string\("(0x[0-9a-fA-F]+)"\)\)/g;
const matches: string[] = [];
for (const m of hpp.matchAll(ffRegex)) {
  matches.push(m[1]);
}

const EXPECTED_TOTAL = T + T * T + (ROUNDS_F + ROUNDS_P) * T + T + T;
if (matches.length !== EXPECTED_TOTAL) {
  throw new Error(`expected ${EXPECTED_TOTAL} FF constants in params.hpp, found ${matches.length}`);
}

const offsets = {
  diag: 0,
  internalMatrix: T,
  roundConstants: T + T * T,
  testInput: T + T * T + (ROUNDS_F + ROUNDS_P) * T,
  testOutput: T + T * T + (ROUNDS_F + ROUNDS_P) * T + T,
};

const diagMinusOne = matches.slice(offsets.diag, offsets.diag + T).map((h) => BigInt(h));

const roundConstantsFlat = matches
  .slice(offsets.roundConstants, offsets.roundConstants + (ROUNDS_F + ROUNDS_P) * T)
  .map((h) => BigInt(h));

const testInput = matches.slice(offsets.testInput, offsets.testInput + T).map((h) => BigInt(h));

const testOutput = matches.slice(offsets.testOutput, offsets.testOutput + T).map((h) => BigInt(h));

// Sanity: internal_matrix's diagonal entries should equal diag + 1 (per the
// comment "We store D_i - 1, ..."). Verify so any future codegen change
// in barretenberg fails loudly here rather than during permutation parity.
for (let i = 0; i < T; i++) {
  const diagEntry = BigInt(matches[offsets.internalMatrix + i * T + i]);
  const expected = (diagMinusOne[i] + 1n) % P;
  if (diagEntry !== expected) {
    throw new Error(
      `internal_matrix[${i}][${i}]=${diagEntry.toString(16)} != ` +
        `diag_minus_one[${i}]+1=${expected.toString(16)}`,
    );
  }
}

// Slice round constants into the three Poseidon2 phases.
const rcLeading: bigint[][] = []; // 4 rounds × 4 lanes
const rcPartial: bigint[] = []; // 56 rounds × lane 0 only
const rcTrailing: bigint[][] = []; // 4 rounds × 4 lanes

const partialStart = ROUNDS_F / 2;
const partialEnd = partialStart + ROUNDS_P;

for (let i = 0; i < ROUNDS_F + ROUNDS_P; i++) {
  const rc = roundConstantsFlat.slice(i * T, (i + 1) * T);
  if (i < partialStart) {
    rcLeading.push(rc);
  } else if (i < partialEnd) {
    // Lanes 1..3 must be exactly zero per the partial-round structure
    // (`apply_single_sbox(state[0])` only touches lane 0; lanes 1..3 don't
    // get a constant added).
    for (let j = 1; j < T; j++) {
      if (rc[j] !== 0n) {
        throw new Error(`partial round ${i} lane ${j} non-zero (${rc[j].toString(16)})`);
      }
    }
    rcPartial.push(rc[0]);
  } else {
    rcTrailing.push(rc);
  }
}

if (rcLeading.length !== ROUNDS_F / 2) throw new Error('leading count');
if (rcPartial.length !== ROUNDS_P) throw new Error('partial count');
if (rcTrailing.length !== ROUNDS_F / 2) throw new Error('trailing count');

// Capture commit hash for the header so any future regeneration is auditable.
function gitHead(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
}

const aztecHead = gitHead(AZTEC_PACKAGES_DIR);

// Emit header.
const headerLines: string[] = [
  '/**',
  ' * Poseidon2 round constants + Montgomery parameters for BN254 Fr.',
  ' *',
  ` * Generated from aztec-packages commit ${aztecHead}.`,
  ' * Audit pin (per barretenberg AUDIT STATUS comment):',
  ' *   dd03c4a23ab067274b4964cacb36d1545f73fb14',
  ' *',
  ' * DO NOT EDIT. Regenerate via:',
  ' *   bun run packages/adapter-ledger/scripts/gen-poseidon2-constants.ts',
  ' */',
  '#pragma once',
  '',
  '#include "fr.h"',
  '#include "poseidon2.h"',
  '',
  `#define AZ_POSEIDON2_ROUNDS_F_HALF ${ROUNDS_F / 2}`,
  `#define AZ_POSEIDON2_ROUNDS_P_COUNT ${ROUNDS_P}`,
  '',
  '/* Leading full rounds (4 rounds, 4 lanes each, Montgomery form). */',
  `extern const fr_t AZ_POSEIDON2_RC_LEADING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T];`,
  '',
  '/* Partial rounds (56 rounds, lane 0 only — other lanes are zero by construction). */',
  `extern const fr_t AZ_POSEIDON2_RC_PARTIAL[AZ_POSEIDON2_ROUNDS_P_COUNT];`,
  '',
  '/* Trailing full rounds (4 rounds, 4 lanes each, Montgomery form). */',
  `extern const fr_t AZ_POSEIDON2_RC_TRAILING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T];`,
  '',
  '/* internal_matrix_diagonal_minus_one (4 lanes, Montgomery form). */',
  `extern const fr_t AZ_POSEIDON2_DIAG_MINUS_ONE[AZ_POSEIDON2_T];`,
  '',
  '/* Raw-permutation parity vectors (Montgomery form). Smoke test from',
  ' * poseidon2_params.hpp:447-458, bypasses sponge. */',
  `extern const fr_t AZ_POSEIDON2_TEST_INPUT[AZ_POSEIDON2_T];`,
  `extern const fr_t AZ_POSEIDON2_TEST_OUTPUT[AZ_POSEIDON2_T];`,
];

writeFileSync(join(OUT_DIR, 'constants.h'), `${headerLines.join('\n')}\n`);

// Emit .c with the actual data. Keep all of this Montgomery-form so the
// permutation doesn't need to convert constants at runtime.
const cLines: string[] = [
  '/* Generated — see constants.h header for source pin. DO NOT EDIT. */',
  '#include "constants.h"',
  '',
  'const fr_t AZ_POSEIDON2_RC_LEADING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T] = {',
];
for (const round of rcLeading) {
  cLines.push(`  { ${round.map(frLiteral).join(', ')} },`);
}
cLines.push('};');
cLines.push('');

cLines.push('const fr_t AZ_POSEIDON2_RC_PARTIAL[AZ_POSEIDON2_ROUNDS_P_COUNT] = {');
for (const rc of rcPartial) {
  cLines.push(`  ${frLiteral(rc)},`);
}
cLines.push('};');
cLines.push('');

cLines.push('const fr_t AZ_POSEIDON2_RC_TRAILING[AZ_POSEIDON2_ROUNDS_F_HALF][AZ_POSEIDON2_T] = {');
for (const round of rcTrailing) {
  cLines.push(`  { ${round.map(frLiteral).join(', ')} },`);
}
cLines.push('};');
cLines.push('');

cLines.push('const fr_t AZ_POSEIDON2_DIAG_MINUS_ONE[AZ_POSEIDON2_T] = {');
for (const x of diagMinusOne) {
  cLines.push(`  ${frLiteral(x)},`);
}
cLines.push('};');
cLines.push('');

cLines.push('const fr_t AZ_POSEIDON2_TEST_INPUT[AZ_POSEIDON2_T] = {');
for (const x of testInput) {
  cLines.push(`  ${frLiteral(x)},`);
}
cLines.push('};');
cLines.push('');

cLines.push('const fr_t AZ_POSEIDON2_TEST_OUTPUT[AZ_POSEIDON2_T] = {');
for (const x of testOutput) {
  cLines.push(`  ${frLiteral(x)},`);
}
cLines.push('};');
cLines.push('');

writeFileSync(join(OUT_DIR, 'constants.c'), cLines.join('\n'));

// Emit fr_params.h with field-level Montgomery scalars. Kept separate from
// constants.h so the Fr backend can be audited/swapped without touching the
// poseidon2 codegen output.
const frParamsLines: string[] = [
  '/**',
  ' * BN254 Fr field parameters for the Montgomery 4×u64 backend.',
  ' * Generated alongside constants.c; do not edit by hand.',
  ' */',
  '#pragma once',
  '',
  '#include "fr.h"',
  '',
  '/* p (the BN254 scalar field modulus), little-endian 64-bit limbs. */',
  'extern const fr_t AZ_FR_P;',
  '',
  '/* R² mod p, used to convert into Montgomery form via one Montgomery mul. */',
  'extern const fr_t AZ_FR_R2;',
  '',
  '/* mu = -p^{-1} mod 2^64. Helper for CIOS reduction. */',
  `extern const uint64_t AZ_FR_MU;`,
];
writeFileSync(join(OUT_DIR, 'fr_params.h'), `${frParamsLines.join('\n')}\n`);

const frParamsC: string[] = [
  '/* Generated — see fr_params.h header. DO NOT EDIT. */',
  '#include "fr_params.h"',
  '',
  `const fr_t AZ_FR_P = ${limbsLiteral(toLimbsLE(P))};`,
  '',
  `const fr_t AZ_FR_R2 = ${limbsLiteral(toLimbsLE(R2))};`,
  '',
  `const uint64_t AZ_FR_MU = 0x${MU.toString(16).padStart(16, '0')}ULL;`,
  '',
];
writeFileSync(join(OUT_DIR, 'fr_params.c'), frParamsC.join('\n'));

console.log(`Wrote constants.{h,c} + fr_params.{h,c} to ${OUT_DIR}`);
console.log(
  `  ${rcLeading.length} leading-full × ${T}, ${rcPartial.length} partial × 1, ${rcTrailing.length} trailing-full × ${T}`,
);
console.log(`  Montgomery mu = 0x${MU.toString(16).padStart(16, '0')}`);
console.log(`  Aztec head: ${aztecHead}`);
