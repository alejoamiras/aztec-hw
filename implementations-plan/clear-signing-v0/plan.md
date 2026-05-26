# Clear-Signing v0 — deep plan

## Pinned source-of-truth

- Aztec packages: `2770bcb82d40323060c2f9c71aaf293b640efbef` (`/Users/alejoamiras/Projects/aztec-packages`)
- aztec-standards: pin TBD at codegen time (`/Users/alejoamiras/Projects/Ecosystem/aztec-standards`)
- Faucet (success-criterion deployment target): `/Users/alejoamiras/Projects/nulo/nulo-2/packages/faucet`
- alpha-testnet RPC: `https://rpc.testnet.aztec-labs.com`

## 1. Problem statement

The L4 arc gives us a Ledger app that signs an Aztec auth witness only after the
device independently recomputes `outer_hash`. **It does NOT show the user what
they're authorizing.** Today the screen renders raw hex: `Target 0x2af7…47c5`,
`Selector 0xa9059cbb`, `Mode PUBLIC`. Power-users with selector tables can
verify; nobody else can. Practical attack surface remaining:

- malicious host claims "1.0 USDC" in its UI but actually transfers 1B USDC →
  device parity passes (host is consistent with itself) → user approves the
  raw-hex screen without realizing.
- malicious host swaps the recipient address → device shows a hex blob; user
  has no chance.

Clear-Signing v0 closes that gap for the most-used Aztec contract family
(aztec-standards FT) by streaming raw args to the device, recomputing
`args_hash` from those args, and rendering decoded semantics
("Transfer 1.0 USDC to 0xabcd…ef12") instead of selectors-and-prayers.

**Non-goal**: arbitrary dApp clear-signing. Aztec lacks a canonical contract
registry; we're not going to fake one. We support FT (per user's confirmed
scope) and degrade gracefully to today's raw-hex display for anything else.

## 2. Scope

### In

- Aztec-standards Fungible Token decoder for these selectors (6 total):
  - `transfer_private_to_public(from, to, amount, _nonce)`
  - `transfer_private_to_private(from, to, amount, _nonce)`
  - `transfer_public_to_private(from, to, amount, _nonce)`
  - `transfer_public_to_public(from, to, amount, _nonce)`
  - `mint_to_public(to, amount)`
  - `mint_to_private(to, amount)`
- APDU wire format extension: stream **raw args** alongside `args_hash`.
  Device recomputes args_hash from raw args; on mismatch → reject. **This is
  the load-bearing security gain** — the host can no longer lie about the
  args contents.
- Private-call `fromArgs` args_hash construction (currently hard-rejected at
  adapter): `poseidon2HashWithSeparator(args, FUNCTION_ARGS=3576554347)`,
  with the `len==0 → Fr.ZERO` edge case from `hash.ts:computeVarArgsHash`.
- Build-time hardcoded contract registry (5 slots, user-chosen layout):
  ```
  USDC      0x2af7c3bd…47c5  decimals=6
  ETH       0x060e0d27…6224  decimals=18
  Dripper   0x172684be…7070  (faucet helper)
  reserved  (zeroed)
  reserved  (zeroed)
  ```
  Adding a token requires firmware rebuild + reflash. Symbol + decimals come
  from registry, **never the host**.
- NBGL UI: per-call decoded display when the call's `target_address` is in
  the registry AND its selector is known. Otherwise → fall back to today's
  hex display.
- End-to-end alpha-testnet acceptance test: device-signed `drip_to_public`
  (or `transfer_public_to_public`) lands on testnet, sponsored by faucet's FPC.

### Out

- NFT decoding (user-confirmed: defer)
- Generic dApp / arbitrary ABI decoding (no canonical registry)
- Signed runtime manifest (user-confirmed: hardcoded for v0)
- Schnorr-Grumpkin (user-confirmed: defer until after this arc ships)
- Ledger Live submission track

## 3. Wire-format extension

`APPEND_CALL` body (currently 97 bytes) grows by `1 + args_count*32`:

```
APPEND_CALL body (variable length, ≤ 226 bytes):
  uint8_t args_hash[32]               // canonical Fr, host-claimed
  uint8_t function_selector[32]       // canonical Fr, high 28B must be zero
  uint8_t target_address[32]          // canonical Fr
  uint8_t flags                       // bit0..2 (unchanged from L4)
  uint8_t args_count                  // 0..L4_MAX_ARGS (=4)
  uint8_t args[args_count][32]        // raw Fr args, canonical
```

