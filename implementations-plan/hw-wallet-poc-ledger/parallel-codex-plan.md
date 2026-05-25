Read-only sandbox prevented writing `/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/implementations-plan/hw-wallet-poc-ledger/parallel-codex-plan.md`. Inline markdown follows.

## 1. Problem statement

Aztec on Ledger is not an “Ethereum app integration” problem. It is a custom signer problem with two distinct security bars.

First, the current Aztec signing seam is hash-centric: the account entrypoint computes a Poseidon2 payload hash, wraps it into `outer_hash`, and the account contract verifies either `sha256(outer_hash.to_be_bytes())` for ECDSA accounts or raw `outer_hash.to_be_bytes()` for Schnorr accounts. That is explicit in `yarn-project/stdlib/src/auth_witness/auth_witness.ts`, `yarn-project/entrypoints/src/encoding.ts`, and the Noir account contracts under `noir-projects/noir-contracts/contracts/account/*_account_contract/src/main.nr`.

Second, Ledger’s public wallet-side signer surface is chain-specific, so the only viable path is a BOLOS app. Wave-1 was right to score the public signer surface badly: stock Ethereum signing cannot safely express Aztec’s preimage discipline.

My framing is blunt:

- `L2` is a worthwhile internal PoC because secp256k1 is native on BOLOS and Aztec’s K1 verifier is simple.
- `L2` is not a responsible public release. Blind-signing `outer_hash` is better than nothing, but it still leaves the user exposed to host/PXE deception.
- `L4` is the first security-credible public milestone because the device recomputes the Aztec hash stack on-device.
- `L5` is not “port barretenberg.” It is “build the smallest auditable constant-time Grumpkin signer possible,” and the main risk is side-channel leakage, not functional correctness.

The catastrophic failure mode differs by phase. Before `L4`, it is host deception: the device signs a malicious authorization while showing benign text. After `L5`, the worst case becomes permanent key extraction from a flawed custom-curve signer.

## 2. Architecture & APDU spec

The app should expose an Aztec-specific APDU surface, not a generic “sign digest” API.

`CLA = 0xE0`

`INS` set:

- `0x01 GET_VERSION`
- `0x02 GET_CAPS`
- `0x03 GET_PUBLIC_KEY`
- `0x04 SIGN_OUTER_HASH`
- `0x05 BEGIN_AUTHWIT`
- `0x06 APPEND_CALL`
- `0x07 FINALIZE_AND_SIGN`
- `0x08 ABORT`

Opinionated rule: `SIGN_OUTER_HASH` accepts only canonical 32-byte `outer_hash`, not an arbitrary host digest. For K1/R1, the device itself computes `sha256(outer_hash)` before calling native ECDSA. That removes an avoidable host-side footgun and matches the Aztec verifier contract.

Suggested request structs:

```c
typedef struct __attribute__((packed)) {
  uint8_t curve_id;      // 1=k1, 2=r1, 3=grumpkin
  uint8_t path_scheme;   // 1=slip13_aztec, 2=slip44_aztec
  uint8_t path_len;
  uint32_t path[10];
} az_key_path_t;

typedef struct __attribute__((packed)) {
  uint8_t manifest_version;
  az_key_path_t key;
  uint8_t consumer[32];
  uint8_t chain_id[32];
  uint8_t auth_version[32];
  uint8_t tx_nonce[32];
  uint8_t call_count;    // max 5
} az_manifest_header_t;

typedef struct __attribute__((packed)) {
  uint8_t args_hash[32];
  uint8_t function_selector_field[32];
  uint8_t target_address_field[32];
  uint8_t flags; // bit0 public, bit1 hide_msg_sender, bit2 static, bit3 padding
} az_call_t;
```

Use 32-byte field encodings for hashed fields. That is slightly larger than a packed selector format, but it eliminates widening/endianness bugs when reproducing `EncodedAppEntrypointCalls.hash()` from `yarn-project/entrypoints/src/encoding.ts`. `APP_MAX_CALLS = 5`, so the size is still manageable.

State machine:

- `BEGIN_AUTHWIT`: reset session and store header.
- `APPEND_CALL`: append one call record; optional UI-label TLVs may follow, but they are advisory unless registry-backed.
- `FINALIZE_AND_SIGN`: recompute `payloadHash`, then `outer_hash`, then sign.
- `ABORT`: zero session state.

Return formats:

