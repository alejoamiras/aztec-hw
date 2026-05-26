# Clear-signing v0 — Opus independent plan

Independent Tier-A plan for the Aztec Ledger PoC. Pinned to aztec-packages `2770bcb`, aztec-standards Token + Dripper as of Wonderland's main, and the L4 baseline at PoC commit `d2176c5`.

## 1. Problem statement (the opinionated framing)

L4 closed the integrity gap: the host can no longer lie about `outer_hash` — the device recomputes Poseidon2 from the streamed manifest and refuses to sign on a mismatch. What L4 did not close is the *semantic* gap. Every `argsHash` on the device is a 32-byte opaque commitment whose preimage lives only on the host. A user staring at "selector `0xa9059cbb`, target `0xabcd…1234`, mode `PUBLIC`" is technically reading bytes the device validated against the L1-anchored hash, but cannot in any meaningful sense check that they are about to drip 100 USDC to themselves rather than vacate their balance to an attacker's address.

Clear-signing v0 is the smallest credible step toward that semantic check. The thesis: **the device must own the binding between `(target_address, selector) → (token_symbol, decimals, action)` and must recompute `args_hash` from raw args streamed alongside the existing pre-image, so neither the host's claimed `args_hash` nor the host's claimed token metadata can lie**. Anything less — host-supplied labels, signed manifests from a remote registry, dynamic ABI decoding of arbitrary calldata — is either a v1+ exercise or a category-mistake about where trust roots belong on a hardware wallet.

This is deliberately narrow. FT-only. Hardcoded registry. Aztec-standards Token + Dripper only. NO NFTs, no generic dApps, no Schnorr/L5. The user is the Aztec Foundation ecosystem lead; the point of v0 is to ship the first transaction that a user can verify on-glass and land on alpha-testnet — not to design the universal Aztec clear-signing protocol. The latter, in my opinion, will require something Ledger-Plugin-shaped or Solana-ABI-Spec-shaped; we are not building that here.

Two opinions worth surfacing upfront:

- **The 5-slot registry is fine; the 5-call max is the real bottleneck.** A USDC drip composes Dripper.drip_to_public + an SponsoredFPC.sponsor call (2 calls). A transfer is 1 call. We will not exceed 5 calls under FT-only scope. The registry is a static C array — easier to audit than the parity logic we already ship.
- **`L4_MAX_ARGS = 4` is correct for v0** and I'll defend it in §2 below. Increasing it costs APDU budget; lowering it locks out the 4-field `(from, to, amount, _nonce)` shapes that dominate the FT verb set. 4 is the structural minimum here, not an arbitrary safety margin.

## 2. Wire-format extension — how raw args reach the device

L4 currently sends APPEND_CALL with a 97-byte body (`args_hash || selector || target || flags`). The host claim of `args_hash` is opaque. Clear-signing v0 adds an *args body* alongside the existing call body, parsed in the same handler and bound into the same parity gate.

I evaluated three wire shapes and chose Option B.

**Option A — Two-INS split (`APPEND_CALL` then `APPEND_CALL_ARGS`):** simpler bounds-checking but doubles per-call APDU latency on a constrained transport (USB HID is 64-byte packets; even small APDUs cost multiple frames), forces a session state machine with a new transitional state, and complicates fault hardening (now there are two attack windows per call instead of one). Rejected.

**Option B — Extended `APPEND_CALL` body, single INS, length-tagged args section. CHOSEN.** Body layout:

```
args_hash      32 B  (existing — kept for now, see footnote)
selector       32 B
target         32 B
flags           1 B
args_count      1 B   (0..L4_MAX_ARGS, validated)
args            32 * args_count  bytes
```

With `L4_MAX_ARGS = 4`: 32 + 32 + 32 + 1 + 1 + 128 = **226 bytes**, well under the 255-byte standard-APDU body budget. The 98-byte L4 baseline becomes 98 + 128 = 226 — single APDU per call, no extended-length, no chunking. This is the load-bearing choice and it keeps the device parser linear.

