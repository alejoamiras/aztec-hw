# M6 — AztecLedgerSession + Browser PoC — final consolidated plan

> Tier-A consolidation. Sources:
> - Main plan: `plan.md`
> - Codex xhigh: session `019e6615-114b-74e3-860b-bf83e3da07da`
> - Opus subagent: `opus-plan.md`
>
> Decisions log in §14. Citations to PoC repo are relative; citations to
> aztec-packages are absolute via `/Users/alejoamiras/Projects/aztec-packages`.

## 1. Problem statement

M5 closed the **cryptographic** clear-signing question (74 tests; signature
verified by Aztec barretenberg `Ecdsa.verifySignature`). M5.6 documented the
three upstream gaps that block on-chain submission. M6 closes the
**operational** question: a real alpha-testnet tx, signed via clear-signing
on a Ledger device (Speculos or real), lands `mined`.

**The PoC IS the bug report.** The user is the Aztec Foundation ecosystem
lead; the audience for the lessons doc is their own protocol team. Each
workaround in our wrapper is upstream evidence the framework's account/
entrypoint seam wasn't designed for HW pre-sign. Optimise for legibility
(one workaround = one upstream gap with diff + rationale), not just minimality.

Demo scope (frozen by user):
- Browser app at `localhost:5173`
- Connect Ledger (Speculos for dev, WebHID for real device)
- Deploy a Ledger-backed Aztec account (one-time, blind-sign)
- Drip 1000 USDC into self (clear-signed, sponsored)
- Transfer 100 USDC to alice (clear-signed, sponsored)
- **Stretch**: private-to-private transfer (uses TRANSFER_PRIV_PRIV
  verb already in M5 manifest — wrapper-only work)
- **Video**: user records; we hand off a working URL + flow checklist

## 2. Architecture

### Naming `[codex consensus]`

Class name: **`AztecLedgerSession`**, NOT `LedgerAztecWallet`. The wrapper is
session-local orchestration, not a drop-in Aztec `Wallet`. (Opus
acknowledged the same critique; both agreed `LedgerAztecWallet` implies
parallel to `BaseWallet`/`EmbeddedWallet`, which we are not.)

### Key model (clarifying the user's "3/4 keys host-side" framing)

| Quantity | Lives in | Derived how |
|---|---|---|
| Master `secret` | Browser (session memory) | `Fr.random()` at session start |
| `nhk_m` (nullifier hiding key) | Browser | derived from `secret` via SHA-512 |
| `ivsk_m` (incoming viewing) | Browser | derived from `secret` |
| `ovsk_m` (outgoing viewing) | Browser | derived from `secret` |
| `tsk_m` (tagging) | Browser | derived from `secret` |
| K1 signing private key | **Ledger only** | BIP-32 from device seed |

So 4 protocol keys derive from a single browser-held `secret`; the K1 signing
key is the only thing on the device. Code path:
`aztec-packages/yarn-project/stdlib/src/keys/derivation.ts:deriveMaster*`.

