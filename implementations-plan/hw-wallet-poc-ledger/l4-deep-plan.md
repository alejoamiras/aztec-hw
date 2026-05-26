I couldn’t save to [l4-deep-plan.md](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/implementations-plan/hw-wallet-poc-ledger/l4-deep-plan.md): this session is mounted read-only. The plan content is below.

**L4 Deep Plan**

Pinned source of truth:
- Aztec source commit: `2770bcb82d40323060c2f9c71aaf293b640efbef`
- Current Ledger app repo commit: `37b43326960cccfc6b9f76a09eee06bff7604417`

Primary spec files:
- `yarn-project/entrypoints/src/encoding.ts`
- `yarn-project/entrypoints/src/account_entrypoint.ts`
- `yarn-project/stdlib/src/auth_witness/auth_witness.ts`
- `yarn-project/foundation/src/crypto/poseidon/index.ts`
- `barretenberg/cpp/src/barretenberg/crypto/poseidon2/poseidon2_permutation.hpp`
- `barretenberg/cpp/src/barretenberg/crypto/poseidon2/sponge/sponge.hpp`
- `noir-projects/aztec-nr/aztec/src/authwit/entrypoint/app.nr`
- `yarn-project/stdlib/src/abi/function_call.ts`
- `yarn-project/stdlib/src/hash/hash.ts`

**Explicit decisions**
- Port Poseidon2 from Aztec’s Barretenberg structure, not from the paper. Reimplement the permutation and sponge in plain C, but follow `poseidon2_permutation.hpp` and `sponge.hpp` exactly.
- For L4 only, prefer BOLOS big-number primitives over a custom Fr backend. The Poseidon inputs are public manifest data, so this is a correctness/performance problem, not an L5 secret-dependent timing problem.
- Keep field encodings as 32-byte big-endian for `consumer`, `chain_id`, `version`, `tx_nonce`, `args_hash`, `target_address`, and `outer_hash`. Keep `function_selector` as a 32-byte field on the wire too, but reject non-canonical values whose high 28 bytes are nonzero.
- Rename `auth_version` to `protocol_version` or just `version`. The algorithm uses Aztec `chainInfo.version`; it is not a Ledger-local auth schema version.
- Change `FINALIZE_AND_SIGN` to carry `claimed_outer_hash[32]`. The current “empty body” sketch is not enough if you want explicit host/device parity refusal.
- Remove the wire-level padding flag. Stream only real calls. The device must synthesize the remaining canonical Aztec padding calls itself.
- Keep `APPEND_CALL` single-call only for v1. The latency win from batching is trivial at `N<=5`; the parser/state-machine complexity is not.
- Do not present L4 as full semantic clear-signing. Title the flow `Verified calls` or `Verified authwit`, not `Clear sign`.
- Do not ship an on-device contract allowlist in L4. Everything is raw and unverified.
- Add temporal redundancy for fault resistance: compute the manifest hash twice, compare to the host claim twice, then sign.

**Open research items**
- The exact BOLOS arithmetic API on the chosen SDK branch. The local repo requires `BOLOS_SDK`, but it is unset here, so `ox_bn.h` vs older `cx_math_*` wrappers must be validated on the real branch before coding.
- Nano S+ performance of BOLOS-bignum-backed Poseidon.
- Whether to include truncated `args_hash` on an advanced UI page.
- Whether zero-call payloads should be allowed or policy-rejected. Aztec code permits them; UX may not want them.

**1. Poseidon2 Port Strategy**

Use Barretenberg as the normative algorithm source. `encoding.ts` and `auth_witness.ts` only tell you which values get hashed; `barretenberg/.../poseidon2_permutation.hpp` and `.../sponge/sponge.hpp` tell you how. The key details you must preserve are:
- State size `t=4`
- S-box `x^5`
- `8` full rounds and `56` partial rounds
- The hardcoded external 4x4 MDS step
- The internal diagonal-minus-one optimization
- Sponge IV = `(input_len << 64)` from `sponge.hpp`
- `poseidon2HashWithSeparator` prepends the separator as the first field in `yarn-project/foundation/src/crypto/poseidon/index.ts`

Do not write a fresh “from-spec” implementation unless you want avoidable parity risk. Aztec is already pinned to Barretenberg behavior, including separator handling and sponge IV conventions. L4 is not the place to discover a one-round or one-lane discrepancy.

