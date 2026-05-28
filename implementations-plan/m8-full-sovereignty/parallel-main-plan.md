# M8 — Full Sovereignty Plan (parallel-main draft)

**Author:** main (drafted in parallel with codex CLI + opus Plan subagent for Tier A triangulation)
**Status:** parallel-plan phase 1/3 draft — NOT consolidated
**Date:** 2026-05-28
**Predecessors:** `implementations-plan/m7-shape-up-demo/plan.md`
**Anchor doc:** `~/Projects/aztec-hardware-wallet/architectures/00-aztec-signing-surface.md`

## 0. TL;DR

M8 closes the privacy-key-sovereignty gap left at `safe-v2`. The device gains Grumpkin scalar multiplication (no BOLOS support; written from scratch on top of `cx_math_*` bignum primitives), a new INS that deterministically signs a domain-separated derivation message, and refuses to sign deploys whose host-supplied `publicKeysHash`/`expected_address` don't match its own derivation. The host HKDF-expands the sig into the four Aztec protocol secrets (`nsk_m`, `ivsk_m`, `ovsk_m`, `tsk_m`). The sig itself becomes the **portable PXE-only backup**: save to 1Password, wipe browser state, paste back to recover all viewing access — no Ledger needed. Signing still requires the Ledger.

Two checkpoints:
- `safe-v3` after **P4** (host deploy builder + outer_hash binding closes — demo-able as "the device sees the call list, not just blind-signs")
- `safe-v4` after **Grumpkin + INS_DERIVE + recovery demo** (the wow-factor demo)

Per the [anchor doc §6](../../../aztec-hardware-wallet/architectures/00-aztec-signing-surface.md), Aztec protocol secrets MUST live on host (PXE needs them to decrypt notes per-tx). M8's contribution: make those four secrets **deterministic functions of device material**, and verify on-device against host-supplied values on every deploy.

## 1. Phase decomposition

### Phase A — P4 host deploy builder (target: `safe-v3`)

