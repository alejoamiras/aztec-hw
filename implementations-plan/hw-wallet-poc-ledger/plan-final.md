# Ledger arc — Consolidated Tier-A plan

> **Status**: triangulated from `plan.md` (mine) + `parallel-codex-plan.md` (codex xhigh session `019e5fda-4ae6-78d2-b81d-7444671409a9`). Awaiting final codex critique → then autonomous execution per user direction.

## 1. Problem statement

The Aztec signing seam is hash-centric: the entrypoint computes Poseidon2 over the call stack into a `payloadHash`, wraps with `(consumer, chainId, version)` into `outer_hash`, and the in-circuit verifier checks either `sha256(outer_hash.to_be_bytes())` (ECDSA) or raw `outer_hash.to_be_bytes()` (Schnorr-Grumpkin). The stock Ledger Ethereum app can't honor that preimage discipline, so we must ship **our own BOLOS app**.

Two security bars, increasing in cost:
1. **L2 — K1 baseline**: secp256k1 ECDSA via BOLOS native primitives. Internal/research only. Blind-sign UX. Catastrophic failure mode = host deception (PXE shows benign text while device signs malicious `outer_hash`).
2. **L4 — clear-signing**: device recomputes `outer_hash` from a streamed call manifest using on-device Poseidon2. First security-credible public milestone.
3. **L5 — Schnorr-Grumpkin native**: the "groundbreaking" pull. **Not** "port barretenberg" — "build the smallest auditable constant-time Grumpkin signer possible." Catastrophic failure mode shifts to private-key extraction from a side-channel or fault attack on a stolen device.

**Unmanned-session scope**: L1 (scaffold) + L2 (K1 baseline) + L3 (Speculos harness) is feasible in a single ~hours session. L4 partial, L5 not. L6 vendor-gated.

## 2. Architecture & APDU spec

### Command set (CLA = `0xE0`)

Adopt codex's **streaming state-machine** (better than my single-shot single-APDU spec — handles APDU size limits + `APP_MAX_CALLS = 5` cleanly):

| INS | Name | Body | Returns | Phase |
|---|---|---|---|---|
| `0x01` | `GET_VERSION` | — | `{major, minor, patch}` | L2 |
| `0x02` | `GET_CAPS` | — | feature bitmask (`R1`, `CLEAR_SIGN`, `GRUMPKIN`) | L2 |
| `0x03` | `GET_PUBLIC_KEY` | `az_key_path_t` | curve-specific pubkey + chain code | L2 (K1) → L5 (Grumpkin) |
| `0x04` | `SIGN_OUTER_HASH` | `az_key_path_t, outer_hash[32]` | sig (curve-specific layout) | L2 (K1) → L5 (Schnorr) |
| `0x05` | `BEGIN_AUTHWIT` | `az_manifest_header_t` | session_id | L4 |
| `0x06` | `APPEND_CALL` | `session_id, az_call_t` | ack | L4 |
| `0x07` | `FINALIZE_AND_SIGN` | `session_id` | sig (after on-device hash recompute + display + user approval) | L4 |
| `0x08` | `ABORT` | `session_id` | ack (zeros session) | L4 |

**Opinionated rule (codex)**: `SIGN_OUTER_HASH` accepts only a canonical 32-byte `outer_hash`. The device itself computes `sha256(outer_hash)` before calling native ECDSA. Removes the avoidable host-side footgun where a malicious host could pre-hash with the wrong domain separator.

### Request struct sketches (codex)

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
  uint8_t call_count;    // ≤ APP_MAX_CALLS = 5
} az_manifest_header_t;

typedef struct __attribute__((packed)) {
  uint8_t args_hash[32];
  uint8_t function_selector_field[32];
  uint8_t target_address_field[32];
  uint8_t flags;         // bit0 public, bit1 hide_msg_sender, bit2 static, bit3 padding
} az_call_t;
```

32-byte field encodings throughout — slightly larger than packed selectors but eliminates widening/endianness bugs when reproducing `EncodedAppEntrypointCalls.hash()` (`yarn-project/entrypoints/src/encoding.ts`).

### Return formats
- K1 / R1: `r ‖ s` (64B), low-s normalized (BOLOS handles via `cx_ecdsa_sign_no_throw` with appropriate flags).
- Grumpkin Schnorr: `s ‖ e` (64B), matching `barretenberg/cpp/src/barretenberg/crypto/schnorr/schnorr.hpp`.

### Derivation strategy (consolidated)

Codex's point won: support **both** schemes in-app with a feature flag, default to SLIP-44 for production.

- `path_scheme = 1` → SLIP-0013 mode: mirrors Trezor's `gpg://aztec/account/{i}` → `m/13'/h0/h1/h2/h3`. Compatibility/migration lane.
- `path_scheme = 2` → SLIP-44: `m/44'/{aztec_coin}'/{account}'/0/0`. Production default. Use `1666` as PoC placeholder; Foundation registers a real coin type as separate work.

