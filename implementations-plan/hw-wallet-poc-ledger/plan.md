# Ledger arc — Tier-A plan (main draft)

> **Status**: Draft 1 of 2 parallel drafts. Triangulates against `parallel-codex-plan.md` (codex xhigh, running). After both land we consolidate, codex critiques the consolidation, then we execute autonomously (Alejo AFK).

## 1. Problem statement

Trezor's adapter rides a generic firmware primitive (`SignIdentity(proto="gpg")`) — no firmware changes. Ledger has no such generic surface; every chain integration is its own custom BOLOS app. So shipping Aztec on Ledger means **building a Ledger app**.

What the app must do (in increasing order of difficulty):
1. **Derive an Aztec signing key** from the device seed.
2. **Sign `outer_hash` over secp256k1** (or secp256r1) using BOLOS's built-in ECDSA primitives — no crypto porting required.
3. **Reconstruct `outer_hash` on-device from a structured Aztec call manifest** via Poseidon2 hashing, so the device can refuse to sign on hash mismatch — the cryptographic-binding step that makes clear-signing real.
4. **Sign Schnorr-over-Grumpkin** — the "native Aztec" path. Requires porting Grumpkin curve arithmetic + Pedersen hash + Schnorr from barretenberg's C++ into BOLOS C. This is the groundbreaking lift Alejo specifically called out.
5. **Ship through Ledger Live** — mandatory audit + vendor review.

Realistic unmanned-session scope: **L1 (scaffold) + L2 (K1 baseline) + start L3 (Speculos harness)**. L4–L6 require multi-week effort + human + Foundation involvement and must be documented but not finished autonomously.

## 2. Architecture & APDU spec

### Derivation strategy

Reject SLIP-0013 parity with Trezor — different vendor ecosystem, different conventions, and the `gpg://aztec/account/<i>` identity is awkward as a Ledger path display. Instead:

- **PoC path**: `m/44'/<coin>'/<account>'/0/0` where `<coin>` is a placeholder (`1666` is unused on the SatoshiLabs SLIP-44 registry as of 2026-05; reserve it on the side, document the request).
- **Production path**: register a real Aztec SLIP-44 coin type with SatoshiLabs (separate Foundation work).
- Display the path on-device on first-use confirmation so the user sees what's derived.

### APDU command set (initial)

CLA byte: `0xE0` (standard Ledger convention).

| INS | Name | Data | Returns | Phase |
|---|---|---|---|---|
| `0x01` | `GET_VERSION` | — | `{major, minor, patch}` | L2 |
| `0x02` | `GET_APP_NAME` | — | `"aztec"` UTF-8 | L2 |
| `0x03` | `GET_PUBKEY` | `bip32_path[]` | `{pk_x[32], pk_y[32], chain_code[32]}` for K1 | L2 |
| `0x04` | `SIGN_K1` | `bip32_path[], outer_hash[32]` | `{r[32], s[32]}` (low-s normalized) | L2 |
| `0x05` | `SIGN_INTENT_K1` | `bip32_path[], encoded_intent[]` | `{r[32], s[32]}` after on-device `outer_hash` verification | L4 |
| `0x06` | `GET_PUBKEY_GRUMPKIN` | `bip32_path[]` | `{pk_x[32], pk_y[32]}` Grumpkin | L5 |
| `0x07` | `SIGN_SCHNORR_GRUMPKIN` | `bip32_path[], outer_hash[32]` | `{s[32], e[32]}` (Aztec convention) | L5 |
| `0x08` | `SIGN_INTENT_SCHNORR` | `bip32_path[], encoded_intent[]` | `{s[32], e[32]}` after verification | L5 |

`encoded_intent` is the device-side representation of `CallIntent` — a packed binary form of `[consumer(32), chainId(32), version(32), num_calls(1), call_data[]]` where each call is `[contract(32), selector(4), num_args(1), args[Fr...]]`. The device parses, displays, computes Poseidon2 over the encoded structure, derives `outer_hash`, compares to host-supplied hash (if any), signs.

### Per-device UI strategy

| Device | Display capacity | Strategy |
|---|---|---|
| Stax (touchscreen, color) | 5+ lines, scrollable | First-class clear-signing; show action / amount / recipient / contract / chain / version + risk warnings as a single scrollable card. Use the `nbgl_useCaseReview` flow. |
| Flex (touchscreen, color) | 4 lines | Same flow, slightly more truncation. |
| Nano X (128×64 OLED, buttons) | 2 lines | Multi-page review: page-1 action+amount, page-2 recipient, page-3 chain/version, page-4 approve. |
| Nano S+ (128×32 monochrome) | 2 lines (compact) | Same multi-page approach as Nano X; tighter copy. **L5 may not fit Nano S+ memory** — see §5. |

