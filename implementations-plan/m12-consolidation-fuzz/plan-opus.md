# M12 — Consolidation + Fuzz — `plan-opus.md`

> **Independent Tier-A draft (opus).** Written without reading the other drafts.
> Triangulation target: be opinionated, name the mis-scopings, refuse to pretend
> the fuzz phase is "moderate" when one of its three targets is a different animal
> from the other two.

---

## 0. Framing & the one opinion that drives everything

Three of these four phases are genuinely safe wins; **one is not the size it
looks**. Read this plan through that lens:

- **P0 (dedup)** — a faithful clone of M11 P4. Mechanical, byte-identical-or-revert.
- **P1 (host profileId)** — the generated metadata + a `csDeployProfileLookup`
  helper *already exist* (`packages/adapter-ledger/src/clear_signing_v0/deploy_profiles.generated.ts`).
  This is a one-line literal→lookup swap. Borderline trivial.
- **P2 (fuzz)** — the brief calls it "moderate." **It is two cheap targets and
  one expensive, scientifically-dubious target glued together.** `begin_authwit.c`
  and `append_call.c` are near-pure (their only BOLOS surface is `io_send_sw` +
  `buffer_*` + pure poseidon2). `begin_deploy_account.c` pulls
  `bip32_derive_get_pubkey_256`, `bip32_derive_init_privkey_256`, and
  `cx_hash_sha512` — secret-dependent BOLOS crypto with **no host source in this
  repo**. Faithfully reproducing those in a shim is the entire risk surface of M12,
  and it is exactly the place where the brief's "does the shim invent bugs / hide
  bugs?" question bites. **My strong recommendation: split P2 and gate the deploy
  target behind a parse/crypto seam, fuzzing only the parse half off-device.** See
  P2 below — this is the single most important opinion in this document.
