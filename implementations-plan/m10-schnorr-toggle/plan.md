# M10 — Schnorr-over-Grumpkin signing + ECDSA/Schnorr toggle (Tier A)

**Status:** drafting (main plan) → parallel codex + opus → consolidate → self-eval → implement (AFK).
**Checkpoint:** branch `m9-real-wallet-ux`, tag `safe-v7` (`c5be220`) is the clean pre-M10 fallback.

## 1. Goal & success criteria
Add **native Schnorr-over-Grumpkin** signing to the Ledger app alongside the existing ECDSA-secp256k1, and a **frontend toggle (ECDSA ⇆ Schnorr)** that demos both end-to-end against testnet. Plus two device-review UX fixes (Phase 0).

"Done" =
- Toggle Schnorr → onboard → deploy a `SchnorrAccount` → drip → transfer, all clear-signed on-device, **included on testnet**, validated **headless via Playwright** (mirroring M9's smoke/onboard/reconnect harness).
- Toggle ECDSA → the existing flow still works (no regression).
- Device Schnorr signatures **verify under `@aztec/foundation/crypto/schnorr` `Schnorr.verifySignature` AND on-chain** (the SchnorrAccount entrypoint).
- Parity tests (bun) prove the device's pedersen/blake2s/schnorr sub-steps match barretenberg golden vectors, plus a `describe.skipIf(!SPECULOS_URL)` integration test.

## 2. Ground truth (verified against source)
- **SchnorrAccount** (`noir-contracts/.../schnorr_account_contract/src/main.nr:83`): `schnorr::verify_signature(EmbeddedCurvePoint{x,y}, [u8;64] sig, outer_hash.to_be_bytes::<32>())`. **Message = the same `outer_hash`** the L4 manifest already computes (NOT sha256'd — unlike ECDSA-K). So all of L4 (BEGIN_AUTHWIT/APPEND_CALL/outer_hash, the deploy outer_hash, B3 consumer recompute) is REUSED; only the final signing primitive changes.
- **Signing key**: a `GrumpkinScalar` (Grumpkin scalar field = BN254 **base** field `Fq`; the device's M8 "Fq module", modulus `AZ_FQ_P`). Pubkey `P = priv·G` (Grumpkin point; coords in BN254 `Fr` = `AZ_FR_P`).
- **Construction** (barretenberg `schnorr.tcc`; the JS `Schnorr` is a thin BarretenbergSync/WASM wrapper, so JS == on-chain):
  - `k` = nonce (Grumpkin scalar). barretenberg uses random; **we will derive k deterministically** = reduce(SHA-512("aztec-schnorr-nonce-v1" ‖ priv ‖ msg)) → verifies identically, removes RNG-failure → nonce-reuse risk, and makes device output reproducible for tests.
  - `R = k·G` (Grumpkin point).
  - `compressed = pedersen_hash([R.x, P.x, P.y])` → one BN254 `Fr` (32 bytes). **Aztec/barretenberg pedersen** (NOT poseidon).
  - `e_raw = Blake2s( compressed(32) ‖ msg(32) )` → 32 bytes (64-byte preimage).
  - `e = e_raw mod n_grumpkin`; `s = (k − priv·e) mod n_grumpkin`.
  - **signature = `s`(32 BE) ‖ `e_raw`(32) = 64 bytes**. (Note: serialize raw `e`, not reduced.)
- **Verify** (what the chain checks): `R' = e·P + s·G`; recompute `e_raw' = Blake2s(pedersen([R'.x,P.x,P.y]) ‖ msg)`; accept iff `e_raw' == sig.e`. Reject if `s==0||e==0` or `R'` is infinity.

## 3. Device crypto gaps (the real work) + existing building blocks
Existing (M8): `grumpkin_point_{double,add_affine,to_affine_be}`, `grumpkin_scalar_mul_generator` (fixed-base [k]G), BN254 `Fr` (`fr_add/sub/mul`, `fr_from_bytes_wide_be`), Grumpkin scalar `Fq` module, poseidon2, SHA-512, the ECDSA sign flow (`sign_outer_hash.c`), deploy/authwit/B3 machinery.

New, in dependency order:
1. **Blake2s** (RFC 7693) — BOLOS likely ships only `cx_blake2b`; implement Blake2s-256 in software (~150 LOC, fully specified). **[research: confirm BOLOS has no blake2s]**
2. **Variable-base Grumpkin scalar mul** `[k]·P` for arbitrary affine `P` (double-and-add over `grumpkin_point_double` + `grumpkin_point_add_affine`). Constant-time-ish (the existing code already documents data-dependent timing as acceptable for this PoC).
3. **Pedersen hash** `pedersen_hash([Fr,Fr,Fr]) → Fr` matching barretenberg's `crypto::pedersen_hash` (**the long pole**):
   - Generators: barretenberg derives them via grumpkin hash-to-curve (`derive_generators("DEFAULT_DOMAIN_SEPARATOR", n, 0)`). **Plan: precompute the needed generators offline (host script using barretenberg) and hardcode them as device constants** (like `g1_generator.c`) — avoids implementing hash-to-curve on-device. Need: generator[0..2] for the 3 inputs + the length/iv generator; confirm count & exact construction (length-prefix? generator-index offset?). **[research: exact barretenberg pedersen_hash construction + which generators]**
   - Hash = `(Σ inputs[i]·generators[i] [+ length term]).x`. Inputs are BN254 `Fr`; used as **Grumpkin scalars** (field-size subtlety: `Fr` modulus ≠ Grumpkin scalar modulus). barretenberg's pedersen handles inputs as full field elements — confirm the scalar-reduction/decomposition. **[research: how barretenberg multiplies a 254-bit Fr input by a Grumpkin generator — wnaf? full-width?]**
4. **Schnorr sign glue**: deterministic-k → R=k·G → pedersen → blake2s → e,s → serialize. Fault-harden (dual recompute + compare, like the ECDSA dup-sign check).
5. **Grumpkin signing-scalar derivation** from the BIP-32 path (deterministic, distinct from viewing keys): `schnorr_priv = reduce_to_grumpkin_scalar( SHA-512("aztec-schnorr-signing-v1" ‖ secp256k1_child_priv) )`. Mirrors the master-secret derivation pattern; recovery = reconnect. **[decision to confirm: derive from secp256k1 child priv vs from the master secret]**

## 4. Wire protocol & host
- **Scheme selector**: reuse the existing `curve_id` wire byte. Add `L4_CURVE_ID_SCHNORR_GRUMPKIN = 2` (K1 = 1 today). BEGIN_AUTHWIT/BEGIN_DEPLOY already carry `curve_id`; the device dispatches sign primitive on it. FINALIZE returns 64-byte sig either way (r‖s for ECDSA, s‖e for Schnorr).
- **New APDU**: `INS_GET_SCHNORR_PUBKEY` (Grumpkin `P=priv·G`) so the host builds the `SchnorrAccount` (ctor args = P.x, P.y). Analogous to `get_public_key.c`.
- **Deploy profile**: add `CS_DEPLOY_PROFILES[1]` = SchnorrAccount (its `account_class_id`, `ctor_selector`, arg schema = 2×Fr pubkey). Regenerate `deploy_profiles.gen.{c,h}` from the manifest. The deploy review’s "Account #N" + verified address (Phase-6) recompute must branch on scheme (Schnorr partial-address uses the Grumpkin pubkey ctor args, not the secp256k1 x/y).
- **B3 consumer recompute** must also branch: for Schnorr, the account address derives from the Schnorr pubkey ctor args + profile[1]. The `az_account_derive_from_path` viewing-key half is scheme-independent (same master secret); only the partial-address ctor args differ.
- **Adapter**: subclass `@aztec/accounts/schnorr` `SchnorrBaseAccountContract` with a device-backed `AuthWitnessProvider` (signs via FINALIZE with curve_id=Schnorr) + `getInitializationFunctionAndArgs` using the device's `GET_SCHNORR_PUBKEY`. New `schnorr-account.ts` + a scheme param threaded through `AztecLedgerSession.connect`.

## 5. Frontend toggle
- `ConnectPanel`/`OnboardPanel`: a `scheme: 'ecdsa' | 'schnorr'` selector (segmented control). Threaded to `connect({ scheme })` → picks account contract + curve_id + cache key (the device pubkey differs per scheme, so the secret/cache key must include scheme). Distinct deterministic accounts per scheme (different class_id ⇒ different address). Copy: explain both are the SAME Ledger key family, different signature scheme.

## 6. Phase 0 — device-review UX (independent, ship first)
- **Truncate the on-device address** (user request). Switch the B3 verified `From` (`verified_calls_ui.c`) and the deploy review address (`deploy_review_ui.c`) from full 64-hex back to the existing `short_hex_field` convention (`0x` + 4 bytes…4 bytes). **Security: safe** — these addresses are device-VERIFIED (B3 cross-check / Phase-6 expectedAddress), so truncation can't enable an address-grinding swap; full-hex was over-cautious. (Revisits the B3 codex "full-hex" call — the verification, not the display width, is what binds the address.)
- **De-redundant the transfer "Mode"** (user request): the action label already says "Transfer pub->pub", so the PUBLIC/PRIVATE token is redundant. `format_mode` will emit ONLY the security-relevant flags (`STATIC`, `HIDE_SENDER`) and the pair is shown **only when one is set**. Plain public/private transfers lose the noise line. (Undecodable calls don't exist — the strict allowlist rejects them at APPEND_CALL — so there's no "need it for undecodable" case to preserve.)

## 7. Phased implementation + validation gates
- **P0** UX (truncate + mode) → build → Playwright onboard/smoke still green (device screens differ; update selectors only if asserted). Commit.
- **P1** Blake2s + golden-vector parity test (bun, vs a JS blake2s).
- **P2** Variable-base Grumpkin mul + parity test (vs barretenberg/noble grumpkin).
- **P3** Pedersen hash + parity test (vs `@aztec/foundation` pedersen golden vectors). ← highest risk; gate hard.
- **P4** Schnorr sign (deterministic k) + parity: device sig **verifies** under `Schnorr.verifySignature` for random scalars/messages (bun, host-side; the device sub-steps already golden-tested).
- **P5** `GET_SCHNORR_PUBKEY` + curve_id dispatch in FINALIZE/BEGIN; Speculos APDU test.
- **P6** Host adapter: SchnorrAccount + device auth-witness provider + scheme param.
- **P7** Frontend toggle.
- **P8** E2E (Playwright, testnet): Schnorr onboard→deploy(fresh idx)→drip→transfer, incl. a `deploy-fresh-account`-style review-appears check + a full drip→include; ECDSA regression suite still green.
- **P9** Post-impl codex review + fix loop.

Each device phase: clean nanos2 `-Werror` build + parity test before advancing. Reuse the M9 Speculos harness (`speculos-aztec-playwright`, the self-healing reset, the 5×right/both approver). After 3 failures on a step → stop & reassess (log in `lessons/phase-N.md`).

## 8. Security & Adversarial Considerations
- **Nonce reuse = key recovery** (the cardinal Schnorr/ECDSA sin): deterministic k bound to (priv, msg) eliminates RNG-failure reuse; dual-derive + compare to catch glitches; never expose k.
- **Cross-impl correctness**: a device pedersen/blake2s that disagrees with barretenberg by one bit → every signature rejected on-chain (fail-closed, but broken). Golden-vector parity at each sub-step is mandatory; final gate = on-chain inclusion.
- **Pedersen generator integrity**: hardcoded generators are a trust root — derive them with a committed host script from barretenberg, parity-test the resulting `pedersen_hash` against `@aztec/foundation`, and document provenance. A wrong/backdoored generator silently changes the hash.
- **Scheme confusion**: the device must bind the displayed/derived account to the curve_id actually signed; a host that says "Schnorr" in the UI but elsewhere must not cause an ECDSA sig over a Schnorr account’s hash (or vice-versa). The B3 consumer recompute + Phase-6 address verify (per-scheme) are the guard — extend both to branch on curve_id, fail-closed on mismatch.
- **Field-size / malleability**: Schnorr sigs here are malleable (s+n accepted); fine for authwit (single-use, nullified). Reject s==0/e==0/R∞ exactly as barretenberg.
- **Least privilege / supply chain**: no new npm runtime deps if possible (reuse installed `@aztec/foundation`); 7-day min-age holds; device build stays pinned `ledger-app-builder-lite` digest.
- **Side-channel**: var-base mul timing is data-dependent (documented PoC limitation; flag for the real-HW audit, not a v0 blocker).
- **Frontend**: scheme toggle must not let a stale session (wrong scheme’s keys/cache) sign — cache key includes scheme; "Forget" clears per-scheme.

## 9. Open questions / decisions (resolved-by-me where AFK)
1. **Pedersen on device — implement fully vs de-scope.** Default: implement (hardcoded generators + var-base MSM) — it's the real flex. **De-scope fallback** (if pedersen proves > ~1 week or blocks): a *custom* account contract whose challenge uses **poseidon2** (device already has it), deployed as our own "Grumpkin-Schnorr (poseidon variant)". Demonstrates Grumpkin-Schnorr signing without pedersen, but is NOT the canonical `SchnorrAccount`. **Codex/opus: weigh this explicitly.**
2. **k derivation** deterministic (chosen) vs cx_rng — chosen deterministic.
3. **Signing scalar** from secp256k1 child priv (chosen, mirrors ECDSA rooting) vs master secret.
4. **Toggle scope**: separate deterministic accounts per scheme (chosen) — a user can hold both.

## 10. Deliverables
plan.md (this) · audit-codex.md · audit-opus.md · eli5.html · lessons/phase-N.md · index.md entry. Code per §7.