Why `L4_MAX_ARGS = 4` and not 3 or 8: the four FT entrypoints with `_nonce` are `(from, to, amount: u128, _nonce: Field)` — exactly 4 Fr slots because `u128` is **1 Fr slot** per `ArgumentEncoder.typeSize` (`yarn-project/stdlib/src/abi/encoder.ts:24-43` returns 1 for `integer`, including `width: 128`). The mint variants are 2 slots `(to, amount)`. Dripper.drip_to_public/private are 2 slots `(token_address, amount: u64)`. SponsoredFPC.sponsor_unconditionally is 0 or 1 slot. So 4 is exactly the FT-only ceiling. Raising to 8 burns ~128 bytes of APDU budget for a feature v0 doesn't need; lowering to 3 forces fallback rendering on every authwit'd transfer, which defeats the point.

**Footnote on `args_hash`:** I considered dropping it from the wire (device recomputes from raw args anyway). I decided to keep it for v0 because (a) it preserves the L4 invariant `claimed_outer_hash` is fully derivable from a *single* `(args_hash, selector, target, flags)` claim, simplifying audit by keeping the L4 surface unchanged; (b) the device checks the claimed `args_hash` against its own recompute and rejects on mismatch — the host is forced to ship the canonical value or fail closed; (c) future "long-args" extension (chunked args body) can keep `args_hash` and skip the inline section, with a `flags` bit signalling "args are opaque". The 32 B cost is trivial and the audit-surface saving is real.

**Empty-args calls.** Some calls take zero args (`view` functions, the `FunctionCall.empty()` padding). `args_count = 0` is legal and the device must compute `args_hash = poseidon2HashWithSeparator([selector], PUBLIC_CALLDATA)` (public) or `Fr.ZERO` for private+empty per `computeVarArgsHash`. Special-case at the gate — see §3.

**Bump `MANIFEST_VERSION` from 1 → 2.** v1 manifests are rejected by v2-firmware devices and vice versa, eliminating "did the host send the new format" ambiguity at runtime. Cheap, decisive, audit-friendly.

## 3. On-device args_hash recompute, parity gate, fault hardening

The recompute mirrors `encodeRealCall` in `packages/adapter-ledger/src/l4-manifest.ts:59-88`, but on-device, and with the public/private branch the current L4 code rejects at line 60.

**Public-call path (`flags & PUBLIC == 1`):**
```
args_hash = poseidon2HashWithSeparator(
    [selector_as_Fr, args[0], args[1], ..., args[n-1]],
    PUBLIC_CALLDATA = 2760353947
)
```

**Private-call path (`flags & PUBLIC == 0`):** the "fromArgs" path in `computeVarArgsHash`. Empty → `Fr.ZERO`; non-empty → `poseidon2HashWithSeparator(args, FUNCTION_ARGS = 3576554347)`. **Note the separator difference** (FUNCTION_ARGS, not PUBLIC_CALLDATA) and **the selector is NOT included** in private args_hash — the binding is a separate inner. Tomorrow's me will re-read `computeVarArgsHash` exactly before writing the parity test; the off-by-one here is the kind of bug that wastes a day. The `private`-call path is the unblock for the `l4-manifest.ts:60` hard-reject in addition to its own merits — `transfer_private_to_public` is a `#[external("private")]` entrypoint per `aztec-standards/src/token_contract/src/main.nr:109`, so authwit'ing it requires the private path.

**Where the parity gate lives.** I considered placing it inside `handler_append_call` (per-call gate) vs deferring to `handler_finalize_and_sign` (batch gate, alongside the existing `outer_hash` parity passes). I'll do **both**:

- *Per-call gate, inside `handler_append_call`*: recompute `args_hash` from raw args + selector + flags, compare against the claimed `args_hash`. Reject `SW_HASH_MISMATCH` immediately. This catches host fraud before any further APDUs, and importantly stops the device from storing a 4×32 B raw-args buffer if it's never going to be used.
- *Batch gate, in `finalize_after_approval`*: re-derive every call's `args_hash` from stored raw args (the third recompute), compare against the stored claimed values, AND consume those locally-recomputed values when re-computing `outer_hash` for the parity-pass-3 sign-step. This closes a TOCTOU window between APPEND_CALL and FINALIZE if a glitch corrupts memory in between. This is the same pattern `finalize_and_sign.c:127-138` uses for `outer_hash`.

