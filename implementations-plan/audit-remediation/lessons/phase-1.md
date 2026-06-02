# Phase 1 — host clear-signing policy (TS)

Commits unsigned (1Password down — backfill later).

```
[▶] P1 — host clear-signing policy
  [x] AHW-001 host fail-close — createAuthWit() throws (blind hash-only sign disabled);
      signAndWrap removed; non-gated fail-close test green. The device blind_signing
      toggle (P2) is the separate device-level backstop. Note: this also neuters the
      AHW-002 ledgerProvider.createAuthWit / default-account sendTx bypass (both route
      through createAuthWit → now throws).
  [ ] AHW-002 — internalDeps stops exposing session/ledgerProvider; cache the clear-signing account.
  [ ] AHW-003/062 — assertClearSignPolicy: reject authWitnesses/capsules/extraHashedArgs;
      pin fee mode; cancellable=true for tx / false for deploy (closes AHW-049).
  [ ] AHW-008 — extract #canonicalOuterHash (tx/deploy hash-block dedup).
  [ ] AHW-005 — typed ledgerDeployContext sideband (shared type, rename = compile error).
  [ ] AHW-004 — clear-signing-entrypoint.test.ts (the 4 guards + #consume).
```

## Log
- AHW-001: createAuthWit fail-closed for ALL curves (was ECDSA-signs / Grumpkin-throws). `bun test` of the new non-gated test: 1 pass / 1 skip (Speculos getPublicKeyXY). biome clean.