**`L4_MAX_ARGS = 4`** is sized to (a) cover every aztec-standards FT function
(max-args function is the 4-arg transfer family), (b) fit a full APPEND_CALL
in the standard 255-byte APDU window without needing chunking or extended-
length APDUs.

Why not extended-length APDUs (3-byte Lc)? Speculos supports them, but real
Ledger devices over USB-HID frame at 64 bytes anyway and the SDK has known
sharp edges on the >255 path. Keeping bodies ≤ 255 means zero protocol
surprises at hardware time.

Why drop chunking? It explodes the state machine (per-call sub-state for
"received K of N args") and adds new failure modes. 4 args is plenty for FT;
NFT and complex contracts can earn chunking when they come.

## 4. Device-side args_hash recompute (the security core)

In `src/l4/args_hash.{h,c}`:

```c
/* Compute args_hash from raw args. `is_public` selects the algorithm:
 *
 *   PUBLIC:  poseidon2HashWithSeparator([selector, ...args], PUBLIC_CALLDATA)
 *            (matches `hash.ts:computeCalldataHash`)
 *
 *   PRIVATE: poseidon2HashWithSeparator(args, FUNCTION_ARGS)
 *            with empty-args edge case → Fr.ZERO
 *            (matches `hash.ts:computeVarArgsHash`)
 *
 * Returns 0 on success; -1 if any arg fails canonicality (>=p).
 */
int az_compute_args_hash(
    const uint8_t selector[32],
    const uint8_t (*args)[32], size_t args_count,
    bool is_public,
    uint8_t out_args_hash[32]);
```

Wired into `handler/append_call.c`:

```
APPEND_CALL handler (mutated):
  1. parse existing fields + new args_count + args
  2. canonicality-check each arg
  3. compute_args_hash(...) → device_args_hash
  4. ct_memcmp32(device_args_hash, host_claimed_args_hash)
     → on mismatch: l4_session_reset() + SW_HASH_MISMATCH
  5. store call (now with raw args) in G_l4_session.calls[i]
```

This closes the gap codex flagged in the L4 final review: with raw args
streamed and the device validating, a malicious host cannot substitute
different args than the in-circuit verifier will see.

`l4_session_t.l4_call_t` adds:
```c
typedef struct {
    uint8_t args_hash[32];        // unchanged (carried for UI/audit)
    uint8_t function_selector[32];
    uint8_t target_address[32];
    uint8_t flags;
    uint8_t args_count;           // NEW
    uint8_t args[4][32];          // NEW (raw Fr)
} l4_call_t;
```

RAM cost: +132 bytes per call × 5 = +660B. Total session struct still <1.6KB.

## 5. Contract registry

`src/l4/registry.{h,c}` — compiled-in 5-slot table:

```c
typedef enum {
    AZ_KIND_UNKNOWN = 0,
    AZ_KIND_FT = 1,        /* aztec-standards Fungible */
    AZ_KIND_DRIPPER = 2,   /* faucet Dripper */
} az_contract_kind_e;

typedef struct {
    uint8_t address[32];     /* canonical AztecAddress (BE Fr) */
    char    symbol[8];       /* null-terminated, max 7 chars */
    uint8_t decimals;
    uint8_t kind;            /* az_contract_kind_e */
} az_contract_entry_t;

extern const az_contract_entry_t AZ_REGISTRY[5];

/* Returns matching entry or NULL if address not in registry. */
const az_contract_entry_t *az_registry_lookup(const uint8_t target[32]);
```

Populated for v0:
```
[0] USDC    0x2af7c3bd…47c5   "USDC"   6   FT
[1] ETH     0x060e0d27…6224   "ETH"   18   FT
[2] Dripper 0x172684be…7070   "DRIP"   0   DRIPPER
[3] reserved (zeroed)
[4] reserved (zeroed)
```

Generated by a TS script that reads `nulo-2/packages/faucet/src/contracts/deployments.json`
(and prints a deterministic C header). Reserved slots are zeroed bytes so
`az_registry_lookup` matching `0x000…` does NOT silently match the reserved
slots (we exclude `kind==UNKNOWN` from match).

**Why include the Dripper**: the faucet's typical flow is one call to
`drip_to_public(token_address, amount)`, which is on the Dripper. Recognizing
that contract lets us render "Drip 1.0 USDC into public balance" instead of
"Call to 0x172684…7070".