- K1/R1: `r || s` as 64 bytes, low-S normalized for ECDSA.
- Grumpkin Schnorr: `s || e` as 64 bytes, matching `barretenberg/crypto/schnorr/schnorr.hpp`.

Derivation strategy:

- Support both schemes in-app.
- `SLIP-0013` compatibility mode should mirror the existing Trezor PoC identity derivation from `packages/adapter-trezor/src/identity.ts`: `gpg://aztec/account/{i}` -> `m/13'/h0/h1/h2/h3`.
- Production should request a dedicated `SLIP-44` coin type up front and default to `m/44'/{aztec}'/{account}'/0/0` once assigned.
- My stance: keep both, but treat `SLIP-0013` as a compatibility lane and `SLIP-44` as the public default.

Per-device UI:

- `Stax/Flex`: one summary page for chain/consumer/call-count, then one page per non-padding call, then risk banners. This is where clear-signing can feel first-class.
- `Nano X/Nano S+`: show abbreviated `consumer`, `chain`, `calls`, and per-call `target + selector + flags`. Keep the copy terse; never pretend semantic certainty the app does not have.
- `L2` must always say `Blind sign`.
- `L4` may say `Clear sign` only after the device recomputes `outer_hash`.

## 3. Crypto sourcing strategy

| Primitive | Strategy | Source | Ref size / effort |
|---|---|---|---|
| ECDSA secp256k1 | BOLOS native | `cx_ecdsa_sign_no_throw` / `cx_ecdsa_sign_rs_no_throw` with `CX_RND_RFC6979` in `https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/lib_cxng/include/lcx_ecdsa.h` | 6-10h integration |
| ECDSA secp256r1 | BOLOS native, feature-gated | Same header as above | 4-8h after K1 |
| SHA-256 | BOLOS native | BOLOS hash primitives; used for K1/R1 Aztec preimage | 1-2h |
| HMAC | BOLOS native if available; otherwise tiny local wrapper over SHA-256 | Used only for deterministic Schnorr nonce derivation | 2-4h |
| Poseidon2 | Port from barretenberg | `barretenberg/cpp/src/barretenberg/crypto/poseidon2/{poseidon2.cpp,poseidon2.hpp,poseidon2_permutation.hpp,poseidon2_params.hpp}` | 686 LOC ref; 12-20h |
| Pedersen hash/commitment | Port from barretenberg | `crypto/pedersen_hash/*`, `crypto/pedersen_commitment/*`, `crypto/generators/generator_data.hpp`, `ecc/groups/precomputed_generators*.hpp` | 550 LOC ref; 10-16h once EC exists |
| Grumpkin EC | Port narrow C subset, not C++ | `ecc/curves/grumpkin/grumpkin.hpp`, `ecc/curves/bn254/fr.hpp`, `ecc/fields/{field_declarations.hpp,field_impl.hpp,field_impl_generic.hpp}`, `ecc/groups/element_impl.hpp` | 3,944 LOC ref; 50-90h |
| Schnorr | Port from barretenberg semantics, but implement in C | `crypto/schnorr/{schnorr.hpp,schnorr.tcc}` | 224 LOC ref; 12-20h once EC/Pedersen exist |

Smallest exact barretenberg slice:

- `L4` minimum: Poseidon2 only, 686 LOC across the four files above.
- `L5` minimum practical reference footprint: 4,718 LOC across the field, curve, group, pedersen, and schnorr files above. Do **not** port `ecc/groups/wnaf.hpp`. That file is the wrong secret-scalar template for this app.

The key insight is that Pedersen tables are not the blocker. `precomputed_generators_grumpkin_impl.hpp` only defines one length generator and eight default generators. The blocker is the constant-time field/EC backend.

## 4. Side-channel hardening plan

Wave-1’s warning was correct: the dangerous part is not “does Grumpkin compile,” it is “does it leak.”

Rules for `L5`:

- Do not use `element_impl.hpp:603-621` as a secret-scalar path. It explicitly acknowledges a timing leak.
- Do not port `element_impl.hpp:658-711` or `wnaf.hpp` for secret scalar multiplication. Endomorphism + WNAF is good for speed, bad for first-pass BOLOS hardening.
- Use a constant-time Montgomery ladder or complete-formula double-and-add ladder for secret scalars.
- Restrict secret-scalar multiplication to fixed-base operations only: `sk * G` and `k * G`. That is enough for key derivation and Schnorr signing.
- Use scalar blinding: `k' = k + r*n` and `sk' = sk + r*n` for random `r` from BOLOS TRNG.
- Use point randomization in Jacobian/projective form by randomizing `Z`.
- Derive Schnorr nonces deterministically from secret key and message, then add TRNG blinding. Barretenberg’s `Fr::random_element()` in `schnorr.tcc` is not the right BOLOS policy.