### Per-device UI strategy

| Device | Display | Strategy |
|---|---|---|
| Stax / Flex (color touchscreen) | first-class | One summary page (chain/consumer/call-count) + one page per non-padding call + risk banners. `nbgl_useCaseReview` flow. |
| Nano X (128×64 OLED, BLE) | multi-page | Abbreviated `consumer`, `chain`, `calls`, per-call `target+selector+flags`. |
| Nano S+ (128×32 mono) | terse | Same as Nano X with tighter copy. **L5 may not fit Nano S+ memory** — see §5. |

**Hard UI rule (codex)**: L2 must always say "Blind sign" on the confirmation screen. L4 may say "Clear sign" only after the device has cryptographically recomputed `outer_hash`. Aligns with upstream H4 (no public blind-sign release).

## 3. Crypto sourcing strategy

Codex's table is more accurate than mine. Adopting with minor edits:

| Primitive | Strategy | Source | Effort |
|---|---|---|---|
| ECDSA secp256k1 | BOLOS native | `cx_ecdsa_sign_no_throw` / `cx_ecdsa_sign_rs_no_throw` with `CX_RND_RFC6979` ([lcx_ecdsa.h](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/lib_cxng/include/lcx_ecdsa.h)) | 6–10 h |
| ECDSA secp256r1 | BOLOS native, feature-gated | same header | 4–8 h post-K1 |
| SHA-256 | BOLOS native | BOLOS hash primitives | 1–2 h |
| HMAC | BOLOS native if available, else 30-line wrapper over SHA-256 | for deterministic Schnorr nonce | 2–4 h |
| TRNG | BOLOS native `cx_trng_get_random_data` ([ox_rng.h](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/include/ox_rng.h)) | for scalar blinding | 0 |
| Poseidon2 | PORT (C, not C++) | `barretenberg/cpp/src/barretenberg/crypto/poseidon2/{poseidon2.cpp,poseidon2.hpp,poseidon2_permutation.hpp,poseidon2_params.hpp}` (686 LOC) | 12–20 h |
| Pedersen hash + commitment | PORT | `crypto/pedersen_hash/*`, `crypto/pedersen_commitment/*`, `crypto/generators/generator_data.hpp`, `ecc/groups/precomputed_generators*.hpp` (550 LOC) | 10–16 h (after EC) |
| Grumpkin EC backend | **narrow C port** | `ecc/curves/grumpkin/grumpkin.hpp` + relevant patterns from `ecc/curves/bn254/fr.hpp`, `ecc/fields/{field_declarations,field_impl,field_impl_generic}.hpp`, `ecc/groups/element_impl.hpp` (~3,944 LOC ref) | 50–90 h |
| Schnorr glue | PORT | `crypto/schnorr/{schnorr.hpp,schnorr.tcc}` (224 LOC) | 12–20 h (after EC + Pedersen) |

**Smallest exact slice (codex):**
- L4 minimum: Poseidon2 + BN254 Fr subset — **~686 LOC reference**.
- L5 minimum: ~**4,718 LOC reference** (field + curve + group + pedersen + schnorr).
- **DO NOT port `ecc/groups/wnaf.hpp`** — wrong template for secret-scalar work.

Pedersen generator tables are NOT the blocker — only one length generator + eight default generators are needed. The blocker is the constant-time field/EC backend.

## 4. Side-channel hardening plan

The dangerous question is not "does Grumpkin compile" but "does it leak." Adopting codex's rules verbatim:

