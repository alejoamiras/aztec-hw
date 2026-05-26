I couldn’t write `/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/implementations-plan/m6-aztec-wallet-wrapper/codex-plan.md` because this session is read-only, so I’m returning the plan here.

## 1. Problem statement

M6 is not a crypto milestone. The cryptography and on-device semantics are already proven. M6 is a transaction assembly and submission milestone: build a browser session that can derive a real Aztec account from an ephemeral browser secret, assemble the exact sponsored call list, choose the `txNonce` before signing, get a Ledger-produced payload witness, and then prove and broadcast that tx to alpha-testnet.

The trap is misframing this as an “account contract” problem. It is not. The account contract seam already exists in `packages/adapter-ledger/src/account-contract.ts`, and upstream `DefaultAccountContract` already converts an arbitrary auth-witness provider into a real `BaseAccount` through [accounts/src/defaults/account_contract.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/accounts/src/defaults/account_contract.ts:25). The actual blocker is upstream wallet orchestration: `BaseWallet` chooses a fresh random `txNonce` internally in [base_wallet.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:163), and `DefaultAccountEntrypoint` always asks for a hash-based witness in [account_entrypoint.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:123).

The correct M6 scope is the one you already fixed on: deploy once with blind-signing, then self-drip public USDC, then transfer public USDC to Alice, both clear-signed. That is the right video scope because it proves end-to-end on-chain submission while avoiding private-note/authwit side quests that would turn M6 into a different project.

## 2. Architecture

The public abstraction should not be `LedgerAztecWallet`. That name is too ambitious and too misleading. This thing is not a drop-in Aztec `Wallet`; it is a session-local orchestration wrapper around one Ledger-backed account. I would name it `AztecLedgerSession`.

Ownership should be split cleanly:

- Browser owns the Aztec `secret`, derived protocol keys, PXE, proving, contract registration, node RPC, and transient app state.
- Ledger owns only the secp256k1 signing key and approval UI.
- Aztec framework still owns address derivation, entrypoint encoding, and tx proving primitives.

The core runtime should be:

- `SessionEmbeddedWallet`: a tiny subclass of browser `EmbeddedWallet` that only exposes public helpers for fee completion, proving, and broadcast, instead of forcing M6 to cast through protected fields.
- `AccountManager.create(...)` for deriving `CompleteAddress`, deploy salt, and deploy method, reusing [account_manager.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/aztec.js/src/wallet/account_manager.ts:32).
- `LedgerEcdsaKAccountContract` unchanged for deploys and normal blind-sign flow.
- `FrozenAuthWitnessProvider`: a one-shot provider that returns one precomputed `AuthWitness` for one exact `outer_hash`, then expires.
- A one-shot `BaseAccount` built from the existing `CompleteAddress` plus `DefaultAccountEntrypoint`, reusing the same seam upstream uses in [account_contract.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/accounts/src/defaults/account_contract.ts:25).

That last point is the key architectural stance. The frozen witness does not need to “plug into” `EmbeddedWallet`’s stored-account machinery. It plugs in one layer lower, at the `BaseAccount` seam. `EmbeddedWallet` is reused for browser PXE and proving. `AccountManager` is reused for address and deploy flow. `DefaultAccountEntrypoint` is reused for tx-request construction. The only thing swapped is where the payload auth witness comes from.

## 3. Adding Dripper to the M5 registry

Add Dripper now. For this demo, that is cleaner than any helper-wallet workaround.

I would not add both Dripper verbs. Add only `drip_to_public`. `drip_to_private` is real, but it reopens private-note scope for zero demo value. The current video target is public drip plus public transfer. Keep the registry as narrow as the demo.

Concrete changes:

- Add a new registry slot for Dripper at the pinned faucet deployment address from `nulo-2/packages/faucet/src/contracts/deployments.json:28-33`.
- Extend manifest/codegen kind enum with `DRIPPER`.
- Add one verb: `drip_to_public(AztecAddress,u64)`, public.
- Cross-check against the pinned Dripper artifact exactly the same way the current generator cross-checks Token and SponsoredFPC in `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts`.

Device/UI changes are smaller than they look. The existing amount formatter in `ledger-app/src/clear_signing_v0/format.c:23` already handles `u64` as a subset of the current `u128` path, so I would not add a separate numeric formatter. The real change is semantic decoding:

- interpret `args[0]` as token address,
- interpret `args[1]` as amount,
- look up `args[0]` in the existing TOKEN registry,
- render `Drip USDC` / `To: you` / `Amount: 1000.0 USDC`,
- reject if the token arg is not a registered token.

There is no cleaner alternative to the one-call drip. A helper wallet that drips then transfers is worse operationally and weaker as a demo.

## 4. The wrapper class

Public API should stay narrow:

```ts
class AztecLedgerSession {
  static connect(opts: ConnectOptions): Promise<AztecLedgerSession>;

  readonly address: AztecAddress;
  readonly completeAddress: CompleteAddress;

  deploy(): Promise<TxReceipt>;
  dripUsdc(amount: bigint): Promise<TxReceipt>;
  transferUsdc(to: AztecAddress, amount: bigint): Promise<TxReceipt>;
  getPublicUsdcBalance(): Promise<bigint>;
  disconnect(): Promise<void>;
}
```