Field arithmetic: for L4, use BOLOS big-number support if the selected SDK branch exposes it cleanly. The official SDK tree exposes `include/ox_bn.h`, `include/ox_rng.h`, `include/cx.h`, `lib_cxng/include/lcx_ecdsa.h`, and `lib_nbgl/include/nbgl_use_case.h` in the Ledger secure SDK tree. Your own app already includes `cx.h` and uses `cx_hash_sha256` in `ledger-app/src/handler/sign_outer_hash.c`. That is enough evidence to choose “SDK arithmetic first” as the implementation plan.

Why this is the right cut:
- Poseidon in L4 only touches public data: host-provided fields, call metadata, and host-provided hashes.
- Timing leakage in public-data field arithmetic does not expose the Aztec signing key. The private key enters only after the outer hash is finalized, via the already-existing BOLOS ECDSA path.
- Using BOLOS bignums shrinks custom code and audit surface. That matters more here than hand-rolled limb performance.

Fallback: if BOLOS bignum support is missing, unstable across targets, or too slow on Nano S+, then write a minimal 4-limb Fr backend. But that is plan B. It should not be the default L4 choice.

Round-constant storage: compress it. Raw storage is `64 rounds * 4 lanes * 32 bytes + 4 diagonal lanes = 8,320 bytes`. Compressed storage is `4 leading full rounds * 4 + 56 partial round first-lane constants + 4 trailing full rounds * 4 + 4 diagonal lanes = 92 field elements = 2,944 bytes`. That is the obvious representation for all targets. Also: there is no such thing as a single binary across Nano X, Nano S+, Stax, and Flex. Ledger ships per-target binaries. Optimize for one source path, not a mythical universal binary.

Flash/RAM budget: `+30–50 KB` in `plan-final.md` is plausible only if BOLOS carries most arithmetic. If you own the Fr math, budget more like `40–70 KB`. The constant table is not the big cost; the field backend is.

Audit bar: constant-time discipline for the Poseidon path is desirable but not gating in the L5 sense. No scalar blinding is needed here. The bar is:
- canonical parsing
- deterministic parity
- no malformed-field acceptance
- fault resistance around compare-and-sign

**2. Manifest Wire Format**

Keep the existing path envelope, but tighten the manifest:

```c
typedef struct __attribute__((packed)) {
  uint8_t curve_id;
  uint8_t path_scheme;
  uint8_t path_len;
  uint32_t path[10];      // big-endian u32 on wire, existing L2 semantics
} az_key_path_t;

typedef struct __attribute__((packed)) {
  uint8_t manifest_version;
  az_key_path_t key;
  uint8_t consumer[32];           // canonical Fr, big-endian
  uint8_t chain_id[32];           // canonical Fr, big-endian
  uint8_t protocol_version[32];   // canonical Fr, big-endian
  uint8_t tx_nonce[32];           // canonical Fr, big-endian
  uint8_t call_count;             // real calls only, 0..5
} az_manifest_header_v1_t;

typedef struct __attribute__((packed)) {
  uint8_t args_hash[32];              // canonical Fr
  uint8_t function_selector_field[32];// canonical Fr, but must fit in u32
  uint8_t target_address_field[32];   // canonical Fr
  uint8_t flags;                      // bit0 public, bit1 hide_msg_sender, bit2 static
} az_call_v1_t;

typedef struct __attribute__((packed)) {
  uint8_t claimed_outer_hash[32];
} az_finalize_v1_t;
```

Endianness: everything big-endian. That matches `Fr.toBuffer()` in `yarn-project/foundation/src/curves/bn254/field.ts` and your existing BIP32 encoder in `packages/adapter-ledger/src/provider.ts`.

Do not batch multiple calls per `APPEND_CALL`. A single `az_call_v1_t` is about `97` bytes. The header is about `173` bytes. Both fit comfortably. Two-call batching would fit; three-call batching would not. The round-trip count is not the bottleneck. Keep v1 simple.

Recovery/state:
- `BEGIN_AUTHWIT` always zeroes prior state and starts a new session.
- `ABORT` is idempotent and zeroes state.
- `APPEND_CALL` before `BEGIN_AUTHWIT` fails.
- `FINALIZE_AND_SIGN` before exactly `call_count` appends fails.
- Any non-`0x9000` path zeroes session state.

Versioning:
- `manifest_version=1` should reject unknown versions immediately, before expensive parsing.
- Do not put the Aztec commit hash on wire.
- Do pin vectors and implementation comments to `2770bcb82d40323060c2f9c71aaf293b640efbef`.

**3. Outer-Hash Reconstruction Parity**