## 6. Selector decoder

`src/l4/decoder.{h,c}` — compile-time table of known selectors per `kind`:

```c
typedef enum {
    AZ_FN_FT_TRANSFER_PRIV_TO_PUB = 1,
    AZ_FN_FT_TRANSFER_PRIV_TO_PRIV,
    AZ_FN_FT_TRANSFER_PUB_TO_PRIV,
    AZ_FN_FT_TRANSFER_PUB_TO_PUB,
    AZ_FN_FT_MINT_TO_PUBLIC,
    AZ_FN_FT_MINT_TO_PRIVATE,
    AZ_FN_DRIPPER_DRIP_TO_PUBLIC,
    AZ_FN_DRIPPER_DRIP_TO_PRIVATE,
} az_function_e;

typedef struct {
    az_function_e id;
    const char   *display_name;     /* "Transfer", "Mint", "Drip" */
    uint8_t       arg_count;        /* expected args length */
    /* arg-position mapping for UI: which arg is "to", "amount", etc. */
    uint8_t       to_arg_idx;       /* 0xFF if not present */
    uint8_t       from_arg_idx;
    uint8_t       amount_arg_idx;
} az_function_entry_t;

const az_function_entry_t *az_decoder_lookup(
    az_contract_kind_e kind,
    uint32_t selector_u32);
```

Selectors are computed at codegen-time from aztec-standards source (the
selector_u32 of `transfer_public_to_public` etc. — extracted from the
compiled contract artifact's `function_selector`).

Codegen script: `packages/adapter-ledger/scripts/gen-fn-selectors.ts`.
Reads `node_modules/@defi-wonderland/aztec-standards/dist/src/artifacts/*.json`,
emits the table as a C header, with the aztec-standards commit/version pinned
in the file's header comment.

## 7. Private-call `fromArgs` (unblocking what L4 hard-rejected)

In `packages/adapter-ledger/src/l4-manifest.ts`, replace the current
hard-reject branch with:

```ts
const argsFields: AztecFr[] = [...call.args];
const argsHash = isPublic
  ? await poseidon2HashWithSeparator(
      [call.selector, ...call.args], PUBLIC_CALLDATA)
  : argsFields.length === 0
    ? Fr.ZERO  /* hash.ts:computeVarArgsHash empty-args edge case */
    : await poseidon2HashWithSeparator(argsFields, FUNCTION_ARGS);
```

Device-side mirror in `src/l4/args_hash.c` handles the same empty-args case.
Golden vectors must cover both branches.

## 8. NBGL UI redesign

Per call, when registry+decoder match the call:

```
Call 1/1 — Transfer
  From:   0xacc0…0111
  To:     0xabcd…ef12
  Amount: 1.0 USDC
  Mode:   PRIVATE  (the call's actual flag bits, not the function name)
```

5 tag-value pairs per call when fully decoded:
1. Call X/N header ("Transfer / Mint / Drip")
2. From (truncated address, or omitted if not in the function signature)
3. To (truncated address)
4. Amount (with token symbol + decimals applied)
5. Mode (PUBLIC / PRIVATE / STATIC / HIDE_SENDER glyphs — independent of function name)

When registry MISSES (target not hardcoded) → fall back to today's L4 display
(target hex, selector hex, mode). A subtitle warning attaches:
"Unknown contract — verify the address externally."

When registry HITS but decoder MISSES (known contract, unknown function) →
"Function: 0xa9059cbb (unrecognized)" + raw args dump.

Pair-capacity budget: 5 calls × 5 = 25 + 4 header (Path, Account, Chain, Calls) +
outer_hash = 30 pairs. NBGL handles paging; on Nano S+ we're well under
NBGL's hard cap (the L4 implementation used 20 cap; bumping to 32 is safe).

**Decimals formatting** is host-untrusted; the device computes it from the
registry's hardcoded decimals using the raw `amount` arg (a u128 as a single
Fr). Algorithm: split into whole + frac, trim trailing zeros from frac, never
fewer than 1 decimal place ("1.0 USDC", not "1 USDC").

## 9. TS adapter changes

### `packages/adapter-ledger/src/l4-manifest.ts`

