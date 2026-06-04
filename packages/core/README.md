# @alejoamiras/aztec-ledger-core

Framework-agnostic shared types for [`@alejoamiras/aztec-ledger-sdk`](../aztec-ledger):
the `AuthWitnessProvider` extension surface and the call-intent types the device
clear-signs against. No runtime device code — types + small helpers only.

> **Status: private / pre-release.** Scope/name are placeholders.

## Install

```sh
bun add @alejoamiras/aztec-ledger-core
# peers (you control the framework version):
bun add @aztec/aztec.js@4.2.1 @aztec/entrypoints@4.2.1 @aztec/foundation@4.2.1 @aztec/stdlib@4.2.1
```

Most consumers get this transitively via `@alejoamiras/aztec-ledger-sdk` and don't
import it directly. Ships as ESM + `.d.ts` (tsup): `bun run build`.