## 3. Crypto sourcing strategy

| Primitive | Source | Effort estimate |
|---|---|---|
| ECDSA secp256k1 | **BOLOS native** `cx_ecdsa_sign_no_throw` with `CX_RND_RFC6979 \| CX_NO_HASH` (we pass the pre-computed digest) | 0 — already in BOLOS |
| ECDSA secp256r1 | BOLOS native, `CX_CURVE_SECP256R1` flavor | 0 |
| SHA-256 | BOLOS `cx_hash_sha256` | 0 |
| HMAC-SHA-256 | BOLOS `cx_hmac_sha256` | 0 (used internally by RFC-6979) |
| BIP-32 derivation | BOLOS native `os_perso_derive_node_bip32` | 0 |
| **Poseidon2** | **PORT** `barretenberg/cpp/src/barretenberg/crypto/poseidon2/` (~666 LOC) | **~3-5 eng-days**: pure math, no EC ops, ports cleanly to C with `cx_bn_mod_*` for BN254 Fr arithmetic |
| BN254 Fr arithmetic | PORT `barretenberg/cpp/src/barretenberg/ecc/curves/bn254/fr.hpp` patterns, implement via BOLOS `cx_bn_*` over BN254 Fr modulus | ~2 eng-days (subset needed for Poseidon2 only) |
| Pedersen hash | **PORT** `barretenberg/cpp/src/barretenberg/crypto/pedersen_hash/` + `crypto/generators/` (precomputed generator tables) | **~5-8 eng-days** + ~1-2 KB generator data |
| Grumpkin EC (scalar mul, point add, point negation) | **PORT** `ecc/curves/grumpkin/grumpkin.hpp` + the underlying group ops | **~5-10 eng-days** with constant-time hardening |
| Schnorr-over-Grumpkin glue | PORT `crypto/schnorr/schnorr.tcc` (~120 LOC) | ~1-2 eng-days once Grumpkin + Pedersen + SHA-256 + Fr arithmetic are in place |
| RNG (for Schnorr k — Aztec ref signer uses random) | BOLOS native `cx_rng` | 0 — but we should consider deterministic Schnorr (HMAC-derived k) to dodge RNG concerns. Aztec's verifier doesn't care about k derivation. |

**Total port effort estimate for full L5**: ~16-25 engineer-days of focused work + 1-2 weeks of side-channel hardening + audit prep. Plus 4-12 weeks of Ledger audit calendar. That's 3-6 months calendar for L5 alone.

**L4-only effort** (Poseidon2 + BN254 Fr, no Pedersen/Grumpkin): ~5-7 engineer-days + audit. Much more tractable.

## 4. Side-channel hardening plan

The single biggest concern codex Wave-1 flagged. Custom curve scalar mul = where private keys leak.

### Mandatory practices
- **Constant-time scalar multiplication**: Montgomery ladder for Grumpkin. No branches based on scalar bits, no early-exit, no data-dependent memory access patterns.
- **Scalar blinding**: derive `k' = k + r * n` where `r` is a fresh random scalar and `n` is the curve order. Compute `R = k' · G`. Since `r·n·G = 0`, this masks the actual `k` from power-analysis correlation.
- **Point projective randomization**: scale each intermediate `(X:Y:Z)` by a fresh random factor `λ` at each scalar-mul iteration. Defeats DPA by making the projective representation non-deterministic.
- **Constant-time field arithmetic over BN254 Fq + Fr**: use BOLOS `cx_bn_mod_*` consistently. Avoid any custom branch logic. Validate that BOLOS bignum ops are documented constant-time (research target).
- **Deterministic Schnorr k**: replace `Fr::random_element()` with `k = HMAC-SHA-256(sk, msg)` per RFC-6979. Eliminates RNG dependency on-device. Aztec's verifier accepts this — k derivation isn't part of the verification equation.

### Fault-injection countermeasures (BOLOS conventions)
- Replay critical comparisons (e.g. PIN check, signature accept/reject) using BOLOS's `cx_ledger_*` patterns if available.
- Use BOLOS's `cx_throw` pattern for unrecoverable states.
- Zeroize secrets immediately after use (`explicit_bzero` equivalent).

### Audit budget — accept as gating
Per codex Wave-1: Ledger custom-curve apps require a mandatory security audit by a Ledger-approved auditor. Estimated $15-30k USD + 4-12 weeks calendar. **Foundation budget approval is a prerequisite to merging L5 to main**. L2 + L4 may be auditable on a lighter pass since they don't introduce custom curve code (L2 uses vendor-blessed K1, L4 adds Poseidon2 which is pure scalar-field hashing, no EC).