- `encodeRealCall` returns the wire-shaped `AzCall` now including `args` (raw).
- `encodeAppendCallBody` emits the new wire layout (header + args_count + args bytes).
- Drop the `isPublic === false` hard-reject; implement the `FUNCTION_ARGS` path.
- Add the `FUNCTION_ARGS = 3576554347` constant (pinned).

### `packages/adapter-ledger/src/decoder.ts` (new)

Host-side mirror of the device decoder. Used for:
- Debug logging in the adapter ("about to stream Transfer 1.0 USDC")
- Unit tests that verify host + device decode the same way
- Optional pre-flight check before streaming (catch user errors locally)

### `packages/adapter-ledger/src/registry.ts` (new)

TS copy of the same 5 entries (single source-of-truth would be ideal — a
JSON file consumed by both gen scripts). For v0: hand-synced + a unit test
that asserts host vs device tables byte-equal.

### `packages/adapter-ledger/scripts/gen-fn-selectors.ts` (new)

Reads aztec-standards artifacts, emits both C + TS selector tables. Pinned
to aztec-standards version in `package.json`. Re-run on upgrade.

### `packages/adapter-ledger/scripts/gen-registry.ts` (new)

Reads `nulo-2/packages/faucet/src/contracts/deployments.json` and emits the
C + TS registry. Pinned to a specific deployments commit (or just regen
whenever the user redeploys).

## 10. Alpha-testnet end-to-end test

The user's success criterion: **a device-signed transaction lands on alpha-testnet**.

`packages/adapter-ledger/src/testnet-e2e.test.ts` (gated by `ALPHA_TESTNET=1`):

1. Boot Speculos with the clear-signing build.
2. Derive device pubkey via `GET_PUBLIC_KEY`.
3. Connect to alpha-testnet via `@aztec/aztec.js` PXE.
4. Deploy an `EcdsaKAccount` with the device pubkey as constructor arg,
   paid by SponsoredFPC. (Reuse faucet's FPC integration patterns from
   `useFaucetDrip.ts` / `getSponsoredFpcInstance`.)
5. Drip some USDC to the new account via the Dripper (also sponsored).
6. Build a `transfer_public_to_public` CallIntent: account → some random
   recipient, 0.1 USDC.
7. Stream the manifest to the device (BEGIN + APPEND with raw args + FINALIZE).
   Auto-confirm via the page-aware Speculos walker.
8. The Aztec entrypoint hands the resulting AuthWitness into the tx.
9. Submit the tx with `wallet.sendTx(...)`.
10. Assert receipt is `mined` within a timeout.

If alpha-testnet is rate-limiting or down, the test skips with a clear log.
If Speculos isn't reachable, the test skips. Local-only opt-in via env var.

**This is the load-bearing acceptance test** — it proves the device's signature
is accepted by the in-circuit verifier, not just by barretenberg-in-TS.

## 11. Security & Adversarial Considerations

### Threat model

What the host can attempt:

| Attack | Mitigation |
|---|---|
| Lie about args contents | Device recomputes args_hash from raw args; binds to args_hash already bound to outer_hash. **No room left for the host to lie about args**. |
| Lie about contract identity ("this is USDC") | Symbol + decimals come from the device's **hardcoded** registry, NOT host metadata. A non-USDC address never gets the "USDC" symbol. |
| Substitute decimals (1.0 → 1M) | Decimals are registry-hardcoded too; host can't influence. |
| Strip raw args, force fallback display | `args_count == 0` is treated as a real claim (private-call zero-args = `Fr.ZERO`); the args_hash recompute either matches or rejects. A malicious 0-count when the actual function expects 4 args would FAIL args_hash parity. |
| Mismatched contract + selector | Decoder lookup is keyed on `(kind, selector_u32)`. A USDC address paired with a Dripper selector → unknown function → fall back to hex display (and warning). |
| Glitch between args_hash recompute and the comparison | Same fault-hardening pattern as L4's outer_hash: triple recompute + cross-compare. |
| Glitch between UI render and sign | Sign target is the JUST-VALIDATED local recheck_outer (codex L4 BLOCKER fix carries forward). |

What the host **can still** do (residual risk):

- Lie about *which* known contract is being called by routing to an unknown
  address that happens to look similar. Mitigation: device shows the full
  target address in the registry-hit path too (or "Unknown contract" warning
  if registry misses).
- Send a legitimate USDC call but with weird flags (static when user expects
  non-static). Mitigation: Mode line shows the real flag bits.
