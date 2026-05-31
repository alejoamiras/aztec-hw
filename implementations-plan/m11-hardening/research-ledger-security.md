# M11 Hardening — Production Ledger embedded-app security research

Research date: 2026-05-31. Goal: ground the M11 hardening plan in what **production
Ledger apps + the BOLOS/Ledger SDK + Ledger's security guidelines actually do**, with
citable references. Every claim below is tagged with a confidence level. Where I could
not verify a thing, it is marked **unverified** rather than invented.

## What our app currently does (baseline under review)

Pulled from the current tree so the contradictions below are precise:

- **Hand-rolled crypto on Grumpkin (BN254-base-field curve, NON-native to `cx_`)**: Montgomery
  CIOS field arithmetic (`src/crypto/grumpkin/fq.c`), Jacobian EC point ops
  (`src/crypto/grumpkin/point.c`), Pedersen / Blake2s / Poseidon2, and Schnorr-over-Grumpkin
  (`src/crypto/schnorr.c`).
- **Scalar multiplication** (`src/crypto/grumpkin/mul_generator.c`): double-and-add-**always**
  with a bitmask `grumpkin_point_cmov` select. Honest self-assessment already in the header
  comment — NOT fully constant-time: the infinity fast-paths in `point.c` (`grumpkin_point_double`,
  `grumpkin_point_add_affine`) short-circuit while `acc == O`, leaking the leading-zero count
  (effective bit-length) of the scalar; plus a data-dependent `H==0` branch in `add_affine`. No
  scalar blinding. No fixed-base comb.
- **Fault injection**: Schnorr signature **construction** runs twice + constant-time 64-byte compare
  (`schnorr_grumpkin_sign_with_nonce`, `sign.c`); ECDSA path dual-derives + compares r/s
  (`finalize_and_sign.c`, `sign_outer_hash.c`); `outer_hash` is recomputed three times. **But the
  Schnorr signing-scalar and the nonce are derived single-pass** (`finalize_and_sign.c` lines ~282-310
  document this as a known follow-up). `cx_*` return codes are checked manually (`!= CX_OK`, `!= 64`).
  No `LEDGER_ASSERT`.
- **Secret memory hygiene**: heavy `explicit_bzero` on every error path + a custom
  `grumpkin_secure_wipe` for EC temporaries. No `BEGIN_TRY/FINALLY` (the codebase uses the modern
  non-throwing API, so there is nothing to `CATCH`). Secrets live on the stack, re-derived per call,
  not in long-lived globals.
- **Nonce**: deterministic, `k = reduce_Fq(SHA-512(DOMAIN ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg))`
  (`l4/aztec_secret.c::az_derive_schnorr_nonce`), single pass. ECDSA path uses BOLOS
  `CX_RND_RFC6979`.
- **Signing scalar**: `priv = reduce_Fq(SHA-512(DOMAIN ‖ child_priv))`
  (`az_derive_schnorr_signing_scalar`), single pass.
- **Scalar-from-hash reduction**: `gk_fq_from_bytes_wide_be` — Horner over the full **512-bit**
  SHA-512 output mod the 254-bit Grumpkin order. No rejection sampling.

---

## 1. Constant-time / side-channel-resistant scalar mul on NON-native curves

### The single most important finding: Ledger's own answer is "use the chip, not app C"

For every curve where BOLOS exposes a `cx_` primitive, **production Ledger apps do NOT roll their
own scalar multiplication** — they call the OS syscall, which is the side-channel/fault-hardened
implementation that actually went through Common Criteria / Donjon evaluation. Confidence: **high**.

- **Monero (Ed25519, `LedgerHQ/app-monero/src/monero_crypto.c`)** — Ed25519 is native, so every
  EC mul is `cx_ecfp_scalar_mult_no_throw(CX_CURVE_Ed25519, Pxy, s, 32)` (the `monero_ecmul_G` /
  `monero_ecmul_k` / `monero_ecmul_8k` wrappers, ~lines 836-960). Field arithmetic is
  `cx_math_*m_no_throw` (`cx_math_multm_no_throw`, `cx_math_addm_no_throw`,
  `cx_math_invprimem_no_throw`, …). They wrote **zero** field-mul or scalar-mul loops.
