# Phase 3 — three transports (add node-hid) → DONE (green)

Added a Node.js USB transport so the SDK has all three: WebHID (browser), Speculos (test), node-hid (Node).

## What changed
- **`src/node-hid-transport.ts`** — `NodeHidLedgerTransport` (mirrors WebHID) + `createNodeHidTransport()` + typed `NodeHidNotAvailableError` / `NodeHidDeviceDisconnectedError`.
- **`src/node-hid.ts`** — the `./node-hid` subpath barrel; `exports` map gains `./node-hid`.
- **`src/hid-apdu.ts`** — extracted the shared `encodeApduBytes` (was private in `webhid-transport.ts`); both USB-HID transports import it now, so they can't drift.
- **Optional peer:** `peerDependencies: { "@ledgerhq/hw-transport-node-hid": "^6.33.2" }` + `peerDependenciesMeta.optional`. NOT installed in the workspace.
- `autoConfirm` stays Speculos-only (WebHID + node-hid ignore it — a human taps the device).

## Lessons
- **node-hid's transport versions independently of webhid** — its latest is **6.33.2**, so `^6.35.2` (webhid's) does not resolve. Don't assume the Ledger `hw-transport-*` packages share a version line.
- **Optional-peer-with-deferred-resolution pattern (no native build, no ambient shim):** `await import(specifier)` where `specifier` is a **string-typed parameter** (not a string literal). tsc then types the import as `Promise<any>` and does NOT resolve the module specifier → the SDK type-checks/builds with the peer ABSENT; esbuild likewise leaves it as a runtime import. A literal specifier (or `const x = '...'`) WOULD be resolved by tsc and error TS2307. The consumer installs the peer; absence fails closed with `NodeHidNotAvailableError`.
- The disconnect guard is testable hardware-free: `send` checks the flag before encoding, so a mock `inner` + firing the captured `on('disconnect')` cb is enough.

## Validation (green)
`lint:all` 0 · `bun test packages/` **124 pass** / 0 fail (the +2 node-hid tests: optional-peer-absent fails closed, disconnect guard) · SDK `tsc` clean (dynamic import of the absent peer does NOT error) · demo `tsc` clean · demo `vite build` ✓ · `./node-hid` in `exports`, optional peer declared · runtime pxe/wallets/noir boundary unaffected (node-hid adds none).

## Next — P4 (production API + version handshake)
`connectLedger` + typed errors + the convenience account flow; GET_VERSION (3-tuple compat-range) + GET_CAPS (⊇ required-bitmask) enforced in EVERY safe constructor; `@aztec/*` → `peerDependencies` pinned 4.2.1.