**Fault hardening pattern (matches the existing L4 dup-sig pattern).** Per call: compute `args_hash` twice into two separate stack buffers, constant-time-compare each against the claimed value, constant-time-compare them against each other. Three independent failure points exactly like the `outer_hash` pass. Aggregate cost: per call ≈ ~5ms (one Poseidon2 over ≤5 fields is sub-millisecond on the secure element; the cost is fixed-size buffer wrangling). Five calls × twice × twice = 20 Poseidon2 hashes worst case. Tolerable. The current outer-hash recompute does the equivalent budget for one big payload.

**Storage cost on-device.** Session struct grows by `L4_MAX_CALLS * L4_MAX_ARGS * L4_FR_BYTES = 5 * 4 * 32 = 640 B`. Plus `args_count` per call (5 B). Plus a single global `padding_args_hash` cache (32 B). Roughly 680 B added to `G_l4_session`. The current session is ~700 B; we're roughly doubling it. **Nano S+ RAM budget is the constraint** — check the linker's `.bss` ceiling during the L5.1 phase. If we're over, the first thing to cut is the per-call `args_count` byte: pack it into the existing `flags` (we have 5 unused high bits). If still over, drop one of the BIP32 path slots (we use 5 + headroom, MAX is 10).

## 4. Registry + decoder

**Layout — `ledger-app/src/cs/registry.h`:**

```c
typedef struct {
    uint8_t  used;                  /* 0 = empty slot — render fallback */
    uint8_t  address_be[32];        /* Aztec address as 32 BE bytes */
    uint8_t  symbol[7];             /* "USDC\0\0\0" — null-padded */
    uint8_t  decimals;              /* 0..30, validated */
    uint8_t  reserved[7];           /* pad to 48 B; alignment + futureproofing */
} az_token_entry_t;                 /* sizeof = 48 B */

#define CS_REGISTRY_SLOTS 5u
extern const az_token_entry_t CS_REGISTRY[CS_REGISTRY_SLOTS];
```

5 slots × 48 B = 240 B in `.rodata`. Negligible. Static-init in `registry.c` with the USDC + ETH addresses from `faucet/src/contracts/deployments.json` and the Dripper at `0x172684be…7070` plus 2 empty reserved slots.

**Selector table — `ledger-app/src/cs/selectors.h`:**

```c
typedef enum {
    CS_VERB_UNKNOWN = 0,
    CS_VERB_TRANSFER_PRIV_PRIV,
    CS_VERB_TRANSFER_PRIV_PUB,
    CS_VERB_TRANSFER_PUB_PRIV,
    CS_VERB_TRANSFER_PUB_PUB,
    CS_VERB_MINT_PUB,
    CS_VERB_MINT_PRIV,
    CS_VERB_DRIP_PUB,
    CS_VERB_DRIP_PRIV,
    CS_VERB_SPONSOR,
} cs_verb_e;

typedef struct {
    uint32_t selector;              /* low 4 bytes of the Fr selector */
    cs_verb_e verb;
    uint8_t   arg_count;            /* expected args_count for this verb */
    uint8_t   contract_kind;        /* TOKEN | DRIPPER | SPONSOR */
} cs_verb_entry_t;
```

The table is ~10 entries, fixed at build time.

**Codegen story.** We do NOT trust a host script to emit the right selector bytes. Selectors are derived from `selectorFromSignature("transfer_public_to_public(AztecAddress,AztecAddress,u128,Field)")` exactly as Aztec computes them. The build step:

1. A Bun script under `ledger-app/scripts/gen-selectors.ts` reads the compiled aztec-standards artifacts. The user has the repo at `/Users/alejoamiras/Projects/Ecosystem/aztec-standards`. The script compiles the contracts (or expects them already compiled at `src/<contract>/target/<name>.json`), extracts each function's `selector` field from the compiled artifact, and emits `ledger-app/src/cs/selectors.gen.h`.
2. The generated header is committed. CI runs `gen-selectors.ts --check` and fails if generated content drifts from committed content.
3. The C dispatcher (`registry_decode_call`) consults `CS_REGISTRY` for target, `CS_VERB_TABLE` for selector, validates `arg_count` matches, and returns a `cs_decoded_call_t` (verb, token_index_or_none, amount, recipient_address, sender_address_or_none).