- Provide a malicious recipient that's a contract that ratholes funds.
  Aztec-level account-abstraction problem, out of scope for the device.

### Supply chain

- aztec-standards: pinned via the npm dep's version. Selector table regen
  script captures the version in its output header. Bumping aztec-standards
  triggers a rebuild + golden-vector resync.
- Registry: deployments are pinned via the faucet's `deployments.json`. If
  the faucet ever redeploys (new addresses), regen + reflash.
- Aztec packages (Poseidon2 + domain separators): pinned at `2770bcb…`.
  All from-Aztec constants asserted at runtime against `@aztec/constants`
  exports so a future bump fails loudly at adapter import.

### Cryptography

- args_hash math reuses the L4.1 Poseidon2 oracle (host-parity 14/14 vs
  barretenberg). No new crypto primitives.
- Domain separator drift: every new separator (`FUNCTION_ARGS = 3576554347`)
  added to a TS constant and asserted equal to `@aztec/constants` at startup.

### Least privilege

- The registry is read-only. No host API can mutate it. Adding a token =
  firmware rebuild.
- No new BIP-32 derivation paths. Same `m/44'/AZTEC_COIN_TYPE'/account'/0/0`
  as L2/L4.
- Sign target stays sha256(outer_hash). Curve stays K1. No L5 crypto bleeds
  into this arc.

### Audit bar

This arc does **not** require external audit:
- Public-data only (args, addresses, selectors — never the signing key).
- No side-channel constraints on field arithmetic.
- Same trust model as L4 (codex parity review + Aztec verifier acceptance).

L5 (Schnorr-Grumpkin) is when external audit lands. Clear-signing is parity-
testable end-to-end.

## 12. Phasing

```
M5.0  Spec freeze + golden vectors        ~1d
      - Pin aztec-standards version
      - Extract 6 FT selectors (codegen output committed)
      - Golden vectors for args_hash (PUBLIC + PRIVATE paths)
      - Golden vectors for one full transfer manifest (host-computed outer_hash)

M5.1  Wire-format extension                ~1d
      - L4_MAX_ARGS=4 in wire.h
      - APPEND_CALL body parser + canonicality check
      - Update l4_call_t struct + session reset coverage
      - Host adapter: encodeAppendCallBody emits new layout

M5.2  Device args_hash recompute            ~1.5d
      - src/l4/args_hash.{h,c}: PUBLIC + PRIVATE paths
      - Hook into APPEND_CALL handler with parity gate
      - Triple-recompute extension (mirror L4 fault hardening)
      - Host parity test (golden vectors from M5.0)

M5.3  Registry + decoder                    ~1.5d
      - src/l4/registry.{h,c} populated from faucet deployments
      - src/l4/decoder.{h,c} keyed on (kind, selector)
      - TS mirrors + cross-table parity test

M5.4  NBGL UI redesign                      ~1.5d
      - Per-call decoded rendering with registry+decoder lookups
      - Fallback paths (unknown contract / unknown function)
      - Decimals formatting helper (device-side, registry-driven)
      - Bump pair capacity to 32
      - Update Speculos auto-confirm if page count changes

M5.5  Private-call fromArgs path            ~0.5d
      - Adapter: drop hard-reject, implement FUNCTION_ARGS branch
      - Device: handled by M5.2 (same args_hash module covers both)
      - Tests: at least one private-call golden vector + integration test

M5.6  Alpha-testnet acceptance              ~2d
      - Deploy EcdsaKAccount + drip USDC via faucet's FPC
      - Build + stream a transfer_public_to_public manifest
      - Submit, wait for inclusion, assert receipt
      - Document the env-var-gated test
      - Reusable script for re-running the demo

M5.7  Codex review + fixes                   ~1d
      - Send the consolidated diff to codex xhigh
      - Apply BLOCKER/MAJOR fixes; document MINORs

Total ~10 working days.
```

## 13. Open questions

1. **`amount` u128 encoding**: confirmed via `encoder.ts:typeSize` that
   integer kinds take 1 Fr slot. But the Noir side is `u128 amount`. We
   need to confirm Aztec's TS encoder packs u128 into a SINGLE Fr (vs.
   serializing as `lo, hi` pair) — verify at M5.0 against a real
   `Contract.at(USDC, ...).methods.transfer_public_to_public(...)` call.
