# M10 opus plan/audit (independent, opus Plan agent)

## Verdict
Feasible, ~1.5–2.5 weeks hardened, **lower-risk than my draft feared**. Build the **canonical `SchnorrAccount`** — do NOT de-scope to a poseidon variant (directly opposes codex's lean; opus's case is better-grounded — see below).

## Load-bearing corrections to my draft (all verified against source)
1. **curve_id: use `L4_CURVE_ID_GRUMPKIN = 3`**, not a new `=2`. `wire.h:24-26` already has `K1=1`, `R1=2 (reserved)`, `GRUMPKIN=3 (reserved for L5)`. My `=2` would collide with R1. ✅ verified.
2. **Pedersen generators are ALREADY hardcoded in barretenberg** — `ecc/groups/precomputed_generators_grumpkin_impl.hpp` has `"pedersen_hash_length"`×1 + `"DEFAULT_DOMAIN_SEPARATOR"`×8 as literal `uint256_t` (x,y). ✅ verified. → No host derivation script (my draft's plan); just lift G0,G1,G2 (first 3 default) + H_len into `pedersen_generators.c` (mirror `g1_generator.c`); the @aztec/foundation parity test proves correctness.
3. **NO scalar reduction for pedersen inputs.** `commit_native`→`mul_without_endomorphism` (`element_impl.hpp:603`) does `uint256_t(scalar)` then plain double-and-add MSB-first. Aztec Fr (input field, `…f0000001`) < Grumpkin group order = Fq (`…d87cfd47`), so every canonical Fr input is already a valid scalar → it's `[raw_32B_BE]·g_i`, exactly the var-base routine. Dissolves codex's "scalar-reduction gotcha."
4. **Pedersen needs Blake3 (+ hash-to-curve) ONLY if deriving generators on-device — which we won't.** Hardcoding generators avoids Blake3 entirely. **Blake2s is needed ONLY for the outer Schnorr challenge `e_raw`.** Corrects my draft's conflation.
5. **Variable-base `[k]·P` is ~9 lines**: clone `grumpkin_scalar_mul_generator` (`mul_generator.c:42`) passing `qx,qy` instead of fixed G; the double-and-add-always loop + `grumpkin_point_add_affine` already handle edges. Pedersen MSM = 3×that + adds + `[3]·g_len`. → P3 is ~1–2 days, not a week.
6. **Construction**: `H(v0,v1,v2) = ( g_len·3 + g0·v0 + g1·v1 + g2·v2 ).x` (length term = length_gen × Fr(inputs.size()==3)).

## Key-derivation (sharpens both my draft + codex)
`schnorr_priv = reduce_mod_Fq( SHA-512("aztec-schnorr-signing-v1" ‖ secp256k1_child_priv_d) )` — **must reduce mod Fq (Grumpkin scalar)**, NOT Fr. The master secret is reduced mod Fr (`aztec_secret.c`, wrong field) AND is host-exportable via the reveal → never root the spend key there. Use the Fq wide-reduce (`fq.h`). Child-priv rooting keeps reconnect==recovery.

## Adversarial (converges with codex; additions in bold)
- **Nonce**: deterministic `k = reduce_Fq(SHA-512("aztec-schnorr-nonce-v1" ‖ **curve_id ‖ P.x ‖ P.y** ‖ priv ‖ msg))` — bind curve_id + pubkey so no cross-scheme/collision (k,msg) repeat. Reject k==0/e==0/s==0. Dual-derive + byte-compare s,e (stronger than barretenberg's random-k).
- **Scheme confusion = highest-value attack**: B3 consumer recompute + Phase-6 address MUST branch on curve_id (Schnorr → profile[1] + Grumpkin pubkey ctor args; viewing-key half is scheme-independent), at BOTH pre-UI and pre-sign sites, fail-closed. Signing-primitive selection + address-recompute must key off the SAME curve_id.
- **Serialization**: emit RAW `e_raw` (not e mod n) + `s` as 32-byte BE — wrong here silently breaks on-chain verify.
- **Generator integrity**: lift from barretenberg's file, commit the provenance (aztec commit hash), make the pedersen parity a committed CI gate.
- **Side-channel (state LOUDLY)**: Schnorr adds secret-dependent var-base mul (`priv·e`, `k·G`) → real key-extraction surface on physical HW. HW-audit item; do NOT claim side-channel resistance.
- **Trust gap**: @aztec/foundation WASM = barretenberg, so JS-parity proves device==barretenberg; **only on-chain inclusion proves device==the Noir verifier** (external `noir-lang/schnorr` v0.2.0). → P6 testnet inclusion is a NON-NEGOTIABLE gate.

## Validation
Per-primitive golden vectors (blake2s, var-base, pedersen-3 incl. zeros/max-canonical-Fr) + e2e sig-verify (≥256 random) + a **fixed-k byte-equality vector** (catches serialization bugs verify-only masks) + on-chain inclusion + Playwright (reuse the Speculos harness; model on `deploy-fresh-account.e2e.ts` + `smoke.e2e.ts`).