This is the exact algorithm.

First, `EncodedAppEntrypointCalls.create()` in `encoding.ts` pads the call list to `APP_MAX_CALLS=5` using `FunctionCall.empty()`. `FunctionCall.empty()` in `yarn-project/stdlib/src/abi/function_call.ts` is not all-zero metadata: it is a public call with selector `0`, address `0`, no args, `hideMsgSender=false`, `isStatic=false`.

Second, `encode()` in `encoding.ts` computes:
- public call `args_hash = HashedValues.fromCalldata([selector.toField(), ...args])`
- private call `args_hash = HashedValues.fromArgs(args)`

Third, `EncodedAppEntrypointCalls.hash()` is `poseidon2HashWithSeparator(this.toFields(), this.domainSeparator)`, where `toFields()` is every call flattened as:
- `args_hash`
- `function_selector`
- `target_address`
- `is_public`
- `hide_msg_sender`
- `is_static`
then `tx_nonce` at the end.

Fourth, `poseidon2HashWithSeparator` prepends the separator as the first field. For this payload hash the separator is `DomainSeparator.SIGNATURE_PAYLOAD = 463525807` from `yarn-project/constants/src/constants.gen.ts`.

Fifth, `computeOuterAuthWitHash()` in `auth_witness.ts` is `poseidon2HashWithSeparator([consumer.toField(), chainId, version, innerHash], DomainSeparator.AUTHWIT_OUTER)`, where `AUTHWIT_OUTER = 3283595782`.

That means the device must:
1. Parse `call_count` real calls.
2. Synthesize the remaining `5 - call_count` canonical padding calls.
3. Build the 31-field payload exactly as Aztec does.
4. Compute `inner_hash = poseidon2HashWithSeparator(payload_fields, SIGNATURE_PAYLOAD)`.
5. Compute `outer_hash = poseidon2HashWithSeparator([consumer, chain_id, protocol_version, inner_hash], AUTHWIT_OUTER)`.
6. Compare `outer_hash` to `claimed_outer_hash` from `FINALIZE_AND_SIGN`.
7. Only then display and sign `sha256(outer_hash_be32)` through the existing BOLOS K1 flow.

Important nuance: because you are synthesizing padding on-device, you must also reproduce the canonical empty public call hash. That depends on `computeCalldataHash([0])` using `DomainSeparator.PUBLIC_CALLDATA = 2760353947` from `constants.gen.ts`. This is exactly why the vectors must be pinned to commit.

Also rename `auth_version` now. The algorithm uses `chainInfo.version` in `account_entrypoint.ts`, not a new authwit-specific version.

**4. UI for L4**

Do not call it `Clear sign`. At L4 the device sees call structure, not decoded function arguments. The right label is `Verified calls` or `Verified authwit`.

Recommended review content:
- Summary page: `Chain`, `Account/Consumer`, `Calls`
- Per-call page: `Target`, `Selector`, `Mode`
- `Mode` is a compact rendering of `public/private`, `static`, and `hide_msg_sender`
- Advanced detail page on larger devices: truncated `args_hash`

Selector display should be the low 4 bytes in hex, but only after the device has validated that the 32-byte selector field is canonical and fits in `u32`. Without ABI, raw selector hex is the honest display.

Unknown-contract UX:
- No allowlist in L4.
- Show a single summary warning: `Addresses and selectors are unverified raw values`.
- Do not spam every page with red danger banners. Users will habituate instantly.

`chain_id` display:
- If the field fits in `u32`, show decimal and hex.
- Otherwise show hex only.
- Do not invent symbolic names in L4.

Padding-call hiding:
- Since v1 streams only real calls, the displayed `call_count` is already the non-padding count.
- That is cleaner than sending padded calls and trying to explain why some are hidden.

NBGL path:
- Reuse `nbgl_useCaseReview` with `nbgl_contentTagValueList_t`.
- Your L2 app already uses NBGL blind-sign review in `ledger-app/src/ui/sign_ui.c`.
- The official SDK docs for `lib_nbgl/include/nbgl_use_case.h` and `nbgl_page.html` support the same review/list model across Stax, Flex, Nano X, and Nano S+.

**5. Security and Adversarial Review**

Side-channel:
- L4 adds public-data Poseidon arithmetic before the private-key ECDSA step.
- That does not create the L5 class of key-extraction risk because the BN254 field ops never touch secrets.
- No scalar blinding is needed for Poseidon. Save that work for L5 Grumpkin.