For field arithmetic, preserve the branchless patterns now living in `field_impl_generic.hpp` and `field_impl.hpp`:

- mask-based `reduce_once`
- branchless add reduction
- borrow-mask add-back on subtraction
- branchless conditional negate

That matters more than transliterating templates. I would write a compact 4-limb Montgomery field backend in C that behaviorally matches those patterns over Grumpkin `fq`/`fr` relations from `ecc/curves/grumpkin/grumpkin.hpp`.

Extra hardening:

- reject invalid points and subgroup mismatches at load time
- zero secrets aggressively
- self-verify Schnorr signatures on-device before returning them
- add host-side dudect-style timing harnesses for the pure-C field/EC code before any audit handoff

## 5. Memory budget per device

Public secure-element ceilings are not the same thing as app budget, but they still matter. ST advertises `ST33K1M5C` at up to `1536 KB flash / 64 KB RAM` and `ST33J2M0` at up to `2048 KB flash / 50 KB RAM` (`https://www.st.com/en/secure-mcus/st33k1m5c.html`, `https://www.st.com/en/secure-mcus/st33j2m0.html`). Exact Stax/Flex mapping remains `unverified — research target`.

Planning assumptions:

- `L2/L3`: small. Expect well under 100 KB code and under 8 KB peak RAM.
- `L4`: Poseidon2 adds modest flash and very little RAM. Estimate `+30-50 KB flash`, `+2 KB RAM`.
- `L5`: the custom field/EC layer is the real jump. Estimate `+120-220 KB flash`, `+8-16 KB peak RAM` if written narrowly in C.

Pedersen generator tables will fit on Nano S+ easily. Even a naive uncompressed representation of nine points is tiny. Stax/Flex are not a hard crypto requirement; they are a UI requirement. If `L5` fails on Nano S+ for memory reasons, Stax/Flex probably do not save it by themselves. Nano X may offer more flash headroom, but the better conclusion is: design `L5` to fit Nano S+ or admit that `L5` is not shipping broadly.

Size-optimization plan:

- compile-time feature flags: `FEATURE_R1`, `FEATURE_CLEAR_SIGN`, `FEATURE_GRUMPKIN`
- no C++ runtime baggage
- stream APDU manifests; never store raw calldata
- fixed-base secret-scalar path only
- no WNAF tables
- shared field backend for Poseidon2 and Grumpkin where possible

## 6. Sequencing

1. `L1` is effectively done as repo framing in `ledger-app/README.md`.

2. `L2` is feasible in a single unattended session.
Acceptance criteria: build in `ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite`, `GET_PUBLIC_KEY` works for K1, `SIGN_OUTER_HASH` returns deterministic low-S ECDSA, and host tests verify against Aztec’s K1 verifier semantics.

3. `L3` is also feasible unattended.
Acceptance criteria: Speculos harness covers pubkey retrieval, blind-sign flow, rejection cases, and golden vectors across at least `nanosplus` and `nanox`. Speculos is the better day-to-day test bed; Docker builder is the build substrate.

4. `L4` is partially feasible unattended if scoped correctly.
Acceptance criteria: device recomputes `EncodedAppEntrypointCalls.hash()` and `computeOuterAuthWitHash()` from hashed call records, rejects mismatches, and renders a cryptographically bound summary. Full semantic token decoding should be deferred.

5. `L5` is not a single-session unattended milestone.
Acceptance criteria: pure-C field backend, fixed-base Grumpkin scalar multiplication, Pedersen challenge parity, Schnorr `s||e` parity with barretenberg/Aztec vectors, timing analysis, and human review. This is where the schedule slip is most likely.

6. `L6` is human- and vendor-gated.
Acceptance criteria: audit by an approved auditor, Ledger submission review, and clear-signing registry/origin-token compliance.

My call: do not submit `L2` to Ledger Live. Sideload it for research; wait for `L4` before public distribution.

## 7. Security & adversarial considerations