**Address-collision risk.** Aztec contract addresses are 254-bit Fr elements; the probability of a collision is astronomically small *for honestly-deployed contracts*. But the threat model here is a host crafting calldata against a *different* registered contract — i.e. host claims target = USDC address but calls Dripper. The decoder must do address-based lookup first, then selector match within that contract's allowed verb set. **Critically: the selector-verb table is indexed per-contract-kind.** A USDC-targeted call with the Dripper's `drip_to_public` selector is decoded as UNKNOWN, not as "drip", because the USDC contract is a TOKEN kind, and TOKEN's allowed verbs do not include `drip_to_*`.

**Address-squatting after testnet redeploys.** A real risk: the user controls the registry at build time, and if Wonderland redeploys aztec-standards with new salts, the addresses in `faucet/deployments.json` change. Mitigation: pin to the addresses in the user's faucet deployments (controlled by him), not Wonderland's mainnet. The Dripper at `0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070` is the deployer-of-record for both tokens (`faucet/deployments.json:12, 24, 29`), so we have a coherent trust root: one deployment campaign, controlled by the user, salts pinned.

**Fallback behavior:**

- **Registry miss (target not in registry):** render Path / Account / Chain / Calls / `(target hex, selector hex, mode)` per call — exactly the L4 UI, plus the user-facing warning "Unknown contract — raw display only". The signing path stays available (the user can still authwit blind), but the title flips to "Authorize **unknown** calls" so a glance at the device communicates risk. This is contentious. If we want to be paranoid, refuse to sign on a registry miss; I'd ship v0 with the warning-only mode because the alternative bricks the device the moment Aztec ships a new core contract.
- **Registry hit + selector miss:** "Known contract, unrecognised function" — render registry-derived contract label + raw selector hex + raw args (we have the bytes; display them as `Field[0]` hex etc.). Warns clearly.
- **Registry hit + selector hit + `arg_count` mismatch:** signal `SW_DECODER_DESYNC` (new SW code), refuse to sign. This indicates an aztec-standards version drift between the build-time selector table and the host's actual call.
- **Address-squat detection:** if `target` matches a non-empty registry slot but `flags` are inconsistent (e.g. PRIVATE selector on a slot we expect public-only for), refuse to render the rich label, fall back to raw + warning. Conservative.

## 5. UI design — Nano S+ (128×64) + Stax/Flex/Apex

NBGL with `nbgl_useCaseReview` is already wired in `ui/verified_calls_ui.c`. The existing pair structure (4 header pairs + 3 per-call + 1 outer_hash) is the right backbone; we extend per-call to render *decoded* fields and gate raw fields behind an "Advanced details" subsection. Pair budget: NBGL handles paginated reviews; the wrapping/pagination cost on a Nano S+ is real but tolerable up to ~25 pairs.

**Per-call pair layout, decoded mode (TRANSFER verbs):**

```
Call X/N       "Transfer USDC pub→pub"
Amount         "1.500000 USDC"
From           "0xabcd…1234"               (or "you (self)" if from == G_session.account)
To             "0x5678…9abc"
Mode           "PUBLIC"
```

Decimals come from the registry, NEVER from the host. The amount-formatting function lives in `cs/format.c` and does *fixed-point decimal* string conversion with no `printf("%f", ...)` (no FP on the secure element). Decimals=6 → "1.500000"; trailing zeros trimmed except for ≥1 zero after the point to anchor "1.0" vs "1"; explicit thousands separator skipped (no comma — locale-free).

**Per-call pair layout, DRIPPER:**

```
Call X/N       "Drip USDC → public"
Amount         "100 USDC"                  (Dripper amount is u64, no decimals applied — see below)
Token          "USDC"
```

The dripper's `amount: u64` (`aztec-standards/src/dripper/src/main.nr:18`) is **raw token units**, not whole tokens. Display reads the registry decimals and divides. *Implementation gotcha*: the user's `useFaucetDrip.ts` passes `token.onchainAmount` which is already scaled. Need to verify and document this before shipping (open question §9).

**Per-call pair layout, MINT verbs:** the user said mint is in scope. Decoded as "Mint X USDC to <addr>" or "Mint X USDC to private <addr>". Mint is dangerous; show a yellow warning pair "MINTER ACTION" so the user notices.

**Fallback mode:** registry miss / selector miss / private-args-decode failure → fall back to L4-style `target hex, selector hex, mode`. The review subtitle becomes "Unknown call — verifying RAW values only".

