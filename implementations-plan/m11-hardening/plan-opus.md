# M11 Hardening — phased plan (OPUS independent draft)

> One of three parallel drafts (main + codex + opus). This is the **opus** draft — its phasing,
> sequencing, and scope calls are made independently from the brief. Where I deviate from the
> brief's scope, it's flagged explicitly. Paths are repo-relative.
>
> Baseline: `safe-v8` (M10). Target device: Nano S+ (`nanos2`) only. Two proven signing paths —
> ECDSA-K1 (BOLOS-native) and Schnorr-over-Grumpkin (hand-rolled) — must stay green throughout.

---

## 0. Governing principles (read first)

1. **The demo never goes red.** Every phase ends at a green, taggable state (`safe-vN`). ECDSA and
   Schnorr parity + the deploy/drip/transfer e2e are the continuous tripwire.
2. **Parity-gate everything that touches device `.c`.** The `*_host` harnesses (which compile the
   *same* `.c` and diff against `bb.js` / `@aztec/foundation` / `node:crypto`) are the cheapest,
   fastest, most trustworthy gate. Any crypto change must produce *identical* output vectors — for
   CT/refactor work that is a **bit-exact non-regression invariant**, not a new behaviour.
3. **No human in the loop.** Self-validation = (a) host parity (`bun test`, seconds), (b) `nanos2`
   docker build (must link + fit), (c) Speculos screen-walk via REST `/button` + `/events`
   (scripted), (d) Playwright e2e against testnet, (e) a codex review of each phase's diff with an
   explicit adversarial ask. A phase is "done" only when (a)-(c) pass deterministically; the
   on-chain e2e (d) is the keystone for the phases that can change on-chain bytes.
4. **Cheapest-highest-leverage first; riskiest-largest last.** Fault gaps (free, pure logic) before
   CT (subtle, perf-sensitive) before the wire break (cross-cutting host+device) before the big
   optional refactor (`cx_math_*`, which I argue OUT of M11).
5. **Three-strikes rule.** Three failed attempts on a step → stop, log in `lessons/phase-N.md`,
   reassess (likely codex consult).

### Standing validation harness (referenced by every phase)

```bash
# G-PARITY  — host parity for all crypto (the regression tripwire). Seconds.
bun test packages/adapter-ledger/src/grumpkin-mul-parity.test.ts \
         packages/adapter-ledger/src/grumpkin-varbase-parity.test.ts \
         packages/adapter-ledger/src/schnorr-parity.test.ts \
         packages/adapter-ledger/src/schnorr-partial-parity.test.ts \
         packages/adapter-ledger/src/grumpkin-account-parity.test.ts \
         packages/adapter-ledger/src/pedersen-parity.test.ts \
         packages/adapter-ledger/src/deploy-outer-hash-parity.test.ts
# G-HOST    — the device .c still compiles + smoke-passes on the host toolchain.
make -C ledger-app/tests/grumpkin_host smoke
# G-BUILD   — the on-device artifact links + fits flash on nanos2.
docker run --rm -v "$PWD/ledger-app":/app ledger-app-builder-lite:latest \
  bash -lc 'make -C /app BOLOS_SDK=/opt/nanosplus-secure-sdk -j && size /app/bin/app.elf'
# G-SPEC    — boot the freshly-built app.elf under Speculos (apdu 9999 / api 5001).
docker run --rm -d --name spec-m11 -p 5001:5000 -p 9999:9999 \
  -v "$PWD/ledger-app/bin":/bin speculos:latest \
  --model nanosp --apdu-port 9999 --api-port 5000 /bin/app.elf
# G-LINT    — host TS + actions.
bun run lint:all
```

> **Self-validation note (no human):** the Speculos screen-walk is automated by the same
> `pressSpeculos`/`waitAndApprove` loop the e2e already uses (`apps/demo-browser/e2e/*.e2e.ts`,
> driving `/button/{left,right,both}` + polling `/events?currentscreenonly=true`). New phases that
> add or change a review screen ship a tiny `bun:test` (or `pytest` under `ledger-app/tests/`) that
> walks the screens and asserts the rendered strings. The on-chain e2e at :5001/:5173 already
> assumes an externally-started Speculos + Vite + testnet RPC (see `playwright.config.ts`,
> `onboard.e2e.ts` header) — M11 keeps that contract.

### Codex per-phase review (mandatory, adversarial)

After each phase's diff is green on G-PARITY + G-BUILD + G-SPEC, send the diff to codex (`xhigh`)
with: *"What could go wrong? What would a fault/side-channel/supply-chain attacker target here? What
are we trusting that we shouldn't? Did this change alter any on-chain-visible byte or any signature
output vector?"* Log verdict in `implementations-plan/m11-hardening/lessons/phase-N.md`. Folding
codex blockers is part of the phase, not a follow-up.

---

## Ordering (the spine)

```
[ P1 ] T0.2  Dual-derive scalar + nonce            (pure logic; #1 leverage; zero on-chain risk)
[ P2 ] T0.3  Reduction-bias DOC + statistical test (doc + test only; pre-empts false audit flag)
[ P3 ] T0.4  Memory-hygiene sweep (PIC + asserts)   (mechanical; low risk)
[ P4 ] T0.1  Constant-time scalar mul               (subtle; perf; bit-exact parity invariant)
[ P5 ] T1.2  Dedup derive/partial helpers           (refactor under parity lock; de-risks P6)
[ P6 ] T1.4  Negative + fuzz the wire parser        (host-only; finds bugs before P7 mutates wire)
[ P7 ] T1.1  Wire version bump: salt+deployer+profile (cross-cutting host+device; riskiest)
[ P8 ] T1.3  Host reads profile-id from metadata     (small; rides P7)
[ P9 ] T1.5  All 4 transfer modes on-chain (Schnorr) (validation-heavy; testnet keystone)
```