2. **Selector field encoding**: `function_selector` on-wire is 32 BE bytes
   with high 28 zero (we enforce this in L4). Need to confirm the selector
   u32 is exactly `keccak256(function_signature)[0..4]` per Aztec convention
   (or whatever Aztec uses — they may have moved off keccak). Check at M5.0
   against the aztec-standards artifact.
3. **Sponsored FPC adds extra calls**: from the faucet's `useFaucetDrip`,
   the SponsoredFeePaymentMethod merges `sponsor_unconditionally()` into
   `exec.calls`. So a "single drip" manifest has 2 calls: drip + sponsor.
   Our L4_MAX_CALLS=5 holds, but our UI/decoder needs to handle the sponsor
   call (it'll target the SponsoredFPC contract, which we should add as a
   6th registry slot — or up the registry size).
4. **EcdsaKAccount deployment on alpha-testnet**: confirm `@aztec/accounts`
   ships the right artifact + that `wallet.deploy()` path works against the
   public testnet PXE. May need to use a specific `EcdsaKAccountManager` /
   `AccountWalletWithSecretKey` factory pattern.
5. **alpha-testnet stability**: if the testnet is flaky/down during dev,
   we want a local sandbox fallback. The faucet supports `local-network`
   via env — we mirror that.
6. **Empty args + private call**: `computeVarArgsHash([])` returns
   `Fr.ZERO` literally (not the hash of empty). The device must mirror
   this short-circuit exactly. Captured in M5.0 vector.
7. **Aztec entrypoint may add an extra "fee payment" call**: separately
   from sponsor merge. Need to confirm L4_MAX_CALLS=5 covers the worst-
   case manifest the SDK builds (drip + sponsor = 2; transfer + sponsor =
   2; transfer with 3 sub-calls + sponsor = 4; tight but OK).
8. **Registry collision**: what if the USDC contract gets undeployed and
   the same address is squatted by an attacker on a future redeploy? On
   testnet, this is reasonably possible. For v0 we accept the risk
   (rebuild fixes it); for production we'd want a kill-switch on the
   registry (e.g., per-network registries gated by chain_id).

## 14. Success criteria

The arc is done when:

1. All 6 FT selectors render decoded on Speculos for both nanosp + nanox.
2. Private-call `fromArgs` round-trips for at least one golden vector and
   one Speculos integration test.
3. The host parity sweep (extended from L4.1 with args-recompute vectors)
   stays at 100% green.
4. Codex review (xhigh) returns no BLOCKER / MAJOR findings (after
   iteration).
5. A real `transfer_public_to_public` USDC transaction signed by Speculos
   lands on alpha-testnet (or local-network, if testnet is flaky), with
   receipt verified.
6. Demo script `apps/demo/src/index.ts` (or a new `apps/demo/src/clear-sign.ts`)
   shows the end-to-end flow with structured output.

## 15. Deliverables

- This file (`implementations-plan/clear-signing-v0/plan.md`)
- `implementations-plan/clear-signing-v0/audit-codex.md` — codex review log
- `implementations-plan/clear-signing-v0/audit-opus.md` — opus subagent review log
- `implementations-plan/clear-signing-v0/eli5.html` — standalone ELI5 companion
- `implementations-plan/clear-signing-v0/lessons/phase-N.md` — per-phase logs
- New device source files: `src/l4/args_hash.{h,c}`, `src/l4/registry.{h,c}`,
  `src/l4/decoder.{h,c}` + updates to wire, session, append_call, finalize,
  verified_calls_ui.
- New TS modules: `decoder.ts`, `registry.ts`, codegen scripts, updated
  `l4-manifest.ts` + `auth-witness-provider.ts`.
- Golden-vector JSON extended with args_hash + clear-signing scenarios.
- `testnet-e2e.test.ts` env-gated integration test.
- Updated lesson doc capturing the gotchas (one will be the u128 encoding,
  another the sponsor-call extra manifest entry).

## 16. Status visibility (per CLAUDE.md)

```
[✓] 0. Clarifying questions (FT-only, hardcoded registry, defer Schnorr,
       testnet-acceptance criterion)
[▶] 1. Parallel plans (main + codex + opus)
[ ] 2. Security & adversarial section (included above; reviewed by audits)
[ ] 3. Final codex review of consolidated plan
[ ] 4. Approval gate
[ ] 5. Implementation (M5.0..M5.7)
[ ] 6. Post-impl codex review
[ ] 7. Fix loop
```
