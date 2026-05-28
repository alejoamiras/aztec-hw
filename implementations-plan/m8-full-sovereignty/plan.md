# M8 — Full Sovereignty Plan (consolidated)

**Status:** Tier A consolidated plan, awaiting final codex audit + user approval
**Date:** 2026-05-28
**Predecessor baseline:** `implementations-plan/m7-shape-up-demo/plan.md` (git tag `safe-v2`, commit `315048f`)
**Inputs triangulated:**
- `parallel-main-plan.md` (main author, primary context)
- `parallel-codex-plan.md` (codex CLI xhigh, session `019e6f00-48ef-7c20-991b-ea8d9d693097`)
- `parallel-opus-plan.md` (opus Plan subagent)

## 0. TL;DR + Decision Pivot

### Decision pivot from briefing

The clarifying-question phase locked **sign-and-derive** (RFC 6979 deterministic ECDSA over a domain-separated message → host HKDF-expand → 4 viewing scalars) as the recovery primitive. **Both reviewers independently pushed back** with convergent evidence:

- **opus** cited `aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:95-124` — Aztec's canonical `deriveKeys(secretKey: Fr)` takes a *single* 32-byte Fr and internally derives all 4 viewing scalars via `sha512ToGrumpkinScalar([secretKey, DomainSeparator.{NHK_M,IVSK_M,OVSK_M,TSK_M}])`. `KeyStore.addAccount(sk, partialAddress)` ingests exactly this Fr.
- **codex** confirmed and **added two findings opus missed:** (1) `INS_SIGN_OUTER_HASH` (`ledger-app/src/handler/sign_outer_hash.c:71-99`) signs an arbitrary host-supplied 32-byte payload with the **same secp256k1 key** as the proposed `INS_DERIVE_AZTEC_VIEWING_KEYS` — a hostile host can replay the derivation digest through blind-sign and produce the same sig, so strict domain separation IS FALSE. (2) Current Aztec APIs assume a single root `Fr secretKey` (`AccountManager.create:32-49`, `CompleteAddress.fromSecretKeyAndPartialAddress:55-72`, `PXE.registerAccount:568-580`); Option B would require new `KeyStore.addAccountFromMasterKeys` etc., a substantial host refactor.

**The user verified the evidence and approved Option A.** This plan supersedes the locked Option B framing.

### Final locked design (Option A)