- **eth2 / BLS12-381 (Ethereum staking deposit; also Filecoin)** — BLS12-381 is a **native syscall**:
  `cx_bls12381_key_gen`, `cx_hash_to_field`, `cx_bls12381_sign` in
  `LedgerHQ/ledger-secure-sdk/include/ox_bls.h` (all `SYSCALL WARN_UNUSED_RESULT cx_err_t`). The
  app (`LedgerHQ/app-ethereum/src/features/get_eth2_public_key/`) consumes a compressed G1 pubkey;
  it does not hand-roll the pairing-curve scalar mul. So the "exotic zk curve on Ledger" precedent
  is *a hardened OS syscall*, not app code.

**The SDK primitive set, verbatim from headers** (confidence: high):
- `cx_ecfp_scalar_mult_no_throw(cx_curve_t curve, uint8_t *P, const uint8_t *k, size_t k_len)`
  — `ledger-secure-sdk/lib_cxng/include/lcx_ecfp.h:213`, `WARN_UNUSED_RESULT`; the throwing
  `cx_ecfp_scalar_mult` is `DEPRECATED`.
- Bignum modular arithmetic: `cx_math_multm_no_throw`, `cx_math_addm_no_throw`,
  `cx_math_subm_no_throw`, `cx_math_powm_no_throw`, `cx_math_invprimem_no_throw`,
  `cx_math_modm_no_throw` — `lcx_math.h`. Curve families documented as "Weierstrass, Montgomery,
  and Twisted Edwards" (Ledger dev portal, *Cryptography API* reference).
- A **randomized** scalar-mult (`cx_ecpoint_rnd_*scalarmul`, the projective-coordinate-randomization /
  scalar-blinding countermeasure) exists **inside the OS cxlib** and is used by `cx_ecschnorr.c`
  (visible in the rendered SDK source at `ledgerhq.github.io/ledger-secure-sdk/cx__ecschnorr_8c_source.html`).
  It is **not part of the public app-facing header surface** on current `ledger-secure-sdk` master
  (`lcx_ecpoint.h` is not shipped there). Confidence the function exists internally: **moderate-high**;
  confidence it is callable from an app: **low** (treat as OS-internal).

### When the curve is genuinely non-native (our case): Mina is the closest real peer

**Mina (Pallas, `LedgerHQ/app-mina/src/crypto.c`)** is the best apples-to-apples reference: a
non-native short-Weierstrass curve, custom Schnorr, on a Ledger device. How they harden it
(confidence: high — read the source):

- **Field & scalar arithmetic delegate to `cx_math_*m_no_throw`** (lines 147-192 for `Field`,
  236-277 for `Scalar`). They did NOT write a Montgomery CIOS multiply — `field_mul` is literally
  `cx_math_multm_no_throw(c, a, b, FIELD_MODULUS, FIELD_BYTES)`. **This is the divergence from us**:
  we hand-wrote `fq.c` CIOS. The SDK bignum path is constant-time-by-construction and already
  audited; our CIOS is bespoke attack surface.
- **The EC group law (`group_dbl`, `group_add`, `group_scalar_mul`) IS hand-written in Jacobian
  coords** (lines 303-425), from the same hyperelliptic.org/EFD formulas we used. So for the group
  law there is no SDK shortcut even for Ledger — confirming our approach is structurally normal.
- **Their scalar mul is *less* hardened than ours on the timing axis.** `group_scalar_mul`
  (line 396) is a plain left-to-right binary ladder: `group_dbl` every bit, and `if (di) group_add`
  — a **conditional add only when the bit is set**, no dummy add, no `cmov`. Plus the same
  data-dependent early returns we have (`if (group_is_zero(p)) return; if (scalar_is_zero(k)) return;`).
  Our add-always + bitmask-cmov is strictly closer to constant-time than the shipped, audited Mina
  app. **Useful framing for the plan**: "best-effort, not perfect" timing is evidently within
  Ledger's tolerance for a secure-element app (the SE's hardware countermeasures — jitter, noise,
  masking — carry the rest).
- Fixed loop bound: `for (i = 0; i < SCALAR_BITS; i++)` with `SCALAR_BITS = 256`
  (`crypto.h:19`) — iteration count does not depend on the scalar. We match this (32 bytes × 8 bits).

**Zcash Sapling / Jubjub (`hhanh00/zcash-ledger`, third-party Rust→C device app; confidence: high
for the file contents, moderate that it is the "canonical" Zcash app since LedgerHQ has multiple)**:
- Custom Jubjub extended-coordinate point type `jj_en_t` with a hand-rolled `jubjub_mul`
  (`src/crypto/sapling.c`) — non-native curve, app-level group law, same as Mina/us.