### Four-layer architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/demo-browser  (React + Vite + TS strict, browser-only)     │
│  ├─ Transport switch: WebHID ⟷ Speculos (Vite proxy)            │
│  ├─ State machine: idle → connecting → ready → deploying →      │
│  │   funded → transferring → done                                │
│  ├─ Plain CSS modules (no Tailwind for PoC) [opus]              │
│  └─ Banner: "PoC — secrets are session-only"                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ packages/adapter-ledger/src/wallet/                              │
│  ├─ aztec-ledger-session.ts       AztecLedgerSession             │
│  ├─ frozen-auth-witness-provider.ts                              │
│  └─ session-embedded-wallet.ts    thin EmbeddedWallet subclass   │
│                                   exposing fee/prove/send helpers│
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ @aztec/wallets — EmbeddedWallet (browser PXE + prover)           │
│ @aztec/aztec.js — AccountManager, DefaultAccountEntrypoint       │
└─────────────────────────────────────────────────────────────────┘
```

### Why `SessionEmbeddedWallet` `[codex]`

`EmbeddedWallet`'s internal helpers for fee completion, simulation, proving,
broadcast live behind protected/internal methods. Reaching them via casts
ages badly; a thin subclass with public exports is cleaner:

```ts
export class SessionEmbeddedWallet extends EmbeddedWallet {
  static async createEphemeral(node, opts): Promise<SessionEmbeddedWallet> {
    // EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled, ... } })
    // ^ `ephemeral` is a TOP-LEVEL EmbeddedWalletOptions flag (not nested under
    //   pxe). See aztec-packages/yarn-project/wallets/src/embedded/entrypoints/browser.ts:22
  }
  // Public exposure of the bits AztecLedgerSession needs (proveTx, sendTx,
  // simulateViaEntrypoint, registerContract). Implementation: forward to the
  // protected methods we'd otherwise reach via cast.
}
```

### The clear-signed submission recipe (the load-bearing piece)

For drip and transfer, bypass `BaseWallet.sendTx` (which hardcodes
`txNonce: Fr.random()` at `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:180`):

```ts
// API contract (post codex final critique MAJOR fix):
//   submitClearSignedIntent accepts an already-fee-merged ExecutionPayload,
//   NOT a raw FunctionCall. Convenience wrappers (dripUsdc, transferUsdc)
//   build the payload internally and pass it in. This keeps fee composition
//   visible at the caller and lets us validate exec.calls.length === 2
//   (sponsor + app) before pre-signing.
// API contract (caller-supplied payload). The convenience wrappers
// (dripUsdc, transferUsdc) build `exec` by calling
//   contract.methods.X(...).request({ fee: { paymentMethod: this.sponsoredFee } })
// per aztec-packages/yarn-project/aztec.js/src/contract/contract_function_interaction.ts:97,
// which produces [sponsor_unconditionally, app_call] in that order.
async submitClearSignedIntent(exec: ExecutionPayload): Promise<SubmitResult> {
  // 1. Shape-check the merged payload (single-app-call contract).
  //    Defensive: protects against future fee strategies that prepend
  //    more than one call or change order.
  if (exec.calls.length !== 2) {
    throw new Error(
      `submitClearSignedIntent expects [sponsor, app] (2 calls); got ${exec.calls.length}`,
    );
  }

  // 2. Pick OUR own txNonce (bypassing BaseWallet.sendTx's random one).
  const txNonce = Fr.random();

  // 3. Build CallIntent matching the merged call list + nonce.
  //    The mapping is byte-deterministic — L4.1 host parity already proves
  //    our buildL4Manifest matches Aztec's computeOuterAuthWitHash for the
  //    registered allowlist.
  const intent: CallIntent = projectIntoCallIntent(exec.calls, this.address, this.chainInfo);

  // 4. Pre-sign via Ledger CLEAR-SIGNING (device shows decoded fields).
  const authWit = await this.ledgerProvider.createAuthWitFromIntent(intent);

  // 5. Wrap in FrozenAuthWitnessProvider (one-shot, asserts hash on use).
  const frozen = new FrozenAuthWitnessProvider(authWit);

  // 6. Build a one-shot BaseAccount with the frozen provider.
  const oneShotAccount = new BaseAccount(
    this.completeAddress,
    this.nodeInfo,
    new DefaultAccountEntrypoint(this.address, frozen, this.chainInfo),
  );

  // 7. Construct the tx request with our chosen txNonce.
  const txRequest = await oneShotAccount.createTxExecutionRequest(
    exec, this.gasSettings, this.chainInfo,
    { txNonce, cancellable: false, feePaymentMethodOptions: undefined },
  );

  // 8. Prove + send via the session wallet (uses the browser PXE).
  const provenTx = await this.session.proveTx(txRequest, options);
  const txHash = await this.session.sendTx(provenTx);

  // 9. Wait for inclusion.
  const mined = await this.waitForTx(txHash);
  return { txHash, mined };
}
```

### `FrozenAuthWitnessProvider`

```ts
export class FrozenAuthWitnessProvider implements AuthWitnessProvider {
  private used = false;
  constructor(private readonly frozen: AuthWitness) {}
  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    if (this.used) throw new FrozenWitnessAlreadyUsed();
    if (!messageHash.equals(this.frozen.requestHash)) {
      throw new FrozenWitnessMismatch(messageHash, this.frozen.requestHash);
    }
    this.used = true;
    return this.frozen;
  }
}
```

One-shot (rejects double-use), hash-asserted (rejects mismatch). Critical:
**throw, don't silently re-sign.** If the framework's computed `messageHash`
ever diverges from ours, we want a loud failure — not a stealthy resign
that confirms a different tx than the user approved on-device.

### Deploy path = blind-sign (unchanged from M5)

`accountManager.getDeployMethod().send({ from: NO_FROM, fee: sponsored, skipClassPublication: true })`
goes through the standard framework path → `provider.createAuthWit(messageHash)`
→ L2 blind-sign INS. Device shows the deploy hash as hex. One-time event,
user confirms once. **No frozen-witness needed.** [codex M5.7 confirmed this.]

## 3. Manifest extension: Dripper into slot 3

**Only `drip_to_public`. NOT `drip_to_private`.** Codex + opus agree:
private dripping reopens private-note scope for zero demo value.

**Reuse nulo's existing deployment — NO redeploy.** The Dripper at
`0x172684be…7070` (salt=1337, deployer=zero) is already live and is the
declared minter for both nulo USDC (`0x2af7c3bd…47c5`, salt=4242) and
nulo ETH (`0x060e0d27…6224`, salt=4243). Source of truth:
`/Users/alejoamiras/Projects/nulo/nulo-2/packages/faucet/src/contracts/deployments.json`.
M6.0 only PINS these addresses into the device registry; it does not
deploy anything. If nulo later redeploys to different addresses we need
a manifest version bump + device-firmware update.

```jsonc
// packages/adapter-ledger/clear-signing-v0/manifest.json updates
{
  "registry": [
    /* slot 0 USDC (unchanged) */
    /* slot 1 ETH (unchanged) */
    /* slot 2 SPONSOR (TBD: address depends on chain — see §3.1 below) */
    {
      "slot": 3,
      "kind": "DRIPPER",
      "address": "0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070",
      "symbol": "DRIP",
      "decimals": 0
    },
    /* slot 4 EMPTY */
  ],
  "verbs": [
    /* existing 7 verbs */
    {
      "verb": "DRIP_PUB",
      "kind": "DRIPPER",
      "artifact_source": "DRIPPER_CONTRACT",
      "function_name": "drip_to_public",
      "expected_selector_u32": "<computed at codegen>",
      "is_public": true,
      "args": ["token", "amount"],
      "wire_arg_count": 2,
      "display_name": "Drip public",
      "amount_type": "u64"   /* opus: explicit annotation; high 24 bytes must be zero */
    }
  ]
}
```

### 3.1 SponsoredFPC address — CRITICAL FIX `[orchestrator pre-research]`

The M5 manifest pins SponsoredFPC at `0x254082…1257` (deterministic from
`SPONSORED_FPC_SALT = 0` = sandbox/local default). **The demo's target
live-network FPC deployment** uses a different salt:
`0x2a0f57c183e73d3390f80b6b28e57593d6faea3517eb57604491220173ad2f32`, which
resolves to **`0x153bddd8249216bd6326f1d5281d61fd8efc091dfc7828378e0399bf2a57ca4f`**.

(Wording nuance: aztec-packages testnet was deployed without SponsoredFPC
in genesis; what we're pinning is the *deployed* SponsoredFPC instance the
demo will actually use on the live network. That's where the salt that
yields `0x153bddd…ca4f` lives.)

M6.0 must update the registry to use this live-network address. (Or:
parameterize the codegen by network — out of v0 scope; consequence is
the sandbox phase drops out of M6.3, see §10.)

### 3.2 Device-side decoder for DRIP_PUB

`args[0]` (token address) must be looked up in the TOKEN-kind registry
slots. The amount at `args[1]` is `u64` (encoder treats it as 1 Fr slot —
`aztec-packages/yarn-project/stdlib/src/abi/encoder.ts:24`), but with high
24 bytes zero. **Decimals come from `args[0]`'s registry entry, NOT
Dripper's own slot** (Dripper has `decimals=0`).

Reject rules added to the device's strict allowlist:
- `args[0]` must be TOKEN-kind in registry (else `SW_REGISTRY_MISS`-equivalent)
- `args[1]` high 24 bytes must be zero (else `SW_HASH_MISMATCH` from canonicality)

UI template:
```
Call X/N    "Drip USDC"
Token       USDC (0x2af7…47c5)
To          you           ← drip_to_public mints to msg.sender
Amount      "1000.0 USDC" ← formatted with token's decimals
```

### 3.3 Codegen pipeline updates

`packages/adapter-ledger/scripts/gen-clear-signing-v0.ts` extends to handle
`artifact_source: 'DRIPPER_CONTRACT'`. Reads Dripper artifact from
`node_modules/@defi-wonderland/aztec-standards/target/dripper-Dripper.json`.
Cross-checks selector + is_public + arg_count just like the Token verbs.

CI's existing `gen:clear-signing-v0:check` step runs on every PR/push and
fails-closed on any drift.

### 3.4 Fail-closed contract-metadata check `[codex]`

Before `submitClearSignedIntent` runs, the wrapper queries
`embedded.getContractMetadata(addr)` for USDC, Dripper, and SponsoredFPC.
If any returns `isContractUpdated: true` OR the contract isn't published,
throw `ContractDriftError`. **Device registry pins are address-based, not
class-hash-based** — without this check, a Wonderland redeploy at the same
address but with a different class hash would silently pass clear-signing
while signing against a different code base.

## 4. The `AztecLedgerSession` class

```ts
// packages/adapter-ledger/src/wallet/aztec-ledger-session.ts