**Concrete 5-call rendering on Nano S+:** at worst 5 calls × 5 pairs decoded = 25 pairs + 4 header + 1 outer = 30 pairs. NBGL `nbgl_useCaseReview` paginates fine but the review is long. **My take: cap real-call count at 3 for decoded mode**, fallback to raw for 4+ calls. Document this. The faucet's drip → confirm-transfer pattern is 2 calls; transfers are 1 call; we're nowhere near 5 in normal FT-only flows. Defining "decoded UI active iff `call_count ≤ 3 AND every call decodes`" makes the device behavior auditable.

**Mental model.** The user is reading sentences, not hex. "Transfer 1.500000 USDC public→public from you to 0x5678…9abc" reads in 2-3 seconds. Hex-only `0xabcd…1234 / 0xa9059cbb / PUBLIC` does not. The outer_hash pair stays in the review (last pair) for the paranoid user, but is no longer the primary verification surface.

**Copy. The "INTERNAL build" subtitle goes away.** v0 ships with a real registry; the warning copy degrades to "Decoded values verified against on-device registry". When the device renders a raw fallback, subtitle flips to "Unverified RAW values — proceed only if you understand the calldata".

## 6. TS adapter changes

Files touched in `packages/adapter-ledger/src`:

- **`apdu.ts`**: bump `MANIFEST_VERSION` to 2; add `L4_MAX_ARGS = 4`; widen `AzCall` interface to `readonly args: readonly Uint8Array[]` (each 32 B); add `SW_DECODER_DESYNC = 0x6f08`; extend `encodeAppendCallBody` to emit `args_count || args` after flags; lengthen body size constant.
- **`l4-manifest.ts`**: remove the `isPublic=false` hard-reject at line 67. Implement private-path `args_hash = computeVarArgsHash(args)` matching the device. Emit `args` as 32 B Fr buffers in `AzCall`. Pad `args_count` field validation (`≤ L4_MAX_ARGS`). The empty-args case for `computeVarArgsHash` returns `Fr.ZERO` and we *don't* include a selector; mirror exactly.
- **New: `cs-registry.ts`** — host-side mirror of `CS_REGISTRY` and `CS_VERB_TABLE`. Generated by the same build script that emits the device-side `.gen.h`. Single source of truth: `cs-registry.gen.ts` committed alongside the C header. The adapter does NOT trust the registry to drive its own logic (the host can construct any intent it likes); it uses the registry only for pre-flight sanity checks ("warn before sending: this looks like an unknown contract") and for golden-vector tests asserting the device decodes correctly. The host never tells the device "this is USDC"; the device looks it up.
- **`provider.ts`**: extend `signMessageHashFromIntent` to populate `StructuredFunctionCall.args` with the encoded Fr fields. The `@aztec/entrypoints` encoder already produces this; we plumb it through.
- **New: `cs-golden.test.ts`** — host/device parity tests for each registered verb. For each `(verb, registry entry)`: build a call, encode it, run a fake-device parity routine, assert decoded fields match expectations. This is the L4.1 pattern (14/14 golden parity) applied to clear-signing.

Total: ~600 lines of new TS, ~150 lines of changes to existing TS. Comparable to the L4 patch.

## 7. Alpha-testnet end-to-end test

**Hard truth: do local sandbox first, alpha-testnet second.** The user phrased this as "not sure how the emulator works"; the answer is that **Speculos is for the device**, **Aztec sandbox is for the network**, and you need both. Speculos runs the Ledger app binary and exposes APDU over TCP. Aztec sandbox runs a PXE + local L1 + L2 sequencer. The integration point is a Node-side test that wires `EcdsaKAccount` to a `LedgerSigner` whose APDU client points at Speculos.

**Phase ordering (this matters):**

