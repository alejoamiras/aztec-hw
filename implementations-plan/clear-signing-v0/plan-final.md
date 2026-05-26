# Clear-signing v0 — final consolidated plan

> Tier-A consolidation of three independent drafts:
> - Main plan: `plan.md`
> - Opus subagent: `opus-plan.md`
> - Codex xhigh: `codex-plan.md` (session `019e65b9-fbbc-7412-a07f-36404fdba3ad`)
>
> Where the three disagreed, this file records the call + which source it came from + the reasoning. Sources of bullets are marked `[main]`, `[opus]`, `[codex]`, or `[consolidated]`.

## Pinned sources

- aztec-packages: `2770bcb82d40323060c2f9c71aaf293b640efbef` (`/Users/alejoamiras/Projects/aztec-packages`)
- aztec-standards (Wonderland): `/Users/alejoamiras/Projects/Ecosystem/aztec-standards`
- Faucet (acceptance target): `/Users/alejoamiras/Projects/nulo/nulo-2/packages/faucet`
- alpha-testnet RPC: `https://rpc.testnet.aztec-labs.com`
- alpha-testnet chain: `11155111`, rollup version: `4127419662` (per `nulo-2/packages/faucet/src/lib/chain-info.ts:21`) `[codex]`

## 1. Problem statement (codex framing)

L4 closed the *integrity* gap: host and device agree on `outer_hash`. It did not close the *intent* gap. The device still asks the user to approve opaque host-provided semantics; `args_hash` is a 32-byte commitment whose preimage lives only on the host.

v0 thesis (codex): **stop being a hash cop, start being a narrow FT intent verifier**. Strict allowlist or no signature. The device owns contract identity, selector meaning, amount scaling, and `args_hash` recomputation. Unknown calls do NOT degrade to raw hex inside clear-signing; they get rejected. Blind signing remains available via the legacy `SIGN_OUTER_HASH` INS — but is now an explicit, separate path.