export interface AztecLedgerSessionOptions {
  readonly transport: LedgerTransport;
  readonly bip32Path: readonly number[];
  readonly node: AztecNode;
  readonly secret: Fr;                  // session-only, host-held
  readonly salt: Fr;                    // session-only
  readonly sponsoredFpcAddress: AztecAddress;
  readonly signOptions?: SignOuterHashOptions;
}

export interface SubmitResult {
  readonly txHash: TxHash;
  readonly mined: TxReceipt;
}

export class AztecLedgerSession {
  static async connect(opts: AztecLedgerSessionOptions): Promise<AztecLedgerSession>;

  readonly address: AztecAddress;
  readonly completeAddress: CompleteAddress;

  // Standard framework path — random nonce is fine, device blind-signs the
  // one-time deploy hash.
  deployAccount(): Promise<SubmitResult>;

  // Pre-sign + frozen-witness submission (§2 recipe).
  // Accepts a FEE-MERGED ExecutionPayload — exactly the shape produced by
  //   contract.methods.X(...).request({ fee: { paymentMethod: this.sponsoredFee } })
  // which yields [sponsor_unconditionally, app_call] per
  //   aztec-packages/yarn-project/aztec.js/src/contract/contract_function_interaction.ts:97
  // The wrapper asserts `exec.calls.length === 2` (single-app-call contract);
  // multi-app batches are out of scope for v0.
  submitClearSignedIntent(exec: ExecutionPayload): Promise<SubmitResult>;