1. **L5.0 — Local sandbox dry-run.** Spin up `aztec start --sandbox` in a parallel-safe ephemeral-port harness (per the user's parallel-safe E2E convention). Deploy aztec-standards Token + Dripper to sandbox. Use a known seed for the device, derive the device pubkey via `GET_PUBLIC_KEY`, register an `EcdsaKAccount(devicePubkey)`. Sign a drip + a public→public transfer using the new clear-signing flow. Assert `mined` receipt. Fail-closed if Speculos reports `SW_HASH_MISMATCH` or any non-9000.
2. **L5.1 — Alpha-testnet dry-run.** Same harness, RPC pointed at `https://rpc.testnet.aztec-labs.com`. Replace the sandbox-deployed Token with the canonical USDC at `0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5` and Dripper at `0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070` (`faucet/deployments.json`). Deploy an `EcdsaKAccount` for the device pubkey, fee-pay through `SponsoredFPCContract` (the faucet's pattern — `useFaucetDrip.ts:62-72`, where `interaction.request({ fee: { paymentMethod: SponsoredFeePaymentMethod(fpc.address) } })` merges the sponsor call into `exec.calls`). Execute `drip_to_public(USDC, 100)`. Assert `mined`.
3. **L5.2 — Alpha-testnet transfer.** With balance from L5.1, sign and submit `transfer_public_to_public(deviceAddress, alice, 1000000, nonce)`. Assert `mined`. Verify on-chain that the recipient balance changed via `balance_of_public`.

**Failure modes to flag explicitly:**

- **Sponsor unavailable / FPC contract not present on testnet.** Mitigation: do an explicit pre-flight `getContractInstance(SponsoredFPCContract.address)` and bail out with a clear error if the sponsor isn't there. The faucet pattern in `sponsored-fpc.ts` does exactly this.
- **Testnet rate limits.** Aztec's testnet sequencer can throttle. Tests should retry with exponential backoff on `429`/network-level errors and never on protocol-level rejections (those are real bugs).
- **Testnet down.** CI shouldn't fall over on a flaky external. The L5 e2e test must be `describe.skipIf(!process.env.AZTEC_TESTNET_E2E)` so the default CI run uses sandbox only.
- **Sandbox + node version drift.** `bun x aztec --version` and `bun x aztec-cli --version` pinned in the harness; mismatch with the @aztec/* npm deps surfaces as obscure deserialization errors. Pin both.
- **Speculos APDU latency.** USB HID has a 64-byte packet ceiling and the new 226-byte APDU body needs 4 inbound frames. Add a per-APDU timeout > 2s (default Speculos is 100ms, which is too tight for fault-hardened paths).

**Speculos test harness file.** Add `tests/e2e/clear-signing.e2e.test.ts` driven by Bun, importing the Speculos client we already use in `speculos-transport.test.ts`, wired to `EcdsaKAccount.deploy(...)` from `@aztec/accounts/ecdsa/k`. Reuse the existing `ragger` setup for click sequences during the review UI confirmation step. The harness must auto-click "Approve" via NBGL automation; ragger supports this.

## 8. Security & adversarial considerations (mandatory)

The L4 baseline already addresses `outer_hash` integrity and TOCTOU between parity and signing. Clear-signing v0 expands the trust boundary — the device now interprets bytes that have semantic meaning. Each new surface is an attack surface.

**Host lies about args contents.** The device recomputes `args_hash` from the streamed raw args (§3) and rejects on mismatch. Crucially, this happens *before* UI display: the device cannot render "Transfer 1.5 USDC" if the args don't hash to the claim, because the parity gate runs in `handler_append_call`. The check is constant-time. Two independent recomputes (per-call + at-FINALIZE) with cross-comparison.

**Host claims "USDC" for a non-USDC address.** The device never accepts a host-supplied token label. The registry lives in `.rodata`, indexed by `target_address`. If the host sends `target = <random address>` and constructs args that hash correctly, the device's lookup returns "unknown contract" and falls back to raw display. The host cannot inject the string "USDC" into the rendered review.

**Host swaps decimals (1.0 ↔ 1M).** Same defense. The device reads `decimals` from `CS_REGISTRY[i].decimals`, never from the host. A 6-decimal token always displays with 6 decimal places. The fixed-point formatter is constant-input — no host-controllable knob touches it.

**Host strips raw args entirely to force a fallback display path.** This is real and subtle: if the host sends `args_count = 0` while the actual call has 4 args, the recomputed `args_hash` for a 0-args call won't match the claimed `args_hash` (the claim was derived from a 4-args call), so the parity gate kicks in and rejects with `SW_HASH_MISMATCH`. **But there's still a downgrade attack vector** — the host could send a *valid* 0-args view-function call (e.g. `total_supply()`) whose `args_hash` IS the empty-args hash, and try to convince the user to sign that as the "transfer". The defense: the **decoder verb table requires `arg_count` to match the verb's declared shape**; a view function isn't in the verb table at all (we only register state-mutating verbs); so a "view" call renders as "Unknown function" with a warning, never as "Transfer". The user can still authorize it blind, but the UI never lies.

**Host sends mismatched contract + selector + args.** Decoder uses contract-kind-scoped verb tables (§4). USDC + Dripper-selector → unknown verb → raw fallback. The user sees "Unknown function — proceed only if you understand the calldata". This is exactly the right UX behavior.

**Glitch attack between args_hash recompute and parity gate.** Mitigated by the three-pass pattern (per-call + at-finalize + at-sign-step), constant-time-compare, and the rule that the *signing step consumes the locally-recomputed `outer_hash` value*, not the stored one (the L4 `finalize_and_sign.c:146` pattern explicitly avoids reading mutable session memory between validation and digest computation — we preserve that for `args_hash` too). The realistic glitch attacker targets the comparison itself, not the hash function; constant-time compare with `diff |= a^b` is the right primitive.

**Supply-chain compromise of aztec-standards.** If Wonderland's repo gets compromised and selectors change, our generated `selectors.gen.h` doesn't auto-update — it's committed and gated by CI. If a compromised version with malicious selectors is built into the device firmware, the user is screwed; but that's a firmware-signing problem, not a runtime problem. v0 build pipeline must pin aztec-standards to a specific commit hash and verify it in CI. The 7-day npm `minimumReleaseAge` (`bunfig.toml`) doesn't help here because aztec-standards is built from source, not npm; we need a separate "pinned git commit in CI" check.

**Address-squatting after a testnet redeploy.** Mitigated by pinning the registry to the user's faucet deployments (which he controls). If the user redeploys the dripper with a new salt, the registry must be updated and the firmware rebuilt. Document this in the firmware build README. Alternative I rejected: signed runtime registries — too much complexity for v0, and the trust root has to live somewhere.

**Decoder bugs causing label corruption.** The decoder runs after the parity gate, so a buggy decoder *cannot* affect what gets signed (only what gets displayed). Worst case: a clean signature lands on chain with the user thinking they signed something else. Mitigation: the decoder is < 200 lines of straight-line C; fuzz it. Add a `decoder-fuzz.test.ts` host-side that throws random Fr values at the decoder, asserts it always either matches a known verb shape OR falls back to raw, never crashes.

**Cross-call confusion.** A 3-call review where call 1 = "approve drip", call 2 = "drip 100 USDC", call 3 = "transfer 1M USDC to attacker" is exactly the kind of UI exploit that bites EVM wallets. The "Call X/N" prefix on every pair (already in L4) is the table-stakes mitigation. v1 should add a per-call "Approve" / "Reject" pair so the user can't bulk-confirm; v0 doesn't.

**Side channels in the amount formatter.** The fixed-point formatter is data-dependent — short strings for small amounts, long for large. Branchless conversion is overkill for v0 (the value the user sees is necessarily public to him). Not a concern.

**Misc:** PRNG used in the K1 signing path is RFC-6979 deterministic (`finalize_and_sign.c:158`), not entropy-dependent — no new RNG surface added by clear-signing. The new memory in `G_l4_session` is zeroed on `l4_session_reset` (`session.h:59`), unchanged. No new BIP32 paths consumed. No new persistent storage. No new entropy sources.

## 9. Phasing, success criteria, deliverables, open questions

**Phasing:**

- **L5.0 (week 1, ~3-4 days):** TS adapter changes (`apdu.ts`, `l4-manifest.ts` private path, `args` propagation). Selector codegen. Host-side parity tests passing (target: 10/10 golden vectors covering each verb + each registered token + fallback). Bumps `MANIFEST_VERSION` to 2.
- **L5.1 (week 1-2, ~3-4 days):** Device-side: `cs/` directory with registry, selectors, decoder, format. Wire into `handler_append_call` (args parsing + per-call parity). Rewire `ui/verified_calls_ui.c` to use decoder output with raw fallback. Ragger-driven Speculos UI test.
- **L5.2 (week 2, ~2 days):** Local sandbox e2e — `EcdsaKAccount` deploy + drip + transfer round-trip. Auto-click via ragger.
- **L5.3 (week 2-3, ~1-2 days):** Alpha-testnet e2e behind `AZTEC_TESTNET_E2E=1`. Document the run-once-by-hand procedure (the first testnet tx is human-witnessed). Capture the tx hash and link in the lessons file.
- **L5.4 (week 3):** Codex post-impl audit. Address findings. Lock down `MANIFEST_VERSION=2`. Tag.

**Success criteria** (in priority order):

1. **A real testnet transaction signed entirely on-device gets `mined` on alpha-testnet**, with the device showing "Transfer X USDC pub→pub" not raw hex.
2. Host/device parity tests: 100% for all FT verbs × public/private × empty/full args. Failure on ANY parity vector blocks merge.
3. Host cannot force the device to display a wrong amount, wrong recipient, wrong token symbol, or wrong decimals. Verified by adversarial test that mutates each field and asserts `SW_HASH_MISMATCH` or fallback rendering.
4. RAM budget on Nano S+ holds (linker doesn't error).
5. APDU round-trip latency for full sign flow < 5s on real hardware (Speculos baseline is much faster; real device is the worry).
6. Codex post-impl review surfaces zero critical findings; any major findings have written rationales for accept/reject.

**Deliverables checklist:**

- `ledger-app/src/cs/registry.h`, `registry.c`, `selectors.gen.h`, `selectors.h`, `decoder.c`, `decoder.h`, `format.c`, `format.h`
- `ledger-app/scripts/gen-selectors.ts`
- Modified `ledger-app/src/l4/wire.h` (MANIFEST_VERSION=2, L4_MAX_ARGS, body sizes)
- Modified `ledger-app/src/handler/append_call.c` (args parsing + per-call parity)
- Modified `ledger-app/src/handler/finalize_and_sign.c` (use stored args in third parity pass)
- Modified `ledger-app/src/l4/session.h` (extended `l4_call_t` with `args[L4_MAX_ARGS][L4_FR_BYTES]` + `args_count`)
- Modified `ledger-app/src/l4/parity.c` (consume stored args for `args_hash` recomputation)
- Modified `ledger-app/src/ui/verified_calls_ui.c` (decoder-driven rendering with fallback)
- Modified `packages/adapter-ledger/src/{apdu,l4-manifest,provider}.ts`
- New `packages/adapter-ledger/src/cs-registry.gen.ts`, `cs-registry.test.ts`, `cs-golden.test.ts`
- `tests/e2e/clear-signing-sandbox.e2e.test.ts` and `clear-signing-testnet.e2e.test.ts`
- `implementations-plan/clear-signing-v0/lessons/phase-N.md` per phase
- Updated `implementations-plan/index.md` entry
- Updated `CLAUDE.md` v0-target section

**Open questions** (must resolve before / during implementation):

1. **Dripper amount semantics**: is `useFaucetDrip.ts`'s `token.onchainAmount` raw-units or whole-tokens? Read `constants/tokens.ts` and verify. If raw-units, the registry decimals divide; if whole, they don't. **Block L5.1 on resolving this.**
2. **NBGL pair pagination on Nano S+**: empirically verify a 25-pair review renders cleanly on the smallest Nano S+ screen. If not, cut the per-call mode pair (it's the lowest-signal one).
3. **`computeVarArgsHash` precise behavior for 1-arg private calls**: re-verify against the upstream source before writing parity tests. Off-by-one here ruins a week.
4. **`SponsoredFPC` testnet availability**: verify the sponsor contract is deployed on `rpc.testnet.aztec-labs.com` *today*. If it isn't, the alpha-testnet e2e blocks on a self-deployment step.
5. **EcdsaKAccount deployment cost**: the first testnet deploy of `EcdsaKAccount` for the device pubkey needs fees. The sponsor pattern from `useFaucetDrip` works post-deploy; first-deploy may need a different funding path. Worst case: deploy from the user's normal wallet, paying with his account.
6. **Should v0 also re-render the `outer_hash` pair?** I lean yes (defense in depth, kept the same as L4); but a Stax/Flex user sees one extra pair and we can drop it on small screens. Punt to UX feedback.

**Out of scope for v0** (recorded so v1 has a clean starting line): NFT support, generic dApp decoding via runtime ABI, signed remote registries, ENS/contact-book recipient labels, Schnorr/Grumpkin authwits, multi-account / SLIP-0013 path scheme, hardware-attested registry updates. These belong in v1+ and the v0 architecture should not constrain them.