- **P3 (cx_math spike)** — correctly scoped as decision-only. The trap is
  measurement generalization, and the existing `dudect.c` already documents the
  honest caveat ("Speculos/on-device timing is a PERF gate, never a leakage
  proof"). The spike must inherit that humility or it produces a confident wrong
  recommendation.

Everything is on one `m12` branch, signed commits, `safe-v15…v18`, one tag per
phase at a green checkpoint.

```
[ ] P0  Deploy-helper dedup            → safe-v15   (small,  device, byte-identical)
[ ] P1  Host metadata-driven profileId → safe-v16   (small,  host-only)
[ ] P2  libFuzzer/ASan handler seam    → safe-v17   (SEE SPLIT — not one phase)
[ ] P3  cx_math residual spike (DOC)   → safe-v18   (decision-only)
```

---

## P0 — Deploy-helper dedup → `safe-v15`

### What's actually duplicated (verified)

`begin_deploy_account.c` (lines 61–104) and `finalize_deploy_and_sign.c`
(lines 86–127) hold **byte-identical** copies of:

- `derive_signing_pubkey_xy()` — already a one-line delegate to
  `account_binding_secp256k1_pubkey_xy` (M11 P4 collapsed the *body*, but left
  two copies of the wrapper).
- `deploy_derive_pubkey_xy()` — scheme dispatch (GRUMPKIN → Schnorr scalar →
  `schnorr_grumpkin_pubkey`; else K1 wrapper).
- `deploy_compute_partial()` — schema dispatch (Schnorr vs ECDSA-K partial).

These are the *deploy* analogue of exactly what M11 P4 did for the authwit B3
secp256k1 path. The header comment in `account_binding.h` already anticipates
this ("Was 3 near-identical copies… Centralizing removes the drift").

### Approach (opinionated: extend `account_binding`, do NOT spawn a new module)

The brief says "alongside/within `account_binding.{c,h}`". I'd put it **within**,
not alongside. Rationale: `account_binding` already owns
`account_binding_secp256k1_pubkey_xy`, which both new helpers call. A separate
`deploy_helpers.c` would create a module that depends on `account_binding` for
one call and on `schnorr.h`/`deploy_address.h` for the rest — a one-sentence
purpose ("scheme-dispatched deploy pubkey + partial") that the existing module
can absorb. CLAUDE.md's "single responsibility / one-sentence purpose" rule cuts
*for* absorption here: account-binding *is* "derive this device's account-identity
inputs from a path + profile."

New public surface in `account_binding.h`:

```c
/* Scheme-dispatched signing pubkey (X,Y) for a deploy: GRUMPKIN → Schnorr
 * scalar → [k]G; K1 → secp256k1 child pubkey. curve_id from the deploy session. */
int account_binding_deploy_pubkey_xy(uint8_t curve_id,
                                     const uint32_t *bip32_path, size_t bip32_path_len,
                                     uint8_t out_x[32], uint8_t out_y[32]);

/* Scheme-dispatched (args_hash, init_hash, partial_address) for a deploy. */
int account_binding_deploy_partial(const cs_deploy_profile_t *profile,
                                   const uint8_t pubkey_x[32], const uint8_t pubkey_y[32],
                                   const uint8_t salt[32],
                                   uint8_t out_args_hash[32], uint8_t out_init_hash[32],
                                   uint8_t out_partial_address[32]);
```

**Decision — pass `salt`/`curve_id` as parameters, NOT read `G_l4_deploy_session`
inside the module.** The current copies reach into the global
(`G_l4_deploy_session.salt`, `.curve_id`). I'd break that. Passing the inputs
explicitly (a) makes the helper unit-testable in isolation (CLAUDE.md: "if a
unit can't be unit-tested in isolation it's too big"), (b) removes a hidden
coupling that is itself a drift surface, and (c) lets the future fuzz seam (P2)
drive it without faking the whole session global. The two call sites already have
`profile` and the session in scope; they pass `.salt` / `.curve_id` explicitly.

`account_binding.{c,h}` must then `#include` `deploy_profiles.gen.h` (for
`cs_deploy_profile_t`), `schnorr.h`, `aztec_secret.h`, `deploy_address.h`. Verify
this doesn't create an include cycle (it won't — those are all leaf crypto/profile
headers).

### Files touched

- `ledger-app/src/l4/account_binding.h` — +2 prototypes, +includes.
- `ledger-app/src/l4/account_binding.c` — +2 function bodies (moved verbatim,
  globals → params).
- `ledger-app/src/handler/begin_deploy_account.c` — delete 3 statics, call the
  shared ones. (`derive_signing_pubkey_xy` also dies — its sole caller was
  `deploy_derive_pubkey_xy`.)
- `ledger-app/src/handler/finalize_deploy_and_sign.c` — same deletions/calls.

### Validation gates (the no-op proof)

This is a **semantic no-op**; the gate is "prove nothing moved on the wire."

1. **Host parity, byte-identical** — run from repo root so the `bunfig.toml`
   `expect.addEqualityTesters` preload applies:
   ```bash
   bun test packages/adapter-ledger/src/schnorr-partial-parity.test.ts \
            packages/adapter-ledger/src/grumpkin-account-parity.test.ts \
            packages/adapter-ledger/src/deploy-outer-hash-parity.test.ts
   ```
   These compile the device `.c` off-device and diff vs bb.js. **Caveat that
   matters:** the partial-address parity tests today compile the *crypto* layer
   (`deploy_address.c`, `account_keys.c`), **not the handler `.c`**. Moving the
   wrapper into `account_binding.c` does not change `deploy_address.c`'s output,
   so these prove the *math* is unchanged but **do not exercise the moved wrapper
   itself**. That gap is acceptable for P0 *only because* the wrapper is a pure
   dispatch with no arithmetic — but call it out, don't pretend the parity suite
   covers the refactor end-to-end.
2. **Device build** — `BOLOS_SDK=… make -C ledger-app` for `nanos2`; binary builds,
   `app.elf` size delta is ~0 (code shrinks slightly).
3. **Negative-APDU on Speculos** — flash the new `app.elf`, run
   `SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/wire-negative.test.ts`
   (proves the deploy reject paths still fire the right SWs).
4. **On-chain deploy unchanged** — one testnet Schnorr deploy + one ECDSA-K deploy
   via the demo, confirm the derived address equals `safe-v14`'s. This is the only
   gate that actually exercises the moved wrapper on-device. **Make it mandatory,
   not optional** — it's the difference between "parity math unchanged" and
   "the refactored handler still derives the right key."

### Risks / rollback

- **Risk:** include cycle or a missed `explicit_bzero` when lifting bodies (the
  originals scrub `priv` on the GRUMPKIN path). **Mitigation:** lift verbatim,
  diff the moved bytes char-for-char in review; `dangerouslyDisableSandbox` is
  not needed.
- **Risk (the real one):** a *silent* semantic change from globals→params — e.g.
  passing `profile->...` where the original read the session, in a case where they
  differ. They don't differ today (BEGIN pairs them), but a future caller could
  pass mismatched salt. **Mitigation:** the helper is a pure function of its args;
  the *binding* check (B3 / P6 address recompute) stays in the handlers and is
  untouched, so a wrong arg fails closed at the address compare.
- **Rollback:** `git revert` the single commit. Byte-identical means revert is
  safe at any later point.

### `safe-v15` checkpoint

Tag after gates 1–4 green. This is the safest tag in M12; ship it first so the
rest of the arc branches from a known-good consolidated base.

---

## P1 — Host metadata-driven profileId → `safe-v16`

### What's hardcoded (verified)

`aztec-ledger-session.ts:356`:
```ts
const deployProfileId = isSchnorr ? 1 : 0; // CS_DEPLOY_PROFILES: 0=ECDSA-K, 1=SchnorrAccount
```
This is a magic literal that must stay in lockstep with the codegen's
`profile_index`. The generated source of truth already exists:
`deploy_profiles.generated.ts` exports `CS_DEPLOY_PROFILES` (with
`profile_index` + a typed `id`) and a `csDeployProfileLookup(id)` helper.

### Approach

Map `scheme → CsDeployProfileId → profile_index`:

```ts
import { csDeployProfileLookup, type CsDeployProfileId } from
  './clear_signing_v0/deploy_profiles.generated.ts';

const DEPLOY_PROFILE_BY_SCHEME: Record<AccountScheme, CsDeployProfileId> = {
  ecdsa:   'DEPLOY_ACCOUNT_ECDSAK_V1',
  schnorr: 'DEPLOY_ACCOUNT_SCHNORR_V1',
};

const profile = csDeployProfileLookup(DEPLOY_PROFILE_BY_SCHEME[this.deps.scheme]);
if (!profile) {
  throw new Error(`deployAccount: no deploy profile for scheme ${this.deps.scheme}`);
}
const deployProfileId = profile.profile_index;
```

**Opinion:** keep the `scheme → id` map as the host's single hardcoded fact. It's
unavoidable — *something* has to know "schnorr means the Schnorr profile." Putting
it in a typed `Record<AccountScheme, CsDeployProfileId>` (string union, not a
number) makes a drift a *compile error* if the codegen renames an id, which is the
whole win. Pushing the scheme→id mapping itself into the manifest is over-engineering
for two schemes and out of scope.

`curveId` stays as-is (`CURVE_ID.GRUMPKIN`/`SECP256K1`) — the brief scopes P1 to
profileId only, and the device enforces the (curve, profile) pair regardless.

### Files touched

- `packages/adapter-ledger/src/aztec-ledger-session.ts` — the swap above.
- Possibly nothing else.

### Validation gates

1. `bun run lint:all && bun test` from repo root — the existing
   `provider.test.ts` / `provider.m8.test.ts` / `deploy-*.test.ts` cover the
   deploy-context shape.
2. **A focused unit test** (add inline): assert
   `csDeployProfileLookup(DEPLOY_PROFILE_BY_SCHEME.schnorr).profile_index === 1`
   and `…ecdsa….profile_index === 0`. This is the regression guard that the map
   stays aligned to codegen — succinct, one test, two assertions. Don't add ten.
3. **Testnet smoke (optional but cheap):** one Schnorr deploy still resolves the
   same address (the device rejects with `SW_UNKNOWN_PROFILE_ID` / `SW_INVALID_CURVE_ID`
   if the host sends the wrong index, so a green deploy *is* the proof the index is right).

### Risks / rollback

- **Risk:** essentially none on the device — it's host-only, and the device's
  firmware whitelist + (curve,profile) pairing is the backstop. The worst case is
  a thrown error pre-flight (fail-safe), never a wrong signature.
- **Risk (subtle):** if the codegen ever reorders entries so `profile_index`
  changes but the `id` doesn't, the lookup-by-id stays correct while the *old*
  literal would have silently signed the wrong template. So P1 is a genuine
  (small) security-robustness improvement, not pure cosmetics. Frame it that way.
- **Rollback:** revert one commit; the literal still works.

### `safe-v16` checkpoint

Tag after gate 1+2 green. No device rebuild needed (host-only), so this tag can
land without a Speculos cycle.

---

## P2 — libFuzzer/ASan handler-seam harness → `safe-v17`

> **This is where the plan earns its keep. Read the split before the mechanics.**

### The mis-scoping I'm flagging

The brief lists three fuzz targets as one phase of equal weight. They are not:

| Target | BOLOS surface | Host-shimmable faithfully? | Fuzz value |
|---|---|---|---|
| `begin_authwit.c` | `io_send_sw`, `buffer_*`, `l4_fr_is_canonical`, `l4_session_reset` | **Yes, cheaply** — all pure | **High** — pure wire parser, lots of length/canonical/path branches |
| `append_call.c` | `buffer_*`, `io_send_sw`, `cs_*_lookup`, `cs_compute_args_hash` (pure poseidon2), `l4_*` | **Yes** — registry/selector tables + poseidon2 are pure C already compiled by grumpkin_host | **High** — richest parser: args loop, allowlist gates, 4-arg-transfer `from==consumer`, args_hash recompute |
| `begin_deploy_account.c` | + `bip32_derive_get_pubkey_256`, `bip32_derive_init_privkey_256`, `cx_hash_sha512`, full Grumpkin/poseidon2 account derive | **NO — not faithfully.** Those three are BOLOS-internal, secret-dependent, and **have no source in this repo.** | **Parser half: high. Crypto half: the shim cannot reproduce it, so fuzzing it off-device is fuzzing a *fake*.** |

The grumpkin_host harness — the only precedent we have — deliberately compiles
**only pure crypto `.c`** and shims exactly **one** function (`explicit_bzero`,
12 lines). It never touches `buffer.c`, `io.c`, or any `bip32_derive_*`. That is
not an accident; it's the line between "compile real device code off-device" and
"reimplement BOLOS." P2 as written crosses that line for one of three targets.

### The split (my recommendation)

**Fuzz the PARSE seam, not the CRYPTO seam.** Concretely:

- **P2a — `begin_authwit` + `append_call` (the cheap, high-value pair).**
  These compile against a small `wire_host/` shim with **real** behaviour for
  everything they touch, because everything they touch is pure or table-driven.
  No BOLOS crypto. This is where 80% of the parser attack surface lives anyway
  (the args loop, the allowlist desync gates, the canonical-Fr rejects).

- **P2b — `begin_deploy_account` PARSE-ONLY.** Refactor the deploy BEGIN so the
  **wire-parse + validation** (everything from `buffer_read_u8(manifest)` through
  the trailing-bytes check and the path-canonicality gates, ending just before
  `deploy_derive_pubkey_xy`) is a separately-callable function:
  `deploy_parse_and_validate(buffer_t*, parsed_out*)`. Fuzz **that**. The
  crypto/binding tail (`deploy_derive_pubkey_xy` → partial → P6 derive → dual
  recompute) is **stubbed** in the harness with a deterministic fake that returns
  fixed bytes, because:
  1. The crypto is already covered byte-exact by the host-parity suite + on-chain
     deploys. Fuzzing it off-device adds nothing but risk.
  2. A faithful shim for `bip32_derive_*` would itself be new, unaudited,
     security-relevant code — the exact "invented bug" surface the brief warns about.

  This refactor is a **bonus**: it's the same "extract a unit you can test in
  isolation" move as P0, and it makes the deploy parser fuzzable *without* lying
  about the crypto. If the owner rejects the refactor (it touches a binding-adjacent
  handler), **fall back to: do not fuzz the deploy handler off-device at all;
  cover it only via the on-device negative-APDU suite (`wire-negative.test.ts`),
  and say so explicitly in the doc.** Do **not** ship a BOLOS-crypto shim to make
  the deploy target "work" — that's the worst outcome.

### The shim layer (`ledger-app/tests/wire_host/`)

This is the real lift even after the split. Mirror grumpkin_host's structure
(Makefile compiles real device `.c` + a tiny shim dir, driven from bun via
`spawnSync`). Shim contents:

- **`os.h`** — reuse grumpkin_host's `explicit_bzero` shim verbatim (12 lines).
- **`io.h` / `io.c`** — `io_send_sw(uint16_t)` and `io_send_response_pointer(...)`
  record the returned SW + response bytes into a global the fuzz target reads back.
  **No real I/O.** This is faithful: on-device these also "just return the SW";
  the harness captures it instead of writing to USB.
- **`buffer.h` / `buffer.c`** — **vendor or reimplement the `lib_standard_app`
  buffer reader** (`buffer_read_u8`, `buffer_read_bytes`, `buffer_read_bip32_path`,
  the `.size`/`.offset` cursor). **This is the single highest-divergence-risk
  artifact in M12** (see Security section). The buffer reader *is* the thing under
  test (every parser bug is a buffer-cursor bug), so a shim that behaves even
  slightly differently from the SDK's `buffer.c` either hides real bugs or invents
  fake ones. **Mitigation: do not hand-roll it. Copy `lib_standard_app/buffer.c`
  verbatim from the pinned BOLOS SDK** (the one the Makefile's `$(BOLOS_SDK)`
  points at) into `wire_host/`, with a header comment pinning the SDK commit. A
  verbatim copy of the real reader is the *only* version that doesn't diverge.
  Add a CI-less check (a `make verify-buffer` that diffs the vendored copy against
  `$(BOLOS_SDK)/lib_standard_app/buffer.c` when the SDK is present) so drift is
  detectable.
- **Session globals** — `G_l4_session` + `G_l4_deploy_session` are real (compile
  `session.c`), reset between iterations via `l4_session_reset()`.
- **NBGL / `cx.h`** — for P2a/P2b *as split*, **not reached** (parse seam stops
  before UI + crypto). So no NBGL stub needed for the fuzzed paths. If the owner
  insists on fuzzing past the seam, NBGL `ui_display_*` / `nbgl_*` become no-op
  stubs and `cx_hash_sha256`/`cx_hash_sha512` need fakes — another reason not to.

### Engines / sanitizers

libFuzzer + ASan + UBSan (the brief: engines exist, don't write one). Build with
`clang -fsanitize=fuzzer,address,undefined -g -O1`. One `LLVMFuzzerTestOneInput`
per target (or a one-byte selector prefix dispatching to the three). Each iter:
`l4_session_reset()`, wrap the input bytes in a `buffer_t`, call the handler/parse
fn, assert no ASan/UBSan trap, assert the returned SW is a *known* SW value (a
fuzzer that produces an *unknown* SW or `0x9000` on garbage is itself a finding).

### Seed corpus

From the negative-APDU cases in `wire-negative.test.ts` (bad version, bad curve,
bad path_scheme, curve/profile mismatch, unknown profile, empty body, truncated
header) — encode each as a raw byte file. **Add positive seeds too:** one
well-formed `BEGIN_AUTHWIT` body and one well-formed `APPEND_CALL` body (a
TRANSFER_PUB_PUB with `from==consumer`), so the fuzzer starts from a state that
reaches deep into the parser, not just the early rejects. Without a valid seed the
coverage plateau is shallow (everything dies at the first length check).

### Files touched / created

- `ledger-app/tests/wire_host/Makefile` — new (mirrors grumpkin_host's).
- `ledger-app/tests/wire_host/hostshim/{os.h,io.{c,h},buffer.{c,h}}` — new
  (buffer.c VENDORED verbatim).
- `ledger-app/tests/wire_host/fuzz_authwit.c`, `fuzz_append_call.c`,
  `fuzz_deploy_parse.c` — the `LLVMFuzzerTestOneInput` entry points.
- `ledger-app/tests/wire_host/corpus/` — seed files.
- `ledger-app/src/handler/begin_deploy_account.{c,h}` — **P2b refactor only:**
  extract `deploy_parse_and_validate(...)`. (Binding tail untouched.)
- `packages/adapter-ledger/src/wire-fuzz.test.ts` — optional bun wrapper that
  `make`s the harness + runs a short bounded campaign (e.g. `-runs=200000`) so
  the build at least stays green in `bun test`. **NOT a coverage-plateau run** —
  that's a manual local activity per the brief ("NOT wired into CI this arc").

### Validation gates

1. Harness **builds** under clang+sanitizers on the dev mac.
2. Each target **runs to coverage plateau locally** (libFuzzer `-print_final_stats`,
   watch `cov:` flatten). Record the plateau cov + corpus size in
   `lessons/phase-2.md`.
3. **Triage + FIX any crash/OOB/UB.** A real fix means a code change to the *device*
   handler (with a host-parity re-run + a new negative-APDU regression test
   capturing the crashing input), **not** a shim patch. If the only way to "fix" a
   crash is to change the shim, that crash was a **shim artifact** → document it as
   a false positive and harden the shim instead (see Security section).
4. **Differential sanity (the anti-false-negative gate):** for the deploy
   parse-only target, take ~20 fuzz-discovered inputs that the off-device parser
   *accepts* (returns `SWO_SUCCESS` from the parse fn) and *replay them on Speculos*
   via the negative-APDU transport; confirm the on-device BEGIN reaches the same
   accept/reject decision at the parse stage. This is the only thing that proves
   the off-device parser didn't diverge from the real one. **Mandatory for P2b.**

### Risks / rollback

- **Risk — false negatives (hidden bugs):** the shim's `buffer.c` or `io.c`
  behaves unlike the SDK's, so a real on-device parser bug never manifests
  off-device. **Mitigation:** vendor `buffer.c` verbatim + the Speculos
  differential gate (#4).
- **Risk — false positives (invented bugs):** ASan flags an OOB that can only
  happen because the shim allocates the input buffer differently than BOLOS's
  fixed APDU buffer (e.g. the device's `G_io_apdu_buffer` is a fixed 260-byte
  array; a heap `buffer_t` in the harness has different bounds). **Mitigation:**
  back the harness `buffer_t` with a **fixed 260-byte array sized to the real APDU
  buffer**, not a tight `malloc`, so out-of-bounds reads past `lc` hit the same
  "still inside the APDU buffer, just stale" semantics as on-device. Document this
  explicitly — it's the difference between a finding and a fiction.
- **Risk — the P2b refactor touches a binding-adjacent handler.** Even though it's
  parse-only, `begin_deploy_account.c` is sensitive. **Mitigation:** the extracted
  fn returns *only* parsed/validated fields into a struct; the crypto + the P6
  address-binding stay verbatim in the handler. Gate with the full P0 validation
  set (host parity + on-chain deploy) since we're editing the same file.
- **Risk — time sink.** The shim (esp. getting `buffer.c` + the fixed APDU buffer
  faithful) can eat days. **Mitigation:** P2a alone is a shippable `safe-v17` if
  P2b's refactor stalls; tag P2a, push P2b's deploy parser to a follow-up.
- **Rollback:** the harness is *new files under `tests/`* + (for P2b) one extract
  refactor. Reverting P2b's refactor is a clean revert; the harness files can stay
  (they don't ship to the device).

### `safe-v17` checkpoint

Tag after P2a + (P2b or its documented fallback) green, all triaged crashes fixed,
`lessons/phase-2.md` recording plateau cov + every crash + its disposition
(real-fix / shim-artifact). **Do not tag with an un-triaged crash outstanding.**

---

## P3 — cx_math residual decision (PROTOTYPE-SPIKE) → `safe-v18`

### What the residual actually is (verified against `dudect.c`)

M11 P3 already killed the *control-flow* leak (the `[k]G` infinity fast-path);
`dudect.c` **gates** on the leading-zero ratio (`RATIO_MAX`) and reports the
field-arith Welch-t as **informational, non-gating**. The residual is precisely:
`gk_fq_mul` (and the BN254 `fr_mul` it's cloned from) is a CIOS Montgomery
multiply whose *final conditional subtraction* and limb-carry patterns make it
*marginally* faster on some operand values. That's the only thing left.

### The spike (one op, real numbers, three outcomes)

Flag-gate (`#ifdef AZ_USE_CX_BN`) **one** field op — `fr_mul` (BN254 `Fr`, the
poseidon2/coordinate field) — to route through Ledger's `cx_bn_*`/`cx_math_*`
bignum API instead of the hand-rolled CIOS. Then:

1. **Correctness:** does `cx_bn_mod_mul` (or `cx_math_mult` + `cx_math_modm`)
   produce byte-identical results to `fr_mul` for the BN254 `Fr` modulus across the
   host-parity vectors? **Gate:** must match bb.js exactly, or the migration is
   dead on arrival. Run via a Speculos build that exposes a debug "mul two Frs" APDU.
2. **Does cx_bn support our moduli?** Confirm `cx_bn_*` accepts a 254-bit custom
   modulus for **both** BN254 `Fr` *and* Grumpkin `Fq` (the scalar field). This is
   a yes/no the SDK answers — but **verify on Speculos with the actual moduli**,
   not from docs, because the failure mode (silent reduction mod the wrong field,
   or rejecting a non-secp/non-stark modulus) is the kind of thing that doesn't
   show up until you run it.
3. **Latency:** benchmark **sign latency** (a full Schnorr-over-Grumpkin sign,
   which is mul-dominated via Pedersen + `[k]G`) on Speculos, `cx_bn` vs
   hand-rolled. Record real numbers (ms per sign, both schemes).
4. **Constant-time:** re-run `make dudect` against a `cx_bn`-backed `fr_mul` and
   check the **informational Welch-t collapses** toward 0. If `cx_bn` is itself
   CT (it should be — it's the hardware path), the value-dependence residual
   disappears at the source.

### The generalization trap (the brief's explicit question)

**Does a CT/latency result for `fr_mul` on Speculos generalize to the full
migration on real Nano S+ silicon? Short answer: NO, and the doc must say so in
these words.** Three independent leaps the spike does *not* cover:

- **One op ≠ the field layer.** `fr_mul` is the hot op, but `fr_add`/`fr_sub`
  (conditional final reduction), `fr_from_bytes` (the `R²` fold), and the Grumpkin
  point add/double (which branch on `H==0`/infinity) all have their own
  value-dependence. Migrating *one* mul and measuring its t-stat says nothing about
  the others. The spike's CT win is *local*.
- **Speculos ≠ silicon.** Speculos is QEMU on x86; it does **not** model the Nano
  S+'s actual ARM SE timing, cache, or the `cx_bn` co-processor's real latency.
  `dudect.c` already states this verbatim ("Speculos/on-device timing is a PERF
  gate, never a leakage proof"). A `cx_bn` t-stat measured under Speculos is a
  *functional* CT check (does the algorithm branch on secrets?), **not** a
  *physical* one (does the silicon leak via power/EM?). The latter needs a real
  device + a scope and is explicitly out of scope (no external audit this arc).
- **`cx_bn` is a black box we'd be trusting.** Migrating means trusting Ledger's
  bignum impl is CT on their SE. That's a *reasonable* trust (it's the vendor's
  hardened path, used by every other Ledger app), but it's a trust transfer, not a
  proof. The doc must frame "migrate" as "inherit Ledger's CT posture" not "we
  proved CT."

So the spike's honest output is: **"cx_bn is functionally CT for `fr_mul` and
costs X ms/sign; extrapolating to the full field+curve layer is a *projection*,
not a measurement, and physical-side-channel CT on real silicon remains unproven
either way."** That framing is the deliverable's spine.

### The three outcomes — my prior (low confidence, to be overturned by numbers)

The brief asks to weigh: (A) full `cx_bn` migration, (B) hand-rolled CT Montgomery
(remove the final conditional subtraction → always-subtract-then-conditional-select),
(C) documented acceptance matching Mina/Zcash Ledger peers.

My prior **before measurement**: **(C) documented acceptance is the likely
recommendation, with (B) as the cheap hedge if (A) is too slow.** Reasoning:
- The residual is a *value-dependence in field mul*, not a control-flow leak (that's
  already fixed). For a HW wallet whose threat model is "attacker has the device
  briefly," a marginal field-mul timing difference is a *power/EM* concern, which
  Speculos can't measure and which a software change can't fully close anyway
  (you'd need silicon-level analysis).
- Mina and Zcash Ledger apps (Pasta/BLS12-381 field arithmetic, hand-rolled) ship
  with exactly this posture — documented acceptance of field-arith value-dependence,
  CT control flow. Matching battle-tested peers is defensible and free.
- (A) is the "right" long answer **if** `cx_bn` is meaningfully faster *and*
  closes the residual at the source — but it's a large M13 arc (every field/curve
  op, re-parity the whole stack), and its CT win is still only *functional* (per
  the trap above). It earns the recommendation **only if** the latency number is a
  clear win (cx_bn materially faster) — that would make it a perf+CT twofer worth
  the migration cost.
- (B) hand-rolled CT mul is a trap: writing your own CT Montgomery is exactly the
  "don't roll your own crypto" footgun, *and* it still doesn't address silicon
  side-channels. Recommend (B) only if (A) is correctness-blocked (cx_bn can't take
  our modulus) AND the residual must be closed for a specific reason.

**I will let the measured numbers overturn this.** If `cx_bn` is both correct for
both moduli and faster, the recommendation flips to (A)-pending-M13.

### Files touched / created

- `ledger-app/src/crypto/poseidon2/fr.c` — `#ifdef AZ_USE_CX_BN` branch in
  `fr_mul` (throwaway, never merged to the default build).
- A debug APDU + Speculos build flag to drive the mul + sign-latency bench
  (throwaway).
- `implementations-plan/m12-consolidation-fuzz/cx-math-decision.md` — **the
  deliverable**: the three outcomes, the real numbers, the generalization caveats
  verbatim, the recommendation + confidence level, and the explicit M13 gate.
- `lessons/phase-3.md` — the spike's measurement log.

### Validation gates

This phase ships **a decision + evidence**, not device behaviour. "Done" =
- correctness gate (#1) answered yes/no with bb.js parity numbers,
- moduli gate (#2) answered yes/no on Speculos for *both* fields,
- latency + dudect numbers recorded,
- `cx-math-decision.md` written with the recommendation, confidence, and the
  three generalization caveats stated.

The throwaway prototype is **deleted** (or left only behind the `#ifdef`, never in
the default build) before tagging — it must not ship to the device.

### Risks / rollback

- **Risk — the spike's measurement is taken as the migration's proof.** This is
  *the* risk and it's epistemic, not technical. **Mitigation:** the doc leads with
  the three caveats; the recommendation carries an explicit confidence level; M13
  is gated on a *real-silicon* CT check, not on the spike.
- **Risk — `cx_bn` quietly does the wrong thing for a custom 254-bit modulus**
  (reduces mod the wrong field, or only supports named curves). **Mitigation:**
  the correctness gate (#1) catches this — byte-diff vs bb.js will scream.
- **Risk — scope creep into M13.** The brief is explicit: the migration is out of
  scope. **Mitigation:** any code beyond the single `#ifdef` mul + the bench is a
  red flag; stop and reassess per the 3-failure rule.
- **Rollback:** nothing ships; revert the `#ifdef` if it lingers.

### `safe-v18` checkpoint

Tag after `cx-math-decision.md` is written and reviewed. The tag marks "M12
complete; M13 decision recorded."

---

## Security & Adversarial Considerations (MANDATORY)

> Threat model framing: the attacker is a **malicious/compromised host** (the
> browser/dApp talking to the device) plus, secondarily, a **local physical
> attacker** with brief device access (side-channel). The device's job is to never
> sign anything its owner didn't clear-sign-approve, and to never leak the signing
> key. M12 must not widen either surface.

### The B3 / firmware-pinned binding is untouched — assert it explicitly

The locked-down B3 binding (`finalize_and_sign.c`: device recomputes its address
from BIP32 pubkey + firmware `salt=Fr.ZERO` + firmware profile, rejects on
`consumer` mismatch with `0x6F12`) and the deploy P6 address/pubkeyhash recompute
are **not edited by any M12 phase**. P0 moves the *deploy pubkey/partial* helpers;
the *binding compares* (B3, P6) stay in the handlers. P2b's deploy refactor stops
*before* the crypto/binding tail. **Review gate: a `git diff` of `finalize_and_sign.c`
and the binding-compare blocks of `begin_deploy_account.c`/`finalize_deploy_and_sign.c`
must be empty (P0: only the static helper deletions; P2b: only the parse extraction,
nothing in the compare region).**

### Q1 (brief): does the fuzz shim diverge from real device behaviour?

This is the dominant risk of M12. Two failure directions:

- **False negatives (the dangerous one) — the shim hides a real on-device bug.**
  Concentrated in `buffer.c` and the APDU buffer model. **Defences:** (a) **vendor
  `lib_standard_app/buffer.c` verbatim** with a pinned SDK commit — the parser-under-
  test must run against the *real* reader, never a reimplementation; (b) back the
  harness `buffer_t` with a **fixed 260-byte array** matching the device's
  `G_io_apdu_buffer`, so over-read semantics match; (c) the **Speculos differential
  gate** (P2 validation #4) — replay fuzzer-accepted inputs on the real `app.elf`
  and confirm same accept/reject. (a)+(c) together are the only credible
  anti-false-negative posture; neither alone suffices.

- **False positives — the shim invents a bug that can't happen on-device.** Mostly
  from (i) heap-allocated input buffers (ASan OOB that the fixed device buffer
  wouldn't hit — fixed by the 260-byte array), and (ii) fuzzing *past the parse
  seam* into stubbed crypto (a fake `bip32_derive` returning attacker-influenced
  bytes could trip a downstream check that the real, seed-bound derive never
  could). **The split (P2b parse-only) eliminates (ii) by construction** — we don't
  fuzz the crypto tail at all. Every crash gets triaged as real-fix vs shim-artifact
  in `lessons/phase-2.md`; a shim-artifact is fixed *in the shim*, never by weakening
  the device.

- **Meta-risk:** a fuzzer that returns `0x9000` (accept) on garbage, or an
  *unknown* SW, is itself a finding — the harness asserts the SW is in the known
  set. This catches "parser accepts malformed input" directly.

### Q2 (brief): can the dedup drift semantically?

Two sub-risks:

- **The lift itself drifts** (P0). A moved helper that reads `G_l4_deploy_session`
  inside vs takes params could behave differently if a caller passes a value that
  disagrees with the session. **Defence:** I deliberately made the helpers **pure
  functions of explicit params** (no global reads), so they have *no* hidden state
  to drift against; and the **binding checks stay in the handlers**, so a wrong arg
  fails closed at the address/partial compare. The host-parity suite + a mandatory
  on-chain deploy of *both* schemes prove the moved code still derives the right key.
- **The host profileId map drifts from codegen** (P1). **Defence:** the
  `scheme → CsDeployProfileId` map is a **string union**, so a codegen rename is a
  *compile error*; a focused unit test pins `id → profile_index`; and the device's
  firmware whitelist + (curve,profile) pairing reject a wrong index with a
  fail-closed SW (never a wrong signature). Drift is caught at compile time, test
  time, and on-device — three independent layers.

The deeper point: **dedup reduces drift surface; it's a security *improvement*,
not just tidiness** — M11's own `account_binding.h` comment notes the three copies
had *already* diverged cosmetically. Consolidating removes the place where a future
fix lands in one copy and not the others.

### Q3 (brief): does the cx_math prototype's measurement generalize?

**No — and the doc must say so in three explicit caveats** (stated verbatim in P3):
(1) one op ≠ the field+curve layer; (2) Speculos is functional-CT only, not
physical-CT — silicon power/EM leakage is unmeasured by any M12 gate and is
explicitly out of scope; (3) "migrate" = inherit Ledger's `cx_bn` CT posture, a
trust transfer, not a proof. The recommendation carries a confidence level and
gates M13 on a *real-silicon* check, not on the spike. The residual is a
field-mul *value-dependence*, the lowest-severity timing class (control-flow leaks
are already fixed), and matching Mina/Zcash peers' documented-acceptance posture is
defensible regardless of which outcome wins.

### Supply chain / least privilege / crypto-library posture

- **No new npm deps** for P0/P1 (device C + host TS using existing `@aztec/*`).
  P2's libFuzzer/ASan are **clang toolchain**, not npm — no new dependency surface,
  honouring the 7-day-min-age regime by simply not adding packages.
- **Vendored `buffer.c`** is a *supply-chain-relevant copy*: pin the SDK commit in
  the file header, add the `make verify-buffer` diff. A stale vendored copy that
  drifts from the SDK is a (mild) supply-chain risk — the diff check is the control.
- **Crypto:** P3 explicitly weighs `cx_bn` (vendor, battle-tested) vs hand-rolled
  CT Montgomery and **recommends against hand-rolling** (CLAUDE.md: never roll your
  own crypto) unless `cx_bn` is correctness-blocked. The existing CIOS is *already*
  hand-rolled and parity-proven; the spike doesn't change that this arc.
- **Least privilege:** nothing in M12 touches signing authority, derivation paths,
  or the firmware-pinned constants. P2 runs entirely off-device (no new device
  capability). No CI wiring this arc = no new token/secret surface.

### Adversarial input classes the fuzzer should provoke (beyond random)

To make the campaign more than a coverage stunt, the corpus + a small set of
structure-aware mutations should target: (i) `args_count` at/over `L4_MAX_ARGS`
(off-by-one on the args loop); (ii) `call_count` boundary (0 → `L4_CALLS_COMPLETE`
shortcut vs >0); (iii) trailing-byte padding (the `cdata->size != cdata->offset`
gate); (iv) non-canonical Fr at every field offset (high-bit / ≥p); (v)
selector with non-zero high-28-bytes (the `selector_fits_u32` gate); (vi)
4-arg-transfer with `from != consumer` (the `SW_DELEGATED_SPEND_UNSUPPORTED`
gate). These are the gates whose *failure* would be a real security regression, so
they're where coverage matters most.

---

## Sequencing & dependencies

```
P0 (safe-v15) ──► P1 (safe-v16) ──► P2 (safe-v17) ──► P3 (safe-v18)
   device           host-only         off-device         decision
   byte-id          robustness        fuzz                doc
```

- **P0 first, hard.** It consolidates the deploy helpers that P2b's parse-extraction
  will sit next to; doing P0 first means P2b edits a *single* clean copy. Reversing
  (P2 before P0) would mean fuzzing/refactoring code that's about to move — wasted
  motion. **Strict dependency: P2b depends on P0.**
- **P1 is independent** (host-only) and could run any time; placing it second keeps
  it as a cheap green checkpoint between the two device-side efforts. No dependency
  either way.
- **P2 before P3.** P2's harness (host-compiled device `.c`) and P3's spike both
  exercise the off-device build muscle; P2 establishes the `wire_host`/shim pattern
  P3's mul-bench can borrow. Soft dependency only — P3 mainly needs Speculos, not
  the fuzz harness.
- **P3 last** — it's a decision doc; it benefits from everything else being stable
  so the latency bench runs against the consolidated build.

**Cross-cutting:** every tag gates on `bun run lint:all && bun test` **from repo
root** (so the parity preload applies) + a device build for P0/P2b. `lessons/phase-N.md`
per phase; `implementations-plan/index.md` updated as each tag lands.

---

## Adversarial self-critique — "where is this plan most likely wrong?"

1. **The P2b parse-extraction refactor may be rejected as too invasive.** I'm
   proposing to edit `begin_deploy_account.c` — a binding-adjacent handler — to make
   it fuzzable. If the owner draws the "don't touch deploy handlers" line tighter
   than I assume, P2b collapses to "fuzz only authwit+append_call off-device; cover
   deploy via on-device negative-APDU only." **I've built that fallback in, but if
   the owner *also* wants real off-device deploy-parser coverage without the
   refactor, there's no good answer** — you either reimplement BOLOS crypto (bad) or
   you don't fuzz it off-device. This is the plan's biggest unresolved fork, and
   it's a genuine values call, not a technical one. **Most-likely-wrong rank: #1.**

2. **I may be overstating the `buffer.c` divergence risk — or understating the
   vendoring cost.** I assert "vendor verbatim" solves false-negatives, but the
   pinned BOLOS SDK's `buffer.c` may itself pull headers (`os.h`, `read.h`,
   `macros.h`) that drag in more SDK surface than a 12-line shim, turning the
   "small shim" into a partial SDK vendor. If that transitive closure is large, the
   honest move might be to compile the harness *against the real SDK headers*
   (point the Makefile at `$(BOLOS_SDK)`) rather than shim them — which changes the
   whole harness shape. I haven't verified the `buffer.c` include closure (the SDK
   isn't checked out locally). **This could make P2's shim 2–3× the work I've
   scoped. Most-likely-wrong rank: #2.**

3. **My P3 prior (recommend acceptance/(C)) may be anchored on the Mina/Zcash
   precedent rather than this device's actual numbers.** If `cx_bn` turns out both
   correct for both moduli *and* materially faster, (A) becomes a perf+CT twofer and
   my "documented acceptance" lean is wrong. I've flagged this and committed to
   letting numbers overturn it — but a reader should treat my (C)-lean as a
   low-confidence prior, not a conclusion. **Most-likely-wrong rank: #3.**

4. **P0's "semantic no-op" claim leans on a parity suite that doesn't actually
   compile the handler `.c`.** The host-parity tests compile the *crypto* layer, so
   they prove the math is unchanged but not that the *moved wrapper* is wired right.
   I've made the on-chain dual-scheme deploy a *mandatory* gate to close that, but
   if testnet is down/slow on the day, there's a temptation to tag `safe-v15` on the
   parity suite alone. **Resist it** — the wrapper is exactly the thing parity
   doesn't cover. **Most-likely-wrong rank: #4.**

5. **"Off-device fuzzing of a HW-wallet parser" has an inherent ceiling I may be
   overselling.** Even with verbatim `buffer.c` + the Speculos differential, the
   harness can't model the device's APDU chunking, the dispatcher's `p1/p2`/`cla`
   gating, or multi-APDU session state transitions (BEGIN→APPEND×N→FINALIZE). I'm
   fuzzing *single handler invocations*, not *sequences*. A bug that only manifests
   across a malformed APDU *sequence* (e.g. APPEND after a partial BEGIN) is out of
   reach of this harness and only `wire-negative.test.ts`-style on-device tests
   catch it. The plan should be honest that P2 hardens *per-APDU parsing*, not
   *session-state-machine* robustness. **Most-likely-wrong rank: #5 — a scope
   honesty issue more than an error.**

---

## ASCII status

```
[ ] P0  Deploy-helper dedup            safe-v15
[ ] P1  Host metadata profileId        safe-v16
[ ] P2a authwit+append fuzz seam       (part of safe-v17)
[ ] P2b deploy PARSE-only fuzz seam    (part of safe-v17; depends on P0)
[ ] P3  cx_math decision doc + spike   safe-v18
```
