# M6 — AztecWallet wrapper + frontend PoC deep plan

## North-star

A 30-second video of a real Ledger device (or Speculos emulator) clear-signing
**two** alpha-testnet transactions in succession:

1. `Drip 1000 USDC into you` — Ledger shows "Drip USDC, Amount: 1000.0 USDC"
2. `Transfer 100 USDC to alice` — Ledger shows "Transfer pub->pub USDC, From: you, To: 0xabcd…, Amount: 100.0 USDC, Mode: PUBLIC"

Both txs land `mined` on `https://rpc.testnet.aztec-labs.com`, viewable on
`https://testnet.aztecscan.xyz`. Browser shows Aztec address, tx hashes,
balance updates.

Secondary deliverable: a lessons doc at `lessons-for-aztec-team.md` —
3-4 concrete PR-shaped suggestions for `aztec-packages`, each with file:line
citations, proposed API diffs, and before/after code snippets.

## Pinned sources

- aztec-packages pin: `2770bcb82d40323060c2f9c71aaf293b640efbef` (kept from L4/M5)
- aztec.js + family: `^4.2.1` (current; matches the rest of the repo)
- aztec-standards: `4.2.0-aztecnr-rc.2` (from M5)
- alpha-testnet RPC: `https://rpc.testnet.aztec-labs.com`
- SponsoredFPC salt on testnet: `0x2a0f57c183e73d3390f80b6b28e57593d6faea3517eb57604491220173ad2f32`
  (per `aztec-accelerator/packages/playground/package.json:dev:testnet`)
- aztecscan: `https://testnet.aztecscan.xyz`

## 1. Architecture

### Key model the Ledger participates in (clarifying the user's "3/4 keys host-side" framing)

An Aztec EcdsaK account has FIVE secret quantities. The breakdown:

| Quantity | Where it lives | Derived from |
|---|---|---|
| `secret` (master) | **Browser** (in-memory per session) | random Fr at session start |
| `ivsk_m` (incoming viewing) | **Browser** | derived from `secret` |
| `ovsk_m` (outgoing viewing) | **Browser** | derived from `secret` |
| `nsk_m` (nullifier secret) | **Browser** | derived from `secret` |
| K1 signing private key | **Ledger device only** | BIP-32 derivation from device seed |

The browser-held `secret` + Ledger-held K1 pubkey jointly determine the Aztec
address (via the EcdsaKAccount constructor that takes `signing_pubkey_x, y`).
Code path: `EmbeddedWallet` derives keys 1-4 from `secret` internally
(`embedded_wallet.ts:298-313`); we override the K1 contract to build it from
the Ledger pubkey instead of a private-key buffer.

### Three components

```
┌──────────────────────────────────────────────────────────────────┐
│ apps/wallet-demo  (React + Vite + TS, browser-only)              │
│  ├─ Transport switch: WebHID ⟷ Speculos HTTP                     │
│  ├─ Connect → derive Aztec address                               │
│  ├─ Deploy account button                                        │
│  ├─ Drip USDC button (clear-signed)                              │
│  ├─ Transfer USDC form (clear-signed)                            │
│  └─ Balance display + tx hash links to aztecscan                 │
└────────────────────────┬─────────────────────────────────────────┘
                         │ uses
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ packages/adapter-ledger/src/ledger-aztec-wallet.ts               │
│  LedgerAztecWallet (the wrapper)                                 │
│  ├─ wraps EmbeddedWallet (in-browser PXE + prover)               │
│  ├─ ensureAccountDeployed()  → blind-sign deploy (one-time)      │
│  ├─ dripUSDC(amount)         → clear-signed drip                 │
│  ├─ transferUSDC(to, amount) → clear-signed transfer             │
│  ├─ getUSDCBalance()         → public read                       │
│  └─ Internally: FrozenAuthWitnessProvider pattern                │
└────────────────────────┬─────────────────────────────────────────┘
                         │ uses
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ packages/adapter-ledger/src/webhid-transport.ts (NEW)            │
│  Wraps @ledgerhq/hw-transport-webhid → matches LedgerTransport    │
│  iface so the existing LedgerProvider works in-browser as-is.    │
└──────────────────────────────────────────────────────────────────┘
```

### The wrapper's headline method (transferUSDC)

Codex confirmed the upstream submission gap: `BaseWallet.sendTx`'s random
`txNonce` (`base_wallet.ts:180`) prevents pre-signing. The wrapper goes one
layer down:

