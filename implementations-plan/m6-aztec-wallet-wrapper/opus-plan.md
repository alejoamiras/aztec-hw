# M6 — Aztec Wallet Wrapper + Browser PoC (opus independent plan)

> Tier-A independent draft. Not yet consolidated. Frame and emphasis chosen
> without reading the orchestrator's main plan or the codex-xhigh draft.
> Citations: `aztec-packages` at version `^4.2.1` (npm consumption per project
> CLAUDE.md), local clone at `/Users/alejoamiras/Projects/aztec-packages` for
> source reads. PoC repo paths relative to
> `/Users/alejoamiras/Projects/aztec-hardware-wallet-poc`.

## 1. Problem statement

M5 proved the device can produce an Aztec-acceptable signature with a
clear-signed UI. M5.6 documented the three reasons the framework can't USE
that signature today (random `txNonce` in `BaseWallet.sendTx`, `auth.createAuthWit(messageHash)` as the only path through `DefaultAccountEntrypoint`, and no `setAuthWitness` analogue at the wallet level). The cryptographic question is closed; the operational question — "can a real dApp actually submit one of these txs?" — is open.

M6 closes that question with the smallest demo that is also a credible
testnet artefact: a browser page that drips USDC into a Ledger-backed account
via SponsoredFPC, then transfers some of it out, both clear-signed on the
device. The demo is the success criterion. Anything that doesn't move that
demo forward is out of scope.

Two framings before architecture:

**The PoC is a bug-report.** Each workaround in `LedgerAztecWallet` is upstream evidence the framework's account/entrypoint seam was not designed for HW pre-sign. The user is the Aztec Foundation ecosystem lead; the audience for the lessons doc is their own protocol team. Optimise workarounds for legibility (one file = one upstream gap, with diff + rationale), not minimality.

**`LedgerAztecWallet` is probably the wrong name.** It implies a wallet abstraction parallel to `BaseWallet`/`EmbeddedWallet`. What we need is a thin orchestrator owning the pre-sign / frozen-witness choreography, delegating PXE + prover + account-manager flow to `EmbeddedWallet`. Two verbs: `deployAccount()` and `submitClearSignedIntent(intent)`. Closer to a tx sender than a wallet. Keep the name for doc back-compat; flag rename to `LedgerTxComposer` after demo lands.

## 2. Architecture

Four layers:

- **Frontend** (`apps/demo-browser`, React+Vite+TS): state machine, transport switch (WebHID | Speculos-HTTP), session-only `secret`+`salt`.
- **LedgerAztecWallet** (`packages/adapter-ledger`): owns pre-sign / frozen-witness choreography; wraps EmbeddedWallet + AccountManager.
- **EmbeddedWallet + AccountManager** (`@aztec/wallets`): in-browser PXE, prover, registration, sendTx — we bypass sendTx for clear-signed flows (random-nonce gap).
- **Aztec alpha-testnet** (`rpc.testnet.aztec-labs.com`, chain 11155111, rollup 4127419662).

Key separation: **Ledger holds only the K1 signing private key**. The master `secret` and the three derived protocol keys (`ivsk_m`, `ovsk_m`, `nsk_m`) live in the browser session and die on page reload.

### Composing with AccountManager

`EmbeddedWallet.createECDSAKAccount(secret, salt, signingKey)` (`aztec-packages/yarn-project/wallets/src/embedded/embedded_wallet.ts:351`) wants the raw key — we don't have it. The seam is one level deeper: call `AccountManager.create(embeddedWallet, secret, ledgerAccountContract, salt)` directly (mirroring `embedded_wallet.ts:315`), passing our existing `LedgerEcdsaKAccountContract` (`packages/adapter-ledger/src/account-contract.ts`). `AccountManager` builds `BaseAccount` with our `LedgerEcdsaKAuthWitnessProvider`; framework treats it like a Schnorr account.

For the **deploy** tx: ride the standard path. `accountManager.getDeployMethod()` → `deployMethod.send({ from: NO_FROM, fee: sponsored, skipClassPublication: true })`. This calls `provider.createAuthWit(messageHash)` (the blind-sign L2 path). The device shows the deploy hash as hex — one-time blind sign, acceptable for v0 (and codex M5.7 already confirmed this).

For the **drip and transfer** txs: bypass `sendTx`. Per tx:

1. Build user `FunctionCall` (`Dripper.methods.drip_to_public(usdc, amount).request()` etc.).
2. `feeExecutionPayload = sponsoredFeeMethod.getExecutionPayload()`; `mergeExecutionPayloads([feePayload, fnPayload])` (mirrors `base_wallet.ts:168-171`).
3. Pick `txNonce = Fr.random()` outside the framework. Capture it.
4. Build `CallIntent` from merged call list + nonce; hand to `createAuthWitFromIntent(intent)` (the clear-signing M5 path: device decodes, displays, signs).
5. Wrap returned `AuthWitness` in `FrozenAuthWitnessProvider` (~30 LOC): `createAuthWit(messageHash)` returns the frozen witness if `messageHash` matches what we pre-signed, else throws.
6. Build a one-shot `BaseAccount` with that frozen provider + `DefaultAccountEntrypoint(address, frozenProvider)`.
7. `oneShotAccount.createTxExecutionRequest(payload, gas, chain, { txNonce, cancellable: false, feePaymentMethodOptions })`.
8. Submit through PXE: `simulateTx` → `proveTx` → `sendTx` (mirrors `base_wallet.ts:200+` minus the random-nonce step).
9. Poll until `mined`.

Six framework public APIs + one new class. No re-implementation.

### Where the workaround leaks

Frozen-witness depends on: the `outer_hash` the entrypoint computes on step 7 MUST match what the device signed on step 4. Today `EncodedAppEntrypointCalls.create(calls, txNonce).hash()` is deterministic (codex confirmed byte-for-byte L4 parity for the registered allowlist). But `account_entrypoint.ts:80` already adds `salt: Fr.random()` to the `TxExecutionRequest` itself — that salt currently does NOT enter `payloadHash` (line 139: `payloadHash = await encodedCalls.hash()`), but is one upstream PR away from being a regression. Lessons-doc item.

## 3. Adding Dripper to the M5 registry

Slot 3 takes Dripper. Selectors and codegen run again; no rewrite.

```
slot 0 USDC      (existing, alpha-testnet faucet USDC)
slot 1 ETH       (existing, alpha-testnet faucet wrapped-ETH)
slot 2 SPONSOR   (SponsoredFPC, deterministic from salt 0x2a0f...2f32)
slot 3 DRIPPER   (Wonderland Dripper, salt 1337 — addr from deployments.json)
slot 4 EMPTY     (reserved)
```

The DRIPPER kind needs one new verb:

```json
{
  "verb": "DRIP_PUB",
  "kind": "DRIPPER",
  "function_name": "drip_to_public",
  "is_public": true,
  "args": ["token", "amount"],
  "wire_arg_count": 2,
  "display_name": "Drip public",
  "amount_type": "u64"
}
```

Three non-obvious points.

**`amount` is `u64`, not `u128`.** Encoder still puts it in 1 Fr slot (`stdlib/src/abi/encoder.ts:24-43` packs both into a single field); device-side it must format with the correct decimal places of the *token at `args[0]`*. Cross-slot dependency: the verb's `amount` is interpreted with the decimals of the token argument, not of the Dripper itself. Decoder needs to look up `args[0]` in the registry to know which decimal scale to apply. Reject if `args[0]` is not a TOKEN-kind registry entry.

**`drip_to_public` is `external("public")`, so `is_public = true`.** This contrasts with `SPONSOR` which is `external("private")`. Mixed visibility in a single call list (sponsor=priv + drip=pub) is already supported by the L4 manifest; M5.2's two-stage parity gate handles both branches of `computeVarArgsHash` per-call. No device-side changes beyond a third verb table entry.

**UI template for DRIP:**

```
Call X/N    "Drip USDC"
Token       0x2af7…47c5 (USDC)
Amount      "1000.0 USDC"
```

