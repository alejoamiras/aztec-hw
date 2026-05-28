# Phase 0 — Independent oracle + golden vectors

**Status:** in progress.
**Branch:** `m8-phase-0-oracle`.

## What's done

- Oracle module skeleton at `packages/adapter-ledger/src/oracle/`:
  - `aztec-derivation.ts` — wraps `deriveKeys` + `derivePublicKeyFromSecretKey` from `@aztec/stdlib/keys`. Returns the four viewing scalars + the 4 master pubkeys + a precomputed `publicKeysHash`.
  - `aztec-grumpkin.ts` — re-exports `Grumpkin.mul`, `Grumpkin.add`, `Grumpkin.generator`, `Point`, `Fq`, `Fr` from `@aztec/foundation` (via bb.js WASM).
  - `aztec-address.ts` — wraps the full address chain (`computeInitializationHashFromEncodedArgs` + `computeSaltedInitializationHash` + `computePartialAddress` + `computePreaddress` + `computeAddress`). Exposes `computeFullAddress(args)` covering everything from ctor selector + encoded args → final address.
  - `index.ts` — barrel.
  - `public-keys-hash-encoding.md` — codex final-audit MAJOR #2 deliverable. Pins the 12-field serialization (`x`, `y`, `isInfinite` per `Point` × 4) under `DomainSeparator.PUBLIC_KEYS_HASH = 777457226`. Phase 6's device-side `recompute_public_keys_hash()` MUST byte-match.
- `aztec-derivation.test.ts` — 3 determinism + shape tests (`3 pass / 0 fail`).

## What's pending

- Golden-vector generator script (`packages/adapter-ledger/scripts/gen-golden-vectors.ts`).
- Committed golden-vectors JSON (256 random `(sk, partial)` triples with expected output).
- Stability test (oracle output today == committed bytes; catches `@aztec/*` regressions).
- Address-chain round-trip test that exercises `computeFullAddress`.
- Grumpkin round-trip test exercising `grumpkinMulGenerator` + `grumpkinAdd`.

## Lessons

### `bun:test` + `@aztec/foundation` compatibility

Any import that transitively pulls `@aztec/foundation/curves/bn254/field.js` (which includes `@aztec/stdlib/keys`) crashes at module load:

```
expect.addEqualityTesters is not a function
  at @aztec/foundation/.../curves/bn254/field.js:407
```

Cause: Aztec's foundation registers a custom equality tester at module load, using a Jest/Vitest-specific API. bun:test doesn't expose `expect.addEqualityTesters`.

**Fix already in repo:** `bunfig.toml` declares `[test] preload = "./tests/preload.ts"` which polyfills the API as a no-op (preexisting from M5 setup). Tests work — but ONLY if `bun test` is invoked from the **repo root** so bunfig.toml's path resolution applies. Running `bun test` from `packages/adapter-ledger/` skips the preload and fails.

**Implications for any future M8 test files:**
- Don't shim `expect.addEqualityTesters` per-file — the global preload handles it.
- Run tests via repo-root commands (`bun test path/to/file.test.ts`) or via the root `test` script.
- If a CI step changes to per-package `bun test`, add an explicit per-package bunfig.

### Pre-existing typecheck failure flagged for Phase 1

`src/aztec-ledger-session.ts:300` has a pre-existing TS error: `'from' does not exist in type 'RequestDeployAccountOptions'`. This is M7 P4 scaffold work that was committed but never made `tsc --noEmit` clean. **Phase 1 (host deploy builder) is the right place to fix this** — it's literally the same code path P4 replaces. Bun:test runs the affected test fine (Bun strips types at runtime), so it doesn't block Phase 0 work.