**Goal:** finish the device-side clear-signed deploy plumbing started in M7 P3 by giving the device a real outer_hash to bind against. Today `INS_FINALIZE_DEPLOY_AND_SIGN` receives `claimed_outer_hash` from host but the device does not cryptographically reconstruct what outer_hash *should* be from the call list. This closes that gap (codex audit MAJOR #1 from M7).

- **A1** — `packages/adapter-ledger/src/deploy/builder.ts` (new). Exports `buildDeployExecutionRequest(deployContext, deps): Promise<TxExecutionRequest>`. Builds init payload via `accountManager.getDeployMethod().request({ from: NO_FROM, deployer: AztecAddress.ZERO, ... })` — `deployer: AztecAddress.ZERO` is the v4.2.1 quirk (`convertDeployOptionsToRequestOptions` adds it normally; we bypass). Wraps via `DefaultMultiCallEntrypoint.wrapExecutionPayload({...init, ...sponsor})` → `DefaultEntrypoint.createTxExecutionRequest`. Returns the typed `TxExecutionRequest` ready for `proveTx`.
- **A2** — Compute claimed `outer_hash` host-side via `computeOuterAuthWitHash(address, chainId, version, encodedCallsHash)` from `@aztec/entrypoints`. Wire through `provider.finalizeDeployAndSign(outer_hash)`.
- **A3** — `ledger-app/src/handler/finalize_deploy_and_sign.c::finalize_deploy_after_approval`: add the outer_hash reconstruction. Synthesize canonical call list (init payload + sponsor payload) from `G_l4_deploy_session` + manifest-pinned profile (no host degrees of freedom remain at FINALIZE — codex MAJOR #1 from M7). Compute outer_hash via poseidon2. Compare against `G_l4_deploy_session.claimed_outer_hash`. Reject with `SW_HASH_MISMATCH` on diff.
- **A4** — `apps/demo-browser/src/panels/AccountPanel.tsx`: switch to `session.deployAccountClearSigned()`. Phase emission already covers build/sign/prove/submit/include/done.
- **A5** — Ragger tests: happy-path full deploy; host-supplied wrong `claimed_outer_hash` → device rejects.
- **A6** — Browser e2e: deploy on testnet via clear-sign flow.

**Done-when:** demo-recordable clear-signed deploy on testnet; ragger green. **Tag `safe-v3` BEFORE phase B begins.**

**Dependencies:** none beyond `safe-v2`. **Effort:** ~1 week.

### Phase B — BN254 base field arithmetic (no UX)

**Goal:** the underlying field arithmetic Grumpkin runs on. BN254 base field p ≈ 2^254 (`0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47`).

- **B1** — `ledger-app/src/crypto/bn254_field.{c,h}` (new). API: opaque 32-byte struct + `bn_add_mod`, `bn_sub_mod`, `bn_mul_mod`, `bn_sqr_mod`, `bn_inv_mod`, `bn_is_zero`. Implementation delegates to BOLOS primitives:
  - `cx_math_addm_no_throw(out, a, b, p, 32)` for add/sub
  - `cx_math_multm_no_throw(out, a, b, p, 32)` for mul
  - `cx_math_invprimem_no_throw(out, a, p, 32)` for inverse (Fermat's little theorem)
- **B2** — Constant-time discipline: `cx_math_*` is CT per BOLOS guarantees. Document this assumption clearly in the header.
- **B3** — `packages/adapter-ledger/test/bn254_field-parity.test.ts`: parity oracle wrapping `Fr` from `@aztec/foundation`. N=1000 random vectors per op; assert byte-equal.

**Done-when:** parity test green; pre-flight benchmark of `bn_mul_mod` on Speculos shows <100µs/op.

**Dependencies:** Phase A complete. **Effort:** ~1 week.

### Phase C — Grumpkin group + scalar multiplication

**Goal:** the heart of M8. `y² = x³ − 17` over BN254 base field.

- **C1** — `ledger-app/src/crypto/grumpkin.{c,h}` (new). API:
  ```c
  typedef struct { uint8_t x[32]; uint8_t y[32]; uint8_t infinity; } grumpkin_point_t;
  typedef uint8_t grumpkin_scalar_t[32];

  void grumpkin_point_add(grumpkin_point_t* out, const grumpkin_point_t* a, const grumpkin_point_t* b);
  void grumpkin_point_double(grumpkin_point_t* out, const grumpkin_point_t* p);
  void grumpkin_scalar_mul(grumpkin_point_t* out, const grumpkin_scalar_t k, const grumpkin_point_t* p);
  void grumpkin_scalar_mul_g(grumpkin_point_t* out, const grumpkin_scalar_t k);
  ```
- **C2** — Algorithm: **Montgomery ladder over Jacobian projective coords**. 254-bit scalar → 254 iterations; per iteration, one point-double + one point-add, always-executed (CT). Final Jacobian→affine via one field inverse.
- **C3** — Generator point G constants hardcoded from `barretenberg/cpp/src/barretenberg/ecc/curves/grumpkin/grumpkin.hpp`. Verify byte-equal vs Aztec's in-circuit constants.
- **C4** — Benchmarking harness: temporary `INS_BENCH_GRUMPKIN = 0xFE` (`#ifdef DEV_BENCH_INS`, never shipped). Measure wall-clock for 1 scalar mult. Establish baseline before Phase E starts. **Hard gate:** <300ms per scalar mult on Nano S+ emulator (deploy needs ~5 mults; total ≤1.5s acceptable).
- **C5** — Parity oracle in `packages/adapter-ledger/test/grumpkin-parity.test.ts`. Wraps `Grumpkin` from `aztec-packages/yarn-project/foundation/src/crypto/grumpkin/index.ts`. N=200 random `(scalar, point)` pairs; assert device output == ref byte-equal.

**Done-when:** parity green; benchmark <300ms; constant-time review documented.

**Dependencies:** Phase B. **Effort:** ~1.5-2 weeks (highest variance — perf may surprise; see risk register).

### Phase D — `INS_DERIVE_AZTEC_VIEWING_KEYS`

**Goal:** deterministic sig + host HKDF expansion → 4 viewing scalars.

- **D1** — INS code: `INS_DERIVE_AZTEC_VIEWING_KEYS = 0x12`. Add to `packages/adapter-ledger/src/apdu.ts` + 5 new SWs as needed.
- **D2** — `ledger-app/src/handler/derive_aztec_viewing_keys.{c,h}` (new). Parses BIP-32 path; computes `msg = sha256("aztec-vk-derive-v1\x00" || path_len_byte || path_bytes)`. Domain prefix in `constants.h`. Path canonicality check identical to deploy (m/44'/AZTEC_COIN_TYPE'/...).
- **D3** — NBGL review UI: `"Derive Aztec viewing keys for m/44'/.../0'/0/0?"`. Single approve. Caption: "One-time per account. Save the resulting signature as backup."
- **D4** — On approve: sign with `bip32_derive_ecdsa_sign_rs_hash_256(... CX_RND_RFC6979, CX_SHA256, msg, ...)` (same primitive as `finalize_deploy_and_sign.c`). Apply existing `s_is_high` + `low_s_normalize` (factor into shared `ledger-app/src/crypto/ecdsa_normalize.{c,h}`). Duplicate-sign + ct_memcmp32 for fault detection.
- **D5** — Return 64 bytes `(r || s)`, low-s normalized.
- **D6** — Host: `packages/adapter-ledger/src/derive-viewing-keys.ts` (new). Exports `deriveViewingKeysFromSig(sig: Uint8Array): { nsk_m: Fr, ivsk_m: Fr, ovsk_m: Fr, tsk_m: Fr }`. HKDF-SHA256 with salt `"aztec-vk-derive-salt-v1"` and per-scalar info `"aztec-vk-derive-v1:nsk"`, etc. Output 64 bytes per scalar, reduce mod Grumpkin q via wide reduction (oversample+reject is unnecessary — 512-bit→254-bit reduction has bias ≈ 2^-258, negligible).
- **D7** — Ragger tests (happy path, wrong path canonicality, abort) + bun:test for HKDF (100-run determinism).

**Done-when:** ragger green; deterministic — same sig + same path → identical 4 scalars across 100 runs.

**Dependencies:** none on Phase B/C for the INS itself (sig is from secp256k1, not Grumpkin). **Effort:** ~0.5 week.

### Phase E — Device-side `publicKeysHash` + address verification

**Goal:** device refuses to sign deploys whose host-supplied `publicKeysHash`/`expected_address` don't match its own derivation. This is the integrity check that closes the privacy attack.

- **E1** — `ledger-app/src/l4/deploy_address.c`: add `az_deploy_compute_pubkeyshash_and_address(...)` that:
  1. Re-runs the same domain-separated sig internally via `bip32_derive_ecdsa_sign_rs_hash_256` (RFC 6979 is deterministic — yields same sig as INS_DERIVE for same path).
  2. HKDF-expands sig → 4 scalars (on-device HKDF — see E4).
  3. For each scalar: `grumpkin_scalar_mul_g(&pubkey_i, scalar_i)` (4 mults).
  4. `publicKeysHash = poseidon2([npk.x, npk.y, ivpk.x, ivpk.y, ovpk.x, ovpk.y, tpk.x, tpk.y])` — **verify against `aztec-packages/yarn-project/circuits.js/src/keys/`** for exact encoding (likely a domain-separated poseidon2 of the 8 field elements).
  5. `preaddress = poseidon2([partial_address, publicKeysHash], DOMAIN_PREADDRESS)`.
  6. `address = (grumpkin_scalar_mul(preaddress, G) + ivpk_m).x`.
- **E2** — Wire into `begin_deploy_account.c`: after existing 3-pass partial_address parity recompute (lines 196-235), call `az_deploy_compute_pubkeyshash_and_address`. Compare device-computed publicKeysHash vs `G_l4_deploy_session.public_keys_hash`; compare device-computed address vs `G_l4_deploy_session.expected_address`. Reject with new SW codes `SW_PUBLIC_KEYS_HASH_MISMATCH = 0x6F12` / `SW_ADDRESS_MISMATCH = 0x6F13` on diff.
- **E3** — Same checks added to parity-pass-3 in `finalize_deploy_and_sign.c::finalize_deploy_after_approval` (lines 143-188).
- **E4** — On-device HKDF: `ledger-app/src/crypto/hkdf.{c,h}` (new, ~50 lines). Uses `cx_hmac_sha256_init_no_throw` + `cx_hmac_no_throw` (existing BOLOS primitives).
- **E5** — Update `ui/deploy_review_ui.c`: address shown is now device-computed. Subtle UI cue ("Computed on-device" caption).

**Done-when:** ragger test — pass valid publicKeysHash → OK; pass swapped publicKeysHash (with valid signature) → device rejects at `SW_PUBLIC_KEYS_HASH_MISMATCH`. Browser e2e: deploy uses device-computed address.

**Dependencies:** Phase C + Phase D. **Effort:** ~1 week.

### Phase F — Host onboarding integration

**Goal:** browser flow integrating the new INS. Onboard once → cache scalars + sig in localStorage → subsequent deploys use cache.

- **F1** — `packages/adapter-ledger/src/account-onboard.ts` (new). Exports `onboardAccount(provider, path): Promise<OnboardedAccount>` where `OnboardedAccount = { path, sig, viewingScalars, publicKeys, publicKeysHash, address }`. Pipeline:
  - `provider.deriveAztecViewingKeys(path)` → 64-byte sig
  - `deriveViewingKeysFromSig(sig)` → 4 scalars
  - 4 × `grumpkin.mul(G, scalar)` host-side (via `@aztec/foundation`)
  - `publicKeysHash` via Aztec's `getContractInstanceFromArtifact` reference
  - `address` via same reference
- **F2** — `AztecLedgerSession`: takes the `OnboardedAccount`, passes scalars + publicKeysHash + address into BEGIN_DEPLOY_ACCOUNT. Device verifies as in Phase E.
- **F3** — `apps/demo-browser/src/state.ts`: new state `onboarded { sig, viewingScalars, publicKeysHash, address }`. Cached in localStorage under `aztec-vk-v1:<path-fingerprint>`.
- **F4** — `apps/demo-browser/src/panels/OnboardPanel.tsx` (new). Shown when no `onboarded` state. Button: "Derive Aztec viewing keys (one device approval)". On success → deploy panel.

**Done-when:** browser flow: connect → onboard (1 approval) → deploy (1 approval) → ready. localStorage persists across reloads.

**Dependencies:** D + E. **Effort:** ~0.5 week.

### Phase G — PXE wipe-and-restore demo (hero — target: `safe-v4`)

**Goal:** the wow-factor. User saves sig, wipes localStorage, pastes sig back, PXE recovers viewing keys, sees notes — without Ledger.

- **G1** — `apps/demo-browser/src/panels/BackupPanel.tsx` (new). Shown after onboarding. Displays 64-byte sig as hex (128 chars). Buttons: "Copy", "Download `.aztec-backup`" (JSON: `{ version: "1", path, sig_hex, verifying_address }`).
- **G2** — `apps/demo-browser/src/panels/RestorePanel.tsx` (new). Shown when localStorage empty (or explicit "Restore" action). Inputs: path, sig (hex paste), optional expected_address. On submit: re-derive scalars; compute publicKeysHash + address; if `expected_address` provided, assert match; hydrate localStorage; route to ready state.
- **G3** — Demo script: `docs/demos/m8-recovery.md` — walkthrough.
- **G4** — **PXE re-sync feasibility (critical unknown):** fresh PXE needs block headers up to `deploy_block`. For testnet, full re-sync can take minutes. Strategies:
  - **Best:** Aztec PXE supports `pxe.startFromBlock(deploy_block_n)` — verify in `@aztec/pxe` source.
  - **Fallback:** bundle a block-header snapshot as static asset; recovery skips header sync, just runs note discovery from `deploy_block`. Marginally weakens "fresh host" framing but keeps demo <90s.

**Done-when:** browser e2e: deploy → mint USDC → save sig → wipe localStorage → paste sig → notes visible in <90s. Demo walkthrough recorded.

**Dependencies:** F. **Effort:** ~1 week (G4 unknown could push to 2 weeks).

## 2. Implementation details — hardest pieces

### 2.1 Grumpkin scalar mult — algorithm + perf + reference

**Algorithm:** Montgomery ladder over Jacobian projective coords. CT by construction. Stack-frugal (≤700 B per call). Single inverse at end.

**Perf estimate:** ~90 ms per scalar mult on Nano S+ (Cortex M0+, 32 MHz).
- Per iteration: ~6 field muls + ~3 squares + ~4 adds. ~50µs per mult (estimate). 254 iterations × ~9 ops × 50µs ≈ ~110ms scalar mult cost.
- Inverse via Fermat exp: ~254 muls ≈ 13ms.
- Estimate is optimistic; benchmark in C4 could push to 200-300ms. Still acceptable for ≤5 mults per deploy.

**Reference port:** `barretenberg/cpp/src/barretenberg/ecc/curves/grumpkin/grumpkin.hpp` is a thin templated wrapper. Actual Montgomery-ladder algorithm is generic Weierstrass curve code. **Hand-port the Montgomery ladder** (<100 lines C) rather than translate templated C++ machinery.

**GLV decomposition:** Grumpkin has an efficient endomorphism (φ : (x,y) → (βx, y), β = cube-root of unity mod p). Speedup ~40%. **Defer to v0.5** if benchmark in C4 exceeds budget — adds complexity without sovereignty wins.

**Side-channels:** `cx_math_*` CT per BOLOS. Montgomery ladder CT by structure. Ledger threat model excludes power analysis (requires physical access). Confidence: high.

### 2.2 Address verification across BEGIN/FINALIZE split

**Grumpkin happens in BEGIN.** Reasoning: BEGIN already computes `partial_address_local`. Extending with publicKeysHash + address lets the device DISPLAY the verified address BEFORE asking for approval (the UI guarantee the user actually wants).

**Session caching:** the 4 viewing scalars derived in BEGIN stored in new `G_l4_deploy_session.viewing_scalars[4][32]` field. FINALIZE doesn't need them.

**Per-deploy time budget:** ~500ms device-side (~5 × Grumpkin + 1 × poseidon2 chain). User sees: tap "deploy" → ~1s before NBGL review screen (acceptable). Approve → ~200ms before sig returns. Total UX dominated by host proving + L2 inclusion (10-60s).

**Lock-screen risk:** Nano S+ doesn't lock during APDU in progress. As long as BEGIN→FINALIZE happens within ~10s (default IO timeout), no interference. Our 500ms compute well within.

### 2.3 Sig-as-backup encoding + UX

**Encoding:** 64 bytes as hex (128 chars). Reasons:
- Universal — clipboard, 1Password, plain text email all handle
- No checksum needed; the publicKeysHash derived from it doubles as integrity proof
- Plain text fits any password manager's "note" field

**Backup file format (optional):** `.aztec-backup` JSON:
```json
{ "version": "1", "path": "m/44'/AZTEC_COIN_TYPE'/0'/0/0", "sig_hex": "<128 chars>", "verifying_address": "0x..." }
```
On restore, host re-derives address from sig and verifies it matches `verifying_address`. Mismatch = mistyped sig or wrong path.

**QR option:** defer to M9. Adds QR library dep; not needed for demo.

**Confirmation UX:** user verifies saved sig by checking that re-derived address matches the one they wrote down separately (or against the address shown on the BackupPanel). If mismatched: sig wrong, path wrong, or HKDF parameters bumped.

### 2.4 HKDF parameters

```ts
const SALT = new TextEncoder().encode("aztec-vk-derive-salt-v1");
const INFO = {
  nsk_m: "aztec-vk-derive-v1:nsk",
  ivsk_m: "aztec-vk-derive-v1:ivsk",
  ovsk_m: "aztec-vk-derive-v1:ovsk",
  tsk_m: "aztec-vk-derive-v1:tsk",
};
// HKDF-SHA256(salt=SALT, ikm=sig_64_bytes, info=INFO[name], length=64) → 64-byte output
// Reduce mod q via wide reduction — bias = 2^254/2^512 ≈ 2^-258 (negligible)
```

The 64-byte oversample is the standard mod-q bias fix. With 512-bit input reduced mod ~254-bit prime, bias is cryptographically negligible. Each INFO string is unique → 4 outputs are independent.

## 3. Independent verification oracle

**Goal:** prove device-side Grumpkin + key derivation is byte-equal with Aztec's reference.

**Reference:** `aztec-packages/yarn-project/foundation/src/crypto/grumpkin/index.ts` — used in production by all PXE clients. Bit-equality with this lib transitively gives bit-equality with everything that calls it.

**Test plan in `packages/adapter-ledger/test/grumpkin-parity.test.ts`:**
- N=200 random `(scalar, point)` pairs
- For each: invoke device via temporary `INS_BENCH_GRUMPKIN_SCALAR_MUL = 0xFE` (`#ifdef DEV_BENCH_INS`, never shipped — guarded compile-time flag)
- Compare device output `(x, y)` against `grumpkin.mul(point, scalar)` from TS reference
- Bit-exact assertion

**Cross-impl HKDF parity:** pin Web Crypto `crypto.subtle.deriveBits`. Test same sig + path → same 4 scalars across 100 runs.

**Cross-impl publicKeysHash parity:** device-side vs `getContractInstanceFromArtifact` from `@aztec/circuits.js`. N=50 random keys; assert byte-equal.

**CI:** parity tests on every PR via `bun test packages/adapter-ledger/test/grumpkin-parity.test.ts`. Speculos required (uses `e2e:agent` harness).

## 4. Security & Adversarial Review

**(a) Host-side INS interception.** Malicious browser extension intercepts WebHID transport, replays INS_DERIVE on attacker-controlled path or replays old sig. **Mitigation:** NBGL review shows full BIP-32 path; user verification gates. **Residual risk:** blind approval → keys for attacker's path. Same as any HW phishing — document in user-facing docs.

**(b) Side-channels on Grumpkin scalar mult.** Montgomery ladder is CT by structure. `cx_math_*` CT per BOLOS. Total CT property assumed. Risk: ARM cache (none on Cortex M0+). Power analysis requires physical access (out of threat model). **Confidence: high** for v0.

**(c) RFC 6979 implementation correctness.** Protocol depends on `cx_ecdsa_sign_no_throw(CX_RND_RFC6979)` being deterministic + bias-free. Ledger's impl is shipped in production Bitcoin/Ethereum apps with millions of users (audited). Trezor 2018 low-entropy bug was on a different (Schnorr) code path — not precedent for Ledger ECDSA. **Mitigation:** Node-side RFC 6979 reference impl via `secp256k1` npm; parity check N=100 vectors. Divergence = file Ledger SDK bug.

**(d) Domain separation leak.** Derivation message `sha256("aztec-vk-derive-v1\x00" || path_len_byte || path_bytes)`. Risk: another Aztec sig (SIWA, future protocols) accidentally collides. Mitigation: a) unique prefix string, b) sha256 input — only deliberate pre-image collision could exploit. **Threat:** attacker who knows the prefix tricks user into signing SIWA with byte-identical pre-image. **Mitigation:** distinct INS = distinct NBGL screen per operation. User sees `INS_DERIVE_AZTEC_VIEWING_KEYS` review, not a TX review. **Residual: low.**

**(e) Sig-backup theft.** Saved sig is viewing-keys bearer token forever. 1Password compromise → permanent viewing leak. **No anti-rewind mitigation** without breaking the "save once, restore forever" property. **Trade-off accepted.** User education: treat sig like a private key. Document on BackupPanel.

**(f) NVRAM.** M8 stores nothing in NVRAM. All session state RAM-only, wiped by `l4_session_reset()`. No write-cycle risk.

**(g) Blind-sign coverage after M8.** Deploys: fully clear-signed (call list + address + publicKeys verified on-device). Transfers: clear-signed via existing CS verb manifest (M6+M7). **What's still blind:** any tx whose call selector isn't in the CS manifest → defaults to safe-blind-sign with raw selector + arg hash displayed. No regression from M7.

**(h) Cross-impl publicKeysHash byte-equivalence.** Three impls must agree: device (C), PXE (TS via `@aztec/circuits.js`), in-circuit (Noir). Aztec's test suite validates PXE↔Noir. M8's parity oracle validates Device↔PXE → transitively Device↔Noir. **Risk:** future Aztec protocol upgrade changes hash domain. **Mitigation:** pin `@aztec/*` to exact `4.2.1`; revisit on each upgrade.

**(i) Anti-phishing for INS_DERIVE.** Hostile dApp tricks user into INS_DERIVE for attacker path, exfiltrating viewing keys. **Mitigation:** NBGL review shows full path + user education. **Residual: same as any sign-this-message phishing;** document on OnboardPanel.

**(j) Reorg/replay for deploys.** Deploys are non-replayable (deploy nonce + sequencer state = one-shot). Re-deploying same address requires different salt = different account. **No new attack surface vs M7.**

**(k) Recovery flow integrity.** If a malicious sig is pasted into RestorePanel, host computes wrong scalars + wrong address. **Mitigation:** the `expected_address` field in the backup JSON acts as integrity proof — host re-derives address from sig and asserts match. Mismatch → user sees clear error before any actions take effect.

**(l) Multi-device users.** A user with two Ledgers + same seed phrase gets the SAME sig (RFC 6979 is deterministic; BIP-32 child key is deterministic from seed). So losing one Ledger doesn't require backup — second Ledger works. Sig backup is for the "no Ledger access right now" case, not "Ledger destroyed".

## 5. Testing strategy

| Layer | Suite | Trigger |
|---|---|---|
| Unit (TS, parity) | `packages/adapter-ledger/test/*-parity.test.ts` | Every PR |
| Unit (C, fault) | `ledger-app/tests/*_unit.py` (ragger) | Every PR |
| Integration (device flow) | `ledger-app/tests/test_deploy_full.py` | Every PR |
| E2E (browser + Speculos) | `apps/demo-browser/e2e/*.spec.ts` (Playwright) | Nightly + manual |
| Recovery on testnet | `apps/demo-browser/e2e/recovery.spec.ts` | Manual + before demo |

**Critical scenarios:**
- **Happy:** onboard → deploy → transfer → save sig → wipe → restore → notes visible
- **Adversarial — pubkeys swap:** host MITM swaps `publicKeysHash` → device rejects at `SW_PUBLIC_KEYS_HASH_MISMATCH`
- **Adversarial — wrong sig on restore:** RestorePanel detects via `expected_address` mismatch
- **Adversarial — wrong path on INS_DERIVE:** device shows path, user rejects → `SW_USER_REJECTED`
- **Determinism:** same sig + path → same 4 scalars across 100 derivations
- **Cross-impl:** N=50 random scalars; device pubkey == foundation Grumpkin byte-equal
- **Cross-impl — publicKeysHash:** N=50 random `(nsk, ivsk, ovsk, tsk)`; device hash == `@aztec/circuits.js` hash

## 6. Effort estimate

| Phase | Best | Most likely | Worst |
|---|---|---|---|
| A — P4 host deploy builder | 4d | 1 wk | 10d |
| B — BN254 field | 3d | 1 wk | 8d |
| C — Grumpkin group + scalar mul | 1 wk | 1.5 wk | 3 wk |
| D — INS_DERIVE | 2d | 0.5 wk | 1 wk |
| E — Device pubkeysHash + address verify | 4d | 1 wk | 1.5 wk |
| F — Host onboarding | 2d | 0.5 wk | 1 wk |
| G — Recovery demo (PXE re-sync) | 3d | 1 wk | 2 wk |
| **Total** | **~4 wk** | **~6.5 wk** | **~10 wk** |

**Highest variance:** Phase C (Grumpkin perf — cx_math_* unknown wall-time; potential need for Barrett/Montgomery reduction specialization). Phase G — PXE partial-restore feasibility unclear; pre-flight in G4.

## 7. Open questions

1. **Anti-rewind on sig backup?** A counter-versioned sig (`sign(msg || epoch)`) would let users rotate without redeploying. Breaks "save once forever" simplicity. **Defer to user.**
2. **INS_DERIVE returns sig vs scalars?** Current plan: returns sig; host HKDF-expands. Alternative: device HKDF-expands internally and returns 4 scalars. Simpler protocol; removes portable backup property unless we ALSO expose sig. **Recommend keeping sig-returning** to preserve backup story.
3. **PXE partial-restore from `deploy_block`?** Need to verify `@aztec/pxe` supports it in Phase G-G4 pre-flight. If no: bundle block-header snapshot as fallback.
4. **Manifest version bump.** Adding INS_DERIVE requires `L4_MANIFEST_VERSION` increment? Probably yes. Downstream clients update.
5. **GLV decomposition for Grumpkin scalar mult.** Include in v0 (1-2 extra wk) or defer? Tied to Phase C-C4 benchmark result.
6. **publicKeysHash exact encoding** — verify against `aztec-packages/yarn-project/circuits.js/src/keys/` BEFORE writing E1 implementation; the domain separator + byte order matters.

## 8. Risk register

| # | Risk | P | I | Mitigation |
|---|---|---|---|---|
| 1 | Grumpkin scalar mul too slow on Nano S+ (>2s per deploy) | 25% | High (re-architect to host-assisted; breaks sovereignty story) | Benchmark in C-C4 BEFORE building E. If >2s: GLV + Barrett (+1-2 wk) |
| 2 | `cx_math_invprimem_no_throw` missing/unstable | 15% | Medium (write Fermat exp manually, ~50 lines) | Pre-flight check on Speculos in Phase B |
| 3 | RFC 6979 cross-impl divergence (Ledger vs Node) | 5% | High (sig non-deterministic → recovery breaks) | Parity oracle in D-D7 |
| 4 | publicKeysHash impl mismatch device ↔ Aztec ref | 20% | High (deploy fails byte-equal) | Parity oracle in E; verify against `getContractInstanceFromArtifact` BEFORE writing E1 |
| 5 | PXE partial-restore not feasible (forces full block sync, breaks <90s demo) | 30% | Medium (demo lands but slow; fallback to pre-cached headers) | Pre-flight test in G-G4 |

## Verdict

**Build this as planned? Yes** — with one caveat. The plan aligns with what Aztec's protocol actually permits (four protocol secrets MUST be host-exportable for PXE; only signing key device-bound). Sign-and-derive is the right primitive: portable, device-independent recovery without compromising the signing key. **Push back hardest on the PXE partial-restore assumption in Phase G** — that's unverified and the <90s demo target hinges on it. If `@aztec/pxe` doesn't support `startFromBlock`, we either pre-cache block headers (which weakens the "fresh host" framing) or accept a slower restore demo. Mandatory Phase 0 pre-flight: spin up a fresh PXE pointed at a known testnet account, time note-discovery from `deploy_block`. If >2 min, Phase G needs a different framing or earlier scoping fix. Secondary push-back: the privacy-key story should be explicitly explained in user-facing docs — sig-backup theft IS permanent viewing leak, and that's a real trade-off vs. fully ephemeral keys we're not even considering.