- Scalar field arithmetic uses the **SDK bignum API** (`cx_bn_*`, `cx_math_modm_no_throw`) —
  `src/crypto/fr.c:51,61`. Again: delegate field/scalar math, hand-roll only the group law.

### Verdict for item 1 vs our approach

- **CONTRADICTS (medium-leverage):** we hand-wrote Montgomery CIOS field arithmetic (`fq.c`,
  `poseidon2/fr.c`). Every comparable Ledger app (Mina, Zcash-Jubjub, Monero) pushes field/scalar
  modular arithmetic into `cx_math_*` / `cx_bn_*`. Moving `Fq`/`Fr` mul/add/sub/inv onto
  `cx_math_*m_no_throw` would (a) delete bespoke crypto attack surface, (b) inherit the SE's
  constant-time bignum, (c) likely speed it up. The EC group law can stay hand-rolled.
- **DOES NOT contradict:** hand-rolling the Jacobian group law is normal even at Ledger.
- **Our scalar-mul timing is already better than shipped Mina.** The honest "not fully
  constant-time" caveat is real but is *not* a blocker by the precedent set by Mina. The
  highest-value timing fix is removing the infinity short-circuit (start `acc` at a fixed multiple
  of G and correct at the end, or use the fixed-base comb already noted in the header) — this also
  kills the leading-zero leak. Scalar blinding (`k' = k + r·n`) is the textbook DPA countermeasure
  but is **not** something the comparable app-C peers do (they lean on the SE); treat as optional,
  lower priority than removing data-dependent branches.

---

## 2. Fault-injection countermeasures Ledger actually mandates / uses

### What the official guidance says (confidence: high where quoted)

- **Ledger dev portal, *Cryptography* requirements page** (`developers.ledger.com/docs/device-app/
  integration/requirements/cryptography`), verbatim: *"From the 2.0 version of the SDK every
  cryptographic function has a version that returns an error code instead of raising an exception …
  `cx_ecdsa_sign_no_throw` … returns `CX_OK` if everything went fine."* and *"We enforce using all
  `_no_throw` equivalents when available, as the ones raising exceptions are deprecated."* This is a
  hard **must**.
- **`LedgerHQ/ledger-app-ai-instructions/C.instructions.md`** (the rules Ledger ships for AI agents
  writing device-app C), verbatim: *"Ensure the PR does not introduce new THROW calls. Deprecated
  cryptographic functions that can throw exceptions must not be used; prefer the non-throwing SDK
  alternatives."* and *"Always validate `dataLength` against expected sizes before any memory copy."*
  It does **not** spell out double-computation idioms (those live in the audit guidelines, not the
  coding-style file).
- **App submission requires an external security audit** (`developers.ledger.com/docs/device-app/
    submission/security-audit` and `.../submission-process/deliverables/security-audit`). The audit —
  not a public checklist — is the gate. Confidence: high that the audit is mandatory; the exact
  pass/fail criteria are not public (**unverified** in detail).

### The canonical fault-hardening idiom (confidence: high — it's Ledger Donjon's own reference)

`Ledger-Donjon/fault_injection_checks_demo/fault_hardened/src/lib.rs` is Ledger's published example
of FI-hardened code. The pattern:

- A `Protected<T>` wrapper whose equality check **compares twice with the operands swapped**:
  `if compare_never_inlined(rhs, &&self.0) { if compare_never_inlined(&self.0, rhs) { true } else
  { panic!("fault") } }`.
- The comparison helper is `#[inline(never)]` so the optimizer cannot fold the two checks; the
  protection method is `#[inline(always)]` so the double-check structure is always emitted.
- On any inconsistency → **immediate `panic!("fault")`** (halt, never return a maybe-faulted value).
- Premise: a glitch may flip one comparison but is very unlikely to flip both redundant ones
  identically.

This maps **exactly** onto our existing `ct_diff64` / `ct_memcmp32` + "recompute and compare"
discipline, and onto the **`LEDGER_ASSERT`** macro:
`ledger-secure-sdk/include/ledger_assert.h:85` — `LEDGER_ASSERT(test, format, ...)` → on `!test`
it prints diagnostics and calls `LEDGER_ASSERT_EXIT()` (halts the app). It is the SDK's "redundant
condition check that hard-stops on violation."

### What the production apps do in practice (confidence: high)

- **Mina** wraps `cx_err == CX_OK` in `LEDGER_ASSERT(cx_err == CX_OK, "…")` after *every single*
  `cx_math_*` call (`crypto.c` lines 148, 155, 162, 169, 176, 184, 192, 240, 247, 254, 261, 269, 277).
  That is the return-code discipline made mechanical.