- **`INS_GET_AZTEC_MASTER_SECRET` (0x12)** returns a 32-byte BE Fr. Internally: BIP-32 derive secp256k1 child at the requested path → `entropy_64 = SHA-512("aztec-master-secret-v1" || child_pubkey_x || child_pubkey_y)` → reduce mod BN254 scalar field (Aztec's `Fr` modulus) via wide reduction → return.
- **Host receives 32-byte Fr → reuses Aztec's canonical `deriveKeys(sk: Fr)`** unchanged. Produces `(nhk_m, ivsk_m, ovsk_m, tsk_m)` + 4 master public keys + `publicKeysHash` via Aztec's existing `sha512ToGrumpkinScalar` + Grumpkin scalar mult. **`PXE.registerAccount(sk, partialAddress)` works out of the box.**
- **Backup bundle:** 24-word BIP-39 mnemonic encoding the 32-byte Fr + sidecar JSON `{ version: "aztec-vk1", accountAddress, chainId, publicKeysHash, deployBlockNumber }`. Optional single-line clipboard format: `aztec-vk1:<base64url(payload)>` where `payload = { secret_fr, accountAddress, chainId, publicKeysHash, deployBlockNumber }`. Stored to user's password manager.
- **Recovery flow (read-only):** paste mnemonic in fresh browser → host derives Fr → `deriveKeys(Fr)` → host fetches `AztecNode.getContract(accountAddress)` and verifies on-chain instance's publicKeysHash matches the locally-derived one (anti-mistyped-mnemonic gate) → `PXE.registerAccount(sk, partialAddress)` → PXE re-syncs notes from `deployBlockNumber` → notes visible.
- **Read-only restoration only.** A restored session can read notes; it cannot sign new transactions without the Ledger. This is honest scoping: viewing keys are device-recoverable; signing capability requires the device or a fresh device + redeploy.
- **Naming fix:** the briefing's `nsk_m` was a typo. Aztec's canonical key is `nhk_m` (nullifier-*hiding* key) per `derivation.ts:29-39`. This plan uses `nhk_m` throughout. Nullifier *secret* keys are derived separately in Noir at note-spend time.

### Two checkpoints

- **`safe-v3`** after Phase 1 (host deploy builder + outer_hash binding closes — demo-able as "device sees the call list").
- **`safe-v4`** after Phases 5-9 (device-derived publicKeysHash + address + recovery demo). The wow-factor demo lives here.

### Codex's original push-back is RESOLVED by this pivot (not pending mitigation)

Codex's draft (which became `parallel-codex-plan.md`) flagged two concerns. **Option A neutralizes both outright:**
- **Domain-separation collision with `INS_SIGN_OUTER_HASH`** — Option A returns raw entropy bytes, not a signature; there is no sig artifact to replay through any other INS that signs `sha256(payload)` with the same secp256k1 key.
- **Host-model blast radius** — Option A is a drop-in replacement for `Fr.random()` in `KeyStore.addAccount(sk, partialAddress)`. No `addAccountFromMasterKeys` / `registerAccountFromMasterKeys` / `AccountManager` refactor needed.

These are closed concerns, not lingering risks.

### Why Option A wins (codified for future readers)

1. **Canonical Aztec primitive.** Reusing `deriveKeys(sk: Fr)` eliminates a custom-HKDF audit surface and inherits Aztec's existing test coverage. Device output → host computation is one well-known function.
2. **No blind-sign domain-separation collision.** Option A has no signature artifact to replay. The 32-byte Fr export is a distinct INS shape (returns raw entropy bytes, not a signature; no relation to the secp256k1 signing key beyond BIP-32 derivation).
3. **No host-side Aztec API refactor.** Option A drops into `PXE.registerAccount` unchanged. Option B would have required new `addAccountFromMasterKeys` host code touching `key-store` and `pxe` packages.
4. **Portable backup.** A 24-word BIP-39 mnemonic is industry-standard and works with any future Aztec wallet that follows the canonical key derivation. A 64-byte `(r||s)` is PoC-specific.
5. **Better cryptographic hygiene.** SHA-512 → mod-Fr reduce is the same pattern Aztec uses internally. HKDF over an ECDSA sig was novel custom code requiring its own threat model.

## 1. Phase decomposition with explicit dependencies

### Phase 0 — Independent verification oracle (FOUNDATIONAL — blocks everything)

**Goal:** establish bit-exact reference for every device-side computation before any C code lands. Without this, parity claims are circular.

**Files:**
- `packages/adapter-ledger/test/oracle/aztec-key-derivation-oracle.ts` (new) — wraps `deriveKeys`, `derivePublicKeyFromSecretKey`, `PublicKeys.hash()` from `@aztec/stdlib/keys`
- `packages/adapter-ledger/test/oracle/aztec-address-oracle.ts` (new) — wraps `computeInitializationHashFromEncodedArgs`, `computeSaltedInitializationHash`, `computePartialAddress`, `computeContractAddressFromInstance` from `stdlib/src/contract/contract_address.ts`
- `packages/adapter-ledger/test/oracle/grumpkin-oracle.ts` (new) — wraps `Grumpkin.mul`, `Grumpkin.add` from `@aztec/foundation/crypto/grumpkin`
- `packages/adapter-ledger/test/oracle/golden-vectors.json` (new) — 256 (sk_fr, partial_address) triples + expected all-4 viewing scalars + publicKeysHash + address
- `packages/adapter-ledger/scripts/gen-golden-vectors.ts` (new) — vector generator
- `ledger-app/tests/test_oracle_parity.py` (new) — ragger parity tests

**APIs:**
```ts
// aztec-key-derivation-oracle.ts
export async function deriveKeysViaAztec(sk: Fr): Promise<DerivedKeys>;
export async function computeAddressViaAztec(sk: Fr, partialAddress: Fr): Promise<AztecAddress>;
```

**Done-when:** golden vectors committed; `bun test test/oracle/*.test.ts` validates Aztec's own bb.js path produces stable output across 256 vectors; CI runs nightly.

**Dependencies:** none. **Effort:** 0.5 week.

---

### Phase 1 — P4 host deploy builder (target: `safe-v3`)

**Goal:** finish device-side clear-signed deploy by giving the device a real outer_hash to bind against. Closes codex audit MAJOR #1 from M7.

**Files:**
- `packages/adapter-ledger/src/deploy/builder.ts` (new) — pure functions, no Ledger transport
- `packages/adapter-ledger/src/aztec-ledger-session.ts` (update — `deployAccountClearSigned`)
- `packages/adapter-ledger/src/deploy/builder.test.ts` (new) — unit tests with frozen witness
- `ledger-app/src/handler/finalize_deploy_and_sign.c` (update — synthesize canonical call list + recompute outer_hash + compare with `claimed_outer_hash`)
- `apps/demo-browser/src/panels/AccountPanel.tsx` (update — call clearSigned variant)
- `ledger-app/tests/test_deploy_finalize_outer_hash.py` (new — happy + wrong-outer-hash adversarial)

**APIs:**
```ts
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
export async function buildDeploy(inputs: DeployBuildInputs): Promise<{
  outerHash: Fr;
  buildTxRequest(witness: AuthWitness): Promise<TxExecutionRequest>;
}>;
```

Behavior:
1. Mirror `DeployMethod.getInitializationExecutionPayload()` with `skipClassPublication=true, skipInstancePublication=true` (ref `aztec.js/src/contract/deploy_method.ts:517-529`).
2. Build sponsor `ExecutionPayload` via `SponsoredFeePaymentMethod.getExecutionPayload()`.
3. Compute `outerHash` via `computeOuterAuthWitHash(account, chainId, protocolVersion, payloadHash)` from `@aztec/entrypoints`.
4. Return a thunk that, given the witness, wraps via `DefaultAccountEntrypoint(account, FrozenAuthWitnessProvider).wrapExecutionPayload`, merges `[init, wrappedSponsor]`, runs through `DefaultMultiCallEntrypoint.wrapExecutionPayload`, then `DefaultEntrypoint.createTxExecutionRequest`.
5. Pass `deployer: AztecAddress.ZERO` when invoking `request()` directly (v4.2.1 quirk).

**Device-side finalize update:** `finalize_deploy_and_sign.c::finalize_deploy_after_approval` synthesizes the canonical call list from `G_l4_deploy_session` + manifest-pinned profile (no host degrees of freedom), computes outer_hash via poseidon2, compares against `claimed_outer_hash`. Reject with `SW_HASH_MISMATCH` on diff.

**Done-when:**
- Pure unit test: feed fixed inputs + frozen pre-computed ECDSA-K signature; assert resulting `TxExecutionRequest` byte-matches Aztec's stock `DeployAccountMethod.request()` path.
- Integration test: deploy on alpha-testnet via device APDU set, account gets full phase trace.
- Ragger: wrong `claimed_outer_hash` → device rejects at `SW_HASH_MISMATCH`.

**Checkpoint: tag `safe-v3` after this phase.** Ships without Grumpkin — same trust model as M7 P3 for `publicKeysHash` (still host-supplied), but closes the outer_hash binding.

**Dependencies:** Phase 0 oracle. **Effort:** 1 week (range 0.5-1.5).

---

### Phase 2 — BN254 base field arithmetic (new module, NOT alias)

**Goal:** field arithmetic Grumpkin runs on. **CRITICAL CORRECTION** (codex final audit BLOCKER #1): the Grumpkin scalar field is **BN254 base field `Fq`** (modulus `0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47`), whereas existing `ledger-app/src/crypto/poseidon2/fr_params.c:4` encodes **BN254 scalar field `Fr`** (modulus `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`). The two share the first 4 bytes but are **distinct primes**. `typedef gk_fq_t = fr_t` would silently break every device-side Grumpkin derivation.

We reuse the **CIOS algorithm structure / file layout** of `crypto/poseidon2/fr.c` but with NEW parameter constants for `Fq`. The function bodies (Mont multiply/add/sub/sqr/inv loops) port directly; only the params change.

**Files:**
- `ledger-app/src/crypto/grumpkin/fq.{c,h}` (new) — CIOS Mont 4×u64 over BN254 base field, mirroring `fr.c`'s layout
- `ledger-app/src/crypto/grumpkin/fq_params.gen.c` (generated) — modulus + R² + Montgomery µ for Fq (different constants from `fr_params.c`)
- `ledger-app/scripts/gen-fq-params.ts` (new) — codegen that emits `fq_params.gen.c` from a single source-of-truth (Fq modulus). Cross-checks against `@aztec/foundation`'s `Fq.MODULUS`.
- `ledger-app/src/crypto/grumpkin/fq_wide.{c,h}` (new) — wide reduction for SHA-512 → Fq (64 B → 32 B), unbiased
- `packages/adapter-ledger/test/grumpkin-fq-parity.test.ts` (new) — 4000+ random vectors against `@aztec/foundation`'s `Fq`

**API:**
```c
typedef struct { uint64_t limbs[4]; } gk_fq_t;  /* Montgomery form, distinct type from fr_t */
void gk_fq_add(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
void gk_fq_sub(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
void gk_fq_mul(gk_fq_t *out, const gk_fq_t *a, const gk_fq_t *b);
void gk_fq_sqr(gk_fq_t *out, const gk_fq_t *a);
void gk_fq_inv(gk_fq_t *out, const gk_fq_t *a);
void gk_fq_from_bytes_be(gk_fq_t *out, const uint8_t bytes[32]);
void gk_fq_to_bytes_be(uint8_t out[32], const gk_fq_t *a);
/* Wide reduction for SHA-512 output. Unbiased: 2^512 / 2^254 ≈ 2^-258 bias. */
void gk_fq_from_bytes_wide_be(gk_fq_t *out, const uint8_t bytes[64]);
```

**Constant-time:** mirror `fr.c`'s CT discipline (branch-free Mont multiply, no early-out). Codegen emits identical algorithm with different params.

**Done-when:** 4000 random `(a, b)` vectors match `@aztec/foundation`'s `Fq` byte-exact. Ragger benchmark: `gk_fq_mul` < 100 µs on Speculos.

**Dependencies:** Phase 0. **Effort:** 0.7-1 week (corrected — net-new code, but copy-paste-with-params from `fr.c` is fast).

---

### Phase 3 — Grumpkin fixed-base scalar mult (`[k]G` only — no generic API)

**Goal:** the heart of M8. `y² = x³ − 17` over BN254 base field. **Fixed-base only** for M8 — every scalar mult is `[k]G` (4× viewing pubkey derivation, 1× preaddress × G). Variable-base is over-scope (codex + opus agree).

**Files:**
- `ledger-app/src/crypto/grumpkin/point.{c,h}` (new) — affine + Jacobian point structs
- `ledger-app/src/crypto/grumpkin/g1_generator.c` (new) — generator G constants in Montgomery form
- `ledger-app/src/crypto/grumpkin/mul_generator.{c,h}` (new) — fixed-base scalar mult `[k]G`
- `ledger-app/src/crypto/grumpkin/generator_table.gen.c` (generated) — precomputed 4-bit signed-digit window table for G (≤ 16 entries × 64B = 1 KB flash; less with GLV split)
- `ledger-app/scripts/gen-grumpkin-table.ts` (new) — codegen script
- `packages/adapter-ledger/test/grumpkin-mul-parity.test.ts` (new) — 256 random scalars vs `Grumpkin.mul(generator, scalar)`

**API:**
```c
typedef struct {
    gk_fq_t x;       /* affine x; or Jacobian x */
    gk_fq_t y;       /* affine y; or Jacobian y */
    gk_fq_t z;       /* z=1 ↔ affine; z=0 ↔ point at infinity */
} grumpkin_point_t;

void grumpkin_mul_generator(grumpkin_point_t *out, const uint8_t scalar_be[32]);
void grumpkin_add_affine(grumpkin_point_t *out, const grumpkin_point_t *p, const grumpkin_point_t *q);
bool grumpkin_is_on_curve(const grumpkin_point_t *p);
void grumpkin_to_affine_bytes(uint8_t out_x[32], uint8_t out_y[32], const grumpkin_point_t *p);
```

**Algorithm (defended):** fixed-base 4-bit signed-digit window. Precompute G, 3G, 5G, ..., 15G (8 entries) in affine Montgomery form, stored in flash. Jacobian accumulator. Constant-time table lookup via bitmask selection (no branch on scalar bits). For a 254-bit scalar: ~63 windows × (1 mixed-add + 4 doublings) ≈ 315 EC operations.

**Perf estimate:** preliminary back-of-envelope suggests `[k]G` in the **50-150 ms range** on Nano S+ (Cortex M0+, ~25 MHz), depending on Mont-mul wall-time. Per-operation Mont-mul count derivation is deliberately deferred to Phase 5 real-hardware measurement — paper estimates of EC-op compositions have a track record of being wrong by 2-3× on embedded targets. **Phase 5 is the source of truth for perf.** Deploy needs 5 calls; if `[k]G` ≤ 100 ms, total Grumpkin work per deploy ≤ 500 ms — well within user-perception bounds. If `[k]G` > 150 ms, Phase 5 decision matrix triggers GLV addition (+1-2 weeks).

**GLV decomposition:** Grumpkin has an efficient endomorphism (cube root of unity β; `grumpkin.hpp:17-21` shows barretenberg enables it). GLV splits the 254-bit scalar into two ~127-bit halves → halves the doublings → ~40% speedup. **Defer to v0.5** if Phase 5 benchmark passes without it. Don't pay complexity cost unless needed.

**Variable-base scalar mult:** intentionally NOT implemented. M8 doesn't need `[k]P` for arbitrary P. If a future milestone needs it (e.g., on-device note decryption), add then.

**Constant-time strategy:**
- Branch-free table lookup via bitmask selection
- Always-execute doubling/addition (no early-out for zero scalar bits)
- No conditional negation branches; use field negation on accumulator
- Documented threat model: "PoC, side-channel hardening pending audit"

**Stack budget:** ≤ 1 KB per call (4 × point structs × 96B + scratch). Well within Ledger's ~7 KB app stack.

**Reference:** port from `barretenberg/cpp/src/barretenberg/ecc/groups/element_impl.hpp:636-712` (Jacobian formulas). Endomorphism constants from `barretenberg/cpp/src/barretenberg/ecc/curves/bn254/bn254_endo_constants.hpp` if GLV is added.

**Done-when:** 256 random scalar vectors match Aztec's `Grumpkin.mul(generator, scalar)` byte-exact. Ragger debug-INS benchmark confirms `[k]G` < 50 ms.

**Dependencies:** Phase 2. **Effort:** 1.5 weeks (range 1-3, highest variance phase).

---

### Phase 4 — `INS_GET_AZTEC_MASTER_SECRET` (Option A primitive)

**Goal:** the recovery primitive. Returns a 32-byte Fr derived deterministically from the device seed; host runs it through Aztec's `deriveKeys()` unchanged.

**Files:**
- `ledger-app/src/handler/get_aztec_master_secret.{c,h}` (new) — APDU 0x12
- `ledger-app/src/crypto/sha512.{c,h}` (new) — BOLOS `cx_hash_sha512_no_throw` wrapper
- `ledger-app/src/ui/master_secret_review_ui.{c,h}` (new) — high-friction reveal screen
- `packages/adapter-ledger/src/apdu.ts` (update — add `INS.GET_AZTEC_MASTER_SECRET = 0x12`)
- `packages/adapter-ledger/src/provider.ts` (update — add `getAztecMasterSecret(path): Promise<Uint8Array>`)
- `packages/adapter-ledger/src/master-secret.ts` (new) — host helper that wraps `provider.getAztecMasterSecret` and calls Aztec's `deriveKeys`
- `ledger-app/tests/test_get_master_secret.py` (new) — happy + adversarial

**Wire format:**
```
INS_GET_AZTEC_MASTER_SECRET = 0x12
  manifest_version : 1 B
  path_scheme      : 1 B  (L4_PATH_SCHEME_DEFAULT = 0x00, matching ledger-app/src/l4/wire.h:28)
  path_len         : 1 B  (≥ 4)
  path[]           : 4 × path_len B  (BE u32 per level)
```
Returns: 32 B Fr (big-endian, canonical-range).

**Derivation:**
1. Verify path canonicality (m/44'/AZTEC_COIN_TYPE'/...). Else `SW_INVALID_PATH_SCHEME`.
2. `bip32_derive_get_pubkey_256(CX_CURVE_256K1, path, raw_pubkey_65)` — same primitive as deploy.
3. Hash: `digest_64 = SHA-512("aztec-master-secret-v1\x00" || X(32) || Y(32))` where `X, Y` come from `raw_pubkey_65[1..65]`. Domain prefix is 23 bytes ASCII + 1 NUL byte = 24 bytes total.
4. Reduce mod Fr (BN254 scalar field, **NOT** Grumpkin scalar field — note that `secretKey: Fr` in Aztec is the BN254 scalar field, distinct from Grumpkin scalar field which is BN254 base field). Wide reduction: interpret `digest_64` as 512-bit BE integer, reduce mod Fr. Bias = 2^254 / 2^512 ≈ 2^-258, negligible.
5. NBGL high-friction review: "⚠️ Reveal Aztec master secret? This grants permanent read access to your notes. Path: m/44'/.../0/0."
6. On approve: return 32-byte Fr. Display a 4-character checksum (`SHA-256("aztec-vk-confirm-v1" || secret)`[0..2] as hex) for cross-verification on the host. **Duplicate-sign discipline isn't applicable here (no sig); instead, run the SHA-512 + reduce TWICE and ct_memcmp32 the outputs to catch faults.**
7. On reject: `SW_USER_REJECTED`.

**Host plumbing:** `master-secret.ts` exports `onboardAccountFromDevice(provider, path): Promise<OnboardedAccount>` which:
- Calls `provider.getAztecMasterSecret(path)` → 32 B Fr
- Computes `Fr.fromBuffer(secret_be)` → `Fr` instance
- Computes `address` via `CompleteAddress.fromSecretKeyAndPartialAddress(sk, partialAddress)` (partialAddress comes from the deploy-context)
- Returns `{ path, secret: Fr, completeAddress, publicKeys, publicKeysHash }`

**Done-when:**
- Same path → same Fr across 100 invocations (deterministic via BIP-32).
- `getAztecMasterSecret(path)` → `Fr.fromBuffer(secret)` → `KeyStore.addAccount(sk, partialAddress)` succeeds and recovers identical viewing keys.
- Ragger: wrong path scheme → `SW_INVALID_PATH_SCHEME`; user rejects → `SW_USER_REJECTED`; fault injection during SHA-512 → caught by duplicate compute.

**Dependencies:** Phase 0. **Effort:** 0.5 week (Option A saves ~1 week vs Option B's HKDF).

---

### Phase 5 — Physical Nano S+ standalone-primitive benchmark gate

**Goal:** measure performance of the primitives that EXIST after Phases 3+4 — Grumpkin `[k]G` and `INS_GET_AZTEC_MASTER_SECRET` — on real hardware before committing to Phase 6's integration. **Hard go/no-go gate.** Restructured per codex final audit BLOCKER #2: the integrated BEGIN benchmark belongs in Phase 6, not here (it can't exist yet).

**Files:**
- `ledger-app/scripts/bench-real-device.sh` (new) — orchestrates real-device test
- `ledger-app/tests/test_perf_gates.py` (new) — perf assertions
- `ledger-app/src/handler/bench_grumpkin.c` (new, `#ifdef DEV_BENCH_INS`) — debug INS that runs N `[k]G` ops + returns timing; never shipped

**Targets (standalone primitives only):**
- `INS_GET_AZTEC_MASTER_SECRET` end-to-end < 2 s (BIP-32 + SHA-512 + duplicate compute + UI render)
- `grumpkin_mul_generator([k]G)` micro-bench < 50 ms per op
- `INS_FINALIZE_DEPLOY_AND_SIGN` regression test (existing perf, should not degrade) < 1 s
- Watchdog: no debug-INS times out

**Projected integration cost** (extrapolated from primitive measurements): `4 × [k]G + 1 × [preaddress]G + 3-pass parity` ≈ 5 × micro-bench + cheap poseidon2 chain. If micro-bench < 50 ms: projected BEGIN < 1 s. If 50-100 ms: projected BEGIN < 2 s.

**Decision matrix:**
- All pass → proceed to Phase 6 with confidence
- `[k]G` 50-150 ms → proceed; revisit GLV in Phase 6 if integrated BEGIN > 3 s
- `[k]G` > 150 ms → STOP. Either add GLV decomposition (Phase 3 extension, +1-2 weeks) or escalate to redesign
- Watchdog trip on standalone primitive → critical; redesign

**Speculos is NOT sufficient.** Codex flagged this — Speculos timing doesn't model the secure element's behavior under sustained crypto load. Need a physical Nano S+.

**Done-when:** signed go/no-go report committed to `lessons/phase-5-perf-gate.md` with measured numbers + acceptance + integration projection.

**Dependencies:** Phases 3 + 4. **Effort:** 0.5 week (hard gate, low variance).

---

### Phase 6 — Device-side `publicKeysHash` + address verification in BEGIN

**Goal:** device refuses to sign deploys whose host-supplied `publicKeysHash` / `expected_address` don't match its own derivation. **This closes the M7 BLOCKER #2 privacy attack.**

**Files:**
- `ledger-app/src/l4/deploy_address.c` (update — extend with Grumpkin chain)
- `ledger-app/src/l4/key_derivation.{c,h}` (new) — derives 4 viewing pubkeys from master_secret on-device, reusing the Phase 4 derivation
- `ledger-app/src/handler/begin_deploy_account.c` (update — call new chain; compare against host-supplied)
- `ledger-app/src/handler/finalize_deploy_and_sign.c` (update — parity-pass-3 reuses cached results, doesn't re-run Grumpkin)
- `ledger-app/src/sw.h` (graduate `SW_DEPLOY_ADDRESS_MISMATCH = 0x6F12`, `SW_DEPLOY_PUBKEY_HASH_MISMATCH = 0x6F13`)
- `ledger-app/src/l4/session.h` (extend `l4_deploy_session_t` with `device_publicKeysHash`, `device_address`, `cached_viewing_pubkeys[4]`)
- `ledger-app/src/ui/deploy_review_ui.c` (update — display DEVICE-verified address)

**Sequencing in BEGIN_DEPLOY_ACCOUNT (after existing partial_address poseidon2 chain + 3-pass parity):**

1. Derive master secret internally:
   - `bip32_derive_get_pubkey_256(path)` → child_pubkey
   - `digest_64 = SHA-512("aztec-master-secret-v1\x00" || child_x || child_y)`
   - `secret_fr = reduce_512_to_fr(digest_64)`
2. Derive 4 viewing scalars via Aztec's pattern:
   - For each domain D in {NHK_M, IVSK_M, OVSK_M, TSK_M}:
     - `entropy = SHA-512(secret_fr_be || D)`
     - `viewing_scalar_d = gk_fq_from_bytes_wide_be(entropy)`  // reduce mod Grumpkin scalar field
3. Derive 4 viewing pubkeys:
   - For each: `grumpkin_mul_generator(&pubkey_d, viewing_scalar_d_be)`
4. Compute `publicKeysHash = poseidon2-with-domain-sep` matching Aztec's `PublicKeys.hash()` (`stdlib/src/keys/public_keys.ts:75-87` — VERIFY exact encoding).
5. Compare `device_publicKeysHash` vs `G_l4_deploy_session.public_keys_hash` (host-supplied). Mismatch → `SW_DEPLOY_PUBKEY_HASH_MISMATCH`.
6. Compute `preaddress = poseidon2([device_publicKeysHash, partial_address], DomainSeparator.CONTRACT_ADDRESS_V1)`.
7. Compute `addressPoint = [preaddress]G + ivpk_m` (1× `grumpkin_mul_generator` + 1× `grumpkin_add_affine`).
8. Compare `addressPoint.x` vs `G_l4_deploy_session.expected_address`. Mismatch → `SW_DEPLOY_ADDRESS_MISMATCH`.
9. **Cache** `viewing_pubkeys[4]`, `device_publicKeysHash`, `device_address` in session.
10. Run 3-pass parity (steps 1-8). Mismatch → `SW_HASH_MISMATCH`.

**Critical design: Grumpkin chain runs in BEGIN, not FINALIZE.** The user must see the *cryptographically verified* address on the review screen. FINALIZE only re-runs the cheap poseidon2 chain (Pass 3) and re-checks one EC step (the `[preaddress]G + ivpk_m` ladder) to detect fault injection. The 4× viewing-pubkey derivation in BEGIN is NOT re-run in FINALIZE — they're cached.

**Stack budget verification:**
- 4 × scalar-mul-generator state: 4 × 300 B = 1.2 KB (reused across calls, not concurrent)
- poseidon2 sponge: 200 B
- Per-pass workspace: 400 B
- **Peak: ~1.8 KB. Well within 7 KB.**

**Per-deploy time budget (post-Phase 5 measurement):**
- 4 × `[k]G` (viewing pubkeys) = 4 × 12 ms = 48 ms
- 1 × `[preaddress]G` = 12 ms
- 1 × point-add = 0.3 ms
- poseidon2 chain = 5 ms
- 3-pass parity = ~190 ms
- **Total BEGIN: ~250 ms compute + UI render. User approval delay dominant.**

**Done-when:**
- Ragger: known seed in Speculos → device-derived `publicKeysHash` matches `deriveKeys(sk).publicKeys.hash()` from Phase 0 oracle.
- Adversarial ragger: host supplies *swapped* `publicKeysHash` (Sybil bundle) → device rejects with `0x6F13` BEFORE the UI renders.
- Adversarial ragger: host supplies wrong `expected_address` → device rejects with `0x6F12`.
- **Integration benchmark on real Nano S+** (moved here per codex audit BLOCKER #2): full `INS_BEGIN_DEPLOY_ACCOUNT` cycle (poseidon2 chain + 4× `[k]G` + publicKeysHash + `[preaddress]G` + point-add + 3-pass parity) < 2 s. If > 2 s but < 3 s: ship with documented limitation. If > 3 s: trigger GLV addition per Phase 5 decision matrix.

**Dependencies:** Phases 3, 4, 5 (perf gate). **Effort:** 1 week.

---

### Phase 7 — Host onboarding + browser flow

**Goal:** browser flow integrating Option A. Onboard once → cache secret + computed publicKeysHash in localStorage → subsequent deploys reuse cache.

**Files:**
- `packages/adapter-ledger/src/account-onboard.ts` (new — covered in Phase 4)
- `packages/adapter-ledger/src/aztec-ledger-session.ts` (update — wire onboarding before deploy)
- `apps/demo-browser/src/state.ts` (update — new state `onboarded { secret_hex, accountAddress, publicKeysHash }`)
- `apps/demo-browser/src/panels/OnboardPanel.tsx` (new — shown when no `onboarded` state)
- `apps/demo-browser/src/panels/AccountPanel.tsx` (update — gated behind onboarding)

**Flow:**
1. User connects Ledger → SessionPanel shows "Onboard account" CTA
2. User clicks → `INS_GET_AZTEC_MASTER_SECRET` fires
3. Device shows reveal screen with checksum
4. User approves → 32 B Fr returned to host
5. Host shows checksum on screen → user verifies match with device
6. Host runs `deriveKeys(sk)` + computes publicKeysHash + computes address (via salt + class_id from a chosen path)
7. Host caches `{ secret_hex, accountAddress, publicKeysHash, deployBlockNumber }` in localStorage under `aztec-vk-v1:<path-fingerprint>`
8. UI transitions to AccountPanel → user can deploy / transfer / drip

**Persistence:** localStorage stores the secret_hex (raw Fr). This IS the same as caching the BIP-39 mnemonic — sensitive but bounded to the user's browser. UX must clearly state "stored locally; clear cookies to wipe."

**Done-when:** browser flow: connect → onboard (1 device approval) → deploy (1 device approval) → ready. localStorage persists across reloads. Phase emission unchanged from M7.

**Dependencies:** Phase 4. **Effort:** 0.5 week.

---

### Phase 8 — Recovery demo (read-only PXE restore — HERO for `safe-v4`)

**Goal:** the wow-factor. User saves master-secret mnemonic, wipes localStorage, pastes mnemonic, PXE re-derives viewing keys, sees notes — without Ledger present.

**Files:**
- `apps/demo-browser/src/panels/BackupPanel.tsx` (new) — exposes the 24-word mnemonic + sidecar JSON
- `apps/demo-browser/src/panels/RestorePanel.tsx` (new) — paste mnemonic + sidecar; restore
- `packages/adapter-ledger/src/recovery/mnemonic.ts` (new) — BIP-39 24-word encode/decode for the Fr
- `packages/adapter-ledger/src/recovery/backup-bundle.ts` (new) — bundle codec, on-chain instance fetch + verify
- `docs/demos/m8-recovery.md` (new — walkthrough script)
- `apps/demo-browser/e2e/recovery.spec.ts` (new — Playwright e2e)

**Backup format:**
- **Primary (mnemonic):** 24-word BIP-39 encoding of the 32-byte Fr.
- **Sidecar (JSON):** `{ "version": "aztec-vk1", "accountAddress": "0x...", "chainId": "...", "publicKeysHash": "0x...", "deployBlockNumber": 12345 }`.
- **Optional single-line clipboard format:** `aztec-vk1:<base58check(payload_json)>` where payload = `{ secret_b58, accountAddress, chainId, publicKeysHash, deployBlockNumber }`.

**Recovery flow (read-only):**
1. User opens RestorePanel on a fresh browser (no Ledger required).
2. Inputs: 24-word mnemonic + sidecar JSON (or single-line bundle).
3. Host:
   - Decodes mnemonic → 32 B → `Fr.fromBuffer(secret)`
   - Runs `deriveKeys(sk)` → 4 viewing scalars + 4 pubkeys + publicKeysHash
   - Compares derived `publicKeysHash` vs sidecar's `publicKeysHash` → **mismatch = mistyped mnemonic; abort with clear error.**
   - Fetches `AztecNode.getContract(accountAddress)` → on-chain instance.
   - Verifies on-chain instance's publicKeysHash matches local → **mismatch = wrong account or tampered backup; abort.**
   - Calls `PXE.registerAccount(sk, partialAddress_derived_from_instance)`.
   - PXE re-syncs notes from `deployBlockNumber` (sidecar field, skips block-0 sync).
4. UI transitions to AccountPanel in "read-only" mode (no Ledger connected; "Send" CTA disabled with explanation).

**PXE recovery strategy (corrected per codex audit BLOCKER #3 + user input):** there is no public `PXE.startSync({ fromBlock })` API — verified against `aztec-packages/yarn-project/pxe/src/pxe.ts:568-580`. `registerAccount(sk, partialAddress)` is the only public surface; sync is internal. **Aztec PXE has tag-based discovery machinery** via `LogService.fetchTaggedLogs()` (`pxe/src/logs/log_service.ts:105-124`) and `syncTaggedPrivateLogs()` (`pxe/src/tagging/recipient_sync/sync_tagged_private_logs.ts:15-25,59-61`), which batches `getPrivateLogsByTags` lookups using recipient tagging secrets. **Empirical hypothesis to validate in Phase 8 pre-flight:** for a freshly-registered account on alpha-testnet, tag-based discovery avoids full re-decryption of all published notes — the older `registerAccount` docstring at `pxe.ts:560-568` says PXE will "trial-decrypt all published notes on the chain," but this appears to be stale documentation predating the tagging system. Phase 8 measures empirically. **Demo runs on testnet with fresh browser** (full clear including IndexedDB). Target: <90 s. Phase 8 done-when includes a measured-on-testnet timing report; if the hypothesis is wrong, fallback is local Aztec sandbox demo.

**Read-only enforcement:** RestorePanel sets `state.mode = 'read-only'`. AccountPanel checks this and disables "Send" / "Deploy" / "Drip" CTAs with copy "Read-only restore. Reconnect Ledger to spend." This is the **only** UX-level enforcement — Aztec's PXE doesn't enforce read-only (it accepts the sk for note decryption regardless).

**Done-when:**
- Playwright e2e: deploy → mint USDC → save mnemonic + sidecar → wipe localStorage + IndexedDB → paste mnemonic + sidecar → notes visible in < 90 s.
- Adversarial: mistyped mnemonic → abort with "publicKeysHash mismatch" error.
- Adversarial: wrong accountAddress in sidecar → abort with "on-chain instance mismatch" error.
- Demo walkthrough video recorded.

**Dependencies:** Phases 6, 7. **Effort:** 1 week (range 0.7-2; PXE re-sync feasibility unknown).

---

### Phase 9 — Adversarial hardening + `safe-v4` cut

**Goal:** harden, document, ship.

**Files:**
- `architectures/m8-trust-model-update.md` (new — definitive trust model post-M8)
- `architectures/06-security-adversarial-review.md` (update)
- `ledger-app/tests/test_deploy_adversarial.py` (new — 12 attacks per opus)
- `packages/adapter-ledger/src/recovery/backup-bundle.test.ts` (new — bundle codec adversarial)
- `apps/demo-browser/e2e/adversarial.spec.ts` (new — host-side attacks)

**Adversarial tests (12 attacks, from opus + codex):**
1. Host swaps `expected_address` post-derivation → `SW_DEPLOY_ADDRESS_MISMATCH`
2. Host swaps `publicKeysHash` → `SW_DEPLOY_PUBKEY_HASH_MISMATCH`
3. Host injects wrong `salt` between Pass 2 and Pass 3 → caught by parity
4. Host calls `INS_GET_AZTEC_MASTER_SECRET` mid-deploy → `SW_DEPLOY_CONTEXT_WRONG_STATE`
5. Two parallel deploys interleaved → second rejected
6. NVRAM erase + replay → no NVRAM touch in M8, no exposure
7. Sponsor-FPC address swap → caught at profile lookup
8. `INS_GET_AZTEC_MASTER_SECRET` with wrong path scheme → `SW_INVALID_PATH_SCHEME`
9. `INS_GET_AZTEC_MASTER_SECRET` with non-canonical Fr embedded → `SW_HASH_MISMATCH`
10. Mnemonic word swap → host detects via publicKeysHash mismatch
11. Host extension intercepts INS bytes, substitutes fake response → host-side validation per Phase 0 oracle catches
12. Fault injection mid-Grumpkin → 3-pass parity catches single-bit; multi-bit caught probabilistically by FINALIZE recompute

**Documentation deliverable:** `architectures/m8-trust-model-update.md` covers:
- What M8 closes (host-controlled publicKeys spoofing — the M7 BLOCKER #2 gap)
- What M8 does NOT close (host-side viewing-key disclosure after PXE has them in memory; PoC-grade side-channel hardening)
- The recovery model: viewing-key-only restoration; signing requires the device
- The privilege confusion warning (viewing-backup ≠ signing-backup; opus surfaced this)

**Done-when:** all 12 attacks reject at documented SWs; trust-model doc reviewed by codex (final audit step §3); `safe-v4` tag applied.

**Dependencies:** Phases 6-8. **Effort:** 0.5 week.

---

## 2. Implementation details — hardest pieces

### 2.1 Grumpkin scalar mult on Nano S+ (defended above in Phase 3)

Summary:
- **Algorithm:** fixed-base 4-bit signed-digit window for `[k]G` only. No generic `scalar_mul(point, scalar)`.
- **Reference:** port from `barretenberg/cpp/src/barretenberg/ecc/groups/element_impl.hpp:636-712`.
- **Reuse:** the existing `crypto/poseidon2/fr.c` implements BN254 **scalar** field (Aztec `Fr`) Montgomery CIOS. We reuse its **algorithm structure / file layout** (CIOS 4×u64 Mont multiply, add, sub, sqr, inv) but with NEW parameter constants for BN254 **base** field (which IS Grumpkin's scalar field per `aztec-packages/yarn-project/foundation/src/curves/bn254/field.ts:360-367`). Saves algorithm-design time, not param-derivation work.
- **Perf estimate:** ~12 ms per `[k]G`. 5 calls per deploy → ~60 ms Grumpkin work per deploy. Phase 5 gate validates on real hardware.
- **CT:** branch-free, masked table lookup. Documented PoC threat model.
- **GLV:** defer to v0.5 unless Phase 5 demands.

### 2.2 BEGIN/FINALIZE split (defended above in Phase 6)

- **Grumpkin runs in BEGIN, not FINALIZE.** User must see *cryptographically verified* address on review screen.
- **Session caches 4 viewing pubkeys + publicKeysHash + address.** FINALIZE doesn't re-run Grumpkin; only re-runs cheap poseidon2 + one EC step for fault detection.
- **Per-deploy compute:** ~250 ms BEGIN, ~80 ms FINALIZE. Sub-second. No watchdog risk.

### 2.3 Backup format + UX

**Mnemonic (primary):** 24-word BIP-39 encoding of the 32-byte Fr. Industry-standard, handwriting-friendly, portable to any future Aztec wallet.

**Sidecar JSON (required):** `{ "version": "aztec-vk1", "accountAddress", "chainId", "publicKeysHash", "deployBlockNumber" }`. Mnemonic alone is not enough — host needs `accountAddress` to fetch the on-chain instance for verification, and `deployBlockNumber` to skip pre-deploy block sync. **codex flagged this — bundling matters.**

**Single-line clipboard format (optional):** `aztec-vk1:<base58check(payload_json_compact)>`. ~100 chars. Useful for paste-to-friend or quick clipboard.

**On-device confirmation:** at master-secret reveal time, the device displays a 4-character SHA-256 checksum of the secret. Host shows the same checksum after computing it from the returned bytes. User verifies match — defends against a hostile host substituting a different Fr in transit.

**Recovery UX:** RestorePanel has 3 inputs: mnemonic textarea, sidecar JSON (paste or file upload), and optionally a manual `accountAddress` override (for case where sidecar is lost). On submit:
1. Decode mnemonic → 32 B Fr.
2. Run `deriveKeys(Fr)` → publicKeysHash.
3. Compare with sidecar's publicKeysHash → mismatch = mistyped mnemonic; abort.
4. Fetch on-chain instance via `AztecNode.getContract(accountAddress)`; verify publicKeysHash matches.
5. `PXE.registerAccount(sk, partialAddress)`.
6. Sync from deployBlockNumber.
7. Transition to read-only AccountPanel.

### 2.4 SHA-512 → Fr reduction parameters

- **Algorithm:** SHA-512 over 24-byte domain prefix + 64-byte pubkey coordinates = 88 bytes input, 64 bytes output.
- **Wide reduction:** interpret 64-byte output as 512-bit big-endian integer; reduce mod BN254 scalar field (Fr modulus = `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`, ~254 bits). Bias = 2^254 / 2^512 ≈ 2^-258, cryptographically negligible.
- **Note on the second SHA-512 chain** (Phase 6 step 2, deriving the 4 viewing scalars from the master secret): this mirrors Aztec's `sha512ToGrumpkinScalar([secretKey, DomainSeparator.X])`. The `DomainSeparator` constants are Fr field elements; see `aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:13-25` for the exact values. The device must serialize `[secretKey_be, domain_separator_be]` byte-identically to Aztec's `serializeToBuffer` — VERIFY in Phase 0 oracle.

## 3. Independent verification oracle (Phase 0 detail)

**Source-of-truth references in `aztec-packages`:**
- `yarn-project/stdlib/src/keys/derivation.ts:29-124` — master/viewing key derivation
- `yarn-project/stdlib/src/keys/public_keys.ts:75-87` — `PublicKeys.hash()`
- `yarn-project/stdlib/src/contract/contract_address.ts:35-90` — partial address chain
- `yarn-project/stdlib/src/contract/complete_address.ts:55-72` — address derivation
- `yarn-project/foundation/src/crypto/grumpkin/index.ts` — Grumpkin EC via bb.js WASM
- `yarn-project/foundation/src/crypto/sha512/index.ts:13-16` — `sha512ToGrumpkinScalar`
- `noir-projects/noir-protocol-circuits/crates/types/src/address/aztec_address.nr:104-155` — Noir address formula (final ground truth)

**Test vector strategy:**
- 256 random (sk_fr, partial_address) triples → expected (publicKeysHash, address, 4 viewing scalars, 4 viewing pubkeys). Committed as `golden-vectors.json`.
- 64 random deploy contexts (class_id, salt, ctor_args) → expected init_hash, partial_address.
- 64 random backup-bundle round-trips → encode → decode → bit-equal.
- CI: PR runs 64 vectors (~30 s). Nightly runs 4096 vectors (~30 min).
- Device parity: ragger debug-INS (`INS_BENCH_GRUMPKIN`, `#ifdef DEV_BENCH_INS`) exposes intermediate values for bit-exact comparison.

**Anti-circularity discipline:** the oracle imports ONLY from `@aztec/*` published packages and `aztec-packages/yarn-project/*`. NO imports from PoC code. The oracle is the "ground truth" that device output is compared against.

**Concrete invariant: `PublicKeys.hash()` byte-encoding** (codex final audit MAJOR — explicit Phase 0 deliverable, not soft citation). TS hashes 4 `Point`s but Noir hashes `self.serialize()` which produces **12 field elements** (`x`, `y`, `is_infinite` per `Point` × 4 master pubkeys). Phase 0 oracle commits a golden vector that includes the exact 12-Fr serialization + the resulting publicKeysHash, plus a documented byte-encoding spec in `oracle/public-keys-hash-encoding.md`. The Phase 6 C implementation MUST replicate this serialization byte-exactly.

## 4. Security & Adversarial Review

**(a) Host-side INS interception.** A malicious browser extension intercepts WebHID and re-routes `INS_GET_AZTEC_MASTER_SECRET` to a different path or replays an old call. **Mitigation:** the device's NBGL high-friction reveal screen shows the full BIP-32 path; user verification gates the operation. The 4-character checksum displayed on-device after computation provides post-hoc verification — host must surface the same checksum, and a mismatch indicates either a host substitution or transmission corruption. **Residual risk:** blind user approval → secret for attacker-controlled path. Same as any HW phishing; document in user-facing docs.

**(b) Side-channels on Grumpkin scalar mult.** Fixed-base scalar mult with masked table lookup is branch-free and timing-uniform at the algorithm level. The underlying `fr_*` Montgomery CIOS is CT in BOLOS's existing implementation. Risk: ARM cache (none on Cortex M0+). Power/EM analysis requires physical access (outside Ledger threat model for a stolen device used briefly). **Confidence: high for PoC.** For production: port the field layer to `cx_bn_*` and engage Ledger Donjon for an audit (~$40 k, 4-6 weeks per opus's estimate).

**(c) SHA-512 + Fr reduction correctness.** Device uses BOLOS's `cx_hash_sha512` (audited primitive shipped in Bitcoin/Ethereum apps). The reduction code is new C — must match `aztec-packages/yarn-project/foundation/src/crypto/sha512/index.ts:13` and `aztec-packages/yarn-project/foundation/src/curves/bn254/field.ts` (for `Fr.fromBufferReduce`). Phase 0 oracle's parity test covers this; 4096 nightly vectors enforce it.

**(d) Domain separation.** Master-secret derivation prefix is `"aztec-master-secret-v1\x00"` (24 bytes ASCII + NUL). Risk: another INS or future Aztec primitive produces a 24-byte prefix collision. Mitigation: maintain a `domains.txt` registry; CI verifies non-collision. **Key advantage over Option B:** there's no signature artifact to replay through other INS. The 32-byte Fr is returned directly — distinct INS shape from any sign-INS.

**(e) Blind-sign (`INS_SIGN_OUTER_HASH`) interaction.** Option A removes the blind-sign domain-separation collision concern (no sig artifact). However, blind-sign remains a powerful operation — a hostile host can still trick the user into signing an outer_hash for a malicious tx. M8 doesn't change M7's blind-sign UX. Mitigation: M9 should consider removing `INS_SIGN_OUTER_HASH` once L4 clear-sign covers all 4 transfer modes + deploy. Today it ships as a fallback.

**(f) Mnemonic backup theft.** A leaked 24-word mnemonic is permanent viewing leak — same as a leaked seed phrase in Bitcoin context. **There is no rotation without redeploying the account** (since the account address derives from the publicKeysHash which derives from the secret). **Trade-off accepted:** sig-backup theft = permanent viewing leak. User education: treat the mnemonic like a private key. Document on BackupPanel: "Anyone with these 24 words can read your notes forever. They CANNOT spend on your behalf."

**(g) NVRAM.** M8 stores nothing in NVRAM. All session state RAM-only, wiped by `l4_session_reset()`. No write-cycle risk.

**(h) Blind-sign coverage after M8.** Deploys: fully clear-signed (call list + publicKeys + address all verified on-device). Transfers: clear-signed via M6+M7 manifest. **What's still blind:** any tx whose call selector isn't in the manifest → defaults to safe-blind-sign with raw selector + arg hash displayed. No regression from M7.

**(i) Cross-impl `publicKeysHash` byte-equivalence.** Three impls must agree: device (C), PXE (TS via `@aztec/stdlib`), in-circuit (Noir per `noir-projects/noir-protocol-circuits/crates/types/src/address/aztec_address.nr`). Aztec's test suite validates PXE↔Noir. M8's Phase 0 oracle validates Device↔PXE → transitively Device↔Noir. **Risk:** future Aztec protocol upgrade changes the hash domain. **Mitigation:** pin `@aztec/*` to exact `4.2.1`; revisit on each upgrade.

**(j) Anti-phishing for `INS_GET_AZTEC_MASTER_SECRET`.** Hostile dApp tricks user into running master-secret reveal for an attacker-controlled path, exfiltrating viewing keys. **Mitigation:** NBGL high-friction review with explicit "REVEAL" wording (not "sync" or "authorize"). User education on OnboardPanel. **Rate-limiting (codex recommendation):** max 16 reveals per device-session without explicit reset to bound EM-probe extraction risk.

**(k) Privilege confusion (opus contribution).** Two distinct backups exist:
- **Viewing backup:** the 24-word mnemonic of the master secret. Restores read access. Does NOT authorize spending.
- **Signing backup:** the Ledger device's BIP-39 seed phrase. Restores signing capability.

These are independent. A user might back up viewing but not signing — they'd read notes but couldn't spend. Opus called this "ruthlessly clear UX." **Mitigation:** two visually distinct backup screens with different colors + copy. BackupPanel only handles viewing; Ledger device handles signing.

**(l) Recovery flow integrity.** A malicious sidecar JSON could direct the host to a wrong `accountAddress`. **Mitigation:** on-chain instance fetch (`AztecNode.getContract(accountAddress)`) returns the deployed publicKeysHash; host asserts it matches the locally-derived one. Wrong sidecar = mismatch = abort.

**(m) Reorg/replay for deploys.** Aztec deploys are unique by `(class_id, salt, ctor_args, deployer)` → unique address. A reorg cannot replay a deploy at a different address. The `outer_hash` includes `txNonce` → replay protection at the sponsor-FPC level. **M8 doesn't change this.**

**(n) Multi-device users.** A user with two Ledgers + same seed phrase gets the SAME 32-byte Fr from both (BIP-32 deterministic from seed). So losing one device doesn't require backup — second device works. Mnemonic backup is for the "no Ledger access right now" case.

**(o) Browser persistence of restored master secret** (codex final audit). After Phase 8 recovery, the host caches `secret_hex` for the PXE session — this is the canonical Aztec root, and XSS / hostile-extension theft of browser state has the **same impact as mnemonic theft**. Default-safe mitigation (codex MINOR pushback applied):
- **Default storage: `sessionStorage` (cleared on tab close) or in-memory only — NOT `localStorage`.** Closing the tab wipes the secret; user must re-paste mnemonic to resume.
- SessionPanel offers an **explicit opt-in** "Persist for fast reconnect" toggle that escalates to `localStorage`. The toggle is gated behind a warning modal that documents the equivalence to mnemonic disclosure.
- RestorePanel surfaces the trade-off explicitly: "After restore, your viewing keys remain decrypted in browser memory. Closing this tab wipes them unless you opted into persistent caching."
- Documented equivalence: persisted-secret-in-localStorage ≡ leaked-mnemonic. Treat any durable browser persistence as on-par with disclosing the 24 words.

## 5. Testing strategy

| Layer | Suite | Trigger |
|---|---|---|
| Unit (TS, oracle) | `packages/adapter-ledger/test/oracle/*.test.ts` | Every PR |
| Unit (TS, bundle codec) | `packages/adapter-ledger/src/recovery/*.test.ts` | Every PR |
| Unit (C, fault) | `ledger-app/tests/*_unit.py` (ragger) | Every PR |
| Integration (device flow) | `ledger-app/tests/test_deploy_full_chain.py` | Every PR |
| E2E (browser + Speculos) | `apps/demo-browser/e2e/*.spec.ts` (Playwright) | Nightly + manual |
| Recovery on alpha-testnet | `apps/demo-browser/e2e/recovery.spec.ts` | Manual + before demo |
| Real Nano S+ benchmark | `ledger-app/scripts/bench-real-device.sh` | Phase 5 gate + nightly |

**Critical scenarios:**
- **Happy:** onboard → deploy → mint USDC → save mnemonic + sidecar → wipe localStorage + IndexedDB → paste mnemonic + sidecar → notes visible (< 90 s on alpha-testnet)
- **Adversarial — publicKeysHash swap:** host MITM → device rejects at `SW_DEPLOY_PUBKEY_HASH_MISMATCH`
- **Adversarial — mistyped mnemonic:** host RestorePanel detects via local publicKeysHash mismatch BEFORE any PXE work
- **Adversarial — wrong accountAddress in sidecar:** host RestorePanel detects via on-chain instance mismatch
- **Adversarial — wrong path on `INS_GET_AZTEC_MASTER_SECRET`:** device shows path, user rejects → `SW_USER_REJECTED`
- **Determinism:** same path → same 32 B Fr across 100 reveals
- **Cross-impl:** N=4096 random sk_fr; device-derived (publicKeysHash, address) == Aztec stdlib byte-equal

## 6. Effort estimate

| Phase | Description | Most likely | Range |
|---|---|---|---|
| 0 | Independent oracle + golden vectors | 0.5 wk | 0.3-0.8 |
| 1 | P4 host deploy builder (→ safe-v3) | 1.0 wk | 0.5-1.5 |
| 2 | BN254 base field (NEW Fq params, not fr_t alias) | 0.7 wk | 0.5-1.0 |
| 3 | Grumpkin fixed-base scalar mult | 1.5 wk | 1.0-3.0 |
| 4 | `INS_GET_AZTEC_MASTER_SECRET` | 0.5 wk | 0.3-0.8 |
| 5 | Physical Nano S+ standalone-primitive gate | 0.5 wk | 0.3-0.7 |
| 6 | Device pkh + address verify + integration bench | 1.2 wk | 0.7-1.8 |
| 7 | Host onboarding + browser flow | 0.5 wk | 0.3-0.7 |
| 8 | Recovery demo (testnet, tag-based note discovery) | 1.0 wk | 0.7-2.0 |
| 9 | Adversarial hardening + safe-v4 cut | 0.5 wk | 0.3-0.8 |
| **Total** | | **~8 weeks** | **6-14 weeks** |

Adjusted from initial ~7 wk after codex final audit corrections: Phase 2 added 0.2wk (net-new params, not aliasing — codex BLOCKER #1); Phase 6 added 0.2wk (integration benchmark moved here — codex BLOCKER #2).

**Saved ~1 week vs Option B** by:
- Skipping HKDF custom code (Option A reuses Aztec's `deriveKeys`)
- No host-side `addAccountFromMasterKeys` refactor
- Reusing `fr.c`'s CIOS algorithm structure (params still new — codex correction)

**Highest variance:** Phase 3 (Grumpkin scalar mult). Real-hardware perf unknown until Phase 5. If GLV needed: +1-2 weeks.

**Critical path:** ~8 weeks sequential. Phases 0+1 can run parallel to Phases 2-3 → critical path drops to ~6 weeks with two engineers.

## 7. Open questions

1. **Aztec coin type SLIP-44 registration.** Current PoC uses placeholder `1666`. Production needs a real SLIP-44 entry. Out of scope for M8 but flag for M9.
2. **`PublicKeys.hash()` exact encoding.** Phase 6 step 4 needs byte-exact match. Verify against `stdlib/src/keys/public_keys.ts:75-87` BEFORE writing C — domain separator + field-element byte order matters.
3. **GLV decomposition in Phase 3.** Include in v0 (+1-2 weeks) if Phase 5 benchmark indicates >50 ms per `[k]G`? Or defer entirely?
4. **Donjon audit budget for production.** Embedded Grumpkin is novel; production claim requires audit. ~$40 k, 4-6 weeks lead. Bake into post-M8 milestone planning.
5. **Schnorr-Grumpkin account support.** Anchor doc lists Schnorr-Grumpkin as a supported scheme. M8 is ECDSA-K1 only. Schnorr would need yet another device verb. Flag for roadmap.
6. **PXE block-synchronizer behavior on testnet under tag-based note discovery.** Phase 8 demo depends on the assumption that note discovery for a fresh `registerAccount` doesn't trigger a full re-index across all encrypted notes on alpha-testnet. Phase 8 pre-flight measures this empirically.
7. **Remove `INS_SIGN_OUTER_HASH` in safe-v4?** Option A removes the domain-separation collision concern, so blind-sign is no longer a sovereignty risk. But it's still a phishing vector and M8 closes other surfaces. Defer to M9 if L4 manifest coverage is complete.

## 8. Risk register

| # | Risk | P | I | Mitigation |
|---|---|---|---|---|
| 1 | Grumpkin scalar mul too slow on real Nano S+ (Phase 5 fails) | 25% | High (re-architect; breaks sovereignty story) | Phase 5 hard gate BEFORE Phase 6 |
| 2 | `PublicKeys.hash()` encoding mismatch device ↔ Aztec | 20% | High (deploy fails byte-equal check) | Phase 0 oracle + Phase 6 ragger test |
| 3 | Tag-based note discovery hypothesis wrong (PXE actually full-rescans on `registerAccount`) | 25% | Medium (demo >90 s on testnet; fallback to local Aztec sandbox demo) | Phase 8 pre-flight measures empirically; sandbox fallback if testnet > 3 min |
| 4 | Mnemonic backup theft = permanent viewing leak | High (accepted) | Med-High | UX warnings; document trade-off; no anti-rewind in v0 |
| 5 | SHA-512 → Fr reduction off-by-one | 10% | High (silent wrong derive) | Phase 0 oracle 4096-vector parity; cross-impl test |
| 6 | Phase 3 effort blows up (embedded Grumpkin novel) | M | M | Time-box; if >4 weeks, ship without GLV; reorder if needed |

## 9. Acknowledged limitations + scope

- **Read-only recovery only.** Restored sessions cannot sign new transactions. Signing requires the Ledger present (or a fresh Ledger with the same BIP-32 seed).
- **PoC-grade side-channel posture.** Constant-time at the algorithm level; not certified for power/EM resistance. Donjon audit required for production claims.
- **Single-account focus.** M8 scopes to one Aztec account per BIP-32 path. Multi-account / per-account derivation tweaks deferred to M9.
- **Alpha-testnet only.** Recovery demo is sized for alpha-testnet's low TPS. Mainnet recovery would require longer demos or different framing.
- **`INS_SIGN_OUTER_HASH` retained.** Legacy blind-sign INS stays for fallback compatibility. Removal deferred to M9.
- **No multi-device signing.** Single-Ledger architecture. Multisig / threshold deferred indefinitely.

## Verdict

Build it. Option A is the right primitive — both reviewers + the user concurred after evidence review. The Phase 5 real-hardware benchmark is the critical decision gate; everything else is well-scoped engineering. Effort estimate ~7 weeks is realistic; expect ±2 weeks variance dominated by Phase 3 (Grumpkin scalar mult). The hero demo (Phase 8 read-only PXE restore) is feasible on alpha-testnet with honest <90 s framing.

**Three things to watch most closely:**
1. **Phase 5 gate** — go/no-go on Grumpkin perf must happen on real Nano S+, not Speculos.
2. **`PublicKeys.hash()` encoding** — verify byte-exact match in Phase 0 oracle BEFORE writing the C in Phase 6.
3. **Tag-based note discovery hypothesis** — Phase 8 pre-flight measures whether a fresh `registerAccount` on testnet triggers full re-decryption or stays within tag-filtered lookup. If full re-decrypt, fall back to local Aztec sandbox demo.

Now waiting on final codex audit of THIS consolidated plan before the user approval gate.