## 5. Memory budget per device

| Device | Flash (app) | RAM | NVRAM (persistent state) | L2 fits? | L4 fits? | L5 fits? |
|---|---|---|---|---|---|---|
| Nano S+ | ~32 KB | ~4 KB | ~16 KB | ✓ comfortably | likely ✓ (~10-15 KB) | **risky** — Pedersen tables (~1-2 KB) + Grumpkin code (~10-15 KB) + Poseidon2 (~5 KB) approaches the wall |
| Nano X | ~80 KB | ~5 KB | ~30 KB | ✓ | ✓ | likely ✓ |
| Stax / Flex | ~256+ KB | ~30 KB | larger | ✓✓ | ✓✓ | ✓✓ |

**Strategy**: target Stax/Flex as the primary L5 platform. Nano X for L4 + K1 transactions. Treat Nano S+ as a stretch — may require dropping Pedersen lookup tables in favor of slower-but-smaller compute, or skipping Grumpkin entirely on Nano S+.

## 6. Sequencing

### L1 — Scaffold + plan (this session)
- ✓ `ledger-app/` directory structure
- ✓ `README.md` outlining roadmap
- ⏳ this plan + codex critique → executable plan-final
- ⏳ `ledger_app.toml` metadata file
- ⏳ skeleton `Makefile` referencing `ledger-app-builder-lite`

### L2 — K1 baseline (this session if feasible, ~4 hours of focused C)
**Acceptance**: a built Ledger app (`.elf`) that, run under Speculos, responds to APDU `0x04 SIGN_K1` with a valid r||s signature that verifies under `Ecdsa.verifySignature` via the Aztec PoC.

Concrete code:
- `src/main.c` — BOLOS entry point + APDU dispatch
- `src/handlers/get_pubkey.c` — `GET_PUBKEY` handler
- `src/handlers/sign_k1.c` — `SIGN_K1` handler: parse path + digest, derive key via `os_perso_derive_node_bip32`, call `cx_ecdsa_sign_no_throw(CX_RND_RFC6979 | CX_NO_HASH | CX_LAST, CX_SHA256, ...)`, return r||s.
- `src/ui/sign_ui.c` — confirmation screen (blind-sign for L2: shows truncated digest hex)
- `Makefile` + `ledger_app.toml`

### L3 — Speculos test harness (this session if time)
**Acceptance**: a `tests/speculos/` test script that:
1. Boots Speculos with the L2 app
2. Sends `GET_PUBKEY` APDU, asserts uncompressed-form result
3. Sends `SIGN_K1` with a known `outer_hash`, captures the signature
4. Verifies via `@aztec/foundation` Ecdsa.verifySignature — expect `OK ✓`
5. End-to-end deterministic given a known seed

### L4 — Poseidon2 + clear-signing (multi-week, NOT this session)
Document but don't execute.

### L5 — Schnorr-Grumpkin native (multi-week, NOT this session)
Document but don't execute.

### L6 — Ledger Live submission (post L4/L5)
Document but don't execute.

## 7. Security & adversarial considerations

### Supply chain (host-side adapter SDK)
Standard 7-day npm `minimumReleaseAge` + OIDC + provenance per our `bunfig.toml`. The `@aztec-hwwallet-poc/adapter-ledger` package (to be created) inherits these defaults.

### App distribution
Ledger Live submission requires:
- Mandatory security audit by Ledger-approved auditor (~$15-30k, 4-12wk)
- Submission review by Ledger team
- Origin token enrollment (Clear Signing) — kept server-side, never client-exposed (per Ledger guidance)
- Reproducible builds + repo links

### Custom curve side-channel (L5 only)
Mitigations: §4 above. Audit budget is gating.

### Fault injection
Consumer SE assumption: chip is not impervious to lab-grade fault attacks. Document the threat model. Critical comparisons replicated; detect-and-zeroize on glitch.

### RNG sourcing
BOLOS provides `cx_rng` (TRNG-backed). For ECDSA: use RFC-6979 deterministic-k via `CX_RND_RFC6979` flag — eliminates RNG dependency entirely. For Schnorr: same, use deterministic k.

### Malicious account-contract deployment
Same threat we identified for Trezor. Mitigation: the Ledger app should consult a Foundation-published canonical-account-contracts registry before signing for an account it doesn't recognize — but this requires the registry to exist first. For L2-L5, accept the threat and document it; for shipping, gate behind the registry.