```ts
async transferUSDC(to: AztecAddress, amount: bigint): Promise<TxHash> {
  // 1. Build the call list via Aztec's own API (sponsor merged in)
  const usdc = await TokenContract.at(USDC_ADDR, this.inner);
  const interaction = usdc.methods.transfer_public_to_public(
    this.address, to, amount, 0n,
  );
  const exec = await interaction.request({ fee: { paymentMethod: this.sponsoredFpc } });
  // exec.calls = [sponsor_unconditionally(), transfer_public_to_public(...)]

  // 2. Pick our own txNonce (the load-bearing piece)
  const txNonce = Fr.random();

  // 3. Project Aztec's FunctionCall[] into our CallIntent shape
  const intent: CallIntent = {
    consumer: this.address,
    chainInfo: await this.inner.getChainInfo(),
    calls: exec.calls.map(fc => functionCallToStructured(fc, txNonce)),
  };

  // 4. Pre-sign via Ledger clear-signing (device shows decoded fields)
  const authWit = await this.ledgerProvider.createAuthWitFromIntent(intent);

  // 5. Wrap into a FrozenAuthWitnessProvider; swap into the account contract
  const frozenContract = new LedgerEcdsaKAccountContract(
    /* transport */ frozenWitnessTransport(authWit),
    /* opts */ { bip32Path: this.bip32Path }
  );
  const account = await this.accountManager.getAccount();

  // 6. Build tx request with OUR fixed txNonce
  const txRequest = await account.createTxExecutionRequest(
    exec, /* gasSettings */, this.chainInfo,
    { txNonce, cancellable: false, feePaymentMethodOptions: undefined },
  );

  // 7. Prove + send via PXE/node directly (bypassing BaseWallet.sendTx)
  const provenTx = await this.embedded.proveTx(txRequest, /* opts */);
  const txHash = await this.embedded.sendTx(provenTx);

  // 8. Wait for inclusion, return
  await this.waitForTx(txHash);
  return txHash;
}
```

The `FrozenAuthWitnessProvider` (NEW class) asserts the framework's computed
`messageHash` exactly equals the `requestHash` we pre-signed. If a glitch or
re-ordering changes the hash, the provider throws — we never accidentally
sign a different tx than what the device displayed.

### What deploy looks like (blind-sign one-time)

`ensureAccountDeployed()` uses the framework's normal path. The auth provider
is the standard `LedgerEcdsaKAuthWitnessProvider.createAuthWit(messageHash)`
which goes through the L2 `INS_SIGN_OUTER_HASH` blind-sign INS. Device shows
the outer_hash as hex; user confirms once. Sponsored FPC pays for the deploy.

This is OK because (a) the deploy outer_hash binds the user's account
parameters (constructor args + salt + chainInfo), so the only thing a user
needs to verify is "yes this is my account being created" — verifiable by
inspecting the displayed hash bytes; (b) it's a one-time event, not a
recurring tx; (c) it's the established pattern.

## 2. Funding model (the user's "use sponsored FPC" constraint)

Sponsored FPC pays the gas for every tx in this PoC (deploy + drip + transfer).
But Sponsor only pays GAS — not the USDC token balance itself. For the
demo's headline transfer, the Ledger account needs USDC first.

Solution: **the Ledger account self-drips**. The Dripper contract's
`drip_to_public(token, amount)` mints to `msg.sender`. So the Ledger account
calls `Dripper.drip_to_public(USDC, 1000_000_000)` (1000 USDC in atomic units)
via clear-signing → Ledger account ends up with 1000 USDC.

This requires adding **Dripper to the clear-signing registry** (we have 2
EMPTY slots; use one). New verbs: `DRIP_PUBLIC` and `DRIP_PRIVATE`. Codegen
extends the existing pipeline.

## 3. Adding Dripper to the registry

Dripper address (testnet): `0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070`
(per `nulo-2/.../deployments.json:29` — already in the M5 manifest as kind=SPONSOR
oops wait, it's there but as kind=SPONSOR pointing to SponsoredFPC; the Dripper
needs its own slot).

Wait — re-checking the M5 manifest:
- slot 0: USDC (TOKEN)
- slot 1: ETH (TOKEN)
- slot 2: **SponsoredFPC** (SPONSOR), address `0x254082…1257`
- slots 3-4: EMPTY

Good. Dripper isn't there yet. We add it to slot 3 with `kind=DRIPPER`. New
selectors: `drip_to_public(AztecAddress,u64)` and `drip_to_private(AztecAddress,u64)`.

Note: Dripper's amount is `u64`, not `u128` — the format helper needs to
accept either (or we add a verb-table-level type hint).

