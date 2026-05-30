# M10 codex plan/audit (session 019e7a55, xhigh)

## Verdict
Canonical `SchnorrAccount` is feasible, but: (a) only a FIXED-generator 4-point MSM is needed for signing (my draft over-scoped "generic var-base mul"), (b) the Pedersen scalar-reduction gotcha is the real risk, (c) codex recommends shipping a **Poseidon2-based Grumpkin-Schnorr account first**, canonical Pedersen/Blake2s as phase 2.

## Adopted (verbatim-worthy points)
- **CRITICAL — key derivation**: NEVER derive the Schnorr signing key from the Aztec master secret — the reveal flow (`get_aztec_master_secret.c`) exports that secret to the host BY DESIGN, so a spend key derived from it = spend-key exfiltration. Derive from the secp256k1 BIP-32 child priv + a SEPARATE domain string. (My draft chose child-priv; codex sharpens *why* it's mandatory.)
- **Signing needs only FIXED-gen MSM** (G0,G1,G2,H_len), NOT generic `[k]P`. Generic var-base is only for on-device *verify* (out of scope). → simplifies P2: implement a 4-point fixed-generator Pedersen MSM, not a general var-base mul.
- **Pedersen construction** (canonical): `pedersen_hash([a,b,c]) = x( 3·H_len + a·G0 + b·G1 + c·G2 )`; `H_len` = `"pedersen_hash_length"` gen, `G0..` = `"DEFAULT_DOMAIN_SEPARATOR"` offsets 0.. . Refs: `barretenberg/.../crypto/pedersen_hash/pedersen.cpp:77-82`, `pedersen.hpp:16-24`, `crypto/generators/generator_data.hpp`, `ecc/groups/precomputed_generators_grumpkin_impl.hpp`.
- **Scalar-reduction gotcha**: Pedersen inputs are Grumpkin coords in BaseField (`bb::fr`); the MSM scalar field is `bb::fq` (Grumpkin scalar). Each 32-byte input is reduced full-width into the Grumpkin scalar field before mul. Don't match WNAF — only the group result. → add BOUNDARY parity vectors near BOTH BN254 moduli (silent-failure trap).
- **Generator provenance** = trust root: in-repo derivation script pinned to the Aztec commit; parity-test G0,G1,G2,H_len.
- **Nonce**: deterministic OK, but domain-separate HARD + independent of any reveal-domain; dual-derive + compare the final signature (ECDSA discipline).
- **Scheme confusion** (HIGH): curve_id, deploy profile/class_id, pubkey APDU, B3 consumer/address recompute, cache key, UI copy must ALL branch on the same scheme or fail closed.
- **Blake2s**: assume BOLOS lacks it → software RFC-7693 Blake2s-256.
- **Reorder**: decide key-derivation + pubkey/APDU FIRST; split "Pedersen scalar semantics" from "Pedersen hash end-to-end" as two gates.
- Effort: canonical POC ~4-7 focused days; hardened (provenance + fault + parity gates) ~1-2 weeks.

## Open decision (de-scope) — to resolve in consolidation
codex: Poseidon2 custom account first (removes all 3 long poles; not canonical SchnorrAccount). My lean: CANONICAL is the credible flex for the Aztec ecosystem lead; de-scope only as a documented fallback if Pedersen parity proves intractable. Confirm against opus.