- **Monero** accumulates errors (`error |= cx_math_…_no_throw(...)`) across a block then checks once
  (`monero_crypto.c` ~lines 386-461) — a looser but still-explicit variant.
- **"Verify the signature after producing it"**: I did **not** find this pattern in Mina's `sign`
  or Monero's signing path (confidence: high they don't do it there). The hardening they actually
  use is *deterministic recomputation + compare* of the signing math (and for us, that is already
  the `schnorr_grumpkin_sign_with_nonce` dual-run). Re-verifying the produced signature against the
  derived pubkey is a stronger, classic FI countermeasure (it catches a faulted scalar mul that a
  pure recompute-the-same-way check would miss if the fault is reproducible) — worth considering, but
  it is **not** an industry-uniform mandate. Confidence the "sign-then-verify" idiom is *generally*
  recommended for FI: moderate; that Ledger *requires* it: **unverified**.

### Verdict for item 2 vs our approach

- **CONTRADICTS (high-leverage):** **the signing-scalar and nonce derivations are single-pass.** This
  is the gap our own code comments already flag (`finalize_and_sign.c` ~line 282). A glitch in
  `az_derive_schnorr_signing_scalar` or `az_derive_schnorr_nonce` produces a signature with the wrong
  secret. It is *fail-safe* (on-chain-invalid, no key leak) and *cross-checked* by the B3
  address-recompute, but a clean fix is **dual-derive the scalar and the nonce, then compare** —
  mirroring the construction-stage dual-run. This is the #1 FI win.
- **CONTRADICTS (medium-leverage):** manual `if (err != CX_OK)` is fine, but adopting `LEDGER_ASSERT`
  (or an equivalent halt-on-violation macro) for the crypto return codes matches the Mina/SDK idiom
  and makes the "must hard-stop, never proceed faulted" intent explicit and uniform.
- **CONSIDER (medium-leverage):** add a **sign-then-verify** step for the Schnorr path — after
  producing `(s, e)`, recompute `R' = s·G + e·P` and check `e == H(compress(R'), …)`. Catches a
  reproducible scalar-mul fault that the dual-run (same inputs, same fault) cannot. Public-only
  inputs, so cheap to reason about.
- **ALREADY GOOD:** triple `outer_hash` recompute, dual-run construction + ct-compare, dual ECDSA
  derive + compare. These are squarely the Donjon idiom.

---

## 3. Secret memory hygiene on BOLOS

### What the SDK / docs mandate (confidence: high)

- **Ledger dev portal *Cryptography* page**, verbatim: *"you **must always clear the memory** after
  you use these keys. That includes key data and key objects."* with the example
  `explicit_bzero(privateKeyData, sizeof(privateKeyData));` and the recommended wrapper
  `BEGIN_TRY { TRY { … } FINALLY { explicit_bzero() } END_TRY;`.
- **`C.instructions.md`**, verbatim: *"Usage of dynamic allocation is impossible and forbidden.
  Prefer static global buffers over heavy stack usage."* (Tension with "don't keep secrets in
  long-lived globals" — see verdict.)
