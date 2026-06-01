# aztec.js — hardware-wallet clear-signing: notes + a few asks

We built a Ledger app + host adapter that **clear-signs** Aztec txs and account deploys on the
device (the signing key never leaves the Ledger), against `@aztec/*` 4.2.1. This is written
*after* re-wiring onto what we believe is the intended seam — so it is deliberately not a list of
"missing features." Our early "gaps" were mostly us using the wrong seam. What's below is the
residue we think is worth your time.

## The seam that works (so the asks are grounded)

A clear-signing device must see the calls, not just a 32-byte hash. We first bound to
`AuthWitnessProvider` — specifically the `createAuthWit(messageHash)` hook that
`DefaultAccountEntrypoint` calls (`account_entrypoint.js:104-106`), which only gets the
`messageHash` — and then drove a parallel intent path + a deploy spy/freeze to recover the calls.
(The higher-level `account.createAuthWit(from, intent)` *does* take an intent, for app authwits —
but that is not the tx-signing path.) That was the wrong seam for tx/deploy signing.

The right seam: `AccountContract.getAccount()` → `BaseAccount(entrypoint, …)` with a **custom
`EntrypointInterface`** that receives the full `ExecutionPayload`:
`createTxExecutionRequest(exec, gas, chainInfo, options)` (txs) and
`wrapExecutionPayload(exec, chainInfo, options)` (self-paid deploy). We compose your stock
`DefaultAccountEntrypoint` so the canonical encoding + request assembly are reused, not copied.

The nonce model makes in-band signing correct: the wallet account path generates `txNonce` in
`createTxExecutionRequestFromPayloadAndFee` and `sendTx` then proves/sends *that exact* request
(`base-wallet/base_wallet.js`). Signing inside `createTxExecutionRequest` (consuming
`options.txNonce`) makes the device sign the nonce that lands on-chain. For the self-paid deploy
we pin `feeEntrypointOptions.txNonce` ourselves so the device and the proved request agree.

Proven on Aztec testnet (ECDSA-K + Schnorr): e.g. transfer
`0x2b146ce0027890d7f3a5563dc910d9b87d32fc19058f4a5b13b8ef2f140a0fd8`, self-paid deploy
`0x1c36fd8ddadce67f3812caa86536d18e6544b07087c9c130ab5bda345ddd713b`, Schnorr transfer
`0x2d5296e2849eb22d1ba96bb6af4f8edb29b02e49ceb7aacdd578cbf686b410b0` (testnet.aztecscan.xyz).

## Asks

### 1. Document the clear-signing `EntrypointInterface` seam
We bound to `AuthWitnessProvider` first because it is what surfaces for "signing"; the full
`ExecutionPayload` only reaches a custom `EntrypointInterface`. A short doc — "for clear-signing
hardware wallets, implement a custom `EntrypointInterface` (compose `DefaultAccountEntrypoint`);
the `createAuthWit` hook only sees the outer hash" — plus the in-band-nonce note, would orient the
next integrator. We're happy to contribute the prose / an example.

### 2. Signal when the app-entrypoint-calls encoding changes
A hardware wallet cannot import `@aztec/entrypoints/encoding`; it re-implements
`EncodedAppEntrypointCalls` + `computeOuterAuthWitHash` on-device (C). The domain separators are
already named in `@aztec/constants`, so the gap is not naming — it is **breakage signaling**: if
the field layout / hashing of `EncodedAppEntrypointCalls` changes across a release, the device
diverges and every signature fails closed (hash-mismatch) with no diagnosis. A version constant or
a changelog flag whenever that encoding moves would let on-device re-implementers gate.

### 3. Publish canonical encoding test vectors
The highest-leverage, lowest-cost item: a published set of
`calls + txNonce + chainInfo → payloadHash + outer_hash` vectors (public/private/multi-call shapes)
lets any hardware-wallet team prove on-device parity without reverse-engineering the encoding. We
maintain our own; promoting a canonical set upstream removes that duplication for everyone.

### 4. State what the app-entrypoint authwit hash commits to
The authwit hash binds `EncodedAppEntrypointCalls(calls, txNonce)` + `(address, chainId, version)`.
It does **not** cover fee-payment mode, `cancellable`, capsules, extra authWitnesses, extra hashed
args, or gas/salt. A clear-signing wallet must not imply it reviewed those; we explicitly constrain
`feePaymentMethodOptions == EXTERNAL` and `cancellable == false` before signing a deploy precisely
because they are outside the signed hash. A one-paragraph "what the authwit hash commits to" would
prevent a class of over-claiming clear-signing bugs.

### Minor
`RequestDeployAccountOptions.fee.feeEntrypointOptions` is `unknown` and flows verbatim into
`account.wrapExecutionPayload(payload, chainInfo, options)`; we carry deploy-context through it.
A typed/documented contract would help, though the genericity is understandable — likely a docs
note rather than an API change.

## What we are NOT asking for
No new signing API, no Schnorr-specific deploy hook (`DefaultAccountEntrypoint` +
`feeEntrypointOptions` carried everything for both ECDSA-K and Schnorr), and no change to the
in-band nonce model (it is right for a device that signs the proved request).
