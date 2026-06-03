# Phase 7 (W7) — regression tests: reject arms + device low-S/verify — DONE (AHW-108 + AHW-109; closes AHW-087)

Commit `1f4b3c2`. Two new/extended Speculos tests, both green on the real `app.elf`.

## AHW-108 — exact-SW per APPEND_CALL reject arm (FIXED)
New `packages/adapter-ledger/src/wire-reject-arms.test.ts`. The M12 fuzzer (`fuzz_append_call.c`)
asserted only `SW ∈ known-set`, so a gate degrading to **accept** (`0x9000`) — most dangerously the
delegated-spend gate — would have shipped GREEN. These pin the EXACT status word per arm, against the
real elf:

| arm | perturbation (everything else valid) | SW |
|-----|--------------------------------------|----|
| unknown `(kind,selector)` | USDC (TOKEN in registry) + selector `0xdeadbeef` | `0x6F09` SW_DECODER_MISS |
| wrong `arg_count` | `transfer_public` (wants 4) sent with 3 args | `0x6F0A` SW_DECODER_DESYNC |
| visibility flip | public verb sent with `is_public=false` | `0x6F0B` SW_VISIBILITY_MISMATCH |
| 4-arg `from != consumer` | `transfer_public` with `from=999 != consumer=1` | `0x6F0C` SW_DELEGATED_SPEND_UNSUPPORTED |

Harness (mirrors the AHW-041 reject pattern in `verified-calls-content.test.ts`): `buildL4Manifest` does
NOT host-validate semantics (it encodes), so the malformed frames reach the device; each test does
`abortAuthwit → beginAuthwit(header) → expect(appendCall(call)).rejects.toThrow('SW=0x6f0X')`. The reject
fires at APPEND parse (pre-B3), so the consumer is a dummy `Fr(1)` and **no UI / blind-sign toggle is
involved** — they ran against the live `speculos-aztec-c2` with no restart. Result: **4 pass / 4 expect**.

**Lesson — my SW guesses all matched, which reveals the device's check ORDER** (each test isolates one arm
by keeping the others valid, so a pass confirms the order): registry → decoder `(kind,sel)` → `arg_count`
→ visibility → delegated-spend. If the order were different, a perturbation-of-one test would surface a
*different* (still-reject) SW and fail — so these also lock the ordering, not just the codes.

## AHW-109 / AHW-087 — device low-S + secp.verify (FIXED, with one honest residual)
Extended `provider.test.ts` SIGN_OUTER_HASH test to assert the **device-emitted** signature is low-S:

```ts
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const sBig = BigInt(`0x${Buffer.from(sig.s).toString('hex')}`);
expect(sBig <= SECP256K1_N >> 1n).toBe(true);
```

The PRIOR low-S test exercised the host `core` impl, not the device — this asserts the **device's**
`low_s_normalize`. Alongside it the test already proves `@noble/secp256k1.verify(...) === true` AND
`Ecdsa.verifySignature` (Aztec in-circuit parity) of the device sig against the device pubkey — which **is**
the `secp.verify`-of-device-sig-vs-pubkey that AHW-087 said no code path performed. Per the /goal's framing
(AHW-087 closed by asserting secp.verify of the device sig), AHW-087 → FIXED. Result: **9 pass / 14 expect**
on fresh NVRAM.

**Honest residual on AHW-109's second half — `0x6F06` SW_DUP_SIG_MISMATCH (glitch-only, untestable via
emulator).** The dual-signature fault defense (`sign_outer_hash.c:186-218`, plus `finalize_and_sign.c:335`,
`finalize_deploy_and_sign.c:323`, `get_aztec_master_secret.c:152`) re-runs RFC6979 ECDSA a 2nd time over the
same `(reviewed_path, digest)` and rejects on `r||s` byte-diff. RFC6979 is **deterministic**, so absent a
physical glitch the two passes are *always* equal — **no host/emulator APDU input can make them diverge**,
and Speculos models no fault injection. Therefore:
- the dup-check **accept path is exercised by every passing sign test** (each successful sign flows through
  the `memcmp==0` branch), and
- the **reject branch (`0x6F06`) is structurally untestable without a fault-injection rig** (flag for the
  hardware audit lab). The guard is a visible 3-line `memcmp` in all four sign handlers.

Refactoring the 4 handlers to extract the compare for a host unit test would be gold-plating a defense whose
code is already diff-visible — declined per the no-gold-plating bar. Graded RESIDUAL inline in the register.

## P7 remainder — deferred to its dependency phases (not blocked here)
plan.md P7 line 62 also says "land the W2 review-content + W4 round-trip + W3 API-shape +
device-mismatch-fail-closed tests here if not already with their phases." Status:
- **W3 API-shape** — already landed with P4 (`w3-api-shape.test.ts`, 3 pass).
- **W2 review-content + W4 round-trip** — depend on W2 (P3, AHW-096) and W4 (P5, AHW-098) firmware that is
  not yet implemented. They land WITH those phases (correct home), not retro-fitted here.

## Status
- AHW-108 → **FIXED** (4 reject arms, exact SW, real elf).
- AHW-109 → **FIXED** (device low-S asserted) with `0x6F06` reject-branch RESIDUAL (glitch-only).
- AHW-087 → **FIXED** (test asserts `secp.verify` + Aztec in-circuit parity of the device sig vs pubkey).