- **BOLOS memory model** (Ledger dev portal *cryptography* / SDK): Flash (code + constants, accessed
  through **`PIC()`** because the app is loaded position-independently — string/const-table pointers
  must be `PIC()`-resolved) vs RAM (the app's `.bss`/stack). Confidence: high on the PIC requirement;
  our generated tables (`*.gen.c`) and `static const` curve params are the things that need `PIC()`
  if dereferenced via pointer.

### What production apps do (confidence: high)

- **Mina `sign`** (`crypto.c:711-766`) is the textbook example: the entire signing body is inside
  `BEGIN_TRY { TRY { … } CATCH_OTHER(e) { error = true; } FINALLY { explicit_bzero(tmp, sizeof(tmp));
  explicit_bzero(k, sizeof(k)); } END_TRY }`. The nonce `k` and the `tmp` scalar are wiped on **every**
  exit path, success or throw.
- **Mina `generate_keypair`** wipes `raw_privkey[64]` with `explicit_bzero` immediately after copying
  out the 32 bytes it needs (`crypto.c` ~lines 553-567), and the comment states the private key *"can't
  be cached for security reasons, so it is always computed (deterministically)"* — i.e. **no
  long-lived secret globals; re-derive per use.**
- **Monero** `explicit_bzero`s AES/HMAC working keys and scalar temporaries throughout
  (`monero_crypto.c`, e.g. line 392).

### Verdict for item 3 vs our approach

- **ALREADY GOOD / industry-matching:** our `explicit_bzero`-on-every-error-path, the custom
  `grumpkin_secure_wipe` for EC temporaries (the EFD formulas leak secret-derived intermediates into
  `A,B,C,…` and `Z`-inverse temporaries — wiping them is *correct and above-average diligence*), and
  re-deriving secrets per call instead of caching them in globals. This matches Mina's
  "re-derive, never cache" posture.
- **NOT a contradiction, but a note:** we don't use `BEGIN_TRY/FINALLY` because we use the
  non-throwing API and never `THROW`. That is *fine and arguably better* — the try/finally idiom in
  the docs exists to guarantee cleanup when a throwing `cx_*` call unwinds. With `_no_throw` + manual
  bzero on each `return`, the guarantee is equivalent. The one risk the try/finally buys you is
  cleanup on an *unexpected* throw from deeper code; audit that nothing we call can `THROW`.
- **VERIFY (low-leverage):** confirm every `static const` table that is *dereferenced via pointer*
  goes through `PIC()`. Direct array indexing of a `static const` is auto-relocated by the linker;
  storing its address in a pointer and dereferencing is the case that bites. Grep for function
  pointers / const-table pointers in `*.gen.c` and curve params.
- **TENSION to resolve:** the "prefer static globals over stack" rule vs "no long-lived secrets in
  globals." Reconcile: secrets → stack (wiped on return); large *non-secret* lookup tables → Flash
  `const`. We already do this. Keep it.

---

## 4. Signature-nonce safety

### The math (confidence: high)

For Schnorr `s = k − priv·e` (our scheme) or ECDSA, the secret is recoverable from **two signatures
that reuse the same `k`** (subtract: `s1 − s2 = priv·(e2 − e1)` ⇒ `priv` directly for Schnorr), and
from **biased `k`** via lattice attacks (a few bits of bias across enough signatures → full key
recovery; this is the Minerva / LadderLeak class). So `k` must be (a) never repeated for distinct
messages, (b) uniform mod n. Deterministic derivation (RFC6979-style) gives (a) for free *as long as
the input is fully message-binding*.

### What BOLOS / production apps do (confidence: high)

- BOLOS native ECDSA supports **`CX_RND_RFC6979`** (deterministic) — what our ECDSA path uses
  (`bip32_derive_ecdsa_sign_rs_hash_256(…, CX_RND_RFC6979, …)`). The SDK also exposes a TRNG and
  "RFC 6979 compliant random number generation" (dev portal *Cryptography API*). `cx_rng` /
  `cx_rng_no_throw` / `cx_get_random_bytes_no_throw` are the RNG syscalls.
- **Mina** uses a **deterministic** nonce: `k = message_derive(input.fields + kp.pub + input.bits +
  kp.priv)` (`crypto.c:721`) — i.e. `k` binds the private key, the public key, AND the full message,
  via a Blake2b hash reduced mod the group order. **This is the same construction as ours**
  (`az_derive_schnorr_nonce` binds DOMAIN ‖ curve_id ‖ P.x ‖ P.y ‖ priv ‖ msg). Single-pass; Mina
  does *not* dual-derive the nonce either.
- Domain separation: ours uses a 23-byte ASCII domain + a `curve_id` byte + the pubkey, specifically
  to prevent any cross-scheme / cross-account `(k, msg)` collision. That binding is **stronger** than
  Mina's (which binds network_id but not an explicit curve tag). Confidence this is a genuine
  improvement: high.

### Verdict for item 4 vs our approach

- **ALREADY GOOD:** deterministic nonce, fully message- and key-binding, with explicit domain +
  curve_id + pubkey separation. Reuse is structurally impossible for distinct `(priv, msg)`; no RNG
  means no "RNG-failure → nonce reuse" class (the bug that has burned multiple hardware wallets).
  Strictly matches or beats Mina.
- **CONTRADICTS (high-leverage, = the item-2 gap):** the nonce derivation is **single-pass** and not
  fault-checked independently of the construction. The construction dual-run uses the *same* `k`, so a
  fault that corrupts `k` *before* the dual-run is invisible to it. **Dual-derive `k` and compare**
  (and likewise the signing scalar) closes this. This is the highest-leverage hardening item, and it
  is item-2 and item-4 simultaneously.
- **Minor robustness:** we already reject `k ≡ 0` and `e ≡ 0` and `s ≡ 0` (fail-closed). Good — those
  are the degenerate cases that leak or are invalid.

---

## 5. Modular-reduction bias when hashing to a scalar

### The math, computed for OUR parameters (confidence: high — arithmetic)

Grumpkin scalar field order `n` (= BN254 base field `q`) is **254 bits**
(`0x30644e72…d87cfd47`). We reduce the **full 512-bit** SHA-512 output mod `n`
(`gk_fq_from_bytes_wide_be`). The statistical distance of `(uniform 512-bit) mod n` from a uniform
element of `[0, n)` is bounded by `n / 2^512`:

- **Our 512→254 wide reduce: SD ≤ n/2^512 ≈ 2^−258.** Utterly negligible — 258 "excess" bits.
- A naive **256→254 reduce** would be `SD ≤ n/2^256 ≈ 2^−2.4` — i.e. ~19% of residues over-represented.
  Catastrophic. (This is *why* width matters.)
- FIPS 186-4 (Appendix B.2.1 "extra random bits" / hash_to_field over-generation) and the general
  rule of thumb target **64 excess bits ⇒ SD ≤ 2^−64** as "safe." We have **258** excess bits.

So: **wide reduce of a 512-bit hash mod a ~254-bit order is more than sufficient. Rejection sampling
buys nothing here** (it would only matter for the narrow-reduce case). Confidence: high.

### What production apps do (confidence: high)

- **Zcash Sapling / Jubjub (`hhanh00/zcash-ledger`)**: `src/crypto/sapling.c:172` comment, verbatim:
  *"ask, nsk are scalars obtained by hashing into 512 bit integer and then reducing mod R"*, implemented
  as `cx_math_modm_no_throw(data_512, 64, R, 32)` (`fr.c:51,61`). **Identical to our wide-reduce
  approach, in a shipped Sapling app. No rejection sampling.**
- **Mina** is the interesting counter-example (`crypto.c:205-229`): the Mina *reference signer* uses
  rejection sampling, but the **Ledger app deliberately does not** — it masks off the top 2 bits of the
  256-bit BIP44 secret (`a[0] &= 0x3f`) and *documents the exact entropy loss* (`p − max =
  45560315531419706090280762371685220354`, "an insignificant amount of entropy"). So the production
  Ledger app chose a bounded-bias bit-mask over rejection sampling for engineering simplicity, with the
  bias written down. Different technique, same conclusion: rejection sampling is not required on-device.
- RFC6979's `bits2octets` + the deterministic-`k` generate-and-retry loop *is* rejection sampling, and
  BOLOS's `CX_RND_RFC6979` implements it for the native-ECDSA path — but that is for a `qlen`-bit hash
  reduced mod a `qlen`-bit order (the narrow case), which is exactly where you need it.

### Verdict for item 5 vs our approach

- **NOT a contradiction — our approach is correct and matches Zcash.** The 512-bit wide reduce gives
  SD ≈ 2^−258. Do **not** add rejection sampling for the Schnorr scalar/nonce; it is wasted code and
  wasted cycles. (Document the 2^−258 bound in the code comment so a future auditor doesn't re-flag it.)
- One thing to double check (low-leverage): that `gk_fq_from_bytes_wide_be` is itself
  **constant-time** (Horner over 64 bytes with `gk_fq_mul`/`gk_fq_add`, no data-dependent branch) — it
  appears to be, since it always runs 64 iterations regardless of input.

---

## 6. Common Ledger app security-audit findings / pitfalls (relevant subset)

Confidence: high for the cited concrete cases; moderate for the generalized list (drawn from public
Donjon writeups + the cited CVE, not an internal audit corpus).

1. **Decryption-oracle / type-confusion in custom crypto protocols — CVE-2020-6861 (Ledger Monero app
   ≤ 1.4.2).** The protocol treated encrypted scalars and points interchangeably and `mlsag_sign()`
   returned a *plaintext* scalar from encrypted inputs, giving a decryption oracle; combined with a
   `C_FAKE_SEC_SPEND_KEY` placeholder substitution and AES-CBC with a **zero IV + static key**, the
   **master spend key was extracted in ~5 API calls, no user confirmation.** Fixes (v1.5.1): removed
   `sc_add`/`sc_sub` scalar ops, derived **distinct HMAC/encryption keys per value-type and context**,
   added **mandatory user confirmation**, enforced a **state machine** on valid call sequences, and
   added **input validation: reject non-reduced scalars and invalid EC points.** (deadcode.me writeup;
   Ledger Donjon LSB.) **Lessons that hit us directly:** (a) validate every external scalar is reduced
   (`< n`) and every external point is on-curve — *we already do* (`gk_fq_from_bytes_be` rejects
   `>= p`; `grumpkin_affine_on_curve` checks membership) — keep it; (b) enforce a strict APDU state
   machine — *we do* (`G_l4_session.state` gating); (c) never expose a primitive that turns the device
   into an oracle on secret-derived values.

2. **Non-constant-time / data-dependent branching on secrets.** The generic Donjon finding class
   (side-channel via power/EM). Our `mul_generator.c` infinity short-circuit and `add_affine` `H==0`
   branch are exactly this category. Mitigation already scoped (item 1).

3. **Fault-induced check bypass.** Single `if` on a security-critical condition can be glitched. Donjon
   mandates the double-check/redundant pattern (item 2). Audit every *single* security `if`
   (consumer match, on-curve, canonical, state gate) for whether a skip is fail-safe; duplicate the
   ones that aren't (we already duplicate the consumer/`outer_hash` checks).

4. **Missing low-S normalization / signature malleability (ECDSA).** A classic finding; *we already
   normalize* (`s_is_high` + `low_s_normalize`). Keep.

5. **Trusting host-supplied display data ("blind signing dressed as clear signing").** If the device
   shows host-asserted fields, an attacker controls the UI. *We addressed this in M9* (device-VERIFIED
   `From` via `b3_verify_consumer_is_this_account`). This is a recurring audit theme — keep all
   user-facing values device-derived.

6. **`THROW`/exception-based crypto and unchecked `cx_*` returns.** Explicitly called out by
   `C.instructions.md` and the dev-portal cryptography page. We use `_no_throw` and check returns —
   compliant; tightening to `LEDGER_ASSERT` (item 2) makes it uniform.

7. **PIC / position-independence bugs.** Dereferencing a Flash pointer without `PIC()` reads garbage at
   runtime — a correctness (and potentially security) bug. Verify (item 3).

8. **Bespoke field arithmetic as attack surface.** Not a "finding" per se, but our hand-rolled `fq.c`
   CIOS is exactly the kind of code auditors scrutinize hardest (and that Mina/Zcash avoided by using
   `cx_math_*`). Migrating to SDK bignum shrinks the audit target (item 1).

---

## Highest-leverage hardening wins (ranked)

1. **Dual-derive + compare the Schnorr signing scalar AND the per-signature nonce `k`** (items 2 & 4).
   Closes the one fault gap our own comments flag. The construction is already dual-run; extend the
   same discipline upstream so a glitch in scalar/nonce derivation is caught, not merely fail-safe.
   *Cheapest, highest-impact.*
2. **Remove data-dependent branches from scalar mul** (item 1): eliminate the infinity short-circuit
   (fixed offset / fixed-base comb, already sketched in `mul_generator.c`) and the `add_affine` `H==0`
   branch. Kills the leading-zero-length leak. This is the genuine constant-time fix; do it before
   any "side-channel-resistant" claim.
3. **Migrate `Fq`/`Fr` modular arithmetic to `cx_math_*m_no_throw`** (items 1 & 6): match Mina/Zcash,
   delete bespoke CIOS attack surface, inherit the SE's constant-time bignum, probably faster. Keep the
   hand-rolled Jacobian group law (Mina does too). *Larger change; high payoff at audit time.*
4. **Adopt `LEDGER_ASSERT` (or a halt-on-violation equivalent) for crypto return codes** (item 2):
   uniform, matches the SDK/Mina idiom, makes "never proceed on a faulted `cx_*`" explicit.
5. **Add sign-then-verify for the Schnorr path** (item 2): recompute `R' = s·G + e·P`, check the
   challenge. Catches reproducible scalar-mul faults the dual-run can't.
6. **Document the 2^−258 reduction-bias bound in code** (item 5) and **do NOT add rejection sampling**.
   Pre-empts a false-positive audit finding.
7. **Verify `PIC()` on every pointer-dereferenced Flash table** (item 3). Low effort, removes a
   correctness landmine.

What is **already at or above production bar** and should be left alone: deterministic
domain-separated nonce, per-call secret re-derivation + `explicit_bzero`/`grumpkin_secure_wipe`,
low-S normalization, device-verified `From`, strict APDU state machine, on-curve + canonical input
validation, triple `outer_hash` recompute.

---

## References (verified)

Repos / files (paths verified to exist via GitHub API on 2026-05-31):
- `LedgerHQ/app-mina/src/crypto.c` — Pallas curve, custom Schnorr; `scalar_*`/`field_*` over
  `cx_math_*m_no_throw` + `LEDGER_ASSERT`; `group_scalar_mul` (binary ladder, line 396);
  `sign` with `BEGIN_TRY/FINALLY` + `explicit_bzero` (line 711); `scalar_from_bytes` bias note (line 205).
- `LedgerHQ/app-mina/src/crypto.h` — `SCALAR_BITS 256`.
- `LedgerHQ/app-monero/src/monero_crypto.c` — `cx_ecfp_scalar_mult_no_throw(CX_CURVE_Ed25519,…)`
  (~836-960), `cx_math_*m_no_throw`, `explicit_bzero`.
- `LedgerHQ/app-ethereum/src/features/get_eth2_public_key/` and `src/plugins/eth2/` — eth2 deposit /
  BLS12-381 G1 pubkey path.
- `hhanh00/zcash-ledger/src/crypto/sapling.c` (line 172 "512 bit … reducing mod R") and
  `src/crypto/fr.c` (lines 51, 61 `cx_math_modm_no_throw(…,64,…,32)`) — Jubjub, wide-reduce, `cx_bn_*`.
- `Ledger-Donjon/fault_injection_checks_demo/fault_hardened/src/lib.rs` — `Protected<T>` double-compare
  + `#[inline(never)]` + `panic!("fault")`.
- `LedgerHQ/ledger-secure-sdk/lib_cxng/include/lcx_ecfp.h:213` — `cx_ecfp_scalar_mult_no_throw`
  (`WARN_UNUSED_RESULT`; throwing variant `DEPRECATED`).
- `LedgerHQ/ledger-secure-sdk/lib_cxng/include/lcx_math.h` — `cx_math_{addm,subm,multm,powm,invprimem,
  modm,cmp}_no_throw`; `cx_math_is_zero` (line 569, comment "accumulate all the bytes in order to run
  in constant time").
- `LedgerHQ/ledger-secure-sdk/include/ox_bls.h` — `cx_bls12381_key_gen`, `cx_hash_to_field`,
  `cx_bls12381_sign` (native BLS12-381 syscalls).
- `LedgerHQ/ledger-secure-sdk/include/ledger_assert.h:85` — `LEDGER_ASSERT(test, format, ...)` →
  `LEDGER_ASSERT_EXIT()` on failure.
- `LedgerHQ/ledger-app-ai-instructions/C.instructions.md` — "no new THROW", "_no_throw alternatives",
  "validate dataLength before any memory copy", "no dynamic allocation; prefer static globals over heavy
  stack".

Docs (URLs verified reachable):
- developers.ledger.com/docs/device-app/integration/requirements/cryptography — `_no_throw`/`CX_OK`
  enforcement; "must always clear the memory … `explicit_bzero` … `BEGIN_TRY/TRY/FINALLY`".
- developers.ledger.com/docs/device-app/references/cryptography-api — primitive catalogue; curve
  families; TRNG + "RFC 6979 compliant" RNG.
- developers.ledger.com/docs/device-app/submission/security-audit and
  developers.ledger.com/docs/device-app/submission-process/deliverables/security-audit — mandatory
  external security audit for app approval.
- ledgerhq.github.io/ledger-secure-sdk/cx__ecschnorr_8c_source.html — internal randomized scalarmul
  (`cx_ecpoint_rnd_*scalarmul`) used by the OS Schnorr (OS-internal, not app-exposed).
- deadcode.me/blog/2020/04/25/Ledger-Monero-app-spend-key-extraction.html — CVE-2020-6861 writeup.
- ledger.com/blog/fault-injection-simulation, ledger.com/academy/glossary/fault-injection,
  donjon.ledger.com — Donjon FI/side-channel methodology (Rainbow/Unicorn emulation; masking,
  shuffling, desync as HW countermeasures).

Unverified / flagged:
- Exact pass/fail criteria of Ledger's app security audit (private; not a public checklist).
- App-callability of `cx_ecpoint_rnd_*scalarmul` from a modern app (treat as OS-internal).
- Whether Ledger *mandates* sign-then-verify (could not confirm; recommend on FI merits, not as a cited
  requirement).
- "Canonical" status of `hhanh00/zcash-ledger` vs LedgerHQ's own `app-zcash` / `app-zcash-new`
  (Zondax) — cited for the wide-reduce idiom, which is consistent across them, not as the official app.