### PXE compromise
Out of scope for the device app (it's a host-side concern). The Aztec adapter's `@aztec-hwwallet-poc/adapter-ledger` package should follow the same OS-keychain at-rest encryption guidance as the Trezor adapter.

### `outer_hash` version skew
The device app is pinned to a specific Aztec protocol version. If Aztec upgrades the `outer_hash` construction, the app needs an update. Implement a version-handshake APDU (`GET_VERSION`) that lets the host detect skew and warn the user.

### Audit submission process
L2 + L4: simpler audit (no custom EC). L5: full audit including side-channel review. Plan audit submissions accordingly — don't bundle L2 with L5; ship audits incrementally.

## 8. Open questions

1. **BOLOS `cx_bn_mod_*` semantics for non-vendor moduli** — does the API accept arbitrary 256-bit prime moduli (we'd be passing BN254 Fr / Fq)? Need to verify against Ledger docs.
2. **`cx_ecdsa_sign_no_throw` exact flag combination for "sign raw digest, deterministic k, secp256k1"** — `CX_RND_RFC6979 | CX_NO_HASH | CX_LAST` is the likely answer but needs verification against `lcx_ecdsa.h` exact constants.
3. **SLIP-44 placeholder for PoC** — codex's view? `1666` looks free; verify.
4. **Pedersen generator count** — how many fixed generators does barretenberg's Pedersen use? Determines size of port. Need to read `crypto/generators/`.
5. **Should L2 ship to Ledger Live ahead of L4 clear-signing?** My stance: **no**. Aligns with §H4 of the upstream research (no blind-sign in public release).
6. **Speculos vs hardware testing for CI** — Speculos covers most semantics but doesn't model side channels. Use Speculos as default; reserve hardware for pre-audit smoke runs.

## 9. Deliverables

```
ledger-app/
├── README.md                  ✓
├── PORTING-PLAN.md            ⏳ (Ledger-specific addendum to this plan)
├── ledger_app.toml            ⏳ L1
├── Makefile                   ⏳ L1
├── src/
│   ├── main.c                 ⏳ L2 — BOLOS entry + APDU dispatch
│   ├── apdu.h                 ⏳ L2 — command constants
│   ├── handlers/
│   │   ├── get_version.c      ⏳ L2
│   │   ├── get_app_name.c     ⏳ L2
│   │   ├── get_pubkey.c       ⏳ L2
│   │   └── sign_k1.c          ⏳ L2
│   ├── ui/
│   │   ├── sign_ui.c          ⏳ L2 — confirmation flow
│   │   └── menu_ui.c          ⏳ L2 — idle screen
│   ├── crypto/
│   │   ├── poseidon2/         (L4)
│   │   ├── pedersen/          (L5)
│   │   ├── grumpkin/          (L5)
│   │   ├── schnorr/           (L5)
│   │   └── common/
│   └── globals.h              ⏳ L2
├── icons/                     ⏳ L1 — per-device app icons
├── glyphs/                    ⏳ L1
└── tests/
    ├── speculos/              ⏳ L3 — Python test harness via speculos-pytest
    └── golden-vectors/        ⏳ L3 — known message/signature pairs

implementations-plan/hw-wallet-poc-ledger/
├── plan.md                    ✓ (this file)
├── parallel-codex-plan.md     ⏳ (codex running)
├── final-codex-critique.md    ⏳ (after consolidation)
├── plan-final.md              ⏳
└── lessons/                   ⏳ (per-phase write-ups as we execute)

packages/
└── adapter-ledger/            ⏳ L2 — TS adapter package, mirrors adapter-trezor structure
    ├── package.json
    └── src/
        ├── index.ts
        ├── transport.ts       — abstract Ledger transport (USB-HID / WebHID / Speculos)
        ├── provider.ts        — implements IntentAuthWitnessProvider
        ├── speculos-transport.ts — Speculos HTTP API client for testing
        └── ledger-transport.ts   — real device via @ledgerhq/hw-transport-node-hid
```

## Top-3 opinionated stands

1. **Ship L2 as private-beta only**. Do NOT submit to Ledger Live with blind-signing — the upstream H4 hardline (no public blind-sign) applies equally to the Ledger arc. L2 unlocks Speculos-tested signing for internal demos; public ship waits for L4 (clear-signing with Poseidon2).
2. **Defer Grumpkin port (L5) to a dedicated multi-week sprint after L4 is auditable**. The "groundbreaking" pull is real but ~16-25 engineer-days of focused porting + audit. Trying to compress L5 into L2's session will produce broken side-channel-leaky code that will fail audit anyway.
3. **SLIP-44 placeholder `1666` for PoC; concurrent Foundation effort to register a real Aztec coin type**. SLIP-13 parity with Trezor is conceptually clean but operationally awkward on Ledger (path doesn't display nicely in the device UI). Use BIP-44 conventions; document the placeholder; queue the registration.
