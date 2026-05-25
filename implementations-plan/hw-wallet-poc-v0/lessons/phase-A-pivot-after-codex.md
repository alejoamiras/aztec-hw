# Phase A — Adapter architecture pivot after codex review #1

> **Trigger**: codex session `019e5ed4-d8c8-7371-ab81-b1b06a4ba4a1` (see [`phase-A-codex-review-1.md`](phase-A-codex-review-1.md)).
> **Outcome**: real end-to-end verification — Trezor-faithful fake transport → adapter → AuthWitness → Aztec's TS `Ecdsa.verifySignature` returns `OK ✓`.

## What I had wrong before the review

| What I assumed | What is actually true |
|---|---|
| Identity is a URL string `aztec://account/{i}` | Identity is an `IdentityType` protobuf with explicit `proto, host, path, index` fields. Serialized as `proto://host/path`. |
| Any URL-shaped identity works | Only `proto='gpg'` makes the device sign `challenge_hidden` DIRECTLY. Any other proto signs `sha256(hidden) ‖ sha256(visual)` (Bitcoin message-signing path) — Aztec verifier wouldn't accept that. |
| Pubkey from device is 65B uncompressed `0x04 ‖ X ‖ Y` | Trezor returns 33B compressed (`02/03 ‖ X`). Adapter must decompress. |
| Aztec expects 65B uncompressed pubkey | Aztec's `EcdsaKAccount` constructor wants 64B `X ‖ Y` (no prefix). `Ecdsa.computePublicKey()` returns 64B already. |
| Separate `GetPublicKey(identity, curve)` API exists for SLIP-0013 | No such API. Pubkey comes back as a side effect of `SignIdentity`. Cache the first return. |
| Marker byte (signature[0]) is `0x1f + recovery_id` | For `proto='gpg'` and `'ssh'` sigtypes, Trezor overwrites byte 0 with `0x00`. Strip and ignore. |
| Stock `TrezorConnect.requestLogin` is the path | `requestLogin` hardcodes `identity.index = 0` and doesn't expose `ecdsaCurveName`. Lowest escape hatch is `trezorlib.misc.sign_identity` (Python) or a custom `@trezor/transport` + `@trezor/protobuf` client. |

## What changed in code

- `packages/adapter-trezor/src/identity.ts`: replaced string-builder with `IdentityType` protobuf shape + `serializeIdentity()` matching firmware's `proto://[user@]host[:port]path` format.
- `packages/adapter-trezor/src/transport.ts`: removed standalone `getPublicKey()`. `signIdentity()` now returns BOTH `compressedPublicKey` (33B) and `signature` (65B). Required `challengeVisual` (no default).
- `packages/adapter-trezor/src/provider.ts`: `getPublicKeyXY()` issues a probe-sign with a zero digest to populate the pubkey cache. `decompressPubkey()` uses `@noble/secp256k1`'s `Point.fromBytes(compressed).toBytes(false)` to get 65B uncompressed, then strips `0x04` to yield 64B `X ‖ Y`.
- `apps/demo/src/fake-transport.ts`: now signs `challenge_hidden` directly via `secp.signAsync(..., { prehash: false, lowS: true })`, returns Trezor wire format (byte 0 = `0x00`, then `r ‖ s`), returns compressed pubkey.
- `apps/demo/src/index.ts`: passes `outerHashBytes` (raw, not pre-hashed) to `Ecdsa.verifySignature` per codex finding #7 — Aztec's verifier internally SHA-256s.

## What this proves

End-to-end, in-process: a signature produced over `sha256(outer_hash.to_be_bytes())` directly (the Trezor `gpg` semantics) verifies under Aztec's `Ecdsa.verifySignature` when the raw `outer_hash.to_be_bytes()` is supplied as `message`. This is the **same logic the Noir circuit runs** (`std::ecdsa_secp256k1::verify_signature(...)` operating over `sha256(outer_hash.to_be_bytes())`), so passing the TS verifier is strong evidence the circuit will accept it too.

Independent confirmation: `apps/demo/src/diagnose-noble.ts` (kept around as a regression check) does the same round-trip without the adapter, isolating that the bug was in adapter shape rather than crypto.

## What this still doesn't prove

1. **Real Trezor wire compatibility**: the fake transport is byte-faithful to my READING of `sign_identity.py`, but a real emulator round-trip is the only definitive check.
2. **Noir-circuit acceptance** (M0b): TS verifier passing doesn't formally prove circuit passing. Phase A's exit needs an end-to-end test against the actual Noir verifier.
3. **High-s safety**: my `normalizeLowS` is a no-op when noble produces low-s (which it does by default). If the real device ever returns high-s, the normalization kicks in — but I haven't tested that path with a real verifier.

## Open carry-forwards

- Replace `FakeTrezorTransport` with a real transport. Two options:
  - **`TrezorlibSubprocessTransport`** — spawn `python3 -m bridge` that runs `trezorlib.misc.sign_identity(...)`. Simplest path, adds Python dep.
  - **`TrezorTransportProtobufTransport`** — pure JS client using `@trezor/transport` + `@trezor/protobuf`. More code, no Python dep, more faithful to a production adapter.
- Verify against an actual `trezor-firmware` emulator instance.
- Begin Phase 0 M0a — bootstrap `aztec-packages` and run `e2e_account_contracts.test.ts` locally.

## Adapter score after this pivot

Codex's 8 findings: all 8 either resolved (1, 2, 3, 5, 6) or carried as next-step plans (4 transport choice, 7 verifier confirmed, 8 address derivation documented for future work).