### L5 hard rules
- **Do not** use `element_impl.hpp:603-621` for secret-scalar paths (explicit timing leak per the file's own comments).
- **Do not** port `element_impl.hpp:658-711` or `wnaf.hpp` for secret scalar multiplication. Endomorphism + WNAF is fast but bad for first-pass BOLOS hardening.
- **Use constant-time Montgomery ladder OR complete-formula double-and-add** for secret scalars.
- **Restrict secret-scalar multiplication to fixed-base operations only** (`sk * G` and `k * G`). Sufficient for key derivation + Schnorr signing; narrower attack surface.
- **Scalar blinding**: `k' = k + r·n` and `sk' = sk + r·n` with `r` from `cx_trng_get_random_data`.
- **Point randomization**: randomize the Jacobian/projective `Z` coordinate every scalar-mul iteration.
- **Deterministic Schnorr nonce + TRNG blinding** instead of barretenberg's `Fr::random_element()`.

### Field-arithmetic patterns to preserve (when porting to C)
- Mask-based `reduce_once`
- Branchless add reduction
- Borrow-mask add-back on subtraction
- Branchless conditional negate

These live in `field_impl_generic.hpp` and `field_impl.hpp`. Write a compact 4-limb Montgomery field backend in C that behaviorally matches.

### Extra hardening
- Reject invalid points + subgroup mismatches at load time
- Zero secrets aggressively (`explicit_bzero`-equivalent)
- **Self-verify Schnorr signatures on-device before returning them** (defends fault attacks on `s` or `e`)
- Add host-side dudect-style timing harnesses for the pure-C field/EC code pre-audit

### Audit budget — gating
~$15–30k USD + 4–12 weeks calendar for a Ledger-approved auditor. **Foundation budget approval is a prerequisite to merging L5 to main**. L2 + L4 may be auditable on a lighter pass (no custom EC); ship audits incrementally.

## 5. Memory budget per device

**Codex's key correction to my §5**: Nano S+ is the determining ceiling for L5, not Stax. Stax/Flex solve a UI problem, not a crypto-memory problem. Design L5 to fit Nano S+ or admit L5 doesn't ship broadly.

Public SE specs (codex):
- ST33K1M5C: up to 1536 KB flash / 64 KB RAM — [datasheet](https://www.st.com/en/secure-mcus/st33k1m5c.html)
- ST33J2M0: up to 2048 KB flash / 50 KB RAM — [datasheet](https://www.st.com/en/secure-mcus/st33j2m0.html)
- Exact Stax/Flex device → SE mapping: `unverified — research target`.

Estimated app budget per phase:

| Phase | Code flash | Peak RAM |
|---|---|---|
| L2 + L3 | < 100 KB | < 8 KB |
| L4 (+ Poseidon2) | +30–50 KB | +2 KB |
| L5 (+ field/EC, Pedersen, Schnorr) | +120–220 KB | +8–16 KB |

### Size-optimization plan (codex)
- Compile-time feature flags: `FEATURE_R1`, `FEATURE_CLEAR_SIGN`, `FEATURE_GRUMPKIN` — let smaller devices opt out.
- No C++ runtime baggage.
- Stream APDU manifests; never store raw calldata.
- Fixed-base secret-scalar path only.
- No WNAF tables.
- Shared field backend between Poseidon2 and Grumpkin where possible.

## 6. Sequencing & autonomous-session boundaries

| Phase | Autonomous-feasible | Acceptance criteria |
|---|---|---|
| L1 — scaffold | ✓ (already done) | Repo framing + plan committed |
| L2 — K1 baseline | ✓ (this session) | Builds under `ledger-app-builder-lite`. `GET_PUBLIC_KEY` returns 64B `x ‖ y` for K1. `SIGN_OUTER_HASH` returns low-s `r ‖ s` that verifies via Aztec's K1 verifier. Sideload-only (no Live submission). |
| L3 — Speculos harness | ✓ (this session) | Python tests via `speculos-pytest` cover: pubkey, blind-sign, rejection cases, golden vectors on `nanosplus` + `nanox`. Speculos = day-to-day test bed; Docker = build substrate. |
| L4 — clear-signing | ⚠ partial unmanned | Device recomputes `EncodedAppEntrypointCalls.hash()` + `computeOuterAuthWitHash()` from streamed call records, rejects mismatches, renders crypto-bound summary. Token-semantic decoding deferred. |
| L5 — Schnorr-Grumpkin | ✗ multi-week, human review required | Pure-C field backend + fixed-base Grumpkin scalar mul + Pedersen + Schnorr parity with barretenberg test vectors + timing analysis + human audit. |
| L6 — Ledger Live submission | ✗ vendor + Foundation gated | Audit by approved auditor + Ledger submission review + Clear Signing registry/origin-token compliance. |

**Call**: do not submit L2 to Ledger Live. Sideload for research only; wait for L4.

## 7. Security & adversarial considerations

### Catastrophic failure modes by phase
- **Pre-L4**: compromised PXE/host shows benign intent text while device blind-signs malicious `outer_hash`. Mitigation: ship L2 sideload-only, with explicit "Blind sign" UI label.
- **Post-L5**: private-key extraction from custom-curve signer via side-channel or fault injection on stolen/borrowed device. Permanent compromise of the Aztec account. Mitigation: §4 hardening.

### Schedule-slip risk
Most likely cause of L2 → L5 slip is **not** Poseidon2 or generator tables — it's getting custom BN254/Grumpkin arithmetic to defensible constant-time state on BOLOS. Budget audit time accordingly.

### Supply chain
- Pin `ledger-app-builder-lite` by digest, not `:latest`.
- Pin `ledger-secure-sdk` by commit.
- Check hashes into the repo.
- Avoid ad-hoc local SDK installs.
- TS-side adapter inherits our existing `bunfig.toml` defaults (7-day npm gate, OIDC, provenance).

### RNG
BOLOS exposes a TRNG via `cx_trng_get_random_data` ([ox_rng.h](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/include/ox_rng.h)). Use for scalar blinding + coordinate randomization. Never trust host randomness.

### Fault injection
Self-verify each custom Schnorr signature on-device before release. A fault flipping `s` or `e` should be caught.

### Malicious account-contract deployment
Add a canonical-account-registry concept early. If the manifest authorizes deployment/upgrade of a contract whose class id isn't in a trusted registry, show severe warning or refuse in public builds.

### PXE compromise
L4 must display `chain_id`, `consumer`, `call_count`, per-call `target+selector+flags`, and unknown-contract warnings. Anything less is too easy to spoof.

### Version skew
Carry `manifest_version` + Aztec hash version. Reject unknown versions instead of best-effort signing. Pin vectors to a specific `aztec-packages` commit.

### Clear-signing registry + origin token
Ledger's wallet clear-signing flow requires origin-token handling — token belongs on a backend service, never in browser code. Per [clear-signing-for-wallets](https://developers.ledger.com/docs/clear-signing/for-wallets).

### Submission process
- Submission flow: [process](https://developers.ledger.com/docs/device-app/submission-process/process)
- Mandatory audit: [security-audit](https://developers.ledger.com/docs/device-app/submission-process/deliverables/security-audit)

### Unverified claim most at risk
"Some existing custom-curve Ledger app proves Grumpkin is straightforward on Nano-class devices." Even if true, doesn't settle Aztec's side-channel burden. Treat as `unverified — research target`.

## 8. Open questions / research targets

1. Exact per-device SE mapping + practical app memory budgets for Stax/Flex/Nano X/Nano S+.
2. Exact BOLOS-native HMAC API surface for deterministic Schnorr nonce derivation.
3. Will Ledger accept hashed-call-based clear-signing schema pre-contract-semantic decoding?
4. Should the manifest carry account-contract class id for deployment flows? Not yet in our PoC intent shape.
5. Aztec function-selector canonical encoding — pin in APDU spec to avoid widening bugs.
6. Pallas/Vesta/Jubjub in [ox_ec.h](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/include/ox_ec.h) hint at curve flexibility but no Grumpkin id today.
7. **My-stance additions**:
   - SLIP-44 placeholder `1666` — confirm unused on the SatoshiLabs registry.
   - Pedersen generator concrete count when exercised by Schnorr's `pedersen_hash::hash({R.x, pk.x, pk.y})` — need to read `precomputed_generators_grumpkin_impl.hpp`.

## 9. Deliverables

```
ledger-app/
├── README.md                              ✓
├── PORTING-PLAN.md                        ⏳ L1
├── ledger_app.toml                        ⏳ L1
├── Makefile                               ⏳ L1
├── src/
│   ├── main.c                             ⏳ L2 — BOLOS entry + dispatch
│   ├── apdu_dispatch.c                    ⏳ L2
│   ├── apdu_types.h                       ⏳ L2 — request/response structs (§2)
│   ├── handlers/
│   │   ├── get_version.c                  ⏳ L2
│   │   ├── get_caps.c                     ⏳ L2
│   │   ├── get_public_key.c               ⏳ L2 (K1)
│   │   ├── sign_outer_hash.c              ⏳ L2 (K1)
│   │   ├── begin_authwit.c                ⏳ L4
│   │   ├── append_call.c                  ⏳ L4
│   │   ├── finalize_and_sign.c            ⏳ L4
│   │   └── abort.c                        ⏳ L4
│   ├── ui/
│   │   ├── sign_ui.c                      ⏳ L2 (Blind sign label)
│   │   ├── clear_sign_ui.c                ⏳ L4
│   │   └── menu_ui.c                      ⏳ L2
│   ├── crypto/
│   │   ├── common/                        ⏳ L2 (path parsing, key derivation)
│   │   ├── k1.c                           ⏳ L2 (BOLOS native wrapper)
│   │   ├── poseidon2/                     ⏳ L4
│   │   │   ├── poseidon2.c
│   │   │   ├── poseidon2.h
│   │   │   └── params.h
│   │   ├── bn254_fr.c                     ⏳ L4 (4-limb Montgomery)
│   │   ├── pedersen/                      ⏳ L5
│   │   ├── grumpkin/                      ⏳ L5
│   │   │   ├── grumpkin.c
│   │   │   ├── grumpkin.h
│   │   │   └── scalar_mul.c               (Montgomery ladder, fixed-base, blinded)
│   │   └── schnorr/                       ⏳ L5
│   ├── aztec_session.c                    ⏳ L4 (streaming manifest state)
│   └── globals.h                          ⏳ L2
├── icons/                                 ⏳ L1 (per-device .gif)
├── glyphs/                                ⏳ L1
└── tests/
    ├── speculos/
    │   ├── conftest.py                    ⏳ L3
    │   ├── test_get_public_key.py         ⏳ L3
    │   ├── test_sign_outer_hash.py        ⏳ L3
    │   ├── test_blind_sign_rejects.py     ⏳ L3
    │   ├── test_manifest_roundtrip.py     ⏳ L4
    │   ├── test_reject_mismatch.py        ⏳ L4
    │   └── test_schnorr_vectors.py        ⏳ L5
    └── vectors/
        ├── k1_outer_hash.json             ⏳ L3
        ├── poseidon2_manifest.json        ⏳ L4
        └── schnorr_grumpkin.json          ⏳ L5

packages/adapter-ledger/                   ⏳ L2 — TS adapter, mirrors adapter-trezor
├── package.json
└── src/
    ├── index.ts
    ├── transport.ts                       — abstract Ledger transport
    ├── provider.ts                        — implements IntentAuthWitnessProvider
    ├── speculos-transport.ts              — Speculos HTTP API client
    └── ledger-transport.ts                — real device via @ledgerhq/hw-transport-node-hid

implementations-plan/hw-wallet-poc-ledger/
├── plan.md                                ✓
├── parallel-codex-plan.md                 ✓
├── plan-final.md                          ✓ (this doc)
├── final-codex-critique.md                ⏳ (next step)
└── lessons/                               ⏳ (per-phase write-ups)
```

### Build / test pipeline
- Reproducible build via `ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite` (pinned digest).
- Emulator-driven testing via Speculos.
- Aztec verifier round-trip tests:
  - K1 (L2/L3): `outer_hash → sha256 → cx_ecdsa_sign_no_throw → Aztec K1 verifier parity`
  - L4: streamed manifest → on-device `outer_hash` reconstruction parity with `aztec-packages`
  - L5: Schnorr `s ‖ e` parity with barretenberg vectors + Aztec `SchnorrAccount` expectation

## 10. Provenance — where each piece came from

| Decision | Source | Why this choice |
|---|---|---|
| Streaming APDU (BEGIN/APPEND/FINALIZE) | codex | Handles APDU 256B/packet limits + APP_MAX_CALLS=5 cleanly; mine was single-shot single-APDU |
| Device computes `sha256(outer_hash)` | codex | Removes host-side digest-substitution footgun |
| Support BOTH SLIP-13 + SLIP-44 | codex | Keep Trezor parity option; SLIP-44 = production default |
| Fixed-base secret-scalar only | codex | Narrows attack surface; sufficient for our use case |
| Avoid `wnaf.hpp` + `element_impl.hpp:603-621/658-711` | codex | Explicit timing leaks acknowledged in the source |
| §4 hardening rules | codex | More specific than mine; barretenberg pattern names cited |
| Nano S+ is the determining memory ceiling for L5 | codex | My §5 mis-claimed Stax/Flex solves it |
| L2 sideload-only, no Ledger Live | both | Aligned upfront |
| L5 = narrow C port, NOT bring barretenberg C++ in | both | Aligned upfront |
| Skeleton structure + `packages/adapter-ledger/` parallel | mine | Codex's was sparser |
| Per-phase acceptance criteria (build artifact + verifier parity) | both | Aligned upfront |
| Audit budget gating L5 merge | both | Codex more explicit about phasing |

### Top-3 consolidated opinionated stands
1. **Ship L2 sideload-only** — never to Ledger Live. Public release waits for L4 clear-signing (upstream H4).
2. **Support both derivation schemes from day one** (SLIP-13 + SLIP-44), but default production users to SLIP-44 once a real Aztec coin type is registered. Use placeholder `1666` for the PoC.
3. **L5 = narrow constant-time C port** with barretenberg as the oracle (not as a code import). Fixed-base secret-scalar paths only. Design for Nano S+ memory — Stax/Flex don't solve a crypto-memory problem.