(`drip_to_public` mints to `msg_sender` so there's no "to" pair — the user *is* the recipient, which is exactly the point of self-funding.)

### Cleaner alternative?

Three options considered: (a) external hot-wallet funds Ledger via transfer — requires second testnet account, more op cost than codegen; (b) Dripper to slot 3 (proposed); (c) pre-fund out-of-band, demo only transfers — video opens with balance from nowhere, defeats the point.

(b) wins. A genericised "UTILITY kind" instead of DRIPPER would be cleaner architecturally, but it's overengineering for one contract. Stay with DRIPPER.

## 4. The wrapper class

```ts
// packages/adapter-ledger/src/wallet/ledger-aztec-wallet.ts

export interface LedgerAztecWalletOptions {
  readonly transport: LedgerTransport;
  readonly bip32Path: readonly number[];
  readonly node: AztecNode;
  readonly secret: Fr;          // session-only
  readonly salt: Fr;            // session-only
  readonly sponsoredFpcAddress: AztecAddress;
  readonly signOptions?: SignOuterHashOptions;  // Speculos auto-confirm hook
}

export interface SubmitResult {
  readonly txHash: TxHash;
  readonly mined: TxReceipt;
}

export class LedgerAztecWallet {
  private embedded?: EmbeddedWallet;
  private accountManager?: AccountManager;
  private ledgerContract?: LedgerEcdsaKAccountContract;
  private feeMethod?: SponsoredFeePaymentMethod;

  constructor(private readonly opts: LedgerAztecWalletOptions) {}

  async initialize(): Promise<void> {
    // EmbeddedWallet.create(node) → register SponsoredFPC → LedgerEcdsaKAccountContract(transport, {bip32Path}) → AccountManager.create(embedded, secret, ledgerContract, salt)
  }

  getAddress(): AztecAddress;
  getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }>;

  /** Standard framework path (random-nonce OK; blind-sign on-device for one-time deploy hash). */
  deployAccount(): Promise<SubmitResult>;

  /** Pre-sign + frozen-witness submission (the §2 9-step recipe). */
  submitClearSignedIntent(call: FunctionCall): Promise<SubmitResult>;

  /** Convenience wrappers around submitClearSignedIntent. */
  dripUsdc(amount: bigint): Promise<SubmitResult>;
  transferUsdc(to: AztecAddress, amount: bigint): Promise<SubmitResult>;
}
```

The wrapper holds three references (`embedded`, `accountManager`,
`ledgerContract`) and one stateful resource (the PXE inside `embedded`).
Lifecycle: construct → `initialize()` → use → `stop()` (closes PXE). State
mutations are guarded at the UI layer, not in the wrapper (same convention
as `aztec-accelerator/packages/playground/src/aztec.ts:65-79`).

**`FrozenAuthWitnessProvider`** is ~30 LOC. The key trick is `messageHash`
parity: it verifies that what the framework asks for matches what we
pre-signed. If they diverge, throw loudly (not silently re-sign):

```ts
class FrozenAuthWitnessProvider implements AuthWitnessProvider {
  constructor(private readonly frozen: AuthWitness) {}
  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    if (!messageHash.equals(this.frozen.requestHash)) {
      throw new FrozenWitnessMismatch(messageHash, this.frozen.requestHash);
    }
    return this.frozen;
  }
}
```

**Alternative considered: precomputation cache.** Loop: pick nonce → build payload → hash → check against pre-signed → re-sign on miss. Rejected: unbounded device round-trips, "approve approve approve" UX. Frozen witness wins because we control both `payload` and `txNonce`; no iteration needed.

**Path switching.** Wrapper has two explicit entry points (`deployAccount` uses framework default → blind-sign; `submitClearSignedIntent` uses pre-sign → clear-sign). Provider has both `createAuthWit` and `createAuthWitFromIntent`; framework's default invokes the former. No mode flag — composition is at the wrapper layer.

## 5. Frontend

Single-page app, three panels stacked vertically.

```
┌──────────────────────────────────────────────────────────┐
│ Panel A: Connection                                       │
│   - Transport radio: [WebHID] [Speculos HTTP localhost]   │
│   - Connect button → fetches pubkey, shows derived addr   │
│   - State: status + truncated address + chain info        │
├──────────────────────────────────────────────────────────┤
│ Panel B: Actions                                          │
│   - Step 1: Deploy account                                │
│   - Step 2: Drip 1000 USDC into self                      │
│   - Step 3: Transfer 100 USDC to alice                    │
│   (Each disabled until prior is mined.)                   │
├──────────────────────────────────────────────────────────┤
│ Panel C: Activity log                                     │
│   - Append-only line buffer with timestamps               │
│   - Tx hashes link to https://testnet.aztecscan.xyz/...   │
└──────────────────────────────────────────────────────────┘
```

State machine (the only frontend abstraction worth being formal about):

```
idle ──connect──→ connecting ──ok──→ ready ──deploy──→ signing(deploy)
                                                          │
                            mined(deploy)←────────────────┘
                                  │
                          ──drip──┴──→ signing(drip) ──mined(drip)──→ funded
                                                                         │
                                                              ──xfer────┘
                                                                  │
                                                           signing(xfer) → done
```

State held in `useReducer` (no Zustand/Redux — overkill). No persistence; page reload → `idle` and the in-browser secret is gone (next deploy produces a different Aztec address from the same Ledger key). UI banner: "PoC — secrets are session-only."

### Transport switching

(1) **Speculos HTTP needs CORS.** Speculos `--api-port 5000` accepts APDUs but sets no CORS headers. Solution: Vite dev-server proxy (`server.proxy['/speculos']`). Production uses WebHID, not Speculos — no prod CORS issue.

(2) **WebHID needs HTTPS or `localhost`.** Vite dev on `localhost:5173` works natively. Deployed public URL would need HTTPS (Vercel / mkcert) — out of M6 scope.

### Dev vs prod

| Scenario | Transport | CORS |
|---|---|---|
| Local dev + Speculos | Speculos HTTP via Vite proxy | proxy handles |
| Local dev + real device | WebHID | native |
| Public demo URL | WebHID only (HTTPS required) | n/a |

Speculos radio disabled in prod via `VITE_TRANSPORT_MODES` env var.

### Frontend stack

React 19 + Vite 6 + TS strict + Biome per CLAUDE.md. **No Tailwind for v0** — three panels, ~20 components, plain CSS modules. Tailwind + shadcn would be right for a real wallet; faster to ship native CSS for PoC video.

## 6. Funding model

Self-drip via Dripper. Two clear-signed transactions, each call list:

**Tx 1 — drip:**
```
calls: [
  sponsor_unconditionally()                  // SponsoredFPC, PRIVATE, 0 args
  drip_to_public(USDC_addr, 1_000_000_000n)  // Dripper, PUBLIC, 2 args (u64 amount in raw u128 lane)
]
txNonce: Fr.random()
```

Device UI for Tx 1 (per M5 header + per-call template + new DRIP_PUB):
```
Header: Path, Account, Chain, Calls=2
Call 1/2: "Sponsor fee (private)"  Via: SponsoredFPC
Call 2/2: "Drip USDC"  Token: 0x2af7…47c5 (USDC)  Amount: 1000.0 USDC
Footer: outer_hash, [Approve] [Reject]
```

USDC has 6 decimals; `1_000_000_000n` raw → `1000.0` displayed. Device formatter looks up `args[0]` in registry to get decimals. New DRIPPER decoder rule: `args[0]` must be TOKEN-kind, else reject.

**Tx 2 — transfer:**
```
calls: [
  sponsor_unconditionally()                                 // 0 args, PRIVATE
  transfer_public_to_public(self, alice, 100_000_000n, 0n)  // 4 args, PUBLIC
]
```
Device UI: existing TRANSFER_PUB_PUB template → "Transfer USDC pub→pub  From: you  To: 0xalice…  Amount: 100.0 USDC". `from == consumer` invariant from M5 enforces `from = self`. Alice address hardcoded in frontend; user sees "To 0xalice…" from on-device decoder, not host.

### M5 strict-allowlist check

| Tx | Targets in registry | (kind, sel) in verbs | args_count | is_public | from==consumer |
|---|---|---|---|---|---|
| Drip | slot 2 + slot 3 | SPONSOR + DRIP_PUB | 0 + 2 | priv + pub | n/a |
| Transfer | slot 2 + slot 0 | SPONSOR + TRANSFER_PUB_PUB | 0 + 4 | priv + pub | yes |

Both pass. Only new rule: `args[0] ∈ TOKEN` for DRIP_PUB.

## 7. Lessons doc structure

Four items, one upstream PR-shaped suggestion each. Ranked by leverage.

### Lesson 1 (highest leverage): `BaseWallet.sendTx` should accept a caller-supplied `txNonce`

**Problem.** `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:180` hardcodes `txNonce: Fr.random()`. HW pre-sign is impossible: the user signs an outer_hash that depends on a nonce the framework hasn't yet picked.

**Diff (base_wallet.ts:179-184):**
```diff
-        txNonce: Fr.random(),
+        txNonce: opts.txNonce ?? Fr.random(),
```
Thread `txNonce?: Fr` through `SendMethodOptions` + `EmbeddedWallet.simulateViaEntrypoint` (`embedded_wallet.ts:265`).

**Rationale.** Caller already knows the nonce. Default preserves back-compat. Single-line change collapses our ~80 LOC workaround to: `wallet.sendTx({ from, txNonce, fee, authWitnesses: [presignedWit] })`.

### Lesson 2: `AuthWitnessProvider` should expose `createAuthWitFromIntent`

**Problem.** `entrypoints/src/interfaces.ts:62` defines only `createAuthWit(messageHash)`. `DefaultAccountEntrypoint` at `account_entrypoint.ts:141` calls only that — no path for a HW provider to receive the call intent.

**Diff:**
```diff
 export interface AuthWitnessProvider {
   createAuthWit(messageHash: Fr): Promise<AuthWitness>;
+  createAuthWitFromIntent?(intent: CallIntent): Promise<AuthWitness>;
 }
```
And in `#buildEntrypointCallData`:
```diff
-    const payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+    const payloadAuthWitness = this.auth.createAuthWitFromIntent
+      ? await this.auth.createAuthWitFromIntent({ consumer: this.address, calls, txNonce: options.txNonce, messageHash })
+      : await this.auth.createAuthWit(messageHash);
```

**Rationale.** Optional, back-compat. Clear-signing HW wallets opt in; software wallets unchanged. The intent carries enough for the device to recompute outer_hash itself.

### Lesson 3: First-class hook for "I already signed this payload"

**Problem.** No public way to inject a pre-built AuthWitness into `sendTx` without bypassing entrypoint construction. `BaseWallet.sendTx` always calls `createAuthWit` internally.

**Diff (account_entrypoint.ts ~141):**
```diff
+if (options.presignedPayloadAuthWitness) {
+  assertMatches(options.presignedPayloadAuthWitness.requestHash, messageHash);
+  payloadAuthWitness = options.presignedPayloadAuthWitness;
+} else {
+  payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+}
```

**Rationale.** Cleaner than Lesson 2: offline pre-sign + inject. Useful for HW, MPC, "approve once batch many". The assertion catches frozen-witness drift loudly.

### Lesson 4: Surface `outer_hash` preimage helpers publicly

**Problem.** `computeOuterAuthWitHash` and `EncodedAppEntrypointCalls.create(...).hash()` are framework-internal. We re-implemented them in `packages/adapter-ledger/src/l4-manifest.ts` and burned a week on L4.1 host-parity.

**Change.** Re-export from `@aztec/aztec.js`:
```ts
export { computeOuterAuthWitHash, EncodedAppEntrypointCalls } from '@aztec/entrypoints/internal';
```

**Rationale.** No internals change; stop hiding the seams external wallets demonstrably need. Saves every future HW-wallet integrator the L4.1 work.

### Why not 5

Considered "auth-witness ABI versioning for non-Schnorr keypairs". Cut — speculative; if lessons 1+2 land, lesson 2 lets the provider own its format. Reconsider M7.

## 8. Security & adversarial considerations

The browser is now an attack surface that M5 didn't have. Walking through
what changes.

**DOM-level recipient substitution.** Once recipient becomes an input field, a malicious extension or compromised JS chunk can swap the address. The device clear-sign screen is the only authority: the user reads "To: 0xalice…" *from the device*, not the browser. UI copy pins this: "Always verify the recipient on your Ledger screen before approving." The strict-allowlist + per-call decoded recipient pair makes the attack visible. **Residual risk**: users who don't read the device screen get rugged. Same problem Ethereum solved in 2017 with the same answer.

**Balance lies.** Frontend can display fake balances tempting users to authorise larger transfers. The device shows the amount being signed; the typed amount is irrelevant. The amount-on-device IS the amount transferred. Browser balance is informational only ("Balance per local PXE; verify via explorer"). Tx hashes link to `aztecscan.xyz` for independent verification.

**Front-running / re-ordering.** Not applicable v0: `drip_to_public` mints to `msg_sender`, `transfer_public_to_public` is self-contained, no front-runnable arbitrage. Flag for v1 if we add swap support.

**Malicious extension reading session secret.** The account `secret` lives in JS memory; an extension with `<all_urls>` permission can in principle read it via content scripts. v0 mitigation: session-only secret model (no localStorage / IndexedDB / cookies). Worst case: extension reads the session secret, decrypts session-time notes only. The Ledger private key is never in browser memory. **Residual**: extensions can exfiltrate session-time private balance. v0 accepts.

**Speculos-as-prod confusion.** Risk: user on deployed demo URL points page at their localhost Speculos and signs with the *emulator's* test seed. Mitigation: disable Speculos radio in prod builds via Vite define + show derived address up-front.

**What device clear-signing mitigates.** All host-side attacks on amount/recipient/symbol are visible on-device. Strict-allowlist refuses unknown calls. Args_hash recompute means a host lying about decoded fields can't trick the device into signing a different outer_hash. M5 already closed these; M6 inherits.

**Residual risks accepted for v0.** (1) Device-screen phishing — attacker constructs a legitimately-formed call that drains the user (address book / known-recipient labels are v1). (2) Supply-chain compromise of `@aztec/*` — frozen-witness defends *partly*; 7-day npm `minimumReleaseAge` + `bun audit` raise the bar but aren't bulletproof. (3) Compromised Ledger firmware — out of scope; trust assumption.

**Out of scope for v0.** CSP hardening, SRI for `@aztec/*`, origin-pinned RPC, TEE-attested signing.

## 9. Phasing, success criteria, open questions, deliverables

### Phasing

```
M6.0  Wrapper + FrozenAuthWitnessProvider, unit tests       ~1.5d
M6.1  Dripper into M5 registry (slot 3 + DRIP_PUB)          ~1d
M6.2  EmbeddedWallet integration + sandbox deployAccount    ~1.5d
M6.3  submitClearSignedIntent e2e in sandbox (drip+xfer)    ~2d
M6.4  Frontend skeleton: panels, state machine, mock mode   ~1.5d
M6.5  Frontend ↔ wrapper integration, Speculos dev run      ~1.5d
M6.6  Alpha-testnet e2e on real device, capture video       ~1d
M6.7  Lessons doc + codex review + fix loop                 ~1d

Total ~10-11 working days. Likely slip if alpha-testnet flakes in M6.6.
```

### Success criteria

1. A browser page on `localhost:5173` connects to Speculos, deploys a
   Ledger-backed Aztec account, drips 1000 USDC into it, and transfers 100
   USDC to a hardcoded recipient — all clear-signed on the emulator screen.
   All three txs land `mined` against alpha-testnet.
2. Same flow works against a real Ledger Nano S+ via WebHID.
3. The lessons doc captures 4 upstream PR-shaped suggestions with citations,
   diffs, and rationale, ready to file as GitHub issues against
   `aztec-packages`.
4. Codex post-impl review: zero BLOCKER findings.
5. Demo video (≤ 90s) captures the full flow end-to-end.

### Open questions

(a) **"Account already deployed" on reload.** With random per-session secret + salt, reloading produces a new address — deploy always succeeds. Non-issue. But if we ever persist salt: frontend must detect + skip to drip. Defer.

(b) **WebHID permission flow.** First-connect browser prompt; subsequent connects silent unless user clears permissions. Document in README; acceptable for PoC.

(c) **PXE sync time on first load.** `EmbeddedWallet.create` syncs from genesis; can take minutes on alpha-testnet. Frontend needs a sync progress indicator (reuse `aztec-accelerator/packages/playground/src/aztec.ts:152-172` pattern). UX-critical.

(d) **Block-header-stale retry.** Wrapper needs the retry logic at `aztec-accelerator/packages/playground/src/aztec.ts:326-349`. Reuse.

### Deliverables

- This file + post-consolidation `plan-final.md` + `eli5.html`
- New TS: `packages/adapter-ledger/src/wallet/{ledger-aztec-wallet,frozen-auth-witness-provider}.ts`, `src/clear_signing_v0/dripper-decoder.ts`
- Regen: `manifest.json` (slot 3 + DRIPPER), `src/clear_signing_v0/*.generated.ts`, `ledger-app/src/clear_signing_v0/*.gen.{h,c}`; `preflight.ts` (TOKEN-arg rule)
- New device: `ledger-app/src/clear_signing_v0/drip_ui.{h,c}`
- New app: `apps/demo-browser/` (~600 LOC)
- Tests: `ledger-aztec-wallet.test.ts` (sandbox), `apps/demo-browser/e2e/full-flow.spec.ts` (Playwright+Speculos)
- Docs: `implementations-plan/m6-aztec-wallet-wrapper/{lessons/phase-N.md,upstream-prs.md}`, updated `index.md`

### One thing I'd push back on the user about

The demo is drip+transfer. If we have 11 days, that's the right scope.
**If** the testnet sync time on first load proves to dominate the demo
video runtime (>60s of "syncing PXE…" before any user action), I'd advocate
cutting the drip step and pre-funding the account before recording — gives
us a snappier video at the cost of "look, no pre-existing funds" narrative.
Decide after M6.4 hands-on testing. Flag this back to the user at the
consolidation gate.

---

[opus plan ends]