  // Convenience wrappers.
  dripUsdc(amount: bigint): Promise<SubmitResult>;
  transferUsdc(to: AztecAddress, amount: bigint): Promise<SubmitResult>;

  // Public reads (no signing).
  getPublicUsdcBalance(): Promise<bigint>;
  getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }>;

  disconnect(): Promise<void>;
}
```

Internal lifecycle:

1. `connect()`:
   - `SessionEmbeddedWallet.createEphemeral(node)` (`ephemeral: true` PXE)
   - Build `LedgerEcdsaKAccountContract(transport, { bip32Path })`
   - `AccountManager.create(embedded, secret, ledgerContract, salt)` →
     deterministic address from `(secret, signing_pubkey, salt)`
   - Register account + USDC + Dripper + SponsoredFPC contract instances
     in PXE
   - Run `getContractMetadata` fail-closed checks (§3.4)
   - Return ready session
2. `disconnect()`:
   - Close PXE
   - Clear `secret` / `salt` references (no persistence anyway)

In-flight mutex: `submitClearSignedIntent` is serialized — concurrent calls
would conflict on the frozen-witness state. Mutex internal to the class.

## 5. WebHID transport + provider refactor

### WebHID transport `[both plans agree]`

```ts
// packages/adapter-ledger/src/webhid-transport.ts (browser-only)
export class WebHidLedgerTransport implements LedgerTransport {
  static async open(): Promise<WebHidLedgerTransport> {
    const hidTransport = await TransportWebHID.create();
    return new WebHidLedgerTransport(hidTransport);
  }
  async send(req: ApduRequest): Promise<ApduResponse> { /* delegate to hidTransport */ }
}
```

### Provider-cast refactor `[codex]`

Current `packages/adapter-ledger/src/provider.ts:109-143` casts `this.transport`
to `SpeculosTransport` to access `autoConfirm`. This is wrong for real-device
browser support — WebHID has no autoConfirm; the user physically presses
buttons on the device. Fix: widen the `LedgerTransport` interface to make
`autoConfirm` optional behavior, not a hard cast.

```ts
// transport.ts
export interface LedgerTransport {
  send(req: ApduRequest, autoConfirm?: AutoConfirmDriver): Promise<ApduResponse>;
}
```

Speculos transport accepts and honors `autoConfirm`; WebHID transport
ignores it. Provider stops casting.

## 6. Frontend (`apps/demo-browser/`)

### Stack `[opus]`
- React 19 + Vite 6 + TS strict + Biome (per CLAUDE.md)
- Plain CSS modules — Tailwind setup cost not justified for a 3-panel PoC
- `useReducer` for state — Zustand/Redux overkill

### State machine

```
idle ──connect──→ connecting ──ok──→ ready
                                       │
                                ──deploy──→ signing(deploy) ──mined──→ deployed
                                                                          │
                                                                  ──drip──┤
                                                                          ▼
                                                              signing(drip)
                                                                          │
                                                                  ─mined──┤
                                                                          ▼
                                                                      funded
                                                                          │
                                                              ──transfer──┤
                                                                          ▼
                                                          signing(transfer)
                                                                          │
                                                                  ─mined──┤
                                                                          ▼
                                                                       done