Scope reaffirmed:
- FT only (aztec-standards Token)
- Hardcoded 5-slot registry
- Build-time pinned contract addresses (user's testnet faucet)
- Schnorr/L5 deferred
- Success = a real alpha-testnet **private-call** USDC transfer signed by Speculos lands `mined`

## 2. Wire-format extension

`[consolidated — all three agreed]`

- `MANIFEST_VERSION = 2` (bump; the device rejects v1 manifests, and the host adapter emits v2 only)
- Single INS (`APPEND_CALL`), single APDU per call, no chunking, no extended-length
- Body layout (≤ 226 bytes, fits 255-byte APDU budget):
  ```
  claimed_args_hash[32]
  selector[32]            // canonical Fr, high 28 bytes must be zero
  target[32]              // canonical Fr (AztecAddress)
  flags[1]                // bit0 public, bit1 hide_msg_sender, bit2 static
  args_count[1]           // 0..L4_MAX_ARGS=4, validated against the decoder's expected
  raw_args[args_count][32]
  ```
- `L4_MAX_ARGS = 4` — exactly the FT ceiling (4-arg transfer family; 2-arg mint; 0-arg sponsor). u128 takes 1 Fr slot (`yarn-project/stdlib/src/abi/encoder.ts:24-43`).
- `claimed_args_hash` stays on the wire `[opus]`: preserves the L4 invariant that `outer_hash` is derivable from a single `(args_hash, selector, target, flags)` claim per call. Future "long-args" extensions can route through a flag bit. 32 B cost is negligible.

## 3. On-device `args_hash` recompute

`[consolidated — opus + codex aligned]`

**Two-stage parity gate**:

1. **`APPEND_CALL` per-call gate**:
   - canonical-Fr check every raw arg
   - look up the call's `(target, selector)` in the registry+decoder
   - assert `args_count == decoder.expected_arg_count`
   - assert `flags & PUBLIC == decoder.expected_is_public`
   - recompute `args_hash` from raw args (algorithm below)
   - constant-time compare against `claimed_args_hash`
   - on mismatch → `l4_session_reset()` + `SW_HASH_MISMATCH`

2. **`FINALIZE_AND_SIGN` finalize gate** (matches L4's three-pass shape from `finalize_and_sign.c:79-105`):
   - On every pass, `l4_compute_outer_hash` re-derives each call's `args_hash` from **stored raw args**, not from the cached `claimed_args_hash`
   - All three passes must agree
   - Sign step consumes the just-validated local `recheck_outer`, preserving the L4 BLOCKER fix from codex's earlier round

**Trusted-session invariant** `[codex final-review MAJOR #4]`:

> After M5.2 lands, the in-flight session (`G_l4_session`) MUST contain raw args + EITHER the device-recomputed `args_hash` OR no hash field at all. Finalize MUST NEVER read the host-claimed `args_hash` again. The current `append_call.c:39` stores the host claim and `parity.c:58` consumes it; the M5.2 patch makes that impossible — either delete the `claimed_args_hash` field after parity passes, or replace it with the device-computed value. The acceptance gate for M5.2 is that no `parity.c` code path reads any byte the host directly supplied as the call's `args_hash`.

**Algorithm** (mirrors `yarn-project/stdlib/src/hash/hash.ts`):

```c
if (flags & PUBLIC) {
    /* poseidon2HashWithSeparator([selector, ...args], PUBLIC_CALLDATA=2760353947) */
    fields = [selector, ...args]
} else if (args_count == 0) {
    /* hash.ts:computeVarArgsHash empty-args short-circuit */
    args_hash = Fr.ZERO
    return
} else {
    /* poseidon2HashWithSeparator(args, FUNCTION_ARGS=3576554347) — NO selector */
    fields = args
}
args_hash = poseidon2_hash_with_separator(fields, separator)
```

The selector is NOT included for private calls. This is the bug codex's plan §3 explicitly flagged: "tomorrow's me will re-read `computeVarArgsHash` exactly before writing the parity test."

**Fault hardening**: per-call double-compute with cross-compare (same pattern as the L4 outer_hash pass). Total worst-case cost: 5 calls × 2 = 10 Poseidon2 hashes at APPEND_CALL time + 3 passes at FINALIZE × 5 calls = 15 more. Aggregate ≤25 hashes per sign — sub-second on Speculos, ~5s on hardware. Tolerable.

**Session storage** `[opus calc]`:
- `args[L4_MAX_CALLS=5][L4_MAX_ARGS=4][L4_FR_BYTES=32]` = 640 B
- `args_count[5]` = 5 B
- Padding-call args_hash cache = 32 B
- Total session struct adds ≈680 B; new session size ≈1.4 KB (still well under Nano S+ RAM budget)

## 4. Registry + decoder

`[codex direction adopted]`: local manifest is the reviewed source-of-truth. Aztec-standards is consulted as a drift detector via CI, not as build authority.

### Source manifest

`packages/adapter-ledger/clear-signing-v0/manifest.json` — committed:

```json
{
  "aztec_packages_pin": "2770bcb82d40323060c2f9c71aaf293b640efbef",
  "aztec_standards_pin": "<sha at codegen-time>",
  "deployments_source_METADATA_ONLY": "../../nulo-2/packages/faucet/src/contracts/deployments.json (used at codegen-time for human cross-check ONLY; NOT a build dependency)",
  "registry": [
    { "slot": 0, "kind": "TOKEN",   "address": "0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5", "symbol": "USDC", "decimals": 6 },
    { "slot": 1, "kind": "TOKEN",   "address": "0x060e0d2735b8e7d39fabe8c02b46535b33a7d4e685fa7e31e833b2edfdc26224", "symbol": "ETH",  "decimals": 18 },
    { "slot": 2, "kind": "SPONSOR", "address": "0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257", "symbol": "FPC", "decimals": 0 },
    { "slot": 3, "kind": "EMPTY" },
    { "slot": 4, "kind": "EMPTY" }
  ],
  "verbs": [
    { "kind": "TOKEN", "signature": "transfer_private_to_public(AztecAddress,AztecAddress,u128,Field)", "is_public": false, "args": ["from","to","amount","_nonce"], "verb": "TRANSFER_PRIV_PUB" },
    { "kind": "TOKEN", "signature": "transfer_private_to_private(AztecAddress,AztecAddress,u128,Field)", "is_public": false, "args": ["from","to","amount","_nonce"], "verb": "TRANSFER_PRIV_PRIV" },
    { "kind": "TOKEN", "signature": "transfer_public_to_private(AztecAddress,AztecAddress,u128,Field)", "is_public": false, "args": ["from","to","amount","_nonce"], "verb": "TRANSFER_PUB_PRIV" },
    { "kind": "TOKEN", "signature": "transfer_public_to_public(AztecAddress,AztecAddress,u128,Field)",  "is_public": true,  "args": ["from","to","amount","_nonce"], "verb": "TRANSFER_PUB_PUB" },
    { "kind": "TOKEN", "signature": "mint_to_public(AztecAddress,u128)",                                 "is_public": true,  "args": ["to","amount"],                  "verb": "MINT_PUB" },
    { "kind": "TOKEN", "signature": "mint_to_private(AztecAddress,u128)",                                "is_public": false, "args": ["to","amount"],                  "verb": "MINT_PRIV" },
    { "kind": "SPONSOR","signature": "sponsor_unconditionally()",                                        "is_public": false, "args": [],                                "verb": "SPONSOR" }
  ]
}
```

Note: SponsoredFPC is included because every sponsored-fee tx (the faucet flow) merges `sponsor_unconditionally()` into `exec.calls` (per `nulo-2/packages/faucet/src/composables/useFaucetDrip.ts:62-72`). Without it in the registry, any sponsored tx is rejected. `[consolidated]`

**Dripper deliberately omitted** `[codex]`: "I would not make Dripper clear-signing a blocker for this milestone." Funding the Ledger account uses an EXTERNAL non-Ledger wallet, not Dripper-via-Ledger. Saves complexity; testnet acceptance is still meaningful.

### Codegen

`packages/adapter-ledger/scripts/gen-clear-signing-v0.ts`:
- reads `manifest.json`
- computes each verb's selector u32 from its literal signature (Aztec's selector algorithm) — does NOT scrape compiled artifacts
- emits two artifacts:
  - C: `ledger-app/src/clear_signing_v0/{registry,selectors}.gen.h` + matching `.c`
  - TS: `packages/adapter-ledger/src/clear_signing_v0/{registry,selectors}.generated.ts`
- both contain the same checksum header; CI re-runs the generator and fails on drift
- **Artifact cross-check (FAIL-CLOSED on shape mismatch)** `[codex final-review BLOCKER #2]`: CI extracts each verb's `selector + arg_count + visibility + existence` from the pinned `@defi-wonderland/aztec-standards` artifact and asserts they match the manifest. **CI fails if the checker cannot run OR if any shape mismatches**. Selector-only warning would have missed the SPONSOR `is_public` bug.
- Warning-only is reserved for "newer aztec-standards exists upstream than the pinned version" — purely informational.

### Strict-allowlist rejection rules `[codex]`

| Condition | Behavior |
|---|---|
| `target` not in registry (or matches an `EMPTY` slot) | reject `SW_REGISTRY_MISS` |
| `(kind, selector)` not in verb table | reject `SW_DECODER_MISS` |
| `args_count != verb.expected` | reject `SW_DECODER_DESYNC` |
| `flags.is_public != verb.is_public` | reject `SW_VISIBILITY_MISMATCH` |
| 4-arg transfer + `from != consumer` | reject `SW_DELEGATED_SPEND_UNSUPPORTED` `[codex]` |

New status words (all in the 6Fxx range):
- `SW_REGISTRY_MISS = 0x6F08`
- `SW_DECODER_MISS = 0x6F09`
- `SW_DECODER_DESYNC = 0x6F0A`
- `SW_VISIBILITY_MISMATCH = 0x6F0B`
- `SW_DELEGATED_SPEND_UNSUPPORTED = 0x6F0C`

No raw fallback. Users who want blind sign use legacy `INS_SIGN_OUTER_HASH` — explicit choice, separate flow.

## 5. UI design

`[consolidated]`: codex's structure (header + per-call decoded) + opus's mint-warning + dropping codex's "L4-style hex fallback for >3 calls" since strict allowlist makes the case unreachable.

**Header pairs (4):**
- Path
- Account (consumer hex, truncated)
- Chain (decimal + hex)
- Calls (count)

**Per-call pairs (one of these layouts based on verb):**

TRANSFER verbs:
```
Call X/N    "Transfer USDC pub→pub"
From        0xacc0…0111   (or "you" if from == consumer)
To          0x5678…9abc
Amount      "1.500000 USDC"
```

MINT verbs (with prepended warning pair):
```
Call X/N    "Mint USDC public"
⚠ MINTER    "Minting requires elevated role"
To          0x5678…9abc
Amount      "100.000000 USDC"
```

SPONSOR verb (PRIVATE call per Aztec — see `aztec-packages/yarn-project/aztec.js/src/fee/sponsored_fee_payment.ts:23`):
```
Call X/N    "Sponsor fee (private)"
Via         "Testnet SponsoredFPC (no value transferred)"
```

`outer_hash` pair stays at the end (defense in depth).

**Decimals formatting** `[consolidated]`: device-side fixed-point string conversion. No FP. No host symbols. No host decimals. Algorithm:
- whole_part = amount / 10^decimals
- frac_part = amount % 10^decimals
- format as `whole.frac` with trailing zeros trimmed (but always at least one digit after `.` — "1.0" not "1")
- locale-free (no thousands separator)
- max width verified against the worst case (u128_max ≈ 39 decimal digits + decimals_split = ~50 chars worst case for ETH)

**NBGL budget**: 4 + 5 × 4 + 1 = 25 pairs at worst case (5-call manifest, each TRANSFER with 4 sub-pairs). Below NBGL's pagination ceiling. Speculos auto-confirm walker handles arbitrary page counts via event-text detection — already wired.

**Copy**: "INTERNAL build" subtitle goes away. v0 subtitle: "Verified on-device against pinned token registry." A successful decode is no longer an apology.

## 6. TS adapter changes

`[consolidated]`:

- `packages/adapter-ledger/src/apdu.ts`: bump `MANIFEST_VERSION` to 2; add `L4_MAX_ARGS = 4`; widen `AzCall` to include `argsCount: number` and `args: readonly Uint8Array[]`; add new SW codes; extend `encodeAppendCallBody` for new layout.
- `packages/adapter-ledger/src/l4-manifest.ts`: remove the hard-reject at `:60`; implement the public/private split exactly matching the device. Empty-args private → `Fr.ZERO`. Adapter does **host preflight** against the same generated tables; fails fast on unsupported intents (better UX than waiting for device rejection).
- `packages/adapter-ledger/src/clear_signing_v0/preflight.ts`: pre-flight check called by `createAuthWitFromIntent` before sending APDUs. Same rules as the device decoder.
- `packages/adapter-ledger/src/auth-witness-provider.ts:84`: drop the existing branching; route through the new preflight.
- `packages/core/src/intent.ts`: add `isPublic` resolution helper, ensure `StructuredFunctionCall.args` is plumbed through correctly (the @aztec/entrypoints encoder already produces fields-per-arg; we just need to forward).
- Tests:
  - `clear_signing_v0/parity.test.ts` — golden vectors for each verb × token, both branches of args_hash, empty-args edge case
  - `clear_signing_v0/preflight.test.ts` — every rejection rule has a positive + negative test
  - `clear_signing_v0/decoder-fuzz.test.ts` `[opus]` — random Fr inputs into the decoder; assert "always either matches a verb OR rejects, never crashes"

## 7. Alpha-testnet end-to-end test

`[consolidated]`: opus's sandbox-first sequencing + codex's "decisive tx must exercise the PRIVATE path".

### M5.E0 — Speculos + Aztec sandbox (local)

```
- Spin up `aztec start --sandbox` on ephemeral ports (per the parallel-safe E2E convention)
- Boot Speculos with the clear-signing build
- Deploy aztec-standards Token (USDC config) + SponsoredFPC to sandbox
- Get device pubkey via GET_PUBLIC_KEY
- wallet.createAccount({ secret, contract: LedgerEcdsaKAccountContract, salt })
- Deploy the Ledger-backed account via SponsoredFPC
- (External hot wallet drips USDC into the Ledger account's private balance)
- Sign + send `transfer_private_to_private(devAccount, alice, 100_000n, nonce)` from the Ledger account
- Assert `mined` + post-state via balance_of_private
```

This validates the entire pipeline locally before touching public testnet.

### M5.E1 — alpha-testnet (gated)

Same script with:
- RPC → `https://rpc.testnet.aztec-labs.com`
- Registry instances → USDC `0x2af7…47c5`, ETH `0x060e…6224`, SponsoredFPC `<alpha-testnet addr>` (resolved at test time, asserted ≠ ZERO)
- Funding source → external funded wallet (NOT Ledger-signed)
- Decisive tx → `transfer_private_to_public` USDC

Test gated by `AZTEC_TESTNET_E2E=1` env var. CI defaults to sandbox only.

Receipt verification + on-chain balance checks. Capture tx hash and link in lessons file.

### Failure modes documented `[consolidated, all three]`

- **SponsoredFPC unavailable on testnet**: pre-flight `getContractInstance(SponsoredFPC.address)`; bail with clear error if absent. Block M5.E1 on this resolving.
- **Testnet rate limits**: exponential backoff on 429/network errors; never retry on protocol-level rejections.
- **Testnet down**: skip with `describe.skipIf(!process.env.AZTEC_TESTNET_E2E)`.
- **Chain/version mismatch**: assert chain `11155111` + rollup `4127419662` at test start.
- **First-deploy funding**: SponsoredFPC pays for EcdsaKAccount deploy too (Aztec supports sponsored account deploy via `deploy_account_method.ts:138` with `from === NO_FROM`). External wallet is needed only for sourcing private USDC into the new account post-deploy.
- **Private note sync lag**: wait + retry `balance_of_private` after funding.
- **Speculos APDU latency**: per-APDU timeout ≥ 2s (default 100ms is too tight for fault-hardened paths).
- **Sandbox version drift**: pin Aztec sandbox version in the harness; mismatch surfaces as deserialization errors.

## 8. Security & adversarial considerations

`[consolidated — all attacks defended explicitly]`:

| Attack | Defense |
|---|---|
| Host lies about args contents | APPEND_CALL recomputes args_hash from raw args; rejects before user sees screen. Three-pass finalize verifies stored raw args, not cached hash. |
| Host claims "USDC" for non-USDC address | Registry is address-keyed in `.rodata`. Host never injects symbol/decimals. Unknown address → strict reject (no "Unknown USDC" mode). |
| Host swaps decimals (1.0 ↔ 1M) | Decimals from registry, never host. Fixed-point formatter is data-only — no host-controllable knob. |
| Host strips raw args (`args_count = 0` for a 4-arg call) | args_hash recompute fails. Strict allowlist refuses to sign without raw args for known verbs. |
| Host sends mismatched (contract, selector, args) | Decoder keyed on `(kind, selector)`; arg_count check; visibility check. USDC+Dripper-selector → reject. |
| Glitch between args_hash recompute and parity gate | Per-call double-compute + cross-compare. Three-pass finalize re-derives from raw args. Sign step uses local recheck (L4 carry-forward). |
| Supply-chain compromise of aztec-standards | Local manifest is reviewed authority; pinned package is drift detector. CI fails on local manifest drift; warns on aztec-standards drift. |
| Registry-address squatting after testnet redeploy | Operational mitigation: rebuild + reflash on redeploy. Document in firmware README. Residual v0 risk. |
| Delegated-spend phishing (4-arg transfer with `from != consumer`) | Device rejects. PoC UI can't honestly explain delegated spend. |
| Cross-call confusion ("approve drip" + "transfer 1M to attacker") | "Call X/N" prefix on every pair (already L4). v1 should add per-call approve/reject; v0 doesn't. |
| Decoder bugs causing label corruption | Decoder runs AFTER parity gate; cannot affect signed bytes. Fuzz-tested via `decoder-fuzz.test.ts`. |
| Side channels in amount formatter | Inputs are public; not a concern. |
| Host/device version skew | Same generator emits both tables; checksums verified; CI fails on drift. App also runs an at-startup sanity equality check. |
| Amount-formatter rendering bugs | Test max u128, zero, sub-unit, long ETH decimals aggressively. |

Audit bar: same as L4 (public-data only, no constant-time required, parity testable). NO external audit needed for v0.

## 9. Phasing

```
M5.0  Manifest freeze + codegen pipeline           ~1.5d
      - Write manifest.json (committed)
      - gen-clear-signing-v0.ts emits both .gen.h + .generated.ts
      - CI drift check
      - Aztec-standards selector cross-check (warning-only)
      - Resolve SponsoredFPC alpha-testnet address (block M5.E1)

M5.1  Wire format v2 + device args parser           ~1d
      - L4_MAX_ARGS=4, MANIFEST_VERSION=2, new SW codes
      - APPEND_CALL parser w/ canonical-Fr per arg
      - l4_call_t extended (args, args_count); l4_session_t too

M5.2  Device args_hash recompute + strict gates     ~1.5d
      - clear_signing_v0/args_hash.{h,c}: public + private + empty-args paths
      - APPEND_CALL: registry + decoder lookup; all strict-allowlist rejects
      - FINALIZE: re-derive args_hash from stored raw args on every pass

M5.3  Device decoder + semantic UI                  ~1.5d
      - clear_signing_v0/{registry,selectors,decoder}.{h,c}
      - verified_calls_ui.c rewrite: per-verb UI templates
      - Decimal formatter w/ edge-case tests
      - MINT warning pair

M5.4  TS adapter changes                             ~1d
      - apdu.ts: v2 wire, new SW codes
      - l4-manifest.ts: public/private split, args propagation
      - auth-witness-provider.ts: route via preflight
      - clear_signing_v0/preflight.ts
      - All adapter unit + parity tests green

M5.5  Sandbox e2e                                    ~1.5d
      - Local aztec-sandbox + Speculos harness
      - Ledger-backed EcdsaKAccount via sponsor
      - External-wallet funding of Ledger account's USDC
      - Sign + send transfer_private_to_private
      - Assert mined + balance

M5.6  alpha-testnet e2e (gated)                      ~1d
      - Same harness, alpha-testnet RPC
      - Real USDC + SponsoredFPC
      - Capture tx hash; link in lessons

M5.7  Codex final review + fixes                     ~1d

Total ~12-14 working days (codex MINOR: M5.1+M5.2 are one chunk; M5.5+M5.6 are 3-4d combined once proving, note sync, and helper-wallet funding are real).
```

## 10. Success criteria

1. A real alpha-testnet transaction signed by Speculos lands `mined`, with the device having shown "Transfer X USDC priv→pub" (or similar) — NOT raw hex.
2. Strict-allowlist: device rejects with the appropriate SW for every adversarial test in §8.
3. Private-call `fromArgs` path: 100% parity tests pass; empty-args edge handled.
4. Decimal formatter: max u128, zero, sub-unit values, ETH 18-decimal all render correctly.
5. RAM budget holds on Nano S+ (linker doesn't error).
6. Both nanosp + nanox device builds compile clean.
7. Codex post-impl review: zero BLOCKER / MAJOR findings (after iteration).
8. Lessons doc captures gotchas (one will be SponsoredFPC integration, another the private-path FUNCTION_ARGS separator).

## 11. Deliverables

- Plan docs: `plan-final.md` (this file), `eli5.html` (companion)
- Device source: `ledger-app/src/clear_signing_v0/{registry,selectors,decoder,args_hash,format}.{h,c}` + `.gen.h` for codegen output
- Modified device source: `wire.h`, `session.{h,c}`, `append_call.{c}`, `finalize_and_sign.c`, `parity.c`, `verified_calls_ui.c`, `sw.h`
- New TS source: `packages/adapter-ledger/src/clear_signing_v0/{registry,selectors,preflight,format}.{ts}` + `.generated.ts`
- Codegen: `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts`
- Manifest: `packages/adapter-ledger/clear-signing-v0/manifest.json`
- Tests: parity, preflight, decoder-fuzz, sandbox-e2e, testnet-e2e
- Lessons: `implementations-plan/clear-signing-v0/lessons/phase-N.md`
- Updated `implementations-plan/index.md`

## 12. Open questions

`[carried from drafts]`:

1. **SponsoredFPC alpha-testnet address** — RESOLVED: `0x254082b62f9108d044b8998f212bb145619d91bfcd049461d74babb840181257` (deterministic from `SPONSORED_FPC_SALT=0`, verified via `getContractInstanceFromInstantiationParams`). Same address on mainnet, testnet, sandbox.
2. **`secret`/`salt` persistence for repeatable testnet runs**: RESOLVED — use fixed test fixtures, document recovery from the seed.
3. **First-deploy funding strategy**: RESOLVED — SponsoredFPC covers it. External wallet only needed for sourcing private USDC post-deploy.
4. **Aztec sandbox version pinning**: pin `@aztec/aztec.js` and `aztec` CLI in the harness; fail on mismatch.
5. **`from == consumer` invariant**: KEEP EXACTLY AS WRITTEN for v0 `[codex final-review]`.
6. **Whether to keep manifest v1 path for back-compat**: RESOLVED — **NO v1 compatibility** `[codex final-review MAJOR #2]`. Same repo, same host, same firmware line. v1 → v2 is a hard cut. Device rejects v1 manifests; adapter emits v2 only.

## 13. Status

```
[✓] 0. Clarifying questions (FT-only, hardcoded registry, defer L5, testnet=priv-transfer)
[✓] 1. Parallel plans drafted (main + codex + opus)
[✓] 2. Consolidated → plan-final.md (this file)
[▶] 3. Final codex review of consolidated plan
[ ] 4. (Auto-approval per user AFK note)
[ ] 5. Implementation (M5.0..M5.7)
[ ] 6. Post-impl codex review
[ ] 7. Fix loop
```

## 14. Decisions log (who-said-what)

| Decision | Source | Rationale |
|---|---|---|
| Strict allowlist (no raw fallback) | codex | v0 thesis: device is FT verifier, not hash cop. Blind sign via legacy INS. |
| `from == consumer` enforced for transfers | codex | Removes delegated-spend phishing surface PoC UI can't explain |
| MANIFEST_VERSION 1→2 bump | all three | Wire format change deserves version break |
| `L4_MAX_ARGS = 4` | all three | Structural minimum for FT verb set |
| Two-stage parity (append + finalize) | opus, codex | Closes glitch window between append and finalize |
| Keep `args_hash` on wire | opus, main | Audit-surface preservation; future "long args" extension |
| Local manifest as truth, aztec-standards as drift detector | codex | Supply-chain hardening; reviewed source-of-truth |
| Sandbox-first then testnet | opus | Clean separation of failure modes |
| Decisive testnet tx is PRIVATE transfer | codex | Otherwise we haven't proven the new work |
| Drop Dripper from registry (fund externally) | codex | Saves complexity; testnet acceptance still meaningful |
| Include SponsoredFPC in registry | consolidated | Required because sponsor call is in every sponsored-tx authwit |
| MINT shows yellow warning | opus | Mint is dangerous; warn the user |
| Decoder runs AFTER parity gate (can't affect signed bytes) | opus | Defense in depth + audit-friendliness |
| SPONSOR `is_public = false` (PRIVATE call) | codex final-review BLOCKER #1 | Aztec's `SponsoredFeePaymentMethod` builds it as a `private` entrypoint; treating it as public would compute the wrong args_hash on every sponsored tx |
| Artifact cross-check is fail-closed on shape mismatch | codex final-review BLOCKER #2 | Selector-only warning would have missed the SPONSOR visibility bug |
| Trusted-session invariant: finalize never reads host-claimed args_hash | codex final-review MAJOR #4 | Closes the trusted-state hole between host claim and device-stored value |
| No manifest v1 back-compat | codex final-review MAJOR #2 | Same repo/host/firmware line; extra parser surface buys nothing |
| Sponsored EcdsaKAccount deploy (no external ETH wallet for gas) | codex final-review MAJOR #3 | Aztec's `deploy_account_method.ts:138` supports `from === NO_FROM` with SponsoredFPC |
