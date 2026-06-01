# aztec.js — hardware-wallet clear-signing: what worked, and a few genuine asks

We built a Ledger app + host adapter that **clear-signs** Aztec txs and account deploys on
the device (the signing key never leaves the Ledger), against `@aztec/*` 4.2.1. This note is
written *after* re-wiring onto what we now believe is the intended seam — so it is deliberately
NOT a list of "missing features." Most of our early "gaps" were us using the wrong seam. What
remains below is the residue we think is genuinely worth your time.

## TL;DR

- The **custom `EntrypointInterface`** is the right clear-signing seam, and it works end-to-end
  (transfer + self-paid deploy, both ECDSA-K and Schnorr, on testnet). Thank you — this is the
  thing that let us delete a pile of workarounds.
- The asks are about **discoverability and stability**, not new APIs: (1) document the
  clear-signing seam; (2) give on-device re-implementers an encoding-stability signal;
  (3) publish canonical encoding test vectors; (4) type/document `feeEntrypointOptions`;
  (5) state precisely what the app-entrypoint auth hash covers.

## Context: the seam that works (so the asks are grounded)

A clear-signing device must *see the calls*, not just a 32-byte hash. Our first implementation
bound to `AuthWitnessProvider.createAuthWit(messageHash)` — which only gets the hash — and then
drove a parallel "intent" path + a deploy spy/freeze two-pass to recover the calls. That was the
wrong seam.

The right seam: `AccountContract.getAccount()` → `BaseAccount(entrypoint, authWitnessProvider, …)`,
where a **custom `EntrypointInterface`** receives the full `ExecutionPayload`:

- `createTxExecutionRequest(exec, gas, chainInfo, options)` — for txs;
- `wrapExecutionPayload(exec, chainInfo, options)` — for the self-paid deploy path.

Because `BaseWallet.sendTx` picks `txNonce` and proves *that exact* request, signing **in-band**
inside `createTxExecutionRequest` (consuming `options.txNonce`) makes the device sign the nonce
that lands on-chain — no pre-sign/replay mismatch. We compose your stock `DefaultAccountEntrypoint`
so the canonical encoding + request assembly are reused, not copied, and the device's independent
outer_hash recompute stays the authority (host hash is only a cross-check). Deletes ~700 LOC of
host workarounds.

## Asks

### 1. Document the clear-signing `EntrypointInterface` seam (highest value)
A competent team (us) missed it and built on `AuthWitnessProvider` first. A short "if you are
building a clear-signing hardware wallet, implement a custom `EntrypointInterface`; the full
`ExecutionPayload` arrives there, whereas `AuthWitnessProvider` only sees the outer hash" — with
the `BaseWallet.sendTx` in-band-nonce note and the `DefaultAccountEntrypoint`-composition pattern —
would save the next integrator weeks. (We are happy to contribute the prose / an example.)

### 2. An on-device encoding-stability signal
A hardware wallet **cannot import** `@aztec/entrypoints/encoding`; it re-implements
`EncodedAppEntrypointCalls` (the per-call args_hash + the field-packed payload + the
`computeOuterAuthWitHash` domain separators) in C. If that encoding changes across a release, the
device silently diverges and every signature fails closed with a hash-mismatch — correct, but a
bricked wallet with no diagnosis. A `PAYLOAD_ENCODING_VERSION` constant (or a documented stability
guarantee + a changelog flag when the app-entrypoint-calls encoding or the domain separators move)
would let on-device re-implementers detect and gate. The separators we pin in C today are bare
magic numbers (`SIGNATURE_PAYLOAD`, `PUBLIC_CALLDATA`, `FUNCTION_ARGS`); naming + versioning them
upstream would make divergence detectable rather than mysterious.

### 3. Publish canonical encoding test vectors
We verify our C re-implementation against `EncodedAppEntrypointCalls` + `computeOuterAuthWitHash`
with our own host parity test + golden vectors. A small published vector set
(calls + txNonce + chainInfo → expected payloadHash + outer_hash, across public/private/multi-call
shapes) would let any hardware-wallet team prove on-device parity without reverse-engineering the
encoding. This is the single highest-leverage artifact for the ecosystem.

### 4. Type and document `feeEntrypointOptions`
`RequestDeployAccountOptions.fee.feeEntrypointOptions` is `unknown`-typed and flows verbatim into
`AccountEntrypointMetaPaymentMethod` → `account.wrapExecutionPayload(payload, chainInfo, options)`.
We rely on this (cleanly) to carry device deploy-context to a self-paid deploy — but it took source
reading to discover, and an `unknown` sideband on the signing path is easy to misuse. A typed,
documented contract for what `wrapExecutionPayload` `options` may carry would make this seam safe by
construction.

### 5. State what the app-entrypoint auth hash covers (and does not)
The authwitness hash binds `EncodedAppEntrypointCalls(calls, txNonce)` + `(address, chainId,
version)` — but **not** the fee-payment mode, `cancellable`, or capsules. A clear-signing wallet
must not imply it reviewed those. We enforce `feePaymentMethodOptions == EXTERNAL` and
`cancellable == false` before signing a deploy precisely because they are outside the signed hash.
A one-paragraph "what the authwit hash commits to" in the docs would prevent a class of
over-claiming clear-signing bugs.

## What we are NOT asking for
No new signing API, no Schnorr-specific deploy hook (your `DefaultAccountEntrypoint` +
`feeEntrypointOptions` carried everything we needed for both ECDSA-K and Schnorr), and no change to
the in-band nonce model (it is exactly right for a device that signs the proven request).