**Why this order (independent call, differs from the brief's T-number order):**

- **P1 before P4.** The brief lists T0.1 (CT) first. I invert it. T0.2 (dual-derive) is *pure
  control-flow logic*, has **zero** effect on any output vector, is the gap our own code comments
  flag, and the research ranks #1. T0.1 (CT) is the subtle one — it must be a *bit-exact* rewrite
  and it's perf-sensitive. Land the free fault win first so the highest-leverage security fix is in
  at `safe-v9` even if CT stalls.
- **P3 before P4.** PIC/assert sweep is mechanical and cannot regress vectors; doing it first means
  the CT rewrite lands into a code base where the `LEDGER_ASSERT` + `PIC()` discipline already
  exists, so the new CT code is written to that bar from line one.
- **P6 before P7.** Fuzz/negative-test the *current* parser first. It (a) hardens the proven v2 wire,
  (b) builds the harness that will validate the v3 parser in P7, (c) likely surfaces latent bugs
  cheaper to fix pre-break.
- **P9 last.** It's the on-chain validation capstone and the longest-running gate; it also benefits
  from P7 (non-zero salt / multi-profile) being settled so the transfer-mode matrix runs against the
  generalized binding, not the hardcoded one.

**Independence:** P1, P2, P3 are mutually independent (parallelizable). P4 depends on P3 only by
preference (assert discipline), not technically. P5 ⟶ P6 ⟶ P7 ⟶ P8 form a chain. P9 depends on P7
(salt/profile generalization) and ideally P1 (so the signed path is fully hardened).

---

## P1 — T0.2: Dual-derive + compare the Schnorr signing scalar AND nonce

**Highest leverage, cheapest, zero on-chain risk. Ship first → `safe-v9`.**

### The gap (precise)

`finalize_after_approval` (`ledger-app/src/handler/finalize_and_sign.c:294-318`) derives `sch_priv`
once (`az_derive_schnorr_signing_scalar`) and `sch_k` once (`az_derive_schnorr_nonce`), then calls
`schnorr_grumpkin_sign_with_nonce`. That function (`ledger-app/src/crypto/schnorr.c:77-93`) dual-runs
the *construction* with the **same** `priv` + `k` — so a glitch that corrupts `priv` or `k`
*before* the construction is invisible to the compare (both runs consume the corrupted value). The
B3 address recompute (`b3_verify_consumer_is_this_account`) re-derives `sch_priv` and proves
`address == consumer`, which is a strong fail-safe — but it is a *different* property
(address-binding), runs at a *different* site, and does **not** cover the nonce at all.

### Exact changes

1. **`ledger-app/src/l4/aztec_secret.c`** — add a thin dual-derive wrapper for each, comparing two
   independent passes with a constant-time 32-byte compare and a hard fail on mismatch. Do **not**
   rewrite the single-pass functions; wrap them so the proven derivation stays byte-identical.
   - `az_derive_schnorr_signing_scalar_checked(path, len, out)`:
     derive into `a[32]`, derive again into `b[32]`, `ct_eq32(a,b)` → on diff `explicit_bzero` both
     and return `-1`; else copy `a`, scrub `b`, return `0`.
   - `az_derive_schnorr_nonce_checked(priv, px, py, curve_id, msg, out)`: same shape.
   - Add a file-local `static int ct_eq32(const uint8_t a[32], const uint8_t b[32])` (mirror the
     `ct_memcmp32`/`ct_diff64` idiom already in `finalize_and_sign.c`/`schnorr.c`). Returns 0 on
     equal. **Compare twice with operands swapped** (`diff |= a^b; diff |= b^a`) per the Donjon
     `Protected<T>` double-compare idiom (research §2) so a single glitch on the compare itself
     can't force a false "equal".
   - Declare both in `aztec_secret.h`.
2. **`ledger-app/src/handler/finalize_and_sign.c`** — replace the two single-pass calls in the
   Grumpkin branch (lines ~296-310) with the `_checked` variants. Update the rejection comment block
   (lines ~283-293) to state the fault gap is now closed: scalar + nonce are dual-derived and
   compared; construction is dual-run; B3 binds address independently.
3. **B3 site (`b3_verify_consumer_is_this_account`, lines ~135-148)** — use
   `az_derive_schnorr_signing_scalar_checked` here too (it derives `sch_priv` to recompute the
   pubkey). Consistency: every secret derivation on the signing path is dual-checked.
4. **(Independence note)** the ECDSA path already dual-derives r/s via the duplicate-signature
   check — leave it untouched.

### Why not also "sign-then-verify" (research §2 CONSIDER)?

The research floats recomputing `R' = s·G + e·P` and re-checking the challenge to catch a
*reproducible* scalar-mul fault the dual-run can't. **I scope this OUT of P1 and into a stretch in
P4**, because: (a) it's two extra Grumpkin scalar-muls (~2× the sign cost) on a Nano S+ — the
budget hit is real and only justified *after* P4 makes the mul itself CT/correct; (b) it overlaps
P4's concern (mul correctness) — fold it in there if the cycle budget tolerates it, else document as
deferred. Dual-derive is the uncontested, free win; ship it alone in P1.

### Validation gate

- **G-PARITY**: must be *byte-identical* — `schnorr-parity.test.ts` 64-vector verify + vector-#1
  byte-exact still green (the `_checked` wrapper changes nothing about the produced bytes on the
  honest path). This is the proof we didn't alter the signature.
- **New negative test** — extend `ledger-app/tests/grumpkin_host` CLI with a `schnorr-derive-fault`
  debug mode compiled **only under `-DHOST_FAULT_TEST`** (never in the device build): it forces the
  second derive pass to flip a byte and asserts `_checked` returns failure. Drive it from a new
  `packages/adapter-ledger/src/schnorr-dualderive.test.ts`. This proves the compare actually
  catches a divergence (the thing that's otherwise untestable without a glitch).
- **G-BUILD** on `nanos2` (links, fits; the wrappers add ~64 B stack + one compare loop).
- **G-SPEC**: boot; run the existing Schnorr authwit screen-walk; assert it still signs.
- **On-chain (keystone)**: `bunx playwright test schnorr-full-flow.e2e.ts` — Schnorr
  drip + transfer still land on testnet (the device sig is still accepted by the in-circuit
  verifier). ECDSA: `deploy-review.e2e.ts` un-regressed.
- **codex** adversarial review of the diff.

### Rollback / safety

Pure additive logic. If the `_checked` compare ever false-positives in the wild it fails *closed*
(reject, no signature, no key leak). Revert = swap the two call sites back to the single-pass
functions; the wrappers are dead code. Tag `safe-v9` on green.

### Dependencies

None. Fully independent. **Do this first.**

---

## P2 — T0.3: Document the 2⁻²⁵⁸ reduction-bias bound + add a statistical/parity test

**Doc + test only. No code-path change. Independent. Pre-empts a false-positive audit finding.**

### Rationale (settled by research §5, high confidence)

We reduce a **512-bit** SHA-512 output mod the **254-bit** Grumpkin order. Statistical distance
`≤ n/2^512 ≈ 2⁻²⁵⁸` — negligible (258 excess bits vs the FIPS 64-bit rule of thumb). Zcash-Jubjub
ships the identical wide-reduce; Mina uses a documented bit-mask. **Rejection sampling buys nothing
and I explicitly reject adding it** (wasted code + cycles + a new data-dependent loop that would
*hurt* CT). The deliverable is to make this analysis un-re-flaggable.

### Exact changes

1. **Code comments** at the three reduction sites, each citing the `2⁻²⁵⁸` bound + the Zcash
   precedent + "do not add rejection sampling — it would introduce a data-dependent branch":
   - `ledger-app/src/crypto/grumpkin/fq.c` — `gk_fq_from_bytes_wide_be` (the primitive).
   - `ledger-app/src/l4/aztec_secret.c` — at `az_derive_schnorr_signing_scalar` + `_nonce` (already
     partially commented; tighten with the numeric bound).
   - `ledger-app/src/crypto/schnorr.c` — the `e = e_raw mod n` wide-reduce (`sign_once`, line ~50).
2. **Statistical test** `packages/adapter-ledger/src/reduction-bias.test.ts`:
   - **Determinism/parity arm (the real gate):** for N random 64-byte inputs, assert the device CLI
     `gk_fq_from_bytes_wide_be` output == a `bigint` reference `(BE(input) mod n)`. Bit-exact. This
     is the test that *catches a regression* if anyone ever "optimizes" the reduce.
   - **Distribution arm (the documentation, advisory):** reduce e.g. 100k samples, bucket the top
     few bits, assert the χ²/range deviation is within the analytic `2⁻²⁵⁸`-implied tolerance (i.e.
     statistically flat). Mark advisory (`test.skipIf` on a fast-CI flag) since it's slow; it exists
     to *show* flatness, not gate.
   - Requires a `wide-reduce` CLI mode in `grumpkin_host/main.c` (add it; trivial).
3. **`research-ledger-security.md` §5** is the citation; reference it from the test header.

### Validation gate

- **G-PARITY** + the new `reduction-bias.test.ts` determinism arm green.
- **G-HOST** smoke (new CLI mode compiles).
- No device-build behaviour change → G-BUILD/G-SPEC unaffected (run G-BUILD once to confirm comments
  didn't break compilation).
- **codex**: confirm the bound + the "no rejection sampling" call. (Low-risk; mostly a sign-off.)

### Rollback / safety

Comments + a test. Zero runtime risk. No tag needed of its own; fold into the `safe-v9` line or tag
`safe-v9.1` if you want a checkpoint.

### Dependencies

None. Parallelizable with P1/P3.

---

## P3 — T0.4: Memory-hygiene sweep — `PIC()` on Flash tables + `cx_*` return-check discipline

**Mechanical, low risk, audit-hygiene. Independent. Lands the assert discipline P4 will write to.**

### Rationale (research §3, §6.6-6.7)

We already match/exceed the bar on `explicit_bzero` + `grumpkin_secure_wipe` + per-call re-derivation
(research §3 "ALREADY GOOD"). Two concrete, low-effort adds:

- **`PIC()` on pointer-dereferenced Flash constants.** Direct array indexing of a `static const` is
  auto-relocated; storing its *address* and dereferencing is the case that reads garbage on a
  position-independent load. The generated tables (`ledger-app/src/clear_signing_v0/*.gen.c`:
  `CS_DEPLOY_PROFILES`, `CS_VERBS`/registry, selectors) and the curve-param tables
  (`grumpkin/fq_params.c`, `g1_generator.c`, `poseidon2/*params*.c`) are the suspects.
- **`LEDGER_ASSERT(cx_… == CX_OK, …)` discipline.** Mina wraps *every* `cx_math_*` in
  `LEDGER_ASSERT` (research §2). We use manual `if (err != CX_OK)` — fine, but adopting
  `LEDGER_ASSERT` for the crypto syscalls (`cx_hash_sha512`, `cx_hash_sha256`,
  `bip32_derive_*`) makes "never proceed on a faulted `cx_*`" explicit + halt-on-violation, matching
  the SDK idiom an auditor expects.

### Exact changes

1. **Audit pass (scripted, then manual):**
   - `grep -rn "cs_deploy_profile_lookup\|CS_DEPLOY_PROFILES\|cs_verb\|CS_VERBS\|REGISTRY\|GRUMPKIN_G_\|AZ_FR_P\|AZ_FQ" ledger-app/src` and inspect each *pointer* deref of a Flash `const`.
   - Wrap each pointer-table base in `PIC()` at the deref site, e.g. `const cs_deploy_profile_t *t = (const cs_deploy_profile_t *)PIC(CS_DEPLOY_PROFILES);` in `cs_deploy_profile_lookup`
     (`deploy_profiles.gen.c`) and analogous in the registry/selector lookups. **Verify against the
     actual generated code** — if the codegen already emits `PIC()` or the tables are only
     array-indexed, document "no change needed" rather than churn.
   - If the codegen (`scripts/gen-clear-signing-v0.ts`) is the source of the `.gen.c`, add the
     `PIC()` in the *generator template* so it can't regress on regen, and re-run codegen.
2. **`LEDGER_ASSERT` adoption** at the crypto-syscall sites in `aztec_secret.c`
   (`cx_hash_sha512`, `bip32_derive_init_privkey_256`), `finalize_and_sign.c` (`cx_hash_sha256`,
   `bip32_derive_ecdsa_sign_rs_hash_256`), and `begin_deploy_account.c` / `finalize_deploy_*`. Keep
   the `explicit_bzero` on the surrounding buffers (assert halts, but scrub-before-assert where the
   buffer holds a secret and the assert message could be reached). Confirm `ledger_assert.h` is in
   the SDK include path for `nanos2`; if `LEDGER_ASSERT` isn't enabled in this SDK build flavor,
   fall back to a local `AZ_ASSERT_CX(err)` macro that `explicit_bzero`s + `os_sched_exit`/`reject`s.
3. **Confirm no `THROW` reachable** (research §3 "audit nothing we call can THROW") — grep for
   `THROW(`/`CATCH`/deprecated throwing `cx_*` (`cx_hash_sha512` non-`_no_throw` is fine; it returns
   a length). Document the finding.

### Validation gate

- **G-PARITY** (host harness doesn't link the BOLOS `PIC`/assert — guard those with
  `#ifdef HAVE_BOLOS` or a hostshim no-op `PIC(x)→(x)` in `grumpkin_host/hostshim/os.h`; confirm the
  host build still compiles). Vectors unchanged.
- **G-BUILD** on `nanos2` is the real gate — `PIC()` + `LEDGER_ASSERT` are device-only; the build
  must link and fit.
- **G-SPEC**: boot + a full screen-walk (deploy-review + authwit) to confirm the asserts don't
  spuriously halt and the profile/registry lookups still resolve (a missing `PIC()` would have
  *previously* worked in Speculos but failed on metal — so also reason about it, since Speculos may
  not reproduce the PIC bug; note this limitation in the lesson log).
- **codex**: ask specifically *"which of these Flash derefs actually needs PIC on a real Nano S+ vs
  which is array-indexed and safe; did I miss any function-pointer table?"*

### Rollback / safety

Each change is independently revertible. `PIC()` on an already-relocated pointer is a harmless
identity on the addresses that don't need it. Tag `safe-v10` after P3 (build-only changes;
conservative checkpoint before the CT rewrite).

### Dependencies

Independent. Best landed before P4 (so P4's new CT code inherits the assert discipline). **Caveat:**
Speculos may not reproduce a real PIC fault — flag in the plan that the *true* PIC validation is a
physical-device smoke test, which is out of scope (nanos2-only, no human); we rely on code-review +
codex for the PIC correctness argument.

---

## P4 — T0.1: Constant-time Grumpkin scalar multiplication

**The subtle one. Bit-exact parity is a hard invariant. Perf-sensitive. The riskiest crypto change.**

### The precise leaks (from `point.c` + `mul_generator.c`, confirmed by reading the source)

The add-always + bitmask-cmov core (`mul_affine_core`, `mul_generator.c:39-58`) is already more CT
than shipped Mina (research §1). The residual data-dependent branches are **all in `point.c`**, and
they fire *inside* the always-executed double/add:

1. **`grumpkin_point_double` infinity/`Y==0` short-circuit** (`point.c:80-85`): while `acc == O`
   (every leading-zero bit of the scalar up to the first set bit), doubling early-returns. Leaks the
   leading-zero count ⇒ effective bit-length of the scalar.
2. **`grumpkin_point_add_affine` infinity short-circuit** (`point.c:142-147`): same — while `acc == O`,
   the add takes the "copy the base" path.
3. **`grumpkin_point_add_affine` `H==0` branch** (`point.c:159-176`): if `acc.x == base.x` it
   branches into double-or-infinity. In the fixed-base ladder this fires exactly when `acc == base`
   (i.e. partial sum equals G), a secret-dependent condition.

### The fix — which branches to remove, and the algorithm call

**Decision: remove the data-dependent branches by switching the accumulator's *initial* state, NOT a
full Montgomery-ladder rewrite.** Reasoning (independent, against the brief's "ladder is an option"):

- A **Montgomery ladder** for a *generic short-Weierstrass* curve needs either (x-only) ladder
  formulas (co-Z / Brier-Joye) — a substantial new, separately-audited formula set — or a full
  ladder with complete addition formulas. That's a large, high-risk rewrite of *proven* code for a
  curve where the research already says our timing is within Ledger's tolerance (Mina ships worse).
  **Rejected for M11** as overkill + the single riskiest possible change.
- The **add-always + cmov core is already correct and effectively CT** *except* for the three
  infinity/`H==0` branches. The header itself sketches the right fix: **start the accumulator at a
  fixed, non-identity offset so it is *never* O during the loop, then correct at the end.** This is
  the minimal change that kills leaks 1+2, and leak 3 falls out with it.

**Concrete approach — "offset accumulator" (a.k.a. the classic `acc = 2^256·G` blinding-by-offset):**

1. Precompute a fixed point `Q0 = [2^256]·G` (a compile-time constant, since G is fixed; for the
   *variable-base* `grumpkin_scalar_mul_affine` we instead use the standard "add the base at a high
   bit" trick — see step 5). Add `Q0`'s affine coords as a `static const` table next to
   `g1_generator.c` (generated + parity-checked).
2. Initialize `acc = Q0` (a finite point) instead of `O`. Now for the whole loop `acc` is finite ⇒
   the `grumpkin_point_double` infinity guard (leak 1) and the `add_affine` infinity guard (leak 2)
   **never execute on the secret path** and can be left as defensive code that is provably-unreached
   for the in-loop calls. After the loop, `acc = Q0·2^256 + [k]·G`; subtract `[2^256·2^256]·G`...
   *(this offset bookkeeping is fiddly — see step 4 for the cleaner formulation actually adopted).*
3. **Cleaner formulation actually adopted (Joye/double-add with a guaranteed-finite accumulator):**
   prepend a fixed leading `1` bit. I.e. process the scalar as `(1 ‖ k)` over `257` iterations with
   `acc` seeded to `G` (finite from iteration 0), then at the end subtract `[2^257]·G` (a fixed
   constant point) via one `grumpkin_point_add_affine` with the *negation* of the constant. Because
   `acc` starts finite and only grows, **no in-loop call ever hits an infinity guard**, and the
   final-subtraction handles the offset deterministically. The `H==0` (leak 3) case can only occur if
   a partial sum equals the base; with the high-bit seed the partial sums are `≥ 2·G` magnitude
   throughout, so `acc.x == base.x` cannot occur in-loop — making leak 3 unreachable too. **Prove
   this exhaustively in the parity test** (below), not by assertion.
4. **Eliminate leak 3 defensively as well:** rather than rely solely on the magnitude argument,
   replace the `H==0` *branch* in `grumpkin_point_add_affine` with a **branchless `cmov`** between the
   add-result and a doubling-result, selected on `is_zero(H)` computed in constant time — OR, since
   the offset construction makes it unreachable in-loop, keep the branch but **add a CT variant
   `grumpkin_point_add_affine_ct` used only by the ladder** and leave the original for the
   non-secret call sites (on-curve check etc.). I prefer the **dedicated CT add** (`*_ct`): it
   localizes the change, keeps the proven `add_affine` for its other callers, and is easier to audit.
5. **Variable-base `grumpkin_scalar_mul_affine`** (used by the Pedersen MSM): same offset trick, but
   the offset must be base-independent and finite — use a fixed `G`-derived seed and the high-bit
   prepend identically (the base is on-curve + canonical, already validated). Its parity test
   (`grumpkin-varbase-parity.test.ts`) is the gate.

> **Do NOT add scalar blinding (`k' = k + r·n`).** Research §1: the app-C peers (Mina, Zcash) don't;
> the SE's hardware countermeasures carry DPA. Blinding needs an RNG (re-introducing an RNG-failure
> surface) and doubles work. **Out of scope** — removing the data-dependent branches is the genuine
> fix; DPA-grade blinding is a hardware-SE concern, not app-C, for M11.

### dudect-style timing-regression test (brief asks for it)

- Build the `grumpkin_host` CLI with a `mul-timed` mode that runs `[k]·G` for two scalar classes —
  (a) random ~254-bit, (b) tiny (e.g. `k=1`, `k=3`, many leading zeros) — under
  `clock_gettime(CLOCK_MONOTONIC)` / `rdtsc`, dumping per-call cycle counts.
- `packages/adapter-ledger/src/grumpkin-ct.test.ts`: run M samples per class, apply a **Welch
  t-test** (dudect's statistic) on the cycle distributions; assert `|t| < threshold`. **Before** the
  fix this test *fails* (the leading-zero leak shows up as a mean shift); **after**, it passes.
  Commit it red-then-green is not possible in one PR — instead: add the test in P4 *with* the fix, and
  prove it would have failed on the old code by temporarily reverting the fix in a scratch run
  (logged in `lessons/phase-4.md`, not committed).
- **Caveat (be honest in the test header):** a host x86 t-test is a *proxy* — it validates "no
  *gross* input-dependent branch remains in the C", not constant-time on the actual Cortex-M /
  secure element. True CT validation needs Donjon-style emulation (Rainbow/Unicorn) on the `nanos2`
  binary, which is out of scope. The host t-test's job is **regression detection**: if someone
  reintroduces a data-dependent branch, it trips. State this limitation explicitly so it isn't
  oversold as a side-channel proof (mirrors the `mul_generator.c` header's existing honesty).

### Validation gate

- **G-PARITY (the hard invariant):** `grumpkin-mul-parity.test.ts` + `grumpkin-varbase-parity.test.ts`
  + `schnorr-parity.test.ts` must be **bit-identical** to pre-P4 for *every* vector — including the
  edge scalars (`1, 2, 3, 255, 65537`) and 64+ random. The offset construction must produce the
  exact same `[k]·G`. This is the proof the CT rewrite didn't change the math. **If any vector
  diverges, the rewrite is wrong — stop.**
- **New `grumpkin-ct.test.ts`** Welch t-test green (with the documented host-proxy caveat).
- **G-BUILD** on `nanos2`: links, fits flash, and **does not blow the cycle budget** — capture
  `size app.elf` delta + an approximate cycle estimate; the offset trick adds 1 iteration + 1 final
  subtraction (~negligible) and a `*_ct` add (a few extra cmov loops).
- **G-SPEC**: boot + Schnorr authwit + deploy screen-walk; the sign must still complete in
  acceptable on-device time (Speculos isn't cycle-accurate, but a wall-clock sanity check catches a
  catastrophic blowup).
- **On-chain keystone:** `schnorr-full-flow.e2e.ts` (deploy + drip + transfer land) AND
  `deploy-review.e2e.ts` (ECDSA un-regressed — ECDSA doesn't touch this code, but prove it).
- **codex** adversarial: *"is the offset construction actually leak-free; is `[k]G` provably correct
  for all k including k near n and k=1; is the `H==0` case truly unreachable in-loop or did I miss a
  partial-sum collision; did the final subtraction introduce a new branch?"* This is the phase where
  I'd most want the codex consult logged.

### Rollback / safety

This is the **riskiest** phase. Mitigations: (a) bit-exact parity lock means a wrong rewrite cannot
silently ship; (b) implement as new `*_ct` functions + an offset seed, so reverting = pointing
`mul_affine_core` back at the original `grumpkin_point_add_affine` and `O` seed (the original code
stays in the tree until P4 is proven). (c) **Only tag `safe-v11` after the on-chain e2e is green** —
do not tag on parity alone, because a CT bug could be parity-clean but timing-broken (acceptable) or,
worse, a correctness bug masked by test-vector gaps (the on-chain verifier is the backstop).

### Dependencies

Soft dependency on P3 (assert discipline). Hard-independent of P1/P2. Must precede any
"side-channel-resistant" claim in docs/marketing.

---

## P5 — T1.2: Dedup `derive_signing_pubkey_xy` (×3) + `deploy_derive_pubkey/partial` into shared l4 TU

**Refactor under parity lock. De-risks P7 (one binding site to change, not three).**

### The duplication (confirmed)

`derive_signing_pubkey_xy_session` in `finalize_and_sign.c:91-111` is explicitly commented as "the
3rd copy of the same 6-line derivation" (the others live in `begin_deploy_account.c` and
`begin_authwit`/reveal paths). `az_deploy_compute_partial_address` /
`az_schnorr_compute_partial_address` (`deploy_address.c`) share `partial_from_args_hash` already, but
the *pubkey derivation* + the *B3 recompute scaffolding* are duplicated across deploy + authwit.

### Exact changes

1. New TU **`ledger-app/src/l4/signing_pubkey.{c,h}`**:
   - `int az_derive_secp256k1_pubkey_xy(const uint32_t *path, size_t len, uint8_t out_x[32], uint8_t out_y[32])` — the canonical secp256k1 `0x04‖X‖Y` derivation, with `explicit_bzero` of `raw`/`chain_code` on every path (lift verbatim from the proven `finalize_and_sign.c` copy).
   - `int az_derive_grumpkin_pubkey_xy(const uint32_t *path, size_t len, uint8_t out_x[32], uint8_t out_y[32])` — wraps `az_derive_schnorr_signing_scalar_checked` (P1) + `schnorr_grumpkin_pubkey`, scrubbing the scalar.
2. Replace all three secp256k1 copies + the Schnorr derive scaffolding in
   `finalize_and_sign.c` (B3), `begin_deploy_account.c`, and the reveal handler with calls to the new
   TU. Add the TU to the device `Makefile` *and* `grumpkin_host/Makefile` (so parity keeps compiling).
3. Optionally fold the B3 *account-recompute* (the partial→pkh→addr→compare in
   `b3_verify_consumer_is_this_account`) into a shared `l4` helper too — **but only if** it doesn't
   entangle the deploy vs authwit session structs. If it adds coupling, leave B3 where it is (the
   code comment already says "kept local to avoid destabilizing the proven deploy path"). I lean
   toward extracting *just the pubkey derivation* in P5 and leaving the B3 orchestration alone —
   minimal blast radius.

### Validation gate

- **G-PARITY**: every parity test bit-identical (pubkey derivation is the same bytes).
- **G-HOST** smoke + **G-BUILD** `nanos2` (the linker must pick up the new TU; watch for double-defs).
- **G-SPEC** + **on-chain**: `deploy-review.e2e.ts` (ECDSA) + `schnorr-deploy-review.e2e.ts` +
  `schnorr-full-flow.e2e.ts` all green — proves the deploy + authwit + B3 paths still derive the
  same pubkey/address after consolidation.
- **codex**: *"did the dedup change any derivation byte, any scrub timing, any error path?"*

### Rollback / safety

Pure refactor; parity lock guarantees behavioural identity. Revert = inline the helper back. Tag
`safe-v12`. **Do this before P7** so the salt/deployer/profile generalization changes *one* binding
site (B3) that calls *one* shared pubkey deriver.

### Dependencies

Depends on P1 (uses `_checked`). Precedes P7.

---

## P6 — T1.4: Negative + fuzz tests on the APDU/manifest wire parser

**Host-only. Finds latent parser bugs cheaply + builds the harness that validates P7's v3 parser.**

### Surface (confirmed parsers)

`handler_begin_authwit` (`begin_authwit.c`), `handler_append_call` (`append_call.c`),
`handler_finalize_and_sign` header read, `handler_begin_deploy_account` (`begin_deploy_account.c`).
All consume `buffer_t` field-by-field with explicit length + canonicality + trailing-byte checks
(good hygiene already). The CVE-2020-6861 lesson (research §6.1): a custom-crypto parser is exactly
where type-confusion / oracle bugs hide.

### Exact changes

1. **New host parser harness** `ledger-app/tests/wire_host/` (mirror `grumpkin_host`): compile the
   *real* `begin_authwit.c` + `append_call.c` + `begin_deploy_account.c` + `session.c` +
   `fr_canonical.c` against a `hostshim` that stubs `io_send_sw`/`io_send_response_pointer` to record
   the returned SW + the resulting `G_l4_session` state (no BOLOS). Expose a
   `parse <hex-apdu-stream>` CLI that prints `SW=0xXXXX state=N`.
2. **Targeted negative tests** `packages/adapter-ledger/src/wire-negatives.test.ts` — for each
   parser, a table of crafted bodies asserting the exact SW:
   - truncated body (each field cut short) → `SWO_WRONG_DATA_LENGTH`.
   - trailing garbage → `SWO_WRONG_DATA_LENGTH`.
   - bad `manifest_version` → `SW_UNKNOWN_MANIFEST_VERSION`.
   - bad `curve_id` (0, 2/R1, 4, 255) → `SW_INVALID_CURVE_ID`.
   - bad `path_scheme` / non-canonical path (wrong purpose, wrong coin, unhardened acct, non-zero
     change/index, len≠5) → `SW_INVALID_PATH_SCHEME` / `SW_BIP32_TOO_LONG`.
   - non-canonical Fr in `consumer`/`chain_id`/`protocol_version`/`tx_nonce`/`claimed_outer_hash`
     (== `p`, `> p`, `2^256-1`) → `SW_HASH_MISMATCH`.
   - `call_count > L4_MAX_CALLS` → reject; `args_count > L4_MAX_ARGS` in APPEND → reject.
   - state-machine violations: APPEND before BEGIN, FINALIZE before calls complete, BEGIN_AUTHWIT
     while in `L4_DEPLOY_CONTEXT`, two BEGINs → the documented SWs.
3. **libFuzzer-style harness** `ledger-app/tests/wire_host/fuzz_begin_authwit.c` (+ append + deploy):
   `int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)` that feeds `data` as the APDU body
   to the parser. Build with `clang -fsanitize=fuzzer,address,undefined`. **Invariants asserted:**
   (a) no ASAN/UBSan finding (no OOB read, no overflow — the real prize: the parser must never read
   past `size`); (b) on any non-9000 SW the session is fully zeroed (`l4_session_reset` invariant);
   (c) a 9000 implies every consumed field is canonical + state advanced correctly. Run a bounded
   corpus in CI (e.g. `-runs=2_000_000` or a time box) via a `bun`/`make` target; keep a seed corpus
   of valid bodies.
4. Wire the fuzz target into a `make -C ledger-app/tests/wire_host fuzz` and a CI step
   (`continue-on-error: false` for the negative tests; the fuzzer time-boxed).

### Validation gate

- `bun test wire-negatives.test.ts` green (every crafted body → expected SW).
- `make -C ledger-app/tests/wire_host fuzz` runs the time-boxed corpus with **zero** sanitizer
  findings. A crash = a real parser bug → fix before proceeding (it's exactly what this phase is for).
- **G-BUILD** unaffected (host-only), but run it to confirm the parser `.c` still cross-compiles for
  `nanos2` (no accidental host-only `#include` leaked into the shared source).
- **codex**: *"craft an input that desyncs the parser, bypasses a canonicality check, or leaves the
  session half-initialized on a reject."*

### Rollback / safety

Tests only — no device change. Any bug it finds gets its own small fix commit (parity-gated). Tag
`safe-v13` once the parser is fuzz-clean. **This is deliberately before P7** so we (a) lock the
proven v2 parser's behaviour and (b) reuse the harness to validate the v3 parser.

### Dependencies

Independent of P1-P5 in principle; sequenced after P5 to keep the chain linear and before P7.

---

## P7 — T1.1: Wire version bump (v2→v3) — carry salt + deployer + profile in BEGIN_AUTHWIT

**The cross-cutting, riskiest *integration* change: host + device must land together. Clean break,
no back-compat (per the user's answer).**

### Scope critique FIRST (the brief explicitly asks)

**Is the wire-break worth it vs the simpler "make zero-salt explicit + fail-closed" alternative?**

My independent verdict: **the full v3 wire-break is justified, but I'd scope it tighter than the
brief implies, and I'd ship the fail-closed assertion *regardless* as a P7a sub-step.**

- Today B3 hardcodes `salt = Fr.ZERO` + `profile 0` (ECDSA) / the Schnorr ctor
  (`finalize_and_sign.c:127-183`). An account deployed with a *non-zero* salt or a *different
  profile* recomputes to a different address ⇒ B3 fails closed ⇒ **the authwit is simply unusable for
  that account**. That's the current *de facto* "fail-closed zero-salt" behaviour — it's already
  safe, just *limited*.
- The **deploy** path *already* carries salt (wire field) + profile_id + deployer (via profile)
  (`deploy-context.ts`, `deploy_profiles.gen.h`, `session.h:l4_deploy_session_t`). So the asymmetry
  is purely on the **authwit** side. T1.1 is really "bring the authwit header up to the deploy
  header's expressiveness."
- **Therefore:** if the *only* near-term need is "support a single non-zero deterministic salt" (the
  demo's `DEFAULT_ACCOUNT_SALT` is already `Fr.ZERO`, but a real wallet may pick another), the
  *cheapest correct* move is **P7a: pass `salt` + `profile_id` in the v3 BEGIN_AUTHWIT header and
  feed them into B3's recompute** — i.e. *un-hardcode the two constants B3 already uses*. The
  "custom deployer / multi-profile" part is then **free** because B3 already looks up
  `profile->deployer` for the ECDSA branch; it just needs the right `profile_id` from the wire
  instead of the literal `0`.

So I **adopt the wire break** (it's the right long-term shape and the user wants the clean break),
but I frame it as *"generalize the two hardcoded B3 constants to wire-driven values, validated
against the same canonicality + profile-lookup gates the deploy path already uses"* — not a
ground-up redesign. And I **keep a fail-closed assertion**: if `salt`/`profile_id` are absent or
malformed, reject (never silently fall back to zero-salt). That assertion is the safety net the
brief's "simpler alternative" was reaching for; it costs nothing and belongs in the v3 parser
anyway.

### Exact changes (host + device, landed in ONE commit)

**Wire (`ledger-app/src/l4/wire.h`):**
- `#define L4_MANIFEST_VERSION 3u` (hard cut; v2 rejected). The existing
  `SW_UNKNOWN_MANIFEST_VERSION` path already handles the reject.
- Extend the BEGIN_AUTHWIT body layout (documented in the header comment): after `tx_nonce`, before
  `call_count`, insert `profile_id[1]` + `salt[32]`. Add a `deployer` field **only if** a profile's
  `deployer` is not sufficient — since `deploy_profiles.gen.h` already pins `deployer` per profile,
  I **do not add a separate `deployer` wire field**; the deployer comes from the looked-up profile
  (consistent with the deploy path). *(Deviation from the brief, which lists "custom deployer" as a
  wire field. I argue the profile already encodes deployer; adding a raw wire deployer would let the
  host assert an arbitrary deployer the device can't tie to a reviewed profile — a regression in the
  device-verified model. If a future profile needs a distinct deployer, add the profile, not a wire
  field. Flag for codex.)*
- "profile" semantics for authwit: reuse `cs_deploy_profile_t` / `cs_deploy_profile_lookup` (the same
  table the deploy path uses) so the authwit B3 recompute and the deploy recompute share one
  source of truth for `(class_id, ctor_selector, deployer)`.

**Device (`begin_authwit.c`):**
- Parse `profile_id` (validate `cs_deploy_profile_lookup(profile_id) != NULL` → else
  `SW_UNKNOWN_PROFILE_ID`) and `salt` (validate `l4_fr_is_canonical` → else `SW_HASH_MISMATCH`).
- Store both in `l4_session_t` (add `uint8_t authwit_profile_id;` + `uint8_t authwit_salt[32];`).
- **Cross-curve consistency check:** for `curve_id == GRUMPKIN`, require the profile's `arg_schema ==
  SCHNORR_PUBKEY_XY`; for `K1`, `ECDSA_K_PUBKEY_XY`. Mismatch → `SW_INVALID_CURVE_ID`. This pins the
  (curve, profile) pair exactly as the deploy path does.

**Device (`finalize_and_sign.c::b3_verify_consumer_is_this_account`):**
- Replace `B3_ZERO` (salt) with `G_l4_session.authwit_salt`.
- Replace the literal `cs_deploy_profile_lookup(0)` / the Schnorr ctor constants with the
  looked-up `cs_deploy_profile_lookup(G_l4_session.authwit_profile_id)` and its
  `account_class_id` / `ctor_selector_u32` / `deployer`. For the Schnorr branch, drive the
  `SCHNORR_ACCOUNT_*` constants from the profile too (or keep a profile→ctor mapping).
- Keep `B3_ZERO` only for the genuinely-zero `deployer`-when-universal case *via the profile's*
  `deployer` field (which is `ZERO` for the universal profile) — i.e. stop hardcoding, read the
  profile.

**Host (`packages/adapter-ledger/src/l4-manifest.ts` + `apdu.ts`):**
- `MANIFEST_VERSION = 3`. Add `profileId` + `salt` to `AzManifestHeader` + `L4ManifestInputs`.
- `encodeBeginAuthwitBody`: emit `profile_id` + `salt` in the new layout; assert
  `salt.length === 32` + canonical. Default `salt` to the session's deterministic
  `DEFAULT_ACCOUNT_SALT` and `profileId` from P8's metadata (wired in P8; until then, the session
  passes them explicitly).
- `buildL4Manifest`: thread `salt` + `profileId` from `L4ManifestInputs` into the header. The
  `claimedOuterHash` math is **unchanged** (salt/profile affect the *address* B3 recomputes, not the
  authwit `outer_hash`) — confirm this in parity.

**Host session (`aztec-ledger-session.ts`):** pass the real `salt` (already held as
`this.deps.salt`) + `profileId` (P8) into `buildL4Manifest`/`encodeBeginAuthwitBody` for authwit, the
same way it already does for deploy.

### How to phase the bump so host + device land together (brief's specific ask)

1. **Single atomic commit** for the wire change (host encoder + device parser + B3) — there is no
   back-compat, so a split commit would leave `main` red. Develop on a branch; do not merge until the
   on-chain e2e is green.
2. **Parity-first gate before any device flashing:** add `packages/adapter-ledger/src/begin-authwit-wire-parity.test.ts` that drives the **P6 `wire_host` harness** with v3 bodies (built by the updated `encodeBeginAuthwitBody`) and asserts the device parser accepts canonical ones (→ session populated with the right salt/profile) and rejects malformed ones (absent salt, bad profile_id, non-canonical salt). This proves host+device agree on the v3 layout **without** a device build.
3. **Then** G-BUILD `nanos2` + G-SPEC screen-walk (the review must still render correct `From` /
   `Account #N` — now derived with the wire salt/profile).
4. **Then** the on-chain keystone: run `schnorr-full-flow.e2e.ts` with the demo's default
   (zero) salt+profile to prove the generalized path reproduces the *proven* behaviour for the
   default case (regression), **and** add a variant that deploys with a *non-zero* salt and proves
   the authwit now works for it (the new capability). The non-zero-salt e2e is the proof T1.1
   actually generalized the binding rather than just renaming constants.

### Validation gate

- New `begin-authwit-wire-parity.test.ts` (host↔device v3 agreement) green.
- **All P6 negatives re-run against v3** (the new parser must still reject everything the v2 parser
  did, plus the new salt/profile malformations) — re-fuzz `begin_authwit` under v3.
- **G-PARITY**: `claimedOuterHash` unchanged for the default case (authwit hash doesn't include
  salt) — the existing `deploy-outer-hash-parity` + manifest parity stay green.
- **G-BUILD** `nanos2` (session struct grew by 33 B — confirm RAM fits).
- **G-SPEC**: deploy-review + authwit screen-walk; `From`/`Account #N` correct.
- **On-chain keystone (two runs):** (a) default salt/profile — `schnorr-full-flow.e2e.ts` +
  `deploy-review.e2e.ts` un-regressed; (b) **non-zero-salt variant** — deploy a Schnorr account with
  `salt = Fr(1337)` (or similar) and prove drip/transfer authwit lands on testnet. ECDSA equivalent
  if cheap.
- **codex** adversarial: *"can the host assert a salt/profile that makes B3 recompute to `consumer`
  for an account the key does NOT control (false accept)? Is the (curve, profile) pin tight? Does
  omitting a wire `deployer` field actually close the spoofing surface, or did I miss a case?"* —
  this is the second phase (with P4) where I'd insist on the codex consult being logged.

### Rollback / safety

The clean break means rollback = revert the whole commit + re-flash v2 app + host emits v2. Keep
the v2 app.elf artifact tagged (`safe-v8`..`safe-v13`) so a revert is one `docker run` + git revert.
**Critical safety property to preserve:** B3 must *still* fail closed on any mismatch — the
generalization changes *which* (salt, profile) it recomputes against, never *whether* it enforces
`address == consumer`. The fail-closed assertion (reject on absent/malformed salt|profile) is
non-negotiable and tested in P6's negatives. Tag `safe-v14` only after **both** on-chain runs green.

### Dependencies

Depends on **P5** (shared pubkey deriver → one B3 site) and **P6** (the wire_host harness +
negative-test scaffolding). Precedes P8.

---

## P8 — T1.3: Host reads deploy profile-id from generated metadata (not hardcoded 0/1)

**Small. Rides on P7's profile plumbing. Removes the last hardcoded constant.**

### The hardcode (confirmed)

`aztec-ledger-session.ts:356`: `const deployProfileId = isSchnorr ? 1 : 0;` with a comment
`// CS_DEPLOY_PROFILES: 0=ECDSA-K, 1=SchnorrAccount`. The generated TS tables
(`packages/adapter-ledger/src/clear_signing_v0/*.generated.ts`) are the source of truth and should be
queried by scheme, not mirrored by a magic number.

### Exact changes

1. In the codegen (`scripts/gen-clear-signing-v0.ts`), emit a typed lookup in the generated TS:
   `export const DEPLOY_PROFILE_BY_SCHEME: Record<'ECDSA_K' | 'SCHNORR', number>` (or by `arg_schema`
   / `curveId`) derived from `manifest.json`'s profile list — so host + device profile indices
   provably come from one source.
2. Replace the `isSchnorr ? 1 : 0` literal in `aztec-ledger-session.ts` with a lookup against the
   generated map (keyed on the chosen `curveId`/scheme). Same for the authwit `profileId` introduced
   in P7 (so authwit + deploy pick the profile the same way).
3. Add a **codegen consistency test** (extend the existing codegen test, or add
   `deploy-profile-metadata.test.ts`) asserting the generated map's indices match the C
   `CS_DEPLOY_PROFILES` order — fail-closed if a future manifest edit reorders profiles.

### Validation gate

- `bun test` (codegen consistency + the new metadata test) green.
- Re-run the **P7 on-chain keystone** (deploy + authwit, both schemes) — proves the metadata-driven
  profile id selects the same profile the hardcode did (regression), now sourced correctly.
- **G-LINT** (generated TS must pass biome + sort).
- **codex**: *"can a manifest edit silently shift the profile index host-side without the device
  noticing?"* (the consistency test is the answer; codex sanity-checks it).

### Rollback / safety

Host-only + codegen. Revert = restore the literal. Tag `safe-v15` (or fold into `safe-v14` if P7+P8
land together — they're naturally one PR since P8 finishes P7's plumbing).

### Dependencies

Depends on P7 (the profile plumbing + authwit profile_id). Trivial after it.

---

## P9 — T1.5: All 4 transfer modes (pub↔priv matrix) on-chain under Schnorr

**Validation capstone. The UI + host wrappers already exist — this is on-chain proof, not feature
work.**

### Status (confirmed)

`apps/demo-browser/src/panels/TransferPanel.tsx` already has all 4 modes
(`pub-pub|priv-pub|pub-priv|priv-priv`), each wired to a `transferUsdc*` wrapper in
`aztec-ledger-session.ts` (→ `transfer_public_to_public` / `_private_to_public` /
`_public_to_private` / `_private_to_private`, selectors pinned in `manifest.json`). The
`schnorr-full-flow.e2e.ts` proves **only `pub→pub`** on-chain under Schnorr. T1.5 is "prove the other
three land under Schnorr."

### Likely real gap (worth a focused look, not assumed)

The private modes (`priv→*`) involve note spending + `hideMsgSender` flags + possibly a different
`from`-pinning at `APPEND_CALL`. The B3 model is "self-spend only; `from == consumer == account`,
delegated spend rejected with `SW_DELEGATED_SPEND_UNSUPPORTED`" (`finalize_and_sign.c:118-126`). For
private transfers the `from` semantics + nonce handling differ — **the phase must verify the
device's `from == consumer` pin and the verb's `args` mapping hold for each private mode**, and
that the manifest decoder renders the right amount/recipient. If a private mode needs a different
`from`-binding than B3 enforces, that's a real device-side finding to fix (not just an e2e).

### Exact changes

1. **Parametrize the e2e:** `apps/demo-browser/e2e/schnorr-transfer-modes.e2e.ts` — a `test.each`
   over the 4 modes that, per mode: ensures a funded balance (drip for public; a prior private mint
   for private), selects the mode in `TransferPanel`, walks the Speculos review (asserting the
   rendered verb/amount/recipient match the mode), approves, and asserts the tx lands on testnet
   (aztecscan link / "transferred" status). Reuse the `pressSpeculos`/`waitAndApprove` helpers.
2. **Pre-funding helper:** private modes need a private note to spend — add a setup step (mint to
   private, or a priv-pub to seed) so each mode has spendable balance. Keep runs idempotent/self-
   skipping like the existing flow (`if balance insufficient → skip with log`), since testnet state
   is shared and these runs are long.
3. **Host wrapper audit:** confirm each `transferUsdc*` builds the correct `CallIntent`
   (visibility flags, `from`, nonce) for Schnorr; fix any mode that mis-maps. Add/adjust a host unit
   test (`project-call-intent.test.ts` already covers private mapping) per mode if a gap is found.
4. **Device finding (contingent):** if a private mode trips `SW_DELEGATED_SPEND_UNSUPPORTED` or a
   `from`-mismatch wrongly, fix the device's verb/`from` handling for that mode (parity-gated,
   re-reviewed by codex). Document any intentional restriction.

### Validation gate

- **On-chain (the whole point):** `schnorr-transfer-modes.e2e.ts` — all 4 modes land under Schnorr
  on testnet. This is a long run (each private transfer = proving + inclusion); time-box per
  `playwright.config.ts` (15 min) per mode, run sequentially (`workers: 1`).
- **ECDSA un-regressed:** spot-check at least `pub→pub` under ECDSA still lands
  (`deploy-review`/existing flow) — ECDSA isn't the focus but must stay green.
- **G-SPEC**: the review screen for each private mode renders the correct semantic string (amount,
  recipient, direction) — assert in the e2e screen-walk.
- **codex**: *"for private transfers, is the device still proving `from == consumer == account`? Can
  a private mode be coerced into authorizing a spend from a note the key doesn't own? Are the
  visibility flags on the wire what the verb actually executes?"*

### Rollback / safety

Mostly tests + (contingent) a small device fix. If a private mode reveals a genuine binding gap, that
fix is itself parity+e2e-gated. Tag `safe-v16` (final M11 checkpoint) once all 4 modes are green.

### Dependencies

Depends on P7 (generalized binding) and benefits from P1 (fully-hardened sign). It's the capstone;
do it last.

---

## Security & Adversarial Considerations

Drawn from the global checklist + research §6. Each maps to the phase that addresses it.

**Threat model.** Adversary classes: (1) a **malicious/compromised host** (the dApp or a MITM on the
USB/transport) trying to get the device to sign something other than what the user sees, or to spend
from an account the device key doesn't control; (2) a **physical fault-injection** attacker
(glitching to skip a check or corrupt a derivation); (3) a **side-channel** attacker (power/EM,
timing) extracting the Schnorr key; (4) a **supply-chain** attacker (host deps, codegen,
artifacts). The sensitive asset is the Schnorr signing scalar (and the secp256k1 child key); the
protocol/viewing keys stay host-side by design.

- **Malicious host / "blind signing dressed as clear signing" (research §6.5).** The device
  recomputes `outer_hash` (3×) + derives + verifies its own account address (B3) + renders only
  device-derived values. **P7 must preserve this**: generalizing salt/profile must never let the host
  assert a `(salt, profile)` that makes B3 recompute to `consumer` for an account the key doesn't
  control. Mitigation: B3 still recomputes `address(path, salt, profile) == consumer` and fails
  closed; the (curve, profile) pair is pinned; **no raw wire `deployer`** (my deviation) so the host
  can't assert an arbitrary deployer. Codex must specifically attack this.
- **Fault injection (research §2, §6.3).** P1 closes the single-pass scalar/nonce gap (dual-derive +
  swapped-operand double-compare → halt on mismatch). P3 adds `LEDGER_ASSERT` halt-on-violation for
  `cx_*`. The existing 3× `outer_hash` recompute + dual-run construction + dual ECDSA derive stay.
  Every security `if` that isn't fail-safe is duplicated at two sites (B3 runs pre-UI *and*
  pre-sign). **P9 contingency:** ensure private-mode `from`-binding can't be fault-skipped into a
  delegated spend.
- **Side-channel / timing (research §1, §6.2).** P4 removes the only known data-dependent branches
  (infinity short-circuits + `H==0`) via the offset accumulator + a CT add; the dudect host t-test is
  a *regression* tripwire, with the honest caveat that true CT needs Donjon emulation on the metal
  binary (out of scope). **No scalar blinding** (app-C peers don't; SE carries DPA) — explicitly
  argued, not omitted. We do **not** claim "side-channel-resistant" until P4 is in.
- **Nonce safety (research §4).** Deterministic, domain-+curve-+pubkey-bound nonce — reuse is
  structurally impossible for distinct `(priv, msg)`; no RNG ⇒ no RNG-failure reuse. P1 makes its
  derivation fault-checked. Degenerate `k≡0`/`e≡0`/`s≡0` already rejected. **Do not** introduce an
  RNG anywhere (P4 blinding rejection reinforces this).
- **Modular bias (research §5).** P2 documents the `2⁻²⁵⁸` bound + a determinism/parity test; **no
  rejection sampling** (would add a data-dependent loop, hurting P4).
- **Input validation at trust boundaries (research §6.1, CVE-2020-6861).** P6 fuzzes + negative-tests
  every parser: canonical-Fr enforcement, on-curve checks, state-machine gating, trailing-byte
  rejection, session-zeroing-on-reject invariant. The CVE's lessons (per-context key separation,
  state machine, reject non-reduced scalars / invalid points) are already satisfied; P6 proves it
  adversarially. **Never expose a primitive that turns the device into an oracle on secret-derived
  values** — none of the M11 changes add such a primitive (P7 adds only public salt/profile inputs).
- **PIC / position-independence (research §3, §6.7).** P3 audits Flash-pointer derefs. **Honest
  limitation:** Speculos may not reproduce a real PIC fault; the true gate is a physical-device smoke
  test (out of scope, nanos2-only, no human) → we rely on code-review + codex for the PIC argument.
- **Supply chain (global defaults).** Host: 7-day npm `minimumReleaseAge` + frozen lockfile + `bun
  audit` already in force; no new runtime deps in M11 (the fuzzer/dudect are dev-time host tooling).
  **Codegen integrity (P8):** the generated profile map + C tables come from one `manifest.json`; the
  consistency test fails closed on drift. **Artifact integrity:** every `safe-vN` tags a built
  `app.elf`; record its `sha256` + `size` in the lesson log so a flashed binary is verifiable.
- **Least privilege.** No new host credentials/tokens. Device app surface unchanged except the v3
  wire (which only *adds* public inputs and *tightens* the (curve, profile) pin).

**The three audit prompts (codex per-phase, plus a final consolidated codex pass on the whole M11
diff) must each carry the explicit adversarial ask** quoted in §0, with P4 and P7 flagged as the
must-log consults.

---

## Scope critique (the brief demands it)

**What's overkill / I'd cut or down-scope:**

- **`cx_math_*`/`cx_bn_*` migration of `Fq`/`Fr` (research's "optional bigger win" #3).** The brief
  doesn't list it as a T-item, and I agree it should stay **out of M11**. It's a large refactor of
  *proven, parity-locked* crypto; the payoff is "smaller audit surface + inherited CT," but it risks
  the single most stable part of the system right before the demo, and our hand-rolled CIOS is
  already parity-correct. **Defer to a dedicated post-M11 phase** with its own parity lock. (If
  anything, do it *after* P4 so CT is already handled by branch-removal and the migration becomes a
  pure attack-surface-reduction play, not a CT play.)
- **Montgomery ladder for P4.** Overkill (argued in P4). The offset-accumulator + CT-add is the
  minimal correct fix; a generic-Weierstrass ladder is a new audited formula set for marginal gain.
- **Sign-then-verify in P1.** Down-scoped to a P4 stretch — it's a 2× cost the dual-derive already
  largely covers; only worth it once the mul is CT.
- **A raw `deployer` wire field in P7.** Cut (argued in P7) — it would let the host assert a deployer
  untethered to a reviewed profile, weakening the device-verified model. Deployer comes from the
  profile.
- **The full distribution arm of P2's statistical test** — advisory/skippable, not a gate. The
  determinism/parity arm is the real test.

**What's missing from the brief (I'd add):**

1. **An artifact-integrity step** (record `sha256`+`size` of each tagged `app.elf`) — cheap supply-
   chain hygiene; folded into the `safe-vN` tagging ritual.
2. **An explicit "does this change any on-chain byte / signature vector?" question in every codex
   review** — the single most important regression question for a wallet; baked into §0.
3. **P9's contingent device finding.** The brief frames T1.5 as "validate on-chain," but the private
   modes may expose a real `from`-binding gap under the self-spend B3 model. I called it out as a
   first-class possibility, not just an e2e.
4. **A consolidated final codex pass** over the whole M11 diff (not just per-phase) before the final
   `safe-v16` — the protocol's step 6.

**The riskiest change: P4 (constant-time scalar mul).** It rewrites the hottest, most subtle crypto
on the device. A bug can be (a) parity-clean but a correctness gap in an untested scalar region, or
(b) introduce a *new* timing leak while removing an old one. Mitigations: bit-exact parity lock over
edge + 64+ random vectors *and* the on-chain verifier as backstop (don't tag on parity alone); the
offset construction implemented as new `*_ct` functions so the proven code stays revertible; a
must-log codex consult; the honest "host t-test is a regression proxy, not a CT proof" caveat.

**Second-riskiest: P7 (wire break).** Cross-cutting host+device, no back-compat → a split landing
reds `main`. Mitigated by the single-atomic-commit + parity-first (`wire_host`) gate before any
flashing + the non-zero-salt on-chain e2e proving the generalization is real, + the preserved
fail-closed B3 property.

**Is T1.1's wire break worth it vs the fail-closed-zero-salt alternative?** Yes — but the honest
framing is that the device *already* fail-closes on non-zero salt today (it just can't *use* those
accounts), so the break's value is **enabling** non-zero-salt / multi-profile accounts, not closing
a security hole. I therefore (a) keep the fail-closed assertion regardless (it's the safety net the
"simpler alternative" wanted, and it lives in the v3 parser anyway), (b) scope the break as
"un-hardcode the two B3 constants, reuse the deploy path's profile table," and (c) refuse the raw
wire `deployer`. That captures the brief's intent at minimum blast radius.

---

## `safe-vN` tag ladder (continuous-green checkpoints)

| After | Tag | State |
|---|---|---|
| P1 | `safe-v9`  | Dual-derive scalar+nonce; #1 fault gap closed. |
| P2 | `safe-v9.1`| Bias documented + parity test. (optional checkpoint) |
| P3 | `safe-v10` | PIC + assert sweep; build-only changes. |
| P4 | `safe-v11` | Constant-time scalar mul; on-chain green. **Riskiest landed.** |
| P5 | `safe-v12` | Pubkey-derivation dedup. |
| P6 | `safe-v13` | Wire parser fuzz-clean + negatives. |
| P7 | `safe-v14` | v3 wire: salt+profile generalized binding; non-zero-salt on-chain. |
| P8 | (folds into v14, or `safe-v15`) | Profile-id from metadata. |
| P9 | `safe-v16` | All 4 transfer modes on-chain under Schnorr. **M11 complete.** |

Tag only on a fully-green gate (parity + nanos2 build + Speculos walk + — for on-chain-affecting
phases — the testnet e2e). Per the user's checkpoint convention, cut the tag *before* the next risky
phase begins. Maintain `implementations-plan/index.md` + `lessons/phase-N.md` as each phase closes.
