# @alejoamiras/aztec-ledger-sdk

Connect a **Ledger** device to **Aztec**: derive an account whose signing key never
leaves the device, and clear-sign transactions (the device decodes and shows the
real call — token, amount, recipient — before you approve).

> **Status: private / pre-release.** The custom Aztec device app is not yet in
> Ledger Live; side-load the dev app to use this. Scope/name are placeholders.

## Install

```sh
bun add @alejoamiras/aztec-ledger-sdk
# peers (you control the framework version — pinned to the protocol this SDK targets):
bun add @aztec/aztec.js@4.2.1 @aztec/accounts@4.2.1 @aztec/entrypoints@4.2.1 \
        @aztec/foundation@4.2.1 @aztec/stdlib@4.2.1
```

## Quick start

```ts
import { connectLedger } from '@alejoamiras/aztec-ledger-sdk';
import { createWebHidTransport } from '@alejoamiras/aztec-ledger-sdk/webhid';

// connectLedger runs the mandatory handshake and FAILS CLOSED if the device app
// version/capabilities don't match this SDK — a returned connection is known-good.
const conn = await connectLedger({ transport: await createWebHidTransport() });

const account = await conn.createAccount({ scheme: 'ecdsa' }); // or 'schnorr'
// `account` is an Aztec `AccountContract` — wire it into your wallet/PXE
// (AccountManager.create(...)) like any account. The device clear-signs.
```

## Transports (subpaths)

| Subpath | Use |
| --- | --- |
| `…/webhid` | Browser, real device (Chromium, https/localhost) |
| `…/node-hid` | Node (CLI/server) — requires the optional peer `@ledgerhq/hw-transport-node-hid` |
| `…/speculos` | The Speculos emulator — **testing only** |

`autoConfirm` (scripted button presses) is Speculos-only; real transports require a
human to approve on the device.

## The honest key model — read this

- **Your spend (signing) key never leaves the device.** Every transaction is
  clear-signed: the device decodes the call and renders it; you approve on-device.
- **Your viewing/privacy root DOES leave the device — by design.** Aztec needs the
  viewing keys host-side to see your private state. Onboarding **reveals** that root
  to host memory under a **separate on-device approval**. So a host compromise can
  *read* your private balance; it can never *spend* (that needs the device). Treat
  the revealed secret as sensitive. Reconnecting the device re-derives the identical
  account — the device is its own backup.
- The reveal/onboarding flow + the raw APDU provider live on **`…/advanced`**, and
  the raw blind-signer on **`…/unsafe`** — both **outside** the fail-closed guarantees
  of the root API. The root barrel exposes only the safe, attested-by-default surface.

## Compatibility (firmware ↔ SDK)

`connectLedger` (and every safe account constructor) runs a mandatory handshake:

- **App version** must be in this SDK's supported range (`GET_VERSION`); and
- **Capabilities** must include what the flow needs (`GET_CAPS` ⊇ clear-sign + attested
  address + the scheme's curve).

A mismatch throws `LedgerIncompatibleVersionError` / `LedgerMissingCapabilityError`.
This is **separate** from the *optional* clear-signing **registry** (which contracts
the device will decode): the SDK ships **no** registry — bring your own, matched to
your firmware, via the `ClearSignPreflight` hook (the device re-validates every gate
regardless, so the hook is advisory). Bump the supported range only at a protocol break.

## Build

Ships as ESM + `.d.ts` (built with tsup): `bun run build`. In a workspace it resolves
from source; the published package resolves from `dist/` (see `publishConfig`).