## 4. Phases

```
M6.0  Manifest extension: Dripper + drip_to_public + drip_to_private
      - Update manifest.json (slot 3 → DRIPPER, new verbs)
      - Codegen: extend cs_format_amount to accept u64 (high 24 bytes zero)
      - Cross-check passes (CI green)
      - Device UI: handle CS_VERB_DRIP_PUB / PRIV templates
      ~0.5d

M6.1  WebHID transport
      - packages/adapter-ledger/src/webhid-transport.ts
      - matches LedgerTransport interface
      - browser-only (skip in unit tests)
      ~0.5d

M6.2  LedgerAztecWallet wrapper (the load-bearing piece)
      - packages/adapter-ledger/src/ledger-aztec-wallet.ts
      - wraps EmbeddedWallet
      - FrozenAuthWitnessProvider class
      - bypasses BaseWallet.sendTx, drives account.createTxExecutionRequest
        directly with our chosen txNonce
      - Methods: connect, ensureAccountDeployed, dripUSDC, transferUSDC,
                getUSDCBalance
      ~1.5d

M6.3  Frontend (apps/wallet-demo/)
      - Vite + React + TS strict
      - Transport selector (WebHID / Speculos)
      - Connect → derive Aztec address from device pubkey + ephemeral secret
      - 3 action buttons: Deploy / Drip / Transfer
      - Tx hash + aztecscan link display
      - Balance display
      ~1.5d

M6.4  Run end-to-end against alpha-testnet
      - Speculos: drip + transfer both land mined
      - WebHID against real device: same flow
      - Capture screen recording (video)
      ~0.5d

M6.5  Lessons doc for Aztec team
      - 3-4 PR-shaped suggestions:
        a) `AuthWitnessProvider.createAuthWitFromIntent?(intent)` (optional)
        b) `sendTx` accepts `opts.txNonce`
        c) `sendTx` accepts `opts.payloadAuthWitness?: AuthWitness`
        d) Public helper to expose payload-outer-hash computation outside
           DefaultAccountEntrypoint
      - Each with file:line in aztec-packages + before/after code
      ~0.5d

M6.6  Codex post-impl review + fixes
      ~0.5d

Total: ~5 working days
```

## 5. Tech-stack details

### Frontend build

Vite handles aztec.js + bb-prover bundling. The accelerator playground
proves this works (`aztec-accelerator/packages/playground/package.json`).

Required deps for apps/wallet-demo:
```json
{
  "dependencies": {
    "@aztec/accounts": "^4.2.1",
    "@aztec/aztec.js": "^4.2.1",
    "@aztec/bb-prover": "^4.2.1",
    "@aztec/foundation": "^4.2.1",
    "@aztec/kv-store": "^4.2.1",
    "@aztec/noir-acvm_js": "^4.2.1",
    "@aztec/noir-contracts.js": "^4.2.1",
    "@aztec/noir-noirc_abi": "^4.2.1",
    "@aztec/protocol-contracts": "^4.2.1",
    "@aztec/pxe": "^4.2.1",
    "@aztec/stdlib": "^4.2.1",
    "@aztec/wallets": "^4.2.1",
    "@ledgerhq/hw-transport-webhid": "^6",
    "@aztec-hwwallet-poc/core": "workspace:*",
    "@aztec-hwwallet-poc/adapter-ledger": "workspace:*",
    "react": "^19",
    "react-dom": "^19"
  }
}
```

### WebHID + Speculos: CORS

WebHID requires `https://` or `http://localhost`. Vite dev runs on
`http://localhost:5173` — OK. Speculos REST is on `http://localhost:5001`
— different origin, will trigger CORS preflight. Either:
- (a) Vite proxy: route `/speculos/*` to `http://localhost:5001` (browser
      sees same-origin), or
- (b) Speculos has `--allow-cors` flag (need to verify).

Going with (a); it's the standard pattern and lets us strip the `:5001`
detail from frontend code.

### Test scope

- **Adapter unit tests**: keep the existing M5 suite (74 pass) green
- **LedgerAztecWallet unit test**: mock EmbeddedWallet + LedgerTransport;
  verify the wrapper builds the right CallIntent + FrozenWitness
  assertions. ~4-6 tests.
- **Frontend**: skip Playwright for v0; visual confirmation through the
  recorded demo is the test artifact.

## 6. Security & adversarial considerations

### Threat model additions vs M5