Fault injection:
- The new critical invariant is `device_recomputed_outer_hash == host_claimed_outer_hash`.
- Check it twice in separate passes.
- Recompute the full outer hash again immediately before signing from stored normalized state. With only five calls, the cost is acceptable and the redundancy is worth it.
- Clear session state on every parse/version/count/mismatch error.

Replay/domain separation:
- `consumer + chain_id + version + inner_hash` already domain-separates cross-consumer, cross-chain, and cross-version replay.
- `tx_nonce` is inside `inner_hash`, so replacement/cancellation semantics are preserved.
- Do not add a second “auth version” concept. It muddies the boundary and invites skew.

Supply chain:
- Pin Aztec commit in vector metadata and comments.
- Pin the BOLOS SDK branch used for the build.
- The local lesson file already shows why SDK drift matters: `/opt/nanosplus-secure-sdk/src/os_printf.c` behavior broke `%lu` assumptions in L2.

What L4 now catches from a compromised PXE/host:
- changing the consumer/account
- changing `chain_id` or `version`
- changing `tx_nonce`
- reordering calls
- dropping calls
- inserting extra calls
- changing target addresses
- changing selectors
- changing `public/private/static/hide_msg_sender` flags
- changing `args_hash`
- giving the device one manifest and the account flow another `outer_hash`

What L4 still does not catch:
- lies about raw function arguments, because the device only receives `args_hash`, not the arguments
- lies about contract identity or human-readable names
- lies about selector meaning beyond raw hex
- malicious but correctly hashed calls that still look opaque to the user

That last list matters. L4 is a real security improvement, but it is not final-form semantic signing.

**6. Implementation Phases**

I would reorder the phases slightly.

- `L4.0`: spec freeze and vector generator. Add a pinned TS script that emits canonical manifests, canonical padding calls, `inner_hash`, `outer_hash`, and negative vectors.
- `L4.1`: Poseidon2 C port plus host-native unit tests. Do this before any APDU logic.
- `L4.2`: APDU types and dispatcher stubs. Add `BEGIN_AUTHWIT`, `APPEND_CALL`, `FINALIZE_AND_SIGN`, `ABORT`, but return `SWO_INVALID_INS` or a dedicated `NOT_IMPLEMENTED` equivalent.
- `L4.3`: device manifest state machine. Parse canonical fields, enforce call counts, enforce selector canonicality, implement `ABORT`.
- `L4.4`: full parity path. Synthesize padding, compute `inner_hash` and `outer_hash`, compare to claimed hash.
- `L4.5`: review UI. Render summary plus per-call pages from stored manifest state.
- `L4.6`: fault-hardening and signing integration. Double recompute, double compare, then call the existing K1 signing path.
- `L4.7`: TS adapter switch. Replace decorative `createAuthWitFromIntent()` in `packages/adapter-ledger/src/auth-witness-provider.ts` with real manifest streaming and `FINALIZE_AND_SIGN(claimed_outer_hash)`.

Acceptance for L4 is not “parity test exists.” It is:
- the device signs only when the streamed manifest, the claimed outer hash, and the displayed summary all bind to the same value
- vectors from the pinned Aztec commit pass on host tests and Speculos
- the existing real Aztec account-flow integration test passes using the new provider path

**7. Best Autonomous Session Cut**

I would pick the first option, but strengthen it slightly: finalize the APDU spec, generate pinned golden vectors, implement Poseidon standalone tests, and scaffold the adapter and firmware stubs. Do not land a half-built state machine, and definitely do not land “parity test failing” firmware.

Why:
- The biggest unknown is parity, not APDU plumbing.
- A partial state machine with no verified hash path creates security-looking code with no security value.
- Vectors plus a standalone Poseidon port de-risk every later phase.
- Adapter scaffolding is useful immediately and low-risk.
- Once parity is clean, the device-side session machine becomes ordinary firmware work.

If an autonomous session overperforms, the next incremental step is `L4.3` with working `BEGIN_AUTHWIT`/`APPEND_CALL`/`ABORT` and a `FINALIZE_AND_SIGN` that only verifies and returns a mismatch code, without yet entering UI or signing. That is still a clean cut. A failing parity branch is not.

Net: L4 should be treated as “verified call-structure signing,” not “full clear-signing.” The right path is Barretenberg-accurate Poseidon, BOLOS arithmetic for public-data Fr ops, a simpler real-call-only manifest, explicit claimed-hash parity in `FINALIZE_AND_SIGN`, and honest raw-value UI.