Internal state:

- `transport`
- `embedded: SessionEmbeddedWallet`
- `ledgerProvider: LedgerEcdsaKAuthWitnessProvider`
- `accountManager`
- `secret`
- `salt`
- `completeAddress`
- registered contract instances for USDC, Dripper, SponsoredFPC
- an in-flight mutex

Lifecycle:

1. `connect()`
   - create browser `EmbeddedWallet` with `ephemeral: true`
   - build `LedgerEcdsaKAccountContract`
   - create `AccountManager` from the browser secret and Ledger-backed contract
   - register account + known contracts with PXE
   - register sender
   - preflight `getContractMetadata` for USDC, Dripper, SponsoredFPC and fail on unpublished or updated contracts

2. `deploy()`
   - use `accountManager.getDeployMethod()`
   - sponsored fee
   - blind-sign only

3. `dripUsdc()` / `transferUsdc()`
   - build `ExecutionPayload` via normal Aztec contract interaction `.request({ fee })`
   - choose `txNonce` now
   - convert `exec.calls` into local `CallIntent`
   - clear-sign through `createAuthWitFromIntent(intent)`
   - arm `FrozenAuthWitnessProvider`
   - create one-shot `BaseAccount`
   - call `account.createTxExecutionRequest(...)` with the chosen `txNonce`
   - prove and broadcast manually

That is the right blind-sign vs clear-sign split. Deploy stays on the legacy `createAuthWit(messageHash)` path. Drip and transfer go through the strict M5 clear-signing path.

## 5. Frontend

Do not mutate `apps/demo`. That is a CLI artifact. Add a new app, `apps/demo-browser`, as React + Vite + TS.

Single page, four blocks:

- Connection: transport switch, connect button, derived address, deploy status
- Account: address, pubkey fingerprint, public USDC balance
- Actions: `Deploy`, `Drip 1000 USDC`, transfer form with prefilled Alice
- Activity: tx hashes, receipts, device/log status, errors

State model should be explicit and boring:

- `transportMode`
- `session`
- `accountStatus`
- `balance`
- `pendingAction`
- `txLog`
- `error`

Transport coexistence:

- `Speculos` is dev-only and should talk to a Vite proxy such as `/speculos`, not directly to `http://localhost:5001`, to avoid CORS pain.
- `WebHID` is the production path and requires Chromium plus a secure context (`https://` or `http://localhost`).
- Runtime switch is fine, but the app should make the distinction visible: “Speculos (dev)” and “Ledger via WebHID”.

One local refactor is mandatory before this app exists: `packages/adapter-ledger/src/provider.ts:109-143` currently casts the transport to `SpeculosTransport`. That is acceptable in tests and wrong for real-device browser support. M6 should widen the transport boundary so `autoConfirm` is optional transport behavior, not a hard cast.

Also: “no localStorage” is not enough. The wrapper must create the browser wallet with `ephemeral: true` so neither wallet DB nor PXE state persists across reloads.

## 6. Funding model

Use self-drip. It is the right choice.

Call list for drip:

1. `SponsoredFPC.sponsor_unconditionally()`
2. `Dripper.drip_to_public(USDC, 1_000_000_000)`

Call list for transfer:

1. `SponsoredFPC.sponsor_unconditionally()`
2. `USDC.transfer_public_to_public(self, alice, amount, nonce)`

That ordering is stable because `ContractFunctionInteraction.request()` prepends the fee payload in [contract_function_interaction.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/aztec.js/src/contract/contract_function_interaction.ts:97), and `mergeExecutionPayloads()` preserves array order in [execution_payload.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/stdlib/src/tx/execution_payload.ts:37).

The current M5 strict allowlist already accepts the transfer call list. After adding Dripper, it also accepts the drip call list. The internal `mint_to_public` call is inside the Dripper contract; it is not present in `exec.calls`, so the device only needs to understand SponsoredFPC plus Dripper. That is correct.

One extra hardening rule belongs in M6: before enabling either button, query `wallet.getContractMetadata(...)` for the pinned USDC, Dripper, and SponsoredFPC addresses. If any is unpublished or `isContractUpdated`, fail closed. Device registry pinning is address-based, not class-hash-based.

## 7. Lessons-doc structure

I would stop at **three** PR suggestions. A fourth would be lower leverage and too tied to this PoC.

1. **Caller-supplied nonce / prepare API**
   - Problem: [base_wallet.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:163) hardcodes `txNonce: Fr.random()`.
   - Proposed change: add `sendTx(exec, { ..., txNonce })` or better `prepareTxExecutionRequest(exec, opts)` returning `{ txRequest, txNonce, feeOptions }`.
   - Rationale: hardware-wallet payload signing requires the nonce before signing.

