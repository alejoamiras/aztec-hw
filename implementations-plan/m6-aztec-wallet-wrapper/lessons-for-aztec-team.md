# Aztec wallet-SDK: 4 hardware-wallet integration gaps

**Audience**: Aztec protocol team (framework + wallet-SDK maintainers).

**Author context**: built an Aztec Ledger PoC that produces clear-signed
ECDSA-K1 signatures the protocol's barretenberg verifier accepts (74/74
parity + integration tests against alpha-testnet). The signing crypto
works; the framework's wallet pipeline does NOT cleanly compose with
hardware-wallet pre-signing.

**Outcome we want**: lessons 1+2 land as upstream PRs in `aztec-packages`
so the next HW-wallet integrator does NOT have to:
- bypass `BaseWallet.sendTx` and re-implement prove+send (~80 LOC + 1 day)
- recompute `outer_hash` from scratch in their own code (~5 days of host-
  parity testing to verify they match Aztec's preimage byte-for-byte)
- pin a `FrozenAuthWitnessProvider` workaround that breaks the moment
  `account_entrypoint.ts` changes its hashing approach

Each lesson is one paragraph problem statement, file-line citations, a
proposed diff, before/after caller code, and rationale. Ranked by leverage
(most impactful first).

---

## Lesson 1 — `BaseWallet.sendTx` should accept a caller-supplied `txNonce`

**Problem**:
`yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:180` hardcodes
the tx-nonce that gets folded into the authwit preimage:

```ts
const executionOptions = {
  ...
  txNonce: Fr.random(),    // ← always random; no caller override
  ...
};
```

Hardware wallet pre-signing is **impossible** if the framework picks
the nonce after the user has already approved. The user signs an
outer_hash that depends on a nonce the framework hasn't decided yet.

**Citations**:
- `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:180`
  — the offending line
- `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:131`
  — where `txNonce` enters `EncodedAppEntrypointCalls.create(calls, txNonce)`
- `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:139`
  — where the resulting `payloadHash` becomes the auth witness preimage

**Proposed diff** (`base_wallet.ts:180`):
```diff
-      txNonce: Fr.random(),
+      txNonce: opts.txNonce ?? Fr.random(),
```

Thread `txNonce?: Fr` through `SendMethodOptions` (already in scope at
the call site) and through `EmbeddedWallet.simulateViaEntrypoint` so the
estimation pass uses the same value.

**Before (HW-wallet caller today)**:
```ts
// Bypass BaseWallet.sendTx entirely. Reimplement prove+send manually
// because there's no way to inject a chosen nonce.
const txNonce = Fr.random();
const intent = projectCallIntent(exec, address, chainInfo);
const witness = await ledger.createAuthWitFromIntent(intent);
const frozen = new FrozenAuthWitnessProvider(witness, witness.requestHash);
const entrypoint = new DefaultAccountEntrypoint(address, frozen);
const txRequest = await entrypoint.createTxExecutionRequest(
  exec, gasSettings, chainInfo,
  { txNonce, cancellable: false, feePaymentMethodOptions: undefined },
);
const provenTx = await pxe.proveTx(txRequest, [address]);
const tx = await provenTx.toTx();
await aztecNode.sendTx(tx);
const receipt = await waitForTx(aztecNode, tx.getTxHash());
```
~30 LOC + ~80 LOC of intent projection + frozen-witness plumbing.

**After**:
```ts
const txNonce = Fr.random();
const witness = await ledger.preSignForNonce(exec, txNonce);
await wallet.sendTx(exec, {
  from: address,
  txNonce,
  authWitnesses: [witness],
});
```
~5 LOC. The framework's prove+send path is reused unchanged.

**Rationale**: one-line change preserves backwards compat (default to
`Fr.random()` when absent). Unlocks every HW-wallet flow that needs
deterministic outer_hash without forking the SDK.

---

## Lesson 2 — Extend `AuthWitnessProvider` with an intent-aware variant

**Problem**:
`yarn-project/entrypoints/src/interfaces.ts:62`:
```ts
export interface AuthWitnessProvider {
  createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness>;
}
```

The provider only sees a 32-byte hash. The framework already KNOWS the
structured call list (it just hashed it at `account_entrypoint.ts:131`),
but discards that context before calling the provider. So a HW wallet
gets:
- "sign this opaque hex blob" (terrible UX)

instead of:
- "sign Transfer 1.5 USDC, from you, to 0xabcd…" (clear-signing)

Every HW-wallet integrator who wants clear-signing has to recompute the
outer_hash preimage in their own code (see Lesson 4) and bind to it via
a frozen-witness shim. This is the most load-bearing of the four
lessons in terms of *user-facing* impact.

**Citations**:
- `aztec-packages/yarn-project/entrypoints/src/interfaces.ts:62`
  — the narrow interface
- `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:131,139,141`
  — where the context exists but is dropped

**Proposed diff** (`interfaces.ts:62`):
```diff
 export interface AuthWitnessProvider {
   createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness>;
+  /**
+   * Optional alternate path: providers that need the structured intent
+   * (for clear-signing on HW wallets, MPC, or signed-history audits)
+   * can implement this. The framework calls it INSTEAD of `createAuthWit`
+   * when present.
+   */
+  createAuthWitFromIntent?(ctx: AuthWitnessIntentContext): Promise<AuthWitness>;
 }
+
+export interface AuthWitnessIntentContext {
+  readonly consumer: AztecAddress;
+  readonly chainInfo: ChainInfo;
+  readonly calls: readonly FunctionCall[];
+  readonly txNonce: Fr;
+  /** The hash that would be passed to createAuthWit, for cross-check. */
+  readonly messageHash: Fr;
+}
```

And in `account_entrypoint.ts:141`:
```diff
-const payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+const payloadAuthWitness = this.auth.createAuthWitFromIntent
+  ? await this.auth.createAuthWitFromIntent({
+      consumer: this.address,
+      chainInfo,
+      calls,
+      txNonce,
+      messageHash,
+    })
+  : await this.auth.createAuthWit(messageHash);
```

**Before (today)**:
A HW-wallet provider must implement `createAuthWit(hash)`. To know what
the hash is for, the provider has to:
1. Re-derive the outer_hash preimage from a CallIntent it built separately,
2. Compare to the hash the framework passes in,
3. Hand over a pre-signed witness if they match.

This is what our `FrozenAuthWitnessProvider` does (~30 LOC + the
upstream-mirroring `buildL4Manifest` at ~250 LOC).

**After**:
```ts
class LedgerProvider implements AuthWitnessProvider {
  async createAuthWit(hash: Fr) { return this.blindSign(hash); }
  async createAuthWitFromIntent(ctx) {
    return this.ledger.clearSign({
      consumer: ctx.consumer,
      chainInfo: ctx.chainInfo,
      calls: ctx.calls,
      nonce: ctx.txNonce,
    });
  }
}
```
~10 LOC. The user sees "Transfer 1.5 USDC to 0xabcd" on the device.

**Rationale**: optional + back-compat. Software wallets continue to
implement only `createAuthWit`. HW wallets opt into clear-signing
without forking entrypoint encoding. Pairs naturally with Lesson 1
(both unblock the same HW-wallet flow at different layers).

---

## Lesson 3 — Accept a pre-signed payload witness via `sendTx` options

**Problem**:
There's no first-class hook for "I have a witness in hand; just use it."
Combined with Lesson 1's missing `txNonce` override, this means the
ONLY way to use a pre-signed witness is to bypass `BaseWallet.sendTx`
entirely.

**Citations**:
- `aztec-packages/yarn-project/wallet-sdk/src/base-wallet/base_wallet.ts:434`
  — `sendTx` entry point (no presigned-witness option)
- `aztec-packages/yarn-project/entrypoints/src/account_entrypoint.ts:141`
  — where the framework decides to sign (could short-circuit here)

**Proposed diff** (`account_entrypoint.ts:141`):
```diff
+if (options.presignedPayloadAuthWitness) {
+  // Caller pre-signed for this exact payload+nonce. Assert it matches
+  // the hash we just computed; refuse to silently substitute.
+  if (!options.presignedPayloadAuthWitness.requestHash.equals(messageHash)) {
+    throw new PresignedWitnessHashMismatch(messageHash, options.presignedPayloadAuthWitness.requestHash);
+  }
+  payloadAuthWitness = options.presignedPayloadAuthWitness;
+} else {
+  payloadAuthWitness = await this.auth.createAuthWit(messageHash);
+}
```

And add `presignedPayloadAuthWitness?: AuthWitness` to
`DefaultAccountEntrypointOptions`.

**Before**:
HW-wallet caller must bypass `BaseWallet.sendTx` and re-implement
prove+send manually (see Lesson 1's "before" snippet).

**After**:
```ts
const witness = await ledger.preSignForExec(exec, txNonce);
await wallet.sendTx(exec, {
  from: address,
  txNonce,
  presignedPayloadAuthWitness: witness,  // ← injects the witness
});
```

**Rationale**: complements Lessons 1+2. Even with createAuthWitFromIntent
landed, a caller wanting offline pre-sign (e.g., approve-on-device,
broadcast-from-server) still needs an inject point. The
hash-assertion makes the trust handoff explicit — the framework
refuses to use a witness for a different payload than what was
pre-signed.

Lower priority than Lessons 1+2 since the same outcome is achievable
via createAuthWitFromIntent. Land it if there's appetite for the
broader "offline approve, later submit" pattern.

---

## Lesson 4 — Re-export the outer_hash preimage helpers from public modules

**Problem**:
`computeOuterAuthWitHash` and `EncodedAppEntrypointCalls.create(...).hash()`
are framework-internal. They have no public re-export from
`@aztec/aztec.js` (the canonical public surface). Every HW-wallet
integrator who wants to verify the framework's hash recomputes both
in their own code.

We re-implemented them in our `packages/adapter-ledger/src/l4-manifest.ts`
and burned ~5 days on the L4.1 host-parity test suite to verify the
re-implementation matched Aztec's byte-for-byte (14/14 shapes across
TRANSFER_PRIV_PUB / TRANSFER_PRIV_PRIV / TRANSFER_PUB_PRIV /
TRANSFER_PUB_PUB / MINT_PUB / MINT_PRIV / SPONSOR / DRIP_PUB).

**Citations**:
- `aztec-packages/yarn-project/stdlib/src/auth-witness/index.ts` (no re-export)
- `aztec-packages/yarn-project/entrypoints/src/encoding.ts:74`
  — `EncodedAppEntrypointCalls.create(...).hash()` is the canonical
    preimage producer

**Proposed change** (`aztec.js`):
```ts
// in yarn-project/aztec.js/src/api/wallet.ts or similar:
export { computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
export { EncodedAppEntrypointCalls } from '@aztec/entrypoints/encoding';
```

**Before**:
~250 LOC in `l4-manifest.ts` + ~150 LOC of L4.1 parity tests + 5 days
of debugging hash mismatches against the framework.

**After**:
```ts
import { computeOuterAuthWitHash, EncodedAppEntrypointCalls } from '@aztec/aztec.js/wallet';

const encoded = await EncodedAppEntrypointCalls.create(calls, txNonce);
const payloadHash = await encoded.hash();
const outerHash = await computeOuterAuthWitHash(
  consumer, chainInfo.chainId, chainInfo.version, payloadHash,
);
```
~5 LOC, guaranteed-correct by construction.

**Rationale**: zero internals change. The exports already exist in the
private graph; this is just a public-surface annotation. Saves every
future HW-wallet (or MPC, or analytics) integrator the L4.1 work.

This was the most expensive piece of our PoC by a wide margin: it took
longer to verify our outer_hash matched Aztec's than to write the rest
of the L4 / M5 device + adapter code combined.

---

## Why not 5

We considered a fifth lesson on auth-witness ABI versioning to support
non-Schnorr-Grumpkin keypairs first-class (today, ECDSA-K1 / R1 work
but require the account contract to do the curve adapter). Decided this
is speculative until Lessons 1 + 2 land — they unblock the same
practical UX without touching the witness format.

We'll revisit at M7 if there's demand for native non-Schnorr key
types in the wallet SDK.

---

## Filing as issues / PRs

Recommended issue order:
1. **Lesson 1** — single line in `base_wallet.ts:180`. Should be
   contentious only on the threading question (how far to surface the
   `txNonce` option through `SendMethodOptions`).
2. **Lesson 2** — affects the `AuthWitnessProvider` interface, but
   the change is purely additive (optional method). Coordinate with
   wallet-SDK maintainers on the `AuthWitnessIntentContext` shape.
3. **Lesson 4** — pure re-export. Should be a 5-line PR.
4. **Lesson 3** — last because Lessons 1+2 cover most of the same
   use case. Land if there's appetite for offline pre-sign as a
   first-class flow.

Concrete repro for each is in:
- `packages/adapter-ledger/src/aztec-ledger-session.ts` (Lessons 1+3)
- `packages/adapter-ledger/src/auth-witness-provider.ts:91` (Lesson 2)
- `packages/adapter-ledger/src/l4-manifest.ts` (Lesson 4 — the
  ~250 LOC we wouldn't have written if these helpers were public)