| Attack | Defense |
|---|---|
| Browser-injected fake address (host substitutes recipient) | Device's clear-signing UI shows the recipient address; user reads it on the device screen before approving. |
| FrozenAuthWitnessProvider hash mismatch (framework computes different hash than we pre-signed) | `provider.createAuthWit(framework_hash)` asserts `framework_hash == requestHash_we_signed_for`; throws on mismatch. **The provider is BYPASSED by the framework if it doesn't match — meaning the witness is never used to sign something we didn't authorize.** |
| Browser localStorage attack reading `secret` | Mitigated by ephemeral-per-session choice (the user already picked this). |
| WebHID/Speculos transport spoofing | The on-device review is the trust root; transport spoofing doesn't bypass the device approval. |
| Stale Aztec address (host claims a different account address than the device pubkey implies) | The address is computed from `secret + signing_pubkey + salt` deterministically; browser displays it and the user can verify it matches the device pubkey via a "show me my address" round-trip. |

### Risks we're explicitly NOT addressing in v0

- **Phishing via attacker-controlled frontend**: the browser code is trusted.
  Mitigating this requires a hardware-attested origin policy (think Ledger
  Live's signed-payload-from-known-domain pattern). Out of scope.
- **Front-running on the recipient field**: even if the device shows the
  correct recipient, the attacker can withdraw a transfer via a private
  flow before the tx mines. Aztec's privacy primitives address some of
  this; not the wallet layer's concern.

## 7. Lessons doc structure

`implementations-plan/m6-aztec-wallet-wrapper/lessons-for-aztec-team.md`:

```
# Lessons from a Ledger hardware-wallet PoC for the Aztec wallet API

## TL;DR
3-4 minimal, additive aztec.js changes would unlock the "wallet sits on
another device" pattern. Each is small, backward-compatible, and matches
the patterns the EVM ecosystem painfully evolved to over 2018-2024.

## #1 — `AuthWitnessProvider.createAuthWitFromIntent` (optional method)
Problem statement, citation, proposed diff, before/after.

## #2 — `sendTx(payload, { txNonce })` — caller-supplied nonce
Same shape.

## #3 — `sendTx(payload, { payloadAuthWitness })` — caller-supplied witness
Same shape.

## #4 — Public helper for payload-outer-hash computation
Same shape — currently buried in DefaultAccountEntrypoint.

## Appendix: how our PoC works around the gaps today
Bypassing BaseWallet.sendTx, bypassing the normal entrypoint flow,
maintaining a FrozenAuthWitnessProvider — none of this should be necessary
for a hardware wallet integration.
```

## 8. Success criteria

1. A real alpha-testnet tx (sponsored) signed by Ledger via clear-signing
   lands `mined`. tx hash captured.
2. The device displays decoded fields (Amount, To, Mode) — verified by
   screen recording.
3. Both Speculos and WebHID transports work from the same frontend.
4. The wrapper exposes a 3-method API (`drip`, `transfer`, `getBalance`)
   that hides all the bypass plumbing from the frontend.
5. Lessons doc is concrete enough that an Aztec engineer could open a PR
   from it.
6. M5 test suite stays green (74 pass / 0 fail).
7. Both device builds clean.

## 9. Open questions

1. Vite + bb-prover WASM bundling — does aztec.js's `@aztec/bb-prover` need
   any special Vite config (top-level await, WASM externals)? The accelerator
   playground works; copy its `vite.config.ts` patterns.
2. Frozen-witness-with-framework: does the framework's `createAuthWit` call
   pass us the SAME messageHash we'd compute from our CallIntent? Codex's
   prior response says yes (encoding.ts matches our buildL4Manifest
   byte-for-byte). Verify with one debug-print in the first end-to-end.
3. EcdsaKAccount deploy via SponsoredFPC: codex's M5.6 gap doc said yes.
   First test confirms.
4. WebHID-vs-Speculos transport switching: do we want a runtime flag
   (?transport=speculos / ?transport=webhid) or build-time? Runtime is
   friendlier for the demo.
5. Aztec testnet stability + sponsor availability: handle both gracefully
   in the frontend (errors → user-readable message + retry).

## 10. Status

```
[✓] 0. Clarifying questions (Drip+Transfer / ephemeral / Speculos+WebHID / PR-shaped lessons)
[▶] 1. Parallel plans (main + codex + opus)
[ ] 2. Consolidate
[ ] 3. Final codex critique
[ ] 4. Approval gate
[ ] 5. Implementation (M6.0..M6.6)
[ ] 6. Record video / capture screens
[ ] 7. Publish lessons doc
```