- Most catastrophic attack: private-key extraction from the `L5` Grumpkin signer via side-channel or fault injection on a stolen or briefly borrowed device. That compromises the Aztec account permanently.
- Immediate pre-`L4` attack: compromised PXE/host shows benign intent text while the device blind-signs a malicious `outer_hash`.
- Most likely cause of `L2 -> L5` slip: not Poseidon2, not generator tables, but getting custom BN254/Grumpkin arithmetic to a defensible constant-time state on BOLOS.
- Supply chain: pin the builder image by digest, pin `ledger-secure-sdk` by commit, check hashes into the repo, and avoid ad hoc local SDK installs.
- RNG: BOLOS exposes a TRNG via `cx_trng_get_random_data` in `https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/include/ox_rng.h`. Use it for scalar blinding and coordinate randomization. Do not trust host randomness.
- Fault injection: rely on BOLOS PIN/isolation, but also self-verify each custom Schnorr signature before release. A fault that flips `s` or `e` should be caught on-device.
- Malicious account-contract deployment: add a canonical account registry concept early. If the manifest is authorizing deployment or upgrade of an account contract whose class id is not in a trusted registry, the device must show a severe warning or refuse in public builds.
- PXE compromise: `L4` must display chain id, consumer, call count, target/selector pairs, and unknown-contract warnings. Anything less is too easy to spoof.
- Version skew: include `manifest_version` and Aztec hash version in the protocol. Reject unknown versions instead of signing “best effort.” Pin vectors to a specific `aztec-packages` commit.
- Clear-signing registry and origin token: Ledger’s wallet clear-signing flow requires origin-token handling (`https://developers.ledger.com/docs/clear-signing/for-wallets`). That token belongs on a backend service, never in browser code.
- Audit: Ledger publication requires the formal submission flow and a mandatory security audit (`https://developers.ledger.com/docs/device-app/submission-process/process`, `https://developers.ledger.com/docs/device-app/submission-process/deliverables/security-audit`).
- Unverified claim most at risk of being over-believed: “some existing custom-curve Ledger app proves Grumpkin is straightforward on Nano-class devices.” That is `unverified — research target`, and even if true it would not settle Aztec’s side-channel burden.

## 8. Open questions / research targets

- Exact per-device secure-element mapping and practical app memory budgets for Stax/Flex/Nano X/Nano S+ are still `unverified — research target`.
- Exact BOLOS-native HMAC API choice for deterministic Schnorr nonce derivation is still an implementation lookup, not yet pinned.
- Whether Ledger will accept an Aztec clear-signing schema that is hashed-call-based before full contract-semantic decoding is `unverified — research target`.
- The manifest should probably carry account-contract class id for deployment flows, but that is not yet part of the current PoC intent shape.
- Aztec function-selector canonical encoding should be pinned explicitly in the APDU spec to avoid host/device widening bugs.
- If Pallas/Vesta/Jubjub support in `ox_ec.h` hints at future custom-curve affordances, that still does not answer Grumpkin support; today there is no public Grumpkin curve id in `https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/include/ox_ec.h`.

## 9. Deliverables

Primary artifact:

- `implementations-plan/hw-wallet-poc-ledger/parallel-codex-plan.md`

Implementation skeleton:

```text
ledger-app/
  Makefile
  README.md
  src/
    main.c
    apdu_dispatch.c
    apdu_types.h
    ui.c
    aztec_session.c
    aztec_k1.c
    aztec_poseidon2.c
    aztec_grumpkin.c
    aztec_schnorr.c
  tests/
    speculos/
      test_get_pubkey.py
      test_sign_outer_hash.py
      test_manifest_roundtrip.py
      test_reject_mismatch.py
      test_schnorr_vectors.py
  vectors/
    k1_outer_hash.json
    poseidon2_manifest.json
    schnorr_grumpkin.json
```

Build/test process:

- reproducible build through `ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite`
- emulator-driven testing through Speculos
- Aztec verifier round-trip tests:
  - K1: `outer_hash -> sha256 -> native ECDSA -> Aztec verifier parity`
  - L4: manifest -> on-device `outer_hash` reconstruction parity with `aztec-packages`
  - L5: `s||e` parity with barretenberg and Aztec Schnorr account expectations

**Top-3 Opinionated Stands**

- Do not ship `L2` to Ledger Live. `L2` is a research/sideload milestone; public release should wait for `L4` clear-signing.
- Implement both derivation schemes, but request a dedicated `SLIP-44` coin type now and make it the production default. Keep `SLIP-0013` only for Trezor parity and migration.
- `L5` should be a narrow constant-time C port with barretenberg as the oracle. Do not drag barretenberg C++ into BOLOS, and do not assume Stax/Flex solve a crypto-memory problem.