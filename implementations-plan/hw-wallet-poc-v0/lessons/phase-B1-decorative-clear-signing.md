# Phase B.1 — Decorative clear-signing (Trezor host-side)

> **Status**: ✅ Done 2026-05-25. Trezor emulator now displays a human-readable summary of an Aztec `CallIntent` and signs the derived `outer_hash` — signature still verifies via Aztec's reference ECDSA verifier.
> **Caveat**: this is **decorative**. The device displays but doesn't verify. Cryptographic binding (device-side Poseidon2 + hash check) is Phase B.2 (firmware work).

## What landed

- `packages/adapter-trezor/src/intent-utils.ts` — `computeOuterHashForIntent` + `formatIntentForDevice`. Pure functions over `@aztec-hwwallet-poc/core` types; testable without a device.
- `packages/adapter-trezor/src/provider.ts` — `TrezorEcdsaKAuthWitnessProvider` now implements `IntentAuthWitnessProvider`. The `createAuthWitFromIntent(intent)` method:
  1. derives `outer_hash` via Aztec's own `computeInnerAuthWitHash` + `computeOuterAuthWitHash`
  2. formats `intent.labels` into a multi-line summary
  3. sends both to `SignIdentity` (challenge_hidden = SHA-256 of outer_hash bytes; challenge_visual = the summary)
  4. unpacks/normalizes/packs identically to the blind-sign path
- `packages/core/src/index.ts` — re-exports `computeInnerAuthWitHash` so adapter-trezor doesn't need a direct `@aztec/stdlib` dep.
- `apps/demo/src/index.ts` — demo now builds a synthetic "Transfer 1.0 USDC" `CallIntent` and calls `createAuthWitFromIntent`. The summary text is printed pre-sign so you can compare against the on-device screen.
- 8 new unit tests for `intent-utils` (34/34 total now pass).

## Reproduced against the real emulator

Same setup as M0b (docker `trezor-user-env` + `start-emulator.py` + `auto-confirm.py`), but now the device's confirmation screen shows:

```
Aztec authorization (INTERNAL — DO NOT SHIP)
Transfer 1.0 USDC
To: 0xabcdabcd…dead1234
On: USDC
Chain 0x0000…0001 v1
```

instead of the opaque `Digest: 0x6668…`. Signature still verifies under Aztec's `Ecdsa.verifySignature`:

```
Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): OK ✓
```

Pubkey for `gpg://aztec/account/0` against the canonical test mnemonic is unchanged (deterministic — same identity + same seed):
`x = 0x6c3383a056225de7df6b4c5e55ac0f979f096a2ddf7775802a9aced046eaa213`
`y = 0x0b2657d41da1a96341a0f06d3a3e1c6a74e9389c1accf2137597f953dadde85c`

## What's still NOT proven (carry-forwards)

1. **Cryptographic binding** — the device doesn't itself recompute `outer_hash` from the displayed fields. Requires Poseidon2 in Trezor firmware (Phase B.2). Without this, a malicious host could in principle render benign visual text while signing a malicious digest.
2. **Real entrypoint hashing parity** — `computeOuterHashForIntent` flattens the call stack as `[contractAddress, selector, ...args]` and runs it through `computeInnerAuthWitHash`. The real Aztec account entrypoint uses `EncodedAppEntrypointCalls.hash()` which has slightly different padding/encoding semantics. Closing this gap is a Phase-B-final step (import the entrypoint encoder and use it directly).
3. **Padding-attack defense** — `formatIntentForDevice` counts non-padding calls correctly per codex T6's adversarial finding. `computeOuterHashForIntent` also skips padding. Test coverage in `intent-utils.test.ts`. But this defense only matters AFTER cryptographic binding lands — until then, the host controls both.
4. **R1 path** — provider only implements K1 (`EcdsaKAccount`). R1 is the next-track work, with passkey alignment.

## Why "decorative" still ships value

For a research / internal demo: the on-device text is dramatically better UX than a hex blob. It makes the demo demonstrable to non-engineers. It also forces us to pin down the `CallIntent` shape and serialization concretely — useful prep for the upstream Aztec SDK PR.

The hard line stands: **decorative ≠ shippable to end users**. Anything public-facing waits for B.2 (firmware-side hash check).
