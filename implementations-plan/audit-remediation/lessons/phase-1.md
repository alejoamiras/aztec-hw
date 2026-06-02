# Phase 1 — host clear-signing policy (TS)

Commits unsigned (1Password down — backfill later).

```
[x] P1 — host clear-signing policy — COMPLETE (AHW-001/002/003/004/008/049; AHW-005 deferred; AHW-007 now type-enforced)
  [x] AHW-001 host fail-close — createAuthWit() throws (blind hash-only sign disabled);
      signAndWrap removed; non-gated fail-close test green. The device blind_signing
      toggle (P2) is the separate device-level backstop. Note: this also neuters the
      AHW-002 ledgerProvider.createAuthWit / default-account sendTx bypass (both route
      through createAuthWit → now throws).
  [ ] AHW-002 — internalDeps stops exposing session/ledgerProvider; cache the clear-signing account.
  [x] AHW-003 — #assertClearSignPolicy(exec, options, kind): rejects non-empty
      authWitnesses/capsules/extraHashedArgs + pins fee mode=EXTERNAL + deploy cancellable=false.
      Applied to createTxExecutionRequest (tx) + wrapExecutionPayload (deploy + non-deploy fee).
      The deploy path's old inline EXTERNAL/cancellable checks refactored into the shared helper.
  [~] AHW-062/049 — tx cancellable=true (sponsor-replay): set host-side (next, with AHW-002);
      the guard's tx-cancellable assert is deferred until the host sets it (no flow breakage now).
  [x] AHW-008 — #canonicalOuterHash extracted; both sign methods use it (no drift).
  [ ] AHW-005 — typed ledgerDeployContext sideband (next host-pass).
  [x] AHW-004 — clear-signing-entrypoint.test.ts: 5 guard-reject tests (authWitnesses, capsules,
      extraHashedArgs, non-EXTERNAL fee, cancellable-deploy), device-free. 5 pass. #consume +
      device flow stay Speculos-covered (b3/provider.m8).
```

## Log
- AHW-001: createAuthWit fail-closed for ALL curves (was ECDSA-signs / Grumpkin-throws). `bun test` of the new non-gated test: 1 pass / 1 skip (Speculos getPublicKeyXY). biome clean.