2. **Intent-aware payload auth witness provider**
   - Problem: [interfaces.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/entrypoints/src/interfaces.ts:63) only exposes `createAuthWit(messageHash)`, and [account_entrypoint.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:139) always discards structure and calls it.
   - Proposed change: optional `createPayloadAuthWit(ctx)` where `ctx` includes `calls`, `txNonce`, `consumer`, `chainInfo`, and `messageHash`.
   - Rationale: lets hardware wallets clear-sign exact payload semantics without forking entrypoint encoding.

3. **Public split between prepare and prove/send**
   - Problem: [embedded_wallet.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/wallets/src/embedded/embedded_wallet.ts:126) simulates and enriches, then falls back into `BaseWallet.sendTx()` in [base_wallet.ts](/Users/alejoamiras/Projects/aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:434), forcing wrappers to duplicate internal flow.
   - Proposed change: expose `prepareExecution(...) -> { finalExecutionPayload, gasSettings, txRequest, offchainEffects }` and `proveAndSend(txRequest, opts)`.
   - Rationale: this helps not just hardware wallets, but any advanced wallet flow that needs to inspect or replace one step.

## 8. Security & adversarial

M6 materially changes the threat model because the browser becomes the live coordinator, not just a script runner. The browser now holds the Aztec `secret` and derived protocol keys in JS memory. If the page, dependency graph, or a malicious extension compromises that memory, the attacker can exfiltrate the privacy side of the account. They still do not get the Ledger’s K1 signing key, so they cannot directly authorize account actions on their own, but privacy loss is real and should be treated as a first-class cost. For this reason, session-only state matters: no localStorage, no persistent IndexedDB wallet DB, no persisted PXE.

What clear-signing does buy you is exact transaction integrity at the payload layer. Recipient substitution, amount substitution, contract substitution, selector substitution, hidden-call insertion, and fee-call confusion all collapse to “produce a different outer hash,” which the device will reject. The on-device registry owns token identity and decimals. The device also sees the real call count, which matters because sponsored execution is inherently multi-call. This is the core security win of M6 over a browser-only hot wallet.

What it does not buy you is trustworthy chain state. The browser and RPC can still lie about balances, tx status, whether the account is deployed, whether the transfer already landed, or whether the user “needs” to drip again. The device does not verify balances, contract code hashes, or note state. The biggest live-net residual risk is contract drift: if the pinned USDC, Dripper, or SponsoredFPC address is updated to a new class with the same selector surface, the device could still render familiar semantics against changed code. M6 should therefore fail closed on `isContractUpdated` from `getContractMetadata()` before any clear-sign flow starts.

Speculos deserves a separate warning. It is a development transport over HTTP, not a security boundary. If you proxy it through Vite, that is fine for local development and demos. It is not equivalent to a real device over WebHID. The demo app should label Speculos mode as dev-only and never pretend otherwise.

Finally, public drip and public transfer are public. They are observable and front-runnable once broadcast. Clear-signing ensures the user signed exactly this tx; it does not make the tx private, and it does not prevent the host from delaying or withholding broadcast after approval.

## 9. Phasing + success criteria + open questions + deliverables

**Phase 1: adapter and registry**
- Refactor the transport/provider boundary for WebHID.
- Add Dripper `drip_to_public` to manifest, codegen, preflight, device UI.
- Add contract-metadata fail-closed checks.

Success:
- Speculos can clear-sign a sponsored Dripper payload locally.
- Unit tests cover Dripper decode and token-arg resolution.

**Phase 2: wrapper and testnet submission**
- Add `SessionEmbeddedWallet`.
- Add `AztecLedgerSession`.
- Deploy via blind-sign.
- Submit sponsored drip and sponsored public transfer via chosen `txNonce` + one-shot frozen witness flow.

Success:
- Speculos deploys the account and both txs reach `mined` on `https://rpc.testnet.aztec-labs.com`.

**Phase 3: browser demo and lessons doc**
- Ship `apps/demo-browser`.
- Add WebHID transport and runtime switch.
- Write lessons doc with the three PR-shaped upstream suggestions above.

Success:
- Real Ledger over WebHID repeats the same drip and transfer flow.
- Session reload forgets the account secret.
- Video flow is one page, one connect step, one blind deploy, two clear-signed txs.

Open questions:
- Whether the current browser PXE bundle under `^4.2.1` needs any Vite worker/polyfill adjustments.
- Whether the pinned Dripper artifact path should come from Wonderland’s dist export or a local copied artifact.
- Whether Alice should be hardcoded for the demo or just prefilled and editable. I would prefill and validate.
- Whether to expose a generic `submitClearSigned(exec)` later. I would not in M6.

Deliverables:
- `apps/demo-browser`
- `packages/adapter-ledger/src/webhid-transport.ts`
- `packages/adapter-ledger/src/frozen-auth-witness-provider.ts`
- `packages/adapter-ledger/src/session-embedded-wallet.ts`
- Dripper registry/codegen/device updates
- a gated alpha-testnet e2e script
- the lessons doc with three concrete Aztec PR proposals