```

Any error → error state, back to ready (preserve session).

### Panels

```
┌─────────────────────────────────────────────────────────┐
│ A: Connection                                           │
│   Transport: ◉ Speculos  ○ WebHID                       │
│   [Connect]   Address: 0xabcd…                          │
│   Chain: alpha-testnet (11_155_111)                     │
├─────────────────────────────────────────────────────────┤
│ B: Actions (gated by state)                             │
│   [Deploy account]   (blind-sign)                       │
│   [Drip 1000 USDC]   (clear-sign)                       │
│   [Transfer 100 USDC to alice]   (clear-sign)           │
├─────────────────────────────────────────────────────────┤
│ C: Activity log                                         │
│   ✓ Deployed: 0xabc… → aztecscan.xyz/...               │
│   ✓ Dripped 1000 USDC                                   │
│   ⟳ Transferring... (signing on device)                 │
└─────────────────────────────────────────────────────────┘
```

### Transport switching

| Mode | Transport | CORS handling |
|---|---|---|
| Dev + Speculos | HTTP to `/speculos/*` | Vite proxy to `localhost:5001` |
| Dev + real device | WebHID | native (browser API) |
| Deployed demo | WebHID only | HTTPS required by spec |

`VITE_TRANSPORT_MODES=webhid,speculos` env var enables both modes in dev;
prod build sets `VITE_TRANSPORT_MODES=webhid` only (`[codex]`).

### PXE sync UX `[opus]`

`EmbeddedWallet.create` syncs from genesis on first load — can take minutes
on alpha-testnet. Reuse `aztec-accelerator/packages/playground/src/aztec.ts:152-172`'s
status-reporter pattern. Frontend shows "Syncing PXE…" with progress.

## 7. Lessons-doc structure

`implementations-plan/m6-aztec-wallet-wrapper/lessons-for-aztec-team.md`.
**Four PR-shaped suggestions, ranked by leverage** [main + opus over codex's 3].

### Lesson 1 (highest leverage): `BaseWallet.sendTx` takes a caller-supplied `txNonce`

**Problem**: `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:180`
hardcodes `txNonce: Fr.random()`. HW pre-sign is impossible because the
user signs an outer_hash that depends on a nonce the framework hasn't picked.

**Diff**:
```diff
-        txNonce: Fr.random(),
+        txNonce: opts.txNonce ?? Fr.random(),
```
Thread `txNonce?: Fr` through `SendMethodOptions` and `EmbeddedWallet.simulateViaEntrypoint`.

**Rationale**: caller already knows the nonce. Default preserves backwards
compat. One-line change collapses our ~80 LOC workaround.

### Lesson 2: `AuthWitnessProvider.createAuthWitFromIntent` (optional)

**Problem**: `aztec-packages/yarn-project/entrypoints/src/interfaces.ts:62`
defines only `createAuthWit(messageHash: Fr)`. `DefaultAccountEntrypoint`
at `account_entrypoint.ts:141` always discards the structured call list
and calls only the hash variant.

**Diff**:
```diff
 export interface AuthWitnessProvider {
   createAuthWit(messageHash: Fr): Promise<AuthWitness>;
+  createAuthWitFromIntent?(ctx: AuthWitnessIntentContext): Promise<AuthWitness>;
 }
+
+export interface AuthWitnessIntentContext {
+  readonly consumer: AztecAddress;
+  readonly chainInfo: ChainInfo;
+  readonly calls: readonly FunctionCall[];
+  readonly txNonce: Fr;
+  readonly messageHash: Fr;  // the outer_hash the provider would otherwise be called with
+}
```
And in `account_entrypoint.ts` near line 141:
```diff
-const payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+const payloadAuthWitness = this.auth.createAuthWitFromIntent
+  ? await this.auth.createAuthWitFromIntent({ consumer: this.address, chainInfo, calls, txNonce, messageHash })
+  : await this.auth.createAuthWit(messageHash);
```

**Rationale**: optional + back-compat. HW wallets opt in; software wallets
unchanged. Lets the provider clear-sign exact payload semantics without
forking entrypoint encoding.

### Lesson 3: `opts.presignedPayloadAuthWitness` on sendTx

**Problem**: no first-class hook for "I already signed this payload, just
use it." Forces wrappers to bypass `BaseWallet.sendTx` and re-implement
prove+send.

**Diff** (around `account_entrypoint.ts:141`):
```diff
+if (options.presignedPayloadAuthWitness) {
+  if (!options.presignedPayloadAuthWitness.requestHash.equals(messageHash)) {
+    throw new PresignedWitnessHashMismatch(...);
+  }
+  payloadAuthWitness = options.presignedPayloadAuthWitness;
+} else {
+  payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+}
```

**Rationale**: complements lesson 1. Offline pre-sign + inject covers HW
wallets, MPC, sponsored relayers, "approve once batch many." The
hash-assertion makes the trust handoff explicit.

### Lesson 4: re-export outer_hash preimage helpers publicly `[opus]`

**Problem**: `computeOuterAuthWitHash` and `EncodedAppEntrypointCalls.create(...).hash()`
are framework-internal. We re-implemented them in
`packages/adapter-ledger/src/l4-manifest.ts` and burned ~5 days on L4.1
host-parity testing to verify the re-impl matched.

**Change**: re-export from `@aztec/aztec.js`:
```ts
export { computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
export { EncodedAppEntrypointCalls } from '@aztec/entrypoints/encoding';
```

**Rationale**: zero internals change. Saves every future HW-wallet
integrator the L4.1 work. (Codex argued for cutting this lesson as
"lower leverage"; we keep it because the L4.1 effort it would have saved
us is concrete evidence.)

### Why not 5

Considered: "auth-witness ABI versioning for non-Schnorr keypairs."
Speculative until lessons 1+2 land. Reconsider M7.

## 8. Security & adversarial considerations

The browser is the new attack surface (M5 was CLI-only). Walking through:

**Browser-held `secret` exposure.** Master secret + derived protocol keys
live in JS memory. A malicious browser extension with `<all_urls>` or a
compromised npm dep can in principle exfiltrate session memory. Mitigation:
`ephemeral: true` PXE — no IndexedDB / localStorage persistence; secret
dies on page reload. **Residual**: session-time privacy data (notes) can
be exfiltrated. The Ledger K1 signing key NEVER leaves the device, so an
extension cannot directly authorize a transfer — but it can read what the
user can read.

**DOM-level recipient substitution.** Once recipient is a form input, a
malicious extension can swap it before submission. Mitigation: the device
clear-sign screen is the only authority. UI copy: "Always verify the
recipient on your Ledger before approving." Strict-allowlist + decoded
recipient pair on the device makes this attack visible. **Residual**:
users who skim the device screen get rugged.

**Balance lies.** Frontend can display fake balances tempting users into
larger transfers. Defense: device shows the actual amount being signed;
typed amount is irrelevant. Browser balance labeled "informational only,
verify via aztecscan."

**Contract drift.** Wonderland redeploys USDC/Dripper at the same address
with different code (or class upgrade). Device registry pins are
address-based, so it'd happily sign against the new code. Mitigation:
`getContractMetadata` fail-closed check (§3.4) before any clear-sign flow.

**Speculos-as-prod confusion.** User on deployed demo URL points page at
their localhost Speculos and signs with the emulator's TEST seed. Mitigation:
Speculos radio button disabled in prod builds via Vite env var; visible
"Speculos (dev only)" label.

**Trusted RPC endpoint.** The PXE connects to a single chain-data oracle —
`rpc.testnet.aztec-labs.com` for the demo, or whatever node URL the
operator configures. A malicious or compromised RPC can lie about chain
state (fake mined receipts, stale balances, withheld notes). The
clear-signing pipeline does NOT defend against this: the device only
authorizes a payload; it does not verify the chain state the host claimed
when assembling that payload. Mitigation for v0: ship a single hard-coded
RPC URL in the demo build (no user-supplied override); document that
production wallets MUST do their own RPC pinning, redundancy, and
ideally light-client verification. Residual: full host trust for chain
oracle.

**Frozen-witness drift.** Framework's computed `messageHash` differs from
what we pre-signed → our provider throws `FrozenWitnessMismatch` loudly.
Never silently re-sign. **Latent risk** `[opus]`:
`account_entrypoint.ts:80` adds `salt: Fr.random()` to the
`TxExecutionRequest` itself. Currently NOT included in `payloadHash` (line
139 uses only `encodedCalls.hash()`), but is one upstream PR away from
becoming a regression. Defensive: log every divergent hash; CI replays
the e2e weekly to catch silent upstream changes.

**Front-running / re-ordering.** Public drip and public transfer are
public-pool observable. Clear-signing ensures the user signed exactly this
tx; it does not make the tx private, and it does not prevent the host
from delaying or withholding broadcast after approval. Out of scope for
v0.

**Out-of-scope for v0** (acknowledged): CSP hardening, SRI for `@aztec/*`,
origin-pinned RPC, TEE-attested signing, hardware-attested Ledger firmware.

## 9. Funding model

Two clear-signed transactions. Codex + opus agree the self-drip is the
right choice — no external helper wallet needed.

**Tx 1 (drip)** call list:
```
[ SponsoredFPC.sponsor_unconditionally(),               // PRIVATE, 0 args
  Dripper.drip_to_public(USDC_ADDR, 1_000_000_000n) ]   // PUBLIC, 2 args
```
Strict-allowlist check: SPONSOR + DRIP_PUB both in registry post-M6.0;
arg counts 0 + 2; visibility priv + pub. Both pass.

**Tx 2 (transfer)** call list:
```
[ SponsoredFPC.sponsor_unconditionally(),
  USDC.transfer_public_to_public(self, alice, 100_000_000n, 0n) ]
```
Strict-allowlist check: SPONSOR + TRANSFER_PUB_PUB; arg counts 0 + 4;
visibility priv + pub; `from == consumer` enforced (self).

Order stability: `mergeExecutionPayloads([feePayload, fnPayload])`
preserves array order at
`aztec-packages/yarn-project/stdlib/src/tx/execution_payload.ts:37`.
SponsoredFPC is always first because `ContractFunctionInteraction.request()`
prepends the fee payload at
`aztec-packages/yarn-project/aztec.js/src/contract/contract_function_interaction.ts:97`.

## 10. Phasing

```
M6.0  Manifest extension                                 ~1d
      - Add Dripper to slot 3 (DRIPPER kind, drip_to_public)
      - Fix SponsoredFPC address for testnet (CRITICAL)
      - Codegen + cross-check
      - Device-side decoder + UI template for DRIP_PUB
      - Contract-metadata fail-closed check helpers

M6.1  Provider refactor + WebHID transport               ~1d
      - Widen LedgerTransport interface (autoConfirm optional)
      - WebHidLedgerTransport
      - Existing tests still green
      - Speculos transport unchanged

M6.2  SessionEmbeddedWallet                              ~0.5d
      - Subclass with public helpers
      - Ephemeral PXE flag
      - Unit tests (mocked)

M6.3  FrozenAuthWitnessProvider + AztecLedgerSession     ~2d
      - FrozenAuthWitnessProvider (~30 LOC + tests)
      - AztecLedgerSession class
      - submitClearSignedIntent (the 9-step recipe)
      - In-flight mutex
      - Contract-metadata fail-closed integration
      - Unit tests + mock-PXE integration tests only — NO sandbox e2e
        (the M6.0 registry is pinned to the demo's target live-network
         SponsoredFPC deployment; aztec-sandbox's salt=0 instance resolves
         to a different address and would REGISTRY_MISS on the sponsor
         call. Real chain submission is gated to M6.5 below.)

M6.4  Frontend skeleton                                  ~1.5d
      - apps/demo-browser/ (Vite + React 19 + TS)
      - Three panels + state machine + transport switch
      - Vite proxy for Speculos CORS
      - Mock-mode integration test (Playwright optional)

M6.5  Alpha-testnet e2e + hand-off for recording         ~3d (+1d buffer)
      - PXE sync handling (progress UI)
      - Real testnet against rpc.testnet.aztec-labs.com
      - First Speculos, then real Ledger via WebHID
      - End-to-end smoke before hand-off (drip + public transfer)
      - **STRETCH (only if all above is green ≥ 1d before video)**:
        expose `transferUsdcPrivate(to, amount)` wrapper using
        `transfer_private_to_private` (already in M5 manifest as
        TRANSFER_PRIV_PRIV — no codegen work). Adds a third demo step.
        Cut if it slips.
      - **Video capture is handled by the user** — we hand off a
        working demo URL + a checklist of the three (or four, with
        stretch) flows to run. No screen-recording tooling on our side.
      - **Testnet-unavailable fallback** (invoke only if testnet
        stalls > 1 day): spin up aztec-sandbox locally AND manually
        deploy a SponsoredFPC at the same salt the M6.0 manifest pinned
        so the registry still resolves (`scripts/deploy-sandbox-fpc.ts`,
        write only if invoked). Hand-off proceeds; lessons doc notes
        the fallback.

M6.6  Lessons doc                                        ~1d
      - Write up 4 PR suggestions with diffs + before/after
      - File as GitHub issues against aztec-packages
      - (Optional: open the actual PRs if scope tight)

M6.7  Codex post-impl review + fix loop                  ~1d

Total: ~11-13 working days (was 10-11; +1d for M6.5 buffer, +1d
       absorbed from removed M6.3 sandbox e2e). Slip dominated by
       testnet stability.
```

## 11. Success criteria

1. Browser page at `localhost:5173` deploys a Ledger-backed Aztec account
   via Speculos, drips 1000 USDC, transfers 100 USDC to alice — all three
   txs `mined` on alpha-testnet.
2. Same flow against a real Ledger Nano S+ via WebHID.
3. Lessons doc: 4 upstream PR-shaped suggestions with file:line citations,
   diffs, before/after code, rationale. Ready to file as GitHub issues.
4. Codex post-impl review: zero BLOCKER findings.
5. Demo runs reliably enough that the user can hit record once and
   capture the full flow in a single take. (User handles recording.)
6. Existing test suite stays green (74 pass before this arc → at least 74
   after, plus new unit tests for the wrapper + Dripper decoder).
7. Both device builds clean (nanosp + nanox).
8. **STRETCH (not blocking)**: private-to-private transfer wrapper
   (`transferUsdcPrivate`) demoed on top of public flow. Verb already in
   M5 manifest as TRANSFER_PRIV_PRIV (`transfer_private_to_private`);
   only the convenience wrapper + UI button are new. Drop if M6.5 slips.

## 12. Open questions

1. **Vite + bb-prover WASM bundling** — the accelerator playground works at
   4.2.0-rc.1; we may need a similar `vite.config.ts` for worker pinning,
   WASM externals, top-level await. Resolve at M6.4.
2. **PXE sync time** `[opus]` — first sync against testnet can take minutes.
   If it dominates the video runtime, push the drip step to a pre-record
   prep step and shorten the video. Decision after M6.5 hands-on.
3. **WebHID permission flow** — first connect triggers a browser prompt;
   subsequent connects are silent. Document in the demo README.
4. **TxExecutionRequest.salt regression** `[opus]` — `account_entrypoint.ts:80`
   currently doesn't enter `payloadHash`; one PR away from breaking
   frozen-witness. Add an explicit assertion in M6.3 + a weekly e2e replay
   to catch silent upstream drift.
5. **Aztec version pin** — user said 4.2.0, repo currently at 4.2.1. Likely
   compatible; if not, downgrade or pin per-package.

## 13. Deliverables

- This file (`plan-final.md`)
- `eli5.html` (standalone companion)
- New TS source:
  - `packages/adapter-ledger/src/wallet/aztec-ledger-session.ts`
  - `packages/adapter-ledger/src/wallet/frozen-auth-witness-provider.ts`
  - `packages/adapter-ledger/src/wallet/session-embedded-wallet.ts`
  - `packages/adapter-ledger/src/webhid-transport.ts`
- Modified TS:
  - `packages/adapter-ledger/src/transport.ts` (widen interface)
  - `packages/adapter-ledger/src/provider.ts` (remove SpeculosTransport cast)
  - `packages/adapter-ledger/clear-signing-v0/manifest.json` (slot 3 +
    SponsoredFPC testnet address)
  - `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts` (Dripper artifact)
  - Generated C + TS tables
- New device source:
  - DRIP_PUB UI template in `verified_calls_ui.c`
  - New decoder rule (token-arg registry lookup)
- New app: `apps/demo-browser/` (~600 LOC)
- Tests:
  - `frozen-auth-witness-provider.test.ts`
  - `aztec-ledger-session.test.ts` (with sandbox)
  - Optional: `apps/demo-browser/e2e/full-flow.spec.ts` (Playwright)
- Docs:
  - `implementations-plan/m6-aztec-wallet-wrapper/lessons-for-aztec-team.md`
  - `implementations-plan/m6-aztec-wallet-wrapper/lessons/phase-N.md`
  - Updated `implementations-plan/index.md`
- Video: `~/Desktop/m6-ledger-aztec-demo.mp4` (or similar)

## 14. Decisions log (who-said-what)

| Decision | Source | Rationale |
|---|---|---|
| Class name `AztecLedgerSession` (not `LedgerAztecWallet`) | codex | Honest about scope; not a wallet peer to `EmbeddedWallet` |
| `SessionEmbeddedWallet` thin subclass | codex | Avoids casting through protected fields |
| `ephemeral: true` for PXE | codex | Stronger than "no localStorage"; kills IndexedDB persistence |
| Only `drip_to_public` (drop `drip_to_private`) | codex + opus | Reopens private-note scope for zero demo value |
| Slot 3 = DRIPPER (vs genericized UTILITY kind) | both | Overengineering for one contract |
| Cross-slot decimals (DRIPPER amount uses TOKEN's decimals) | opus | Explicit rule; auditable |
| `amount_type: "u64"` annotation in manifest | opus | Auditable + future-proof |
| 4 PR suggestions (keep lesson 4 — outer_hash helpers) | opus over codex | The L4.1 work is concrete evidence of high leverage |
| `getContractMetadata` fail-closed | codex | Catches contract drift between manifest pin and live testnet |
| Refactor `provider.ts` transport cast | codex | WebHID has no autoConfirm; cast is wrong |
| Plain CSS (no Tailwind) for the frontend | opus | PoC scope; Tailwind setup cost not justified |
| `apps/demo-browser/` (new dir) | both | Don't mutate `apps/demo` (CLI artifact) |
| Document `account_entrypoint.ts:80` salt regression risk | opus | Defensive: latent upstream-change blast radius |
| Document PXE sync time concern | opus | UX-critical for the video |
| Fix SponsoredFPC address to live-network deployment | orchestrator pre-research | M5 manifest has sandbox address; live deployment differs |
| Drop M6.3 sandbox e2e; go straight to testnet | codex final-critique BLOCKER | Pinning registry to live-network FPC makes sandbox REGISTRY_MISS unless we re-deploy FPC at same salt — kept as M6.5 fallback |
| `submitClearSignedIntent(exec: ExecutionPayload)` (not `FunctionCall`) | codex final-critique MAJOR | Caller composes fee + app explicitly; wrapper asserts shape; single-app-call contract |
| Reword §3.1: "live-network FPC deployment" not "testnet uses" | codex final-critique MAJOR | aztec-packages testnet had no SponsoredFPC in genesis; what we pin is the demo's deployed FPC instance |
| Move `ephemeral: true` to top-level `EmbeddedWalletOptions` | codex final-critique MINOR | It's not under `pxe`; see `wallets/src/embedded/entrypoints/browser.ts:22` |
| Fix `nsk_m` → `nhk_m` in key table | codex final-critique MINOR | Aztec uses NHK (nullifier hiding key) on the master path |
| Add explicit RPC-trust paragraph in §8 | codex final-critique MINOR | Chain-oracle trust isn't defended by clear-signing |
| M6.5 buffer to +1d AND sandbox-with-redeployed-FPC fallback | codex final-critique MINOR | Testnet stability is a known unknown; need a recordable demo path |
| User records the video — we hand off, not capture | user (post-critique) | Removes screen-recording tooling from our scope; we ship a working URL + flow checklist |
| Reuse nulo's existing Dripper (no redeploy) | user (post-critique) | Already live at 0x172684be…7070 (salt=1337), minter for nulo USDC/ETH; manifest only PINS this address |
| Private p2p transfer as STRETCH (not blocking M6.5) | user (post-critique) | TRANSFER_PRIV_PRIV verb already in M5 manifest; cost is wrapper method + UI button only; cut if M6.5 slips |

## 15. Status

```
[✓] 0. Clarifying questions (drip+transfer / ephemeral / Speculos+WebHID / PR-shaped lessons)
[✓] 1. Parallel plans drafted (main + codex + opus)
[✓] 2. Consolidated → plan-final.md (this file)
[✓] 3. Final codex critique (session 019e6626 — 1 BLOCKER + 1 MAJOR + 4 MINORs)
[✓] 3a. Apply codex critique fixes (this commit)
[▶] 4. Approval gate (surface to user)
[ ] 5. Implementation (M6.0..M6.7)
[ ] 6. Codex post-impl review
[ ] 7. Hand off demo URL for user-recorded video + ship lessons doc
```
