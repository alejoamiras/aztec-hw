# M8 Full-Sovereignty — Independent Implementation Plan (Opus)

**Audience:** main author triangulating three independent drafts.
**Stance:** I challenge the locked premises where I have evidence and propose a sharply different shape for the recovery primitive. I treat sign-and-derive as an inferior choice and explain why.

---

## 0. Top-line critique before any phases

After reading the briefing, the anchor doc, the M7 plan, the current device code, and the Aztec key derivation reference (`aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:95-124`), I have a strong objection to the framing.

**The locked design — "RFC 6979 deterministic ECDSA over `H('aztec-vk-derive-v1' || path_bytes)` then host HKDF-expand sig → 4 Grumpkin scalars" — is solving a problem Aztec already solved, badly.**

Aztec's canonical derivation is in `derivation.ts:95-124`: from a single 32-byte `secretKey: Fr`, run `sha512ToGrumpkinScalar([secretKey, DomainSeparator.{NHK_M,IVSK_M,OVSK_M,TSK_M}])`. SHA-512 outputs 512 bits, reduce to a Grumpkin scalar via `GrumpkinScalar.fromBufferReduce(sha512(buffer))` (`foundation/src/crypto/sha512/index.ts:13-16`). The bias from reducing 512 bits mod a ~254-bit prime is negligible (≤ 2^{-256}). The host PXE's `KeyStore.addAccount(sk, partialAddress)` already takes exactly this `sk: Fr` (`key-store/src/key_store.ts:54-94`) and reconstructs every viewing key.

**This means recovery from a single 32-byte master secret is the natural primitive.** Sign-and-derive forces:

1. RFC 6979 implementation correctness on-device (Trezor's 2018 nonce bug precedent is exactly this surface).
2. A *new* domain separation regime ("aztec-vk-derive-v1") that has no precedent in the protocol.
3. Host-side HKDF expand into 4 scalars with non-zero bias unless oversampled, all of which is custom code that has to be audited.
4. A user-visible 64-byte `r || s` blob that is *not* the same as Aztec's notion of "master secret" and therefore cannot be imported into any other Aztec wallet or PXE backup tool.
5. A binding lever: the sig is computed from `H("aztec-vk-derive-v1" || path)`, which means the master secret is *only* recoverable through the device — losing the device means losing decryption, regardless of seed-phrase backup.

**My recommendation: drop sign-and-derive. Use `INS_GET_AZTEC_MASTER_SECRET` instead.**

The instruction returns a 32-byte BE Fr derived from BIP-32 entropy via SHA-512 to Fr (BN254 scalar, **not** Grumpkin scalar — that's `sk: Fr` in Aztec's model). The host calls `deriveKeys(sk)` from `@aztec/stdlib/keys` directly — same code path the in-memory wallet uses, so behavior is bit-identical by construction (no independent oracle problem). Recovery: device shows "Reveal Aztec master secret? This grants permanent read access to your notes." User confirms. Device displays a 24-word BIP-39 derived mnemonic of the 32-byte secret + a checksum. User writes it down. Restore on a new browser: paste the mnemonic, host re-runs `deriveKeys` and `KeyStore.addAccount`, PXE re-syncs notes.

This is simpler, uses existing primitives the wallet already trusts, and is robust against device loss (the mnemonic recovers viewing — signing requires a new device + redeploy, which is fine because protocol/viewing keys are the irreversible loss). It also doesn't need on-device Grumpkin scalar mult for derivation — only for `publicKeysHash` and address verification (which is unavoidable).

**However**, the briefing locks sign-and-derive. So I plan for both: my "Option B" plan honors the locked decision exactly, and "Option A" is what I'd build if the lock were lifted. Phases below are written against Option B with notes for Option A divergence. I expect the main author to weigh the trade-off after triangulation.

---

## 1. Phase decomposition with explicit dependencies

I structure M8 as 9 phases. Phases 1–4 ship as `safe-v3` (P4 host deploy builder, in isolation). Phases 5–9 ship as `safe-v4` (Grumpkin device + viewing derivation + recovery demo).

### Phase 1 — Independent oracle and golden vectors (foundational, blocks everything)

**Files:**
- `packages/adapter-ledger/test/oracle/aztec-grumpkin-oracle.ts` (new)
- `packages/adapter-ledger/test/oracle/aztec-derivation-oracle.ts` (new)
- `packages/adapter-ledger/test/oracle/golden-vectors.json` (new)
- `ledger-app/tests/test_grumpkin_oracle_parity.py` (new)

**APIs added:**
- `computeAddressViaBarretenberg(publicKeys: PublicKeys, partialAddress: Fr): Promise<AztecAddress>` — direct call to `Grumpkin.add(Grumpkin.mul(generator, preaddress), ivpk_m)` from `@aztec/foundation/crypto/grumpkin` (bb.js WASM, NOT our own code).
- `deriveKeysViaStdlib(secretKey: Fr)` — passthrough to `deriveKeys` from `@aztec/stdlib/keys`.
- Random-vector generator: 256 `(sk, partial)` triples + their expected `address`, all four `viewing_secret_keys`, `publicKeysHash`.

**Dependencies:** none.

**Done-when:** golden vectors committed; `bun test test/oracle/*.test.ts` validates that Aztec's own bb.js path produces stable output; CI runs nightly.

**Why first:** without this, any later assertion that "device output matches Aztec" is circular. The M7 plan flagged "shared crypto bug across host TS + device C" as risk 8.11. This phase closes it.

---

### Phase 2 — Host-side deploy builder (P4 → safe-v3 checkpoint)

**Files:**
- `packages/adapter-ledger/src/deploy-builder.ts` (new): pure functions, no Ledger transport
- `packages/adapter-ledger/src/aztec-ledger-session.ts` (update `deployAccountClearSigned`)
- `packages/adapter-ledger/src/deploy-builder.test.ts` (new): unit tests with frozen witness
- `packages/adapter-ledger/src/aztec-ledger-session.integration.test.ts` (update: end-to-end deploy on alpha-testnet)

**APIs added:**
```ts
// deploy-builder.ts
export interface DeployBuildInputs {
  account: AztecAddress;
  partialAddress: Fr;
  publicKeysHash: Fr;
  signingPubkey: { x: Uint8Array; y: Uint8Array };
  salt: Fr;
  classId: Fr;
  txNonce: Fr;
  chainInfo: { chainId: Fr; protocolVersion: Fr };
  sponsorFpc: AztecAddress;
}
export interface DeployBuildOutput {
  outerHash: Fr;
  buildTxRequest(witness: AuthWitness): Promise<TxExecutionRequest>;
}
export async function buildDeploy(inputs: DeployBuildInputs): Promise<DeployBuildOutput>;
```

The function:
1. Mirrors `DeployMethod.getInitializationExecutionPayload()` with `skipClassPublication=true, skipInstancePublication=true` (ref `aztec.js/src/contract/deploy_method.ts:517-529`).
2. Builds sponsor `ExecutionPayload` via `SponsoredFeePaymentMethod.getExecutionPayload()`.
3. Computes `outerHash` via `computeOuterAuthWitHash(account, chainId, protocolVersion, payloadHash)` from `@aztec/entrypoints` so the host hash matches what the device will recompute later.
4. Returns a thunk that, once given the witness, wraps via `DefaultAccountEntrypoint(account, FrozenAuthWitnessProvider).wrapExecutionPayload`, merges into `[init, wrappedSponsor]`, runs through `DefaultMultiCallEntrypoint.wrapExecutionPayload`, then `DefaultEntrypoint.createTxExecutionRequest` — exactly per M7 plan §3.1 with the codex audit BLOCKER #1 fix already baked in.
5. Passes `deployer: AztecAddress.ZERO` when invoking `request()` directly (v4.2.1 quirk — `convertDeployOptionsToRequestOptions` injects this normally).

**Dependencies:** Phase 1 oracle (for unit test parity vs. `DeployAccountMethod` output on a fixed seed).

**Done-when:**
- Pure unit test: feed in fixed inputs + a frozen pre-computed ECDSA-K signature; assert the resulting `TxExecutionRequest` byte-matches one produced by Aztec's stock `DeployAccountMethod.request()` path with the same witness.
- Integration test: deploy on alpha-testnet via the device APDU set, account gets a 9-step phase trace, balance show on a follow-up tx.

**Checkpoint:** tag `safe-v3` after this phase. Ships without Grumpkin scalar mult — same trust model as M7 P3 (no on-device address verification).

---

### Phase 3 — Grumpkin scalar (`bb::fq`) arithmetic module

**Files:**
- `ledger-app/src/crypto/grumpkin/fq.h`, `fq.c` (new): Grumpkin scalar field = BN254 base field
- `ledger-app/src/crypto/grumpkin/fq_params.c` (new): generated modulus + R^2 + mu constants
- `ledger-app/src/crypto/grumpkin/CMakeLists.txt` or `Makefile.fragment` update
- `ledger-app/tests/test_grumpkin_fq.py` (ragger unit test via a debug INS, behind `#ifdef DEBUG_GRUMPKIN`)
- `packages/adapter-ledger/test/oracle/grumpkin-fq-vectors.ts` (parity vectors)

**APIs added:**
```c
typedef struct { uint64_t limbs[4]; } gk_fq_t;  /* Montgomery form */
void gk_fq_from_bytes_be(gk_fq_t *out, const uint8_t bytes[32]);  /* returns nonzero on overflow */
void gk_fq_to_bytes_be(uint8_t out[32], const gk_fq_t *a);
void gk_fq_add(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
void gk_fq_sub(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
void gk_fq_mul(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
bool gk_fq_eq(const gk_fq_t *a, const gk_fq_t *b);
/* Reduction from a wide buffer (for SHA-512 → Grumpkin scalar). */
void gk_fq_from_bytes_wide_be(gk_fq_t *out, const uint8_t bytes[64]);
```

**Implementation strategy:** clone the existing `crypto/poseidon2/fr.c` Montgomery CIOS backend. The only difference is the modulus (Grumpkin scalar = BN254 base, `0x30644E72…` per `barretenberg/cpp/src/barretenberg/ecc/curves/bn254/fq.hpp`) and the parameter constants. The 4×u64 limb shape is identical; the BOLOS clang produces no `__uint128_t` so we reuse the `mul64`/`muladd` split.

**Stack budget:** each `gk_fq_t` is 32 bytes. Multiplication needs ~80 bytes temp. Trivially fits.

**Cycle budget per mul:** the existing `fr_mul` runs ~16 64-bit muladds. On Cortex M0+ with no native 64×64, each is ~80 cycles. Total ~1280 cycles per Mont-mul. At ~25 MHz that's ~50 µs/mul. Acceptable.

**Dependencies:** Phase 1 oracle for parity vectors.

**Done-when:** 4000+ random `(a, b)` parity vectors against `Fq` from `aztec-packages/yarn-project/foundation/src/curves/bn254/field.ts`. Bit-exact. Ragger test runs a debug INS that loops Mont-muls and returns timing — confirm <100 µs/mul on Speculos.

---

### Phase 4 — Grumpkin EC group operations (the core of M8)

**Files:**
- `ledger-app/src/crypto/grumpkin/g1.h`, `g1.c` (new)
- `ledger-app/src/crypto/grumpkin/g1_generator.c` (new): generator point in Montgomery form, both affine and Jacobian representations
- `ledger-app/src/crypto/grumpkin/g1_endo.c` (new): GLV endomorphism (lambda, beta constants)
- `ledger-app/src/crypto/grumpkin/g1_table.c` (new, optional): precomputed 4-bit signed window table for `[k]G`
- `packages/adapter-ledger/test/oracle/grumpkin-g1-vectors.ts`

**APIs added:**
```c
typedef struct {
    fr_t x;        /* point coord — Grumpkin BASE field == BN254 scalar field */
    fr_t y;
    fr_t z;        /* Jacobian; z=1 for affine; z=0 for infinity */
} gk_point_t;

void gk_point_zero(gk_point_t *out);          /* point at infinity */
void gk_point_from_affine_xy(gk_point_t *out, const fr_t *x, const fr_t *y);
void gk_point_to_affine(uint8_t out_x[32], uint8_t out_y[32], const gk_point_t *p);
void gk_point_double(gk_point_t *out, const gk_point_t *p);
void gk_point_add_mixed(gk_point_t *out, const gk_point_t *p, const fr_t *q_x, const fr_t *q_y);
void gk_point_add(gk_point_t *out, const gk_point_t *p, const gk_point_t *q);
bool gk_point_on_curve(const gk_point_t *p);  /* y^2 == x^3 - 17 mod r */

/* Variable-base scalar mult (constant-time Montgomery ladder, used for ivpk_m * G if needed). */
void gk_scalar_mul(gk_point_t *out, const gk_fq_t *k, const gk_point_t *base);

/* Fixed-base scalar mult: [k]G. 4-bit signed comb + precomputed table.
 * Constant-time relative to k (table lookup is masked). */
void gk_scalar_mul_generator(gk_point_t *out, const gk_fq_t *k);
```

**Algorithm choices (defended):**

For `[k]G` (the hot path for `preaddress * G` and for deriving each viewing pubkey from its secret), use a **fixed-base 4-bit signed-digit comb**. Precompute 16 multiples of G (or fewer with GLV — see below) stored in Montgomery form, ~16 × 64B = 1024B of flash. Each scalar bit consumes one window; ~63 windows for a 254-bit scalar; ~63 mixed adds + 63 doublings; with GLV (Grumpkin's endomorphism is enabled per `grumpkin.hpp:21`), the scalar splits into two 127-bit halves, halving the doublings. **Per-scalar-mul cost estimate: ~150 Mont-muls × 50 µs = ~7.5 ms.** That's excellent — orders of magnitude under the user's perception threshold.

For variable-base (`[k]ivpk_m` only relevant if we ever decode notes on-device, which we won't), use Montgomery ladder; not worth the perf complexity for one-shot.

**Constant-time strategy:** the scalars touched on-device are `preaddress` (derived from poseidon2 — already public) and `master_viewing_secrets` (private). For private scalars, the fixed-base comb table is read constant-time using bitmask selection (no branch on key material). The endomorphism split also operates constant-time on the scalar. Squaring uses the same code path as multiplication (no `is_squaring` branch).

**Stack budget per scalar-mul:** 1 × `gk_point_t` accumulator (96B) + 1 × `gk_point_t` temp (96B) + 1 × `gk_fq_t` split scratch (32B) + 16 × `gk_point_t` precomputed table if held on stack (1536B; better to keep in flash). **Total ≤ 300B per call.** Well under Ledger's ~7KB app-stack budget.

**Reference impl to port:** barretenberg `cpp/src/barretenberg/ecc/groups/element.hpp` and `element_impl.hpp` for the Jacobian formulas. Endomorphism constants from `cpp/src/barretenberg/ecc/curves/bn254/bn254_endo_constants.hpp` (Aztec uses GLV for BN254/Grumpkin throughout). Do NOT use libsecp256k1 — different field, different curve constants.

**Has anyone done Grumpkin on embedded?** Not publicly. Pasta (Pallas/Vesta, used in Mina/Halo2 on small devices) is a close analog — Mina's hardware-wallet research published embedded Pallas. Polygon/Zcash use BLS12-381 on Ledger but not Grumpkin specifically. So this is novel embedded crypto; a third-party audit (e.g. Quarkslab) is in scope before any sovereign production claim.

**Side channels:** Ledger Nano S+ has Secure Element (ST33K1M5); BOLOS exposes Mont-mul-style ops via `cx_bn_*` that are advertised as constant-time. Our portable C path is NOT advertised constant-time — branch-free, yes, but cycle-counting and EM side channels on a 32-bit Cortex-M0+ are real. For M8 PoC: ship the portable code with a documented threat model ("PoC, side-channel hardening pending audit"). For production: port the Mont-mul layer to `cx_bn_*` and have Ledger Donjon audit.

**Dependencies:** Phase 3 (`gk_fq_t`).

**Done-when:** 256 random scalar-mul vectors against `Grumpkin.mul`/`Grumpkin.add` (Phase 1 oracle). Bit-exact. Ragger debug-INS timing test confirms `[k]G` < 50 ms (target ≤ 100 ms — leaves headroom for full address derivation).

---

### Phase 5 — Device-side viewing-key derivation (depending on Option)

#### Option A (my recommendation): direct master-secret derivation

**Files:**
- `ledger-app/src/handler/get_aztec_master_secret.{c,h}` (new)
- `ledger-app/src/crypto/sha512.{c,h}` (new) — BOLOS `cx_hash_sha512` wrapper
- `ledger-app/src/ui/master_secret_review_ui.{c,h}` (new) — high-friction "Reveal Aztec master secret?" screen with explicit per-app-instance permission
- `packages/adapter-ledger/src/master-secret.ts` (new)

**Wire format:**
```
INS_GET_AZTEC_MASTER_SECRET = 0x12
  path_scheme  : 1 B
  path_len     : 1 B
  path[]       : 4 * path_len B
```
Returns: `secret_be: 32 B`. Path: `m/44' / AZTEC_COIN_TYPE' / account' / 0 / 0`.

**Derivation:**
- BIP-32 derive a secp256k1 child key at the path.
- `entropy_64 = SHA-512("aztec-master-secret-v1" || X(child) || Y(child))`.
- `secret_fr = reduce_512_to_fr(entropy_64)` — reduce mod BN254 scalar field (the `Fr` modulus).
- Display review screen: "Aztec viewing key reveal. Path: m/44'/.../0/0. Address: 0x..." (full address required if Phase 6 is also wired).
- On confirm, return `secret_fr`. On reject, return SW_USER_REJECTED.

#### Option B (briefing-locked): sign-and-derive

**Files:**
- `ledger-app/src/handler/derive_aztec_viewing_keys.{c,h}` (new)
- `packages/adapter-ledger/src/viewing-derivation.ts` (new)
- `ledger-app/src/crypto/hkdf.{c,h}` — NOT NEEDED if the host does HKDF (preferred per briefing)

**Wire format:**
```
INS_DERIVE_AZTEC_VIEWING_KEYS = 0x12
  path_scheme  : 1 B
  path_len     : 1 B
  path[]       : 4 * path_len B
  // No additional inputs — message is internally synthesized
```
Returns: `r: 32 B, s: 32 B`. Internal message: `SHA-256("aztec-vk-derive-v1" || path_bytes_canonical)`. Signs with `bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1, path, CX_RND_RFC6979, CX_SHA256, digest, r, s)`. Low-s normalize. Display: "Derive Aztec viewing keys? Path: m/44'/.../0/0. This grants permanent read access to your notes." Strict domain separation: the digest is constructed from a literal byte-string `"aztec-vk-derive-v1"` (18 bytes ASCII, not part of any other Aztec primitive) + path. **No collision with `sha256(outer_hash)`** — outer_hash is 32 bytes BE, prefix collision with our 18-byte ASCII tag is cryptographically negligible but conceptually clean because the input length differs and the device never accepts a host-supplied digest here.

#### HKDF parameters (Option B only)

- Use HKDF-SHA-256, RFC 5869.
- Salt: `"aztec-vk-derive-v1-salt"` (23 bytes ASCII), public, fixed.
- IKM: `r || s` (64 bytes).
- Info bytes per scalar:
  - `nsk_m` → `"aztec/nsk_m/v1"` (15 B)
  - `ivsk_m` → `"aztec/ivsk_m/v1"` (16 B)
  - `ovsk_m` → `"aztec/ovsk_m/v1"` (16 B)
  - `tsk_m` → `"aztec/tsk_m/v1"` (15 B)
- Output length per scalar: **64 bytes** (NOT 32), so wide-reduction mod Grumpkin q (the order, ~254 bits) has bias ≤ 2^{-256}. Reducing 32 bytes mod a 254-bit prime yields bias ≈ 2^{-2} from the top two bits — unacceptable for crypto material. With 64-byte expand + wide reduction (via `gk_fq_from_bytes_wide_be`, Phase 3 addition), bias is negligible.

**Dependencies:** Phase 1 (oracle). Phase 3 (wide reduction for Option B). For Option A, only Phase 1.

**Done-when:**
- Option A: `getAztecMasterSecret(path)` returns 32 BE bytes; passing to `deriveKeys(Fr.fromBuffer(secret))` produces the *same* `publicKeysHash` that the device computes in Phase 7. Round-trip test on 64 random paths.
- Option B: 64 random paths produce stable `(r, s)`, host HKDF-expanded scalars match the device's Grumpkin pubkeys (after Phase 6).

---

### Phase 6 — Device-side `publicKeysHash` + address recomputation

**Files:**
- `ledger-app/src/l4/deploy_address.c` (update — add Grumpkin EC step)
- `ledger-app/src/l4/key_derivation.{c,h}` (new) — derives 4 viewing pubkeys from a master secret on-device
- `ledger-app/src/handler/begin_deploy_account.c` (update — call the EC step; cross-check against `expected_address`)
- `ledger-app/src/sw.h` (graduate `SW_DEPLOY_ADDRESS_MISMATCH = 0x6F0E` and `SW_DEPLOY_PUBKEY_HASH_MISMATCH = 0x6F0F` from reserved → active)
- `ledger-app/src/clear_signing_v0/deploy_profiles.gen.{c,h}` (already exists)

**API additions:**
```c
int gk_derive_viewing_keys(
    const uint8_t master_secret_be[32],  /* Fr */
    gk_point_t out_npk_m, out_ivpk_m, out_ovpk_m, out_tpk_m,
    uint8_t out_public_keys_hash_be[32]);

int gk_compute_address(
    const uint8_t public_keys_hash[32],
    const uint8_t partial_address[32],
    const gk_point_t *ivpk_m,
    uint8_t out_address[32]);
```

**Sequencing in `begin_deploy_account.c`:**

1. Existing poseidon2 chain → `partial_address` (already implemented).
2. Internally call `INS_GET_AZTEC_MASTER_SECRET`-equivalent: derive the master secret from the same path (or, for Option B, replay the local sign→HKDF inside the device).
3. Derive the 4 viewing pubkeys via `[sk_i]G` (4 × scalar-mul-generator).
4. Compute `publicKeysHash` on-device via poseidon2 over the 4 points (matches `PublicKeys.hash()` in `aztec-packages/yarn-project/stdlib/src/keys/public_keys.ts:75-87`).
5. Compare device-computed `publicKeysHash` with host-supplied. Mismatch → `SW_DEPLOY_PUBKEY_HASH_MISMATCH (0x6F0F)`.
6. Compute `preaddress = poseidon2([publicKeysHash, partial_address], DomainSeparator.CONTRACT_ADDRESS_V1)`.
7. Compute `addressPoint = (preaddress * G) + ivpk_m`.
8. Compare `addressPoint.x` with host-supplied `expected_address`. Mismatch → `SW_DEPLOY_ADDRESS_MISMATCH (0x6F0E)`.
9. Run 3-pass parity recompute (steps 2–8). Mismatch → `SW_HASH_MISMATCH`.

**Critical: this removes the M7 trust gap.** Per M7 §8.1 BLOCKER #2: "a malicious host can deliberately pick a valid host-controlled key bundle and a matching expected_address". After M8 Phase 6, the device derives its own viewing pubkeys, computes its own `publicKeysHash`, and rejects if the host bundle disagrees. The host can no longer pick the key bundle.

**Stack budget for the deploy review path:**
- 4 × scalar-mul-generator state: 4 × 300B = 1200B
- poseidon2 sponge: 200B
- Per-pass workspace: 400B
- Triple recompute: not concurrent, reuses workspace
- **Total stack at peak: ~1800B.** Well within Ledger's 7KB budget.

**Per-deploy time budget:**
- 4 × scalar-mul-generator (viewing pubkey derivation) = 4 × 7.5 ms = 30 ms
- 1 × scalar-mul-generator (preaddress * G) = 7.5 ms
- 1 × point addition = ~0.3 ms
- poseidon2 chain (already measured): ~5 ms
- 3-pass triple recompute: 3 × 45 ms = ~135 ms
- BIP-32 derivation + display I/O: ~50 ms
- **Total: ~200 ms compute, plus user approval delay (always dominant).** No lock-screen risk.

**Dependencies:** Phase 4, Phase 5.

**Done-when:** ragger test sets a known seed in Speculos, derives, signs a deploy, asserts:
- Device-recomputed `publicKeysHash` matches `derive_keys(sk).publicKeys.hash()` from the oracle.
- Device-recomputed `address` matches `computeAddress(publicKeys, partial)` from the oracle.
- Adversarial test: host supplies a *different* `publicKeysHash` (a Sybil bundle) → device rejects with `0x6F0F` before display.

---

### Phase 7 — BEGIN/FINALIZE state machine extension

**Files:**
- `ledger-app/src/l4/session.h` (update `l4_deploy_session_t` to carry `device_recomputed_address`, `device_recomputed_pkh`)
- `ledger-app/src/handler/begin_deploy_account.c` (update — full EC chain runs in BEGIN, before user sees the review)
- `ledger-app/src/handler/finalize_deploy_and_sign.c` (update — parity-pass-3 recomputes EC step too)
- `ledger-app/src/ui/deploy_review_ui.c` (update — show device-recomputed address with provenance marker)

**Design decision: Grumpkin EC step runs in BEGIN, NOT FINALIZE.**

Rationale: the user must see the *cryptographically-verified* address on the review screen. If we defer the EC step to FINALIZE, the review screen would show host-supplied data only — same trust gap as M7 P3 still. The full chain (poseidon2 + 4 × viewing-pubkey-mul + 1 × address-mul) takes ~50 ms; latency between BEGIN APDU ack and UI render is dominated by the screen redraw anyway.

**Session-state caching:** BEGIN stashes `device_address`, `device_pkh`, the 4 viewing pubkeys (4 × 64 = 256 B). FINALIZE does NOT recompute these; only re-runs the poseidon2 chain (Pass 3) and re-runs ONE scalar-mul (Pass 3 of `preaddress*G + ivpk_m`) to detect fault injection on the EC step. **This avoids paying 30 ms × 3 = 90 ms per deploy redundantly.**

**Per-deploy time budget revisited:**
- BEGIN APDU (poseidon2 + full EC + Pass 1+2): ~100 ms
- User approval: dominant (seconds)
- FINALIZE APDU (Pass 3 = 1 poseidon2 chain + 1 scalar-mul + 2 ECDSA-K signs): ~80 ms
- **Total ≤ 200 ms compute. User perception threshold (6 s/deploy from briefing) met with 5× headroom.**

**Dependencies:** Phase 6.

**Done-when:** end-to-end deploy on alpha-testnet, observe BEGIN+FINALIZE timing on Speculos. The device review screen shows the *device-recomputed* address (with provenance label "Address: verified on device"); host pill shows the *host-claimed* address. They must match — if they don't, the device rejects at `SW_DEPLOY_ADDRESS_MISMATCH` before render. Ragger test: 100 deploys with adversarial perturbations (wrong salt, wrong class_id, swap pkh, swap expected_address) → all reject correctly.

---

### Phase 8 — Sig-as-backup UX and recovery flow

**Files:**
- `packages/adapter-ledger/src/recovery.ts` (new)
- `apps/demo-browser/src/panels/RecoveryPanel.tsx` (new)
- `apps/demo-browser/src/state.ts` (add `recoveryStep` to state machine)
- `apps/demo-browser/src/recovery-mnemonic.ts` (new — BIP-39 encoding helpers for Option A)

#### Option A: master-secret backup UX

The user clicks "Back up viewing keys". Browser triggers `INS_GET_AZTEC_MASTER_SECRET` with the deployed path. Device displays "Reveal Aztec master secret?" with the account address. On approve, device returns 32 BE bytes.

Browser encodes via BIP-39 to 24 words + 1 checksum byte → 24-word mnemonic + a final 4-character version tag. UI shows: "Write down these 24 words. Anyone with these words can read your Aztec notes. **The words do not authorize spending.**"

Confirmation: device displays a 4-character checksum (first 32 bits of `SHA-256("aztec-vk-confirm-v1" || secret)`). UI prompts user to verify the 4 chars match device. If they don't, the user is being phished by the host.

Restore: user pastes 24 words into a fresh browser. Browser decodes → 32 bytes → `Fr.fromBuffer`. Calls `deriveKeys(sk)` from `@aztec/stdlib/keys`. Calls `PXE.addAccount(sk, partialAddress)`. PXE re-syncs notes.

#### Option B: sig-as-backup UX (briefing-locked)

The user clicks "Back up viewing keys". Browser triggers `INS_DERIVE_AZTEC_VIEWING_KEYS`. Device approves. Device returns `r || s` (64 bytes).

Encoding: 64 bytes as hex (128 chars) is too long for clean clipboard; QR is overkill for a 64-byte payload; **base58check** is the right primitive — 88 chars, copy-paste-friendly, no checksum errors. Alternative: BIP-39 over 64 bytes → 48 words + checksum. **Recommendation: offer BOTH base58check (one-line, copy-pasteable) AND 48-word mnemonic (handwriting-friendly).**

Restore: user pastes string. Browser decodes → 64 bytes. Replays the HKDF-expand → 4 Grumpkin scalars. Derives 4 viewing pubkeys via Aztec's bb.js. Computes `publicKeysHash`. Asks the user to confirm the resulting address (and ideally re-attaches the device to cross-verify `publicKeysHash`). Calls `PXE.addAccount(deriveSk(sig), partialAddress)`.

**Confirmation UX (both options):** after first device-side reveal, the device displays an address derived from the freshly-computed pkh. If recovery yields a *different* address, the user knows the backup is wrong.

**Is the recovery demo doable in <2 min?** This is the biggest open question. PXE re-sync on alpha-testnet means re-scanning block headers from the account's deploy block. On alpha-testnet (low TPS, few accounts) this is seconds. On mainnet it would be minutes-to-hours. **For the demo, we pin the deploy block height and sync only from there**, taking ~30 s. The demo IS demoable; producing a 2-minute demo is realistic.

**Dependencies:** Phase 5, Phase 6.

**Done-when:** Playwright e2e test — deploy account, dispatch viewing-key backup, copy mnemonic/sig, clear browser indexedDB, paste backup, re-sync, observe identical balance.

---

### Phase 9 — Adversarial hardening and docs

**Files:**
- `architectures/m8-trust-model-update.md` (new)
- `architectures/06-security-adversarial-review.md` (update)
- `ledger-app/tests/test_deploy_adversarial.py` (new — 12 attacks)
- `packages/adapter-ledger/src/provider.test.ts` (update)

**Adversarial tests (ragger):**
1. Host swaps `expected_address` post-derivation → `SW_DEPLOY_ADDRESS_MISMATCH`
2. Host swaps `publicKeysHash` → `SW_DEPLOY_PUBKEY_HASH_MISMATCH`
3. Host injects a wrong `salt` between Pass 2 and Pass 3 → caught by recompute
4. Host calls `INS_DERIVE`/`GET_MASTER_SECRET` mid-deploy → SW_DEPLOY_CONTEXT_WRONG_STATE
5. Two parallel deploys interleaved → second rejected
6. NVRAM erase + replay → no NVRAM touch in M8, no exposure
7. Sponsor-FPC address swap → caught at profile lookup
8. `INS_DERIVE` with wrong path scheme → `SW_INVALID_PATH_SCHEME`
9. `INS_DERIVE` with non-canonical Fr embedded somewhere → `SW_HASH_MISMATCH`
10. Replay an old (r, s) on a different path → derivation deterministic, but doesn't match new path's pubkey → host detects
11. Host extension intercepts INS bytes and substitutes a fake response → host-side validation per Phase 1 oracle catches divergence
12. Fault injection mid-Grumpkin: parity-pass-3 catches single-bit faults; multi-bit faults caught probabilistically by the FINALIZE EC step recompute.

**Done-when:** All 12 attacks reject at the documented SW. Audit-readiness checklist signed off.

---

## 2. Implementation details for the hardest pieces

### (a) Grumpkin scalar mult on Nano S+

Defended above in Phase 4. Summary:
- **Algorithm:** fixed-base 4-bit signed-digit comb with GLV endomorphism for `[k]G`; Montgomery ladder for variable-base (rarely needed).
- **Constant-time:** branch-free, masked table lookups; portable C path documented as "not yet cycle-counting-hardened."
- **Stack budget:** ≤ 300 B per call.
- **Cycle budget:** ~150 Mont-muls per `[k]G`; ~7.5 ms at 25 MHz.
- **Reference:** barretenberg `ecc/groups/element_impl.hpp` (Jacobian formulas), `ecc/curves/bn254/bn254_endo_constants.hpp` (endomorphism).
- **BN254 base field arith:** already implemented as `crypto/poseidon2/fr.c` (CIOS Montgomery 4×u64). Grumpkin scalar field needs a parallel module with a different modulus.

### (b) BEGIN/FINALIZE split

Defended above in Phase 7. Summary: Grumpkin EC chain runs entirely in BEGIN (before review render). FINALIZE only does parity-pass-3 (full poseidon2 chain + one EC step) + ECDSA-K sign-twice-and-compare. Session caches the device-computed `address`, `pkh`, and the 4 viewing pubkeys (256 B added to session struct).

### (c) Sig-as-backup encoding & UX

Defended in Phase 8. **Strong recommendation: replace sig with master-secret reveal (Option A).**

If briefing-lock is firm:
- Encode as base58check (88 chars) for one-line copy-paste AND BIP-39 48-word mnemonic for handwriting.
- Confirmation: 4-char SHA-256 prefix shown on device after reveal.
- Recovery flow: paste → HKDF expand → derive pubkeys → user reconnects device → device cross-verifies.

### (d) HKDF parameters

Defended in Phase 5. SHA-256 HKDF, salt `"aztec-vk-derive-v1-salt"`, info per scalar (`"aztec/{nsk,ivsk,ovsk,tsk}_m/v1"`), **output length 64 bytes** with wide reduction mod Grumpkin q. Reducing 32 bytes mod a 254-bit prime introduces ~2-bit bias; wide reduction is mandatory.

**However:** the briefing's HKDF approach diverges from Aztec's canonical scheme (`sha512ToGrumpkinScalar`). For interop with Aztec PXE recovery, I'd argue the device should perform `sha512ToGrumpkinScalar([sig_as_fr, DomainSeparator.{NHK_M,IVSK_M,OVSK_M,TSK_M}])` — same primitive Aztec uses internally. That way the host's `deriveKeys(sig_as_fr)` path works unchanged. **HKDF is novel custom code, not justifiable.** I push back hard here.

---

## 3. Independent verification oracle

Built in Phase 1. Architecture:
- Oracle layer wraps `@aztec/foundation` and `@aztec/stdlib` exclusively (bb.js WASM for Grumpkin EC; Aztec's TS for poseidon2; no PoC code).
- Golden vectors generated once, frozen as `golden-vectors.json`.
- Device parity tests run a debug INS that returns intermediate values (`args_hash`, `init_hash`, `partial_address`, viewing pubkeys, `pkh`, `address`).
- Vitest cross-checks device output against oracle output bit-exact.
- CI: PR runs 64 vectors (~30 s); nightly runs 4096 vectors (~30 min).

**Reference paths to wrap:**
- `aztec-packages/yarn-project/foundation/src/crypto/grumpkin/index.ts` (Grumpkin EC via bb.js)
- `aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:95-124` (`deriveKeys`)
- `aztec-packages/yarn-project/stdlib/src/contract/contract_address.ts` (address chain)
- `aztec-packages/yarn-project/foundation/src/crypto/sha512/index.ts` (`sha512ToGrumpkinScalar`)

---

## 4. Security & adversarial review (mandatory)

**Host-side INS swap.** A hostile host extension intercepts and rewrites APDU bytes. M8 closes the major M7 gap: the device-computed `publicKeysHash` (Phase 6) means a host swap of viewing keys is detected on-device before signing. The remaining gap: `INS_GET_AZTEC_MASTER_SECRET` / `INS_DERIVE_AZTEC_VIEWING_KEYS` is its own attack surface. A malicious dApp that tricks the user into running it leaks viewing access permanently. Mitigation: device requires explicit per-app-instance approval ("Reveal Aztec viewing keys to *this* origin?"). The browser extension API does NOT surface this INS through the normal `signAuthWit` flow — it's gated behind a separate, marked-high-friction UX.

**Side channels on Grumpkin scalar mult.** Ledger threat model: Nano S+ has a CC EAL 5+ secure element. Our portable C scalar-mul is timing-uniform (branch-free, constant-pattern table loads with bit-mask selection), but NOT certified for power/EM resistance. For a PoC, this is acceptable; for production, port to `cx_bn_*` and Donjon audit. **Concrete risk:** if a user runs M8 on a captured device and triggers `INS_DERIVE` 100k times under EM probe, the attacker may recover the secret. Mitigation: rate-limit INS_DERIVE on-device (e.g., max 16 calls without device reset).

**RFC 6979 implementation bugs (Option B only).** Trezor's 2018 nonce bug shipped because the RNG-fallback path used a derived-but-not-uniform value. BOLOS provides `CX_RND_RFC6979` natively — we use it via `bip32_derive_ecdsa_sign_rs_hash_256`, not a hand-rolled RFC 6979. Risk: if BOLOS's RFC 6979 has a bug, we inherit it. Mitigation: deterministic-output test vs. Wycheproof RFC 6979 vectors. Plus low-s normalization is non-optional (already enforced in M7).

**Domain separation leak.** The derivation message in Option B is `SHA-256("aztec-vk-derive-v1" || path_bytes_canonical)`. This is fully unique because:
1. It's an internally-synthesized message, never an APDU input.
2. The byte-string `"aztec-vk-derive-v1"` (18 ASCII bytes) cannot collide with `outer_hash` (an Fr-encoded 32-byte value with the high bits constrained < BN254 scalar modulus).
3. The path byte encoding is fixed-length per `path_len` (1 B prefix + 4*N bytes), parsed identically to the existing INS_SIGN path encoder.

Risk: if a future INS adds a new domain that *also* prefixes "aztec-" + a tag, it could collide. Mitigation: maintain a `domains.txt` registry in the repo with one entry per INS-side internal hash domain; CI verifies non-collision.

**Sig-backup theft (Option B).** A leaked 64-byte sig means permanent viewing leak — same as a leaked seed phrase in Bitcoin context. **There is no rotation.** Mitigation: explicit UX warning ("If anyone gets these 24 words, they can read your notes forever; this CANNOT be revoked"). For high-value accounts, recommendation is to NOT back up — accept that device loss means decryption loss but recovery via fresh device + redeployed account remains possible (with help of host migration tooling that re-points the same address).

**NVRAM touch risks.** Ledger NVRAM has ~100k write-cycle limits per cell. M8 does NOT add NVRAM writes (no settings, no counter). The deploy session lives in RAM only; session_reset zeros it. No exposure.

**Blind-sign coverage AFTER M8.** Outstanding:
- `signOuterHash` (legacy blind-sign) still ships as a fallback. Recommend removing in M9 — once L4 clear-sign covers all 4 transfer modes + deploy, legacy is unused.
- Cross-app calls beyond the manifest registry → blind-sign falls back. M9 expand registry.
- Schnorr accounts → out of scope (PoC is ECDSA-K only).

**Cross-impl `publicKeysHash` byte-equivalence.** Phase 1 oracle compares: (a) `PublicKeys.hash()` from Aztec stdlib; (b) device-computed `publicKeysHash`. Bit-exact assertion. Identifies any divergence in poseidon2-with-separator parameterization.

**Anti-phishing.** Hostile dApp prompts: "click here to derive your Aztec viewing keys." If the user complies, device shows a high-friction "REVEAL viewing keys?" screen with the origin URL. Same threat model as MetaMask `eth_signTypedData` — relies on user reading the screen. Mitigation: device displays origin URL with explicit "PHISHING WARNING" framing if `INS_DERIVE` is called within 30s of a non-deploy INS.

**Reorg/replay considerations for deploys.** Aztec deploys are unique by `(class_id, salt, ctor_args, deployer)` → unique address. A reorg cannot replay a deploy at a different address. The `outer_hash` includes `txNonce` → replay protection at the sponsor-FPC level. M8 doesn't change this.

**Brand-new failure mode introduced by M8: privilege confusion.** The user has two distinct "secrets" — the signing key (BIP-32 derived secp256k1) and the viewing key bundle (BIP-32 derived Aztec-Fr). They are independent. If the user backs up the viewing key but not the signing key, they can read past notes but cannot spend them. Inverse for signing-only. Mitigation: UX must be ruthlessly clear about which is which. Recommend two distinct UI screens with different colors.

---

## 5. Testing strategy

**Unit (TypeScript, bun:test):** Phase 1 oracle; `gk_fq_t` parity; `gk_point_t` parity; HKDF/SHA-512 derivation parity; `buildDeploy` byte-equivalence to `DeployAccountMethod.request()`.

**Device (ragger):** existing infrastructure under `ledger-app/tests/`. Add `test_grumpkin_oracle_parity.py` (Phase 3), `test_deploy_full_chain.py` (Phase 7), `test_recovery_demo.py` (Phase 8), `test_deploy_adversarial.py` (Phase 9, 12 attacks).

**Browser e2e (Playwright):** existing infrastructure. Add full recovery flow — deploy account, back up, clear state, restore, verify balance.

**Cross-impl golden vectors:** 256 PR-time vectors + 4096 nightly vectors against Aztec's own bb.js path. Re-generated only when Aztec upgrades.

**Performance regression:** Speculos timing harness records device APDU latency per phase. Tracked in CI metrics; fails if BEGIN_DEPLOY takes >250 ms or FINALIZE_DEPLOY takes >200 ms.

**Adversarial fuzzing:** 1000 random perturbations of BEGIN_DEPLOY inputs each PR; device must reject at one of the 18 documented SWs.

**CI matrix:**
- PR: unit + 64 ragger tests + Playwright happy paths + 256 golden vectors. ~10 min.
- Nightly: full ragger + Playwright matrix + 4096 vectors + perf regression. ~60 min.
- Manual / pre-release: physical-device smoke on Nano S+ + alpha-testnet end-to-end.

---

## 6. Effort estimate

| Phase | Description | Effort (engineer-weeks) | Variance band |
|------|-------------|--------------------|---------------|
| 1 | Oracle + golden vectors | 0.5 | 0.4–0.8 |
| 2 | Host deploy builder (P4 → safe-v3) | 1.0 | 0.7–1.5 |
| 3 | Grumpkin scalar field arith | 0.7 | 0.5–1.0 |
| 4 | Grumpkin EC group ops (highest variance) | 2.0 | 1.5–4.0 |
| 5 | Derivation primitive (Option A or B) | 0.7 | 0.5–1.2 |
| 6 | Device pkh + address recompute | 1.0 | 0.8–1.5 |
| 7 | BEGIN/FINALIZE wiring | 0.7 | 0.5–1.0 |
| 8 | Recovery UX | 1.0 | 0.8–2.0 |
| 9 | Adversarial hardening + docs | 0.5 | 0.4–0.8 |
| **Total** | | **8.1 weeks** | **6.1–13.8** |

**Highest-variance phase:** Phase 4 (Grumpkin EC group ops). Embedded crypto is novel; GLV implementation correctness traditionally takes 2–3× initial estimate when audited. If timing/side-channel hardening is in scope, double the estimate.

**Lowest-variance:** Phase 1 (purely TypeScript, well-defined).

**Critical-path duration if sequential:** 8 weeks. If Phases 2 (P4 builder) and 3–4 (Grumpkin) parallelize (different engineers), critical path drops to 5 weeks.

---

## 7. Open questions

1. **Option A vs. Option B (master secret vs. sign-and-derive):** I strongly prefer Option A. The briefing locks Option B. I want this revisited at the triangulation step.

2. **Aztec coin type registration.** Current PoC uses placeholder 1666. SLIP-44 PR to BIP repo is necessary before any public ship.

3. **Audit budget for Phase 4.** Embedded Grumpkin is novel. Donjon engagement is ~$40k and 4-6 weeks lead time. Bake into milestone planning if production is the goal.

4. **Schnorr accounts.** Anchor doc lists Schnorr-Grumpkin as a supported scheme. M8 is ECDSA-K only. Schnorr-Grumpkin native (no `sha256` wrap) would require yet another device verb. Out of scope, but worth flagging on the roadmap.

5. **Recovery from alpha-testnet block 0 is fast (~30 s); mainnet from arbitrary deploy block is slow (~minutes). Demo strategy:** pin the demo to a recent deploy block. Document the limitation honestly.

6. **Why not derive viewing keys ON the device entirely (no host involvement)?** Because Aztec's PXE needs the viewing scalars in cleartext to decrypt notes. The device CAN'T hold them and serve them on a per-note basis (latency would be untenable). So the keys are always cleartext on the host PXE; the device is just a derivation oracle.

7. **DeepWiki or external Grumpkin embedded references.** I couldn't find any published embedded Grumpkin impls. Suggest a literature pass on Pasta/Pallas embedded as the closest analog before Phase 4 kickoff.

---

## 8. Risk register

| Rank | Risk | P | I | Mitigation |
|------|------|---|---|------------|
| 1 | Grumpkin EC impl bug (silent wrong-output) | M | H | Phase 1 oracle + 4096 nightly vectors + 3-pass parity recompute |
| 2 | Sig-as-backup theft = permanent viewing leak (Option B specific) | M | H | UX warnings + recommend Option A; rate-limit INS_DERIVE |
| 3 | RFC 6979 / domain-separation collision | L | C | Strict domain separation registry + Wycheproof vectors; use BOLOS native RFC 6979 |
| 4 | Recovery demo unviable (PXE re-sync too slow) | M | M | Pin demo to recent deploy block; document limitation |
| 5 | Phase 4 effort blows up (embedded GLV novel) | M | M | Time-box; if >4 weeks, ship safe-v4 without GLV (slower but correct); reorder Phase 4/5 if needed |

---

## Verdict

Yes, I would build M8 — the scope is well-chosen, the M7 trust gap (host-controlled publicKeys) is the single most important thing to close, and the team has the right primitives (poseidon2 4×u64 Montgomery already exists). The Grumpkin EC step is the largest unknown but tractable; my time estimate of ~8 engineer-weeks with appropriate hardening sounds right.

**Where I'd push back hardest:** the sign-and-derive primitive. Aztec's canonical scheme is `sha512ToGrumpkinScalar([secretKey, DomainSeparator.*])` (`derivation.ts:95-124`), and it accepts a single 32-byte `secretKey: Fr`. The cleanest M8 design is `INS_GET_AZTEC_MASTER_SECRET` returning 32 bytes — same primitive Aztec uses, no HKDF custom code, recoverable via mnemonic, and `KeyStore.addAccount(sk, partialAddress)` ingests it directly. Sign-and-derive is more code, more attack surface, and produces a backup blob that's not portable to any other Aztec wallet. The briefing locks sign-and-derive; I'd ask for the lock to be re-examined at triangulation, citing `derivation.ts:95-124` and `key_store.ts:54-94` as concrete evidence that the simpler primitive is the canonical one. Secondary push-back: the recovery "demo" is borderline-demoable on mainnet but fine on alpha-testnet — be honest about the scope.

### Critical Files for Implementation

- `packages/adapter-ledger/src/deploy-builder.ts` (new — host deploy assembly)
- `ledger-app/src/crypto/grumpkin/g1.c` (new — Grumpkin EC group operations)
- `ledger-app/src/l4/deploy_address.c` (update — extend with Grumpkin EC step)
- `ledger-app/src/handler/begin_deploy_account.c` (update — wire full chain + device-computed pkh/address)
- `ledger-app/src/handler/get_aztec_master_secret.c` (new — Option A) OR `ledger-app/src/handler/derive_aztec_viewing_keys.c` (new — Option B)
