# M12 — Consolidation + Fuzz — CONSOLIDATED PLAN

Tier-A protocol. Consolidated from 3 independent drafts: [plan-main.md](plan-main.md), [plan-codex.md](plan-codex.md) (session `019e801f`), [plan-opus.md](plan-opus.md). Provenance noted per decision; rejected suggestions flagged with reasoning. **Status: consolidated; final codex review next; then owner approval.**

Owner decisions locked (Step 0): **P2 fuzzer = 3 handlers / local / fix-findings**; **P3 cx_math = prototype-spike** (decision + throwaway prototype + measurements, NOT the migration). The firmware-pinned B3 binding stays untouched (owner-ratified M11 P5).

### Final codex review (folded)
Verdict **approve-with-changes** (no blocker). Addressed: (1) the **P2b fork is now a HARD gate** — no proceed-on-silence; defaults to Y; P2a-only narrowing needs re-approval; (2) **Option X fuzzes the extracted `deploy_parse_and_validate()` directly** (no faked tail), seam ends before `deploy_derive_pubkey_xy`, post-parse body byte-identical; (3) **differential replay is bidirectional** (accepted + near-boundary rejects, same SW class) across **P2a and P2b**, and the APDU slack bytes are fuzz-controlled — closing the **shared blind spot** (a harness *cleaner* than the device hiding an accept-bug); (4) P0 updates the `account_binding.h` contract comment; (5) P1 notes the intentional rejection of the schema-selector + restores `gen:clear-signing-v0:check`; (6) P3 adds stack/RAM delta. **codex confirmed right:** the P2 split, pure param-driven P0 helpers, P1 typed lookup, P3 default-off/decision-only.

## ⚠️ ONE OWNER DECISION REQUIRED BEFORE P2b (the only fork the 3 drafts couldn't resolve)
**May I refactor `begin_deploy_account.c` to extract a parse-only `deploy_parse_and_validate()` seam, so the deploy *parser* can be fuzzed off-device?** (opus's central finding; main/codex independently flagged deploy-begin as the heavy/dubious target.)
- **The problem:** `begin_deploy_account.c` calls `bip32_derive_get_pubkey_256` / `cx_hash_sha512` — secret-dependent BOLOS crypto with **no host source in this repo**. Fuzzing that off-device means *fuzzing a fake shim of the crypto* — the exact "invented bug" trap. You can't faithfully fuzz the whole handler.
- **Option X (recommended):** extract the wire-parse + validation (everything up to, but not including, `deploy_derive_pubkey_xy`) into `deploy_parse_and_validate(buffer_t*, parsed_out*)`; fuzz **that**; stub the crypto/binding tail. The B3/P6 binding compares stay **verbatim** in the handler. It's the same "extract a testable unit" move as P0, gated by the full P0 validation set (parity + on-chain deploy), and cleanly revertible.
- **Option Y (safe fallback):** do **not** touch the deploy handler; fuzz only `begin_authwit` + `append_call` off-device, and cover the deploy parser **only** via the on-device negative-APDU suite (`wire-negative.test.ts`). No off-device deploy-parser coverage.
- **My recommendation: X** — parse-only, binding untouched (per the mechanical safety rule in P2b), reversible, closes a real coverage gap. But it edits a binding-adjacent handler, so per the final codex review this is a **HARD gate, not a silent default: X requires your explicit go-ahead. If deferred/AFK, P2b defaults to Y** (the conservative no-touch option). Narrowing P2 to **P2a-only** (dropping the deploy parser entirely) likewise requires **explicit re-approval** — it shrinks the Step-0-locked 3-handler scope.
- **✅ OWNER DECISION (recorded at planning approval): Option X APPROVED.** P2b proceeds with the `deploy_parse_and_validate()` parse-seam extraction (seam ends before `deploy_derive_pubkey_xy`; the crypto + B3/P6 binding stays byte-identical, empty-diff review gate). The default-to-Y fallback no longer applies — a fresh `/loop` session should honor X per this line.

## Reframe (all 3 drafts converge)
M12 is **consolidation + assurance**, not new capability. P0/P1 are genuinely small (P1 is borderline a one-line literal→lookup swap). **P2 is the real M12 project and is *not* "moderate" as a single phase** — it's two cheap, faithful targets (`begin_authwit`, `append_call`) plus one expensive, scientifically-dubious one (`begin_deploy_account`), so it **splits into P2a + P2b**. P3 is correctly decision-only; its trap is measurement-generalization, which the deliverable must confront head-on.

## Common validation gates (reused from M11; codex+opus emphasis)
- **Host parity — FROM REPO ROOT:** `bun test packages/adapter-ledger/src/grumpkin-*.test.ts …/pedersen-parity.test.ts …/schnorr-*.test.ts …/deploy-outer-hash-parity.test.ts` (root so the `bunfig.toml` `expect.addEqualityTesters` preload applies — the package-dir gotcha from M11).
- **Nano S+ build:** `cd ledger-app && docker run --rm -v "$PWD:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1d… make BOLOS_SDK=/opt/nanosplus-secure-sdk` → rebuild `bin/app.elf` (record size delta), reload Speculos.
- **Speculos seam tests:** `SPECULOS_URL=http://localhost:5001 bun test …/wire-negative.test.ts …/b3-consumer-binding.test.ts`.
- **On-chain e2e:** `cd apps/demo-browser && bunx playwright test e2e/schnorr-full-flow.e2e.ts` (+ `TRANSFER_MODE=`, deploy-review specs).
- **dudect:** `make -C ledger-app/tests/grumpkin_host dudect` — the algorithmic CT gate (host proxy, NOT silicon — explicit residual).
- Per phase: gate green → logged self-review (`lessons/phase-N.md`) → signed `safe-vN` tag → update `implementations-plan/index.md`.

---

## P0 — Deploy-helper dedup → `safe-v15` (small, device, byte-identical)
**Verified (all 3 drafts):** `begin_deploy_account.c:61–104` and `finalize_deploy_and_sign.c:86–127` hold byte-identical copies of `derive_signing_pubkey_xy` (already a 1-line delegate to `account_binding_secp256k1_pubkey_xy`), `deploy_derive_pubkey_xy` (scheme dispatch: GRUMPKIN→Schnorr scalar→`schnorr_grumpkin_pubkey`; K1→secp256k1 wrapper), and `deploy_compute_partial` (schema dispatch). The M11 P4 deploy analogue.

**Approach — extend `account_binding.{c,h}` with PURE, param-driven helpers** (provenance: opus, with main agreeing; **codex's "separate `deploy_binding.{c,h}` module" rejected** — the new helpers *call* `account_binding_secp256k1_pubkey_xy` and *are* account-identity computation; a separate TU would depend on `account_binding` for one call and bloat the module graph for two functions. CLAUDE.md single-responsibility cuts *for* absorption: account-binding = "derive this device's account-identity inputs from a path + profile"):
```c
int account_binding_deploy_pubkey_xy(uint8_t curve_id, const uint32_t *path, size_t path_len,
                                     uint8_t out_x[32], uint8_t out_y[32]);
int account_binding_deploy_partial(const cs_deploy_profile_t *profile,
                                   const uint8_t pk_x[32], const uint8_t pk_y[32], const uint8_t salt[32],
                                   uint8_t out_args_hash[32], uint8_t out_init_hash[32], uint8_t out_partial[32]);
```
**Critical (opus):** pass `salt`/`curve_id` as **explicit params — do NOT read `G_l4_deploy_session` inside the module.** This (a) makes the helpers unit-testable in isolation, (b) removes a hidden global-coupling drift surface, (c) lets P2b drive them without faking the session. The two call sites already hold `profile` + the session, so they pass `.salt`/`.curve_id` explicitly. Lift bodies **verbatim** (preserve the `explicit_bzero(priv,…)` scrub on the GRUMPKIN path); verify no include cycle (`deploy_profiles.gen.h`, `schnorr.h`, `aztec_secret.h`, `deploy_address.h` are leaf headers). **Update `account_binding.h`'s header-contract comment** to match the broadened scope — it now means "account-identity primitives incl. scheme-dispatched deploy pubkey + partial-address," not just "narrow secp256k1 key-derivation" (codex final-review Minor: the absorption is fine, but the module's stated purpose must keep up).

**Files:** `account_binding.{c,h}` (+2 prototypes/bodies, +includes); `begin_deploy_account.c` + `finalize_deploy_and_sign.c` (delete the 3 statics each, delegate). **B3/P6 binding compares stay in the handlers — untouched.**

**Validation:** host parity byte-identical (`schnorr-partial-parity`, `grumpkin-account-parity`, `deploy-outer-hash-parity`) — **honest caveat (opus): these compile the *crypto* layer, not the handler `.c`, so they prove the math unchanged but NOT the moved wrapper's wiring**; nanos2 `-Werror` build (size ≈ −ε); `wire-negative` on Speculos; **MANDATORY on-chain deploy of BOTH schemes** (ECDSA + Schnorr fresh index) confirming the derived address equals `safe-v14`'s — *the only gate that exercises the moved wrapper on-device; do not tag on parity alone even if testnet is slow.* → `safe-v15`.
**Risk/rollback:** silent globals→params semantic drift → wrong deploy address. Mitigated: pure-fn helpers (no hidden state) + binding check stays in handler (wrong arg fails closed at the address compare) + the mandatory on-chain gate. Rollback = revert the single commit (byte-identical).

## P1 — Host metadata-driven profileId → `safe-v16` (small, host-only)
**Verified (opus):** `aztec-ledger-session.ts:356` is literally `const deployProfileId = isSchnorr ? 1 : 0;`. The generated `packages/adapter-ledger/src/clear_signing_v0/deploy_profiles.generated.ts` already exports `CS_DEPLOY_PROFILES` (typed `id` + `profile_index`) + `csDeployProfileLookup(id)` — **no codegen change needed** (codex+opus agree; the metadata already carries what we need).

**Approach (merge opus's compile-time safety + codex's runtime fail-closed):**
```ts
const DEPLOY_PROFILE_BY_SCHEME: Record<AccountScheme, CsDeployProfileId> = {
  ecdsa: 'DEPLOY_ACCOUNT_ECDSAK_V1', schnorr: 'DEPLOY_ACCOUNT_SCHNORR_V1',
};
const profile = csDeployProfileLookup(DEPLOY_PROFILE_BY_SCHEME[this.deps.scheme]);
if (!profile) throw new Error(`deployAccount: no deploy profile for scheme ${this.deps.scheme}`);
const deployProfileId = profile.profile_index;
```
The typed `Record<AccountScheme, CsDeployProfileId>` (string-union, not a number) makes a codegen rename a **compile error** (opus); the lookup throws on miss = **runtime fail-closed** (codex). Keep the `scheme→id` map as the host's single unavoidable fact (pushing it into the manifest is over-engineering for two schemes — opus). `curveId` stays as-is (P1 is profileId-only; the device enforces the (curve,profile) pair regardless).

**Files:** `aztec-ledger-session.ts` (the swap) + a focused unit test.
**Validation:** `bun run lint:all && bun test` (root); **`bun run --cwd packages/adapter-ledger gen:clear-signing-v0:check`** (the cheap codegen-sync gate — codex final-review Minor, restored); **one unit test** pinning `csDeployProfileLookup(…schnorr).profile_index===1` and `…ecdsa…===0` (the regression guard — succinct, 2 asserts, not 10); optional testnet deploy each scheme (a green deploy *is* proof the index is right — the device rejects a wrong index with `SW_UNKNOWN_PROFILE_ID`). No device rebuild. → `safe-v16`.
**Provenance note:** the typed `scheme→id` map is an **intentional choice over** `plan-codex.md`'s schema-based exact-one-match selector — both fail closed, but the string-union map makes a codegen rename a *compile* error (earlier + louder). A deliberate rejection, not a pure merge (codex agreed the consolidated choice is better).
**Security framing (opus — not cosmetics):** if codegen ever reorders so `profile_index` changes but `id` doesn't, lookup-by-id stays correct while the old literal would silently sign the **wrong template**. P1 is a real (small) robustness improvement. Rollback = revert (literal still works).

## P2 — libFuzzer/ASan handler-seam harness → `safe-v17` (the real work; SPLIT)
We IMPLEMENT a harness; libFuzzer+ASan+UBSan are clang built-ins (no new deps). Fuzz the **handlers directly, not the dispatcher** (CLA/INS/P1/P2 already tested — codex). Scoped to begin_authwit + append_call firmly (P2a) + deploy-begin parse-only (P2b, pending the fork above).

### P2a — `begin_authwit` + `append_call` (cheap, high-value, faithful)
Both are near-pure: their only BOLOS surface is `io_send_sw` + `buffer_*` + pure poseidon2/registry tables (main verified the includes; opus tabulated it). ~80% of the parser attack surface lives here (the args loop, allowlist desync gates, 4-arg-transfer `from==consumer`, canonical-Fr rejects, args_hash recompute). Compile the **real** handler `.c` + real `clear_signing_v0` tables + `args_hash` + `fr_canonical` + `session.c` against the shim.

### P2b — `begin_deploy_account` PARSE-ONLY (pending the owner fork; Option X)
Extract `deploy_parse_and_validate(buffer_t*, parsed_out*)` and **fuzz that function directly — NOT the full handler with a faked crypto tail** (codex final-review Major). Mechanical safety rule: the seam ends *strictly before* `deploy_derive_pubkey_xy`; the post-parse handler body (crypto + B3/P6 binding) stays **byte-identical** (review-gated empty-diff). So there is no fake crypto *anywhere* in the fuzz path — the fuzzer never reaches the crypto, rather than reaching a stub of it. Rationale: the crypto is already byte-exact-covered by host-parity + on-chain deploys; a faithful `bip32_derive_*` shim would be new, unaudited, security-relevant code (the invented-bug surface). **Fallback = Option Y** (no off-device deploy fuzz; Speculos negatives only).

### The shim (`ledger-app/tests/wire_host/`) — the anti-divergence triad (opus, the headline quality bar)
- **`os.h`:** reuse grumpkin_host's `explicit_bzero` shim (12 lines).
- **`io.{c,h}`:** `io_send_sw`/`io_send_response_pointer` record the SW + bytes into a global the target reads back (faithful — on-device these also just return the SW).
- **`buffer.{c,h}` — VENDOR `lib_standard_app/buffer.c` VERBATIM** from the pinned BOLOS SDK, header-comment the SDK commit, add `make verify-buffer` (diffs the vendored copy vs `$(BOLOS_SDK)/lib_standard_app/buffer.c` when present). The buffer reader *is* the thing under test (every parser bug is a cursor bug); a reimplementation that behaves even slightly differently hides/invents bugs. A verbatim copy is the only non-diverging version.
- **Fixed 260-byte APDU buffer** backing the `buffer_t` (matches the device `G_io_apdu_buffer`), so over-read-past-`lc` semantics match on-device (prevents ASan false positives from a tight `malloc`). **The slack bytes past `lc` are fuzzer-controlled / nonzero, NOT implicitly zeroed** (codex final-review Major) — else a stale-tail read looks *safer* off-device than on-device, hiding a real bug.
- **Session globals real** (`session.c`), `l4_session_reset()` between iterations. **NBGL/`cx.h` not reached** by the split parse seams (no UI/crypto stubs needed for the fuzzed paths — the whole point of the split).

### Engines / corpus / gates
- `clang -fsanitize=fuzzer,address,undefined -g -O1`; one `LLVMFuzzerTestOneInput` per target (or a 1-byte selector). Each iter asserts: no ASan/UBSan trap **and** the returned SW is a **known SW** (a `0x9000`/unknown-SW on garbage is itself a finding — opus).
- **Corpus:** negative seeds from `wire-negative.test.ts` **+ ≥1 canonical VALID seed per target** (a well-formed BEGIN_AUTHWIT; an APPEND_CALL TRANSFER_PUB_PUB with `from==consumer`) — without valid seeds coverage plateaus at the first length check (codex+opus). Structure-aware targets (opus): `args_count` ≥ `L4_MAX_ARGS`, `call_count` 0-boundary, trailing-byte padding, non-canonical Fr at every offset, selector high-28-bytes, 4-arg-transfer `from!=consumer`.
- **Gates:** harness builds under sanitizers; each target runs to **coverage plateau locally** (record `cov:` + corpus size in `lessons/phase-2.md`); **triage + FIX every crash** — a real fix is a *device* handler change (+ host-parity re-run + a new negative-APDU regression test capturing the input), a shim-only "fix" means it was a **shim artifact** (document as false positive, harden the shim). **Differential-replay gate (MANDATORY, P2a AND P2b — codex final-review Major):** replay on Speculos both (a) fuzz-*accepted* inputs AND (b) a stratified sample of *near-boundary rejected* inputs, asserting the **same SW class on-device**. Accepted-only replay misses the dangerous false-negative class — *host harness rejects, device accepts* — which is exactly how a real device accept-bug hides without a crash. Primary defence against the shared blind spot (below); applies to the pure P2a handlers too, not just deploy. **Start P2 with a shim-sizing spike** (get `begin_authwit` compiling under the shim + resolve `buffer.c`'s include closure) BEFORE committing to all targets — opus flags the closure is unverified (SDK not checked out) and could 2–3× the work, possibly forcing a compile-against-real-SDK-headers shape instead of a shim. NOT wired into CI this arc. → `safe-v17` (after P2a + P2b-or-Y green, all crashes triaged; **no tag with an un-triaged crash**). **Escape hatch:** P2a alone is a shippable `safe-v17` if P2b stalls.
**Risk/rollback:** see Security §. Harness is new `tests/` files; P2b's extract reverts cleanly.

## P3 — cx_math residual decision (PROTOTYPE-SPIKE) → `safe-v18` (decision-only)
**The residual (opus, verified vs `dudect.c`):** M11 P3 killed the control-flow leak; dudect gates on the leading-zero ratio and reports field-arith Welch-t as **informational/non-gating**. The residual is precisely `fr_mul`/`gk_fq_mul`'s CIOS Montgomery **final conditional subtraction + limb-carry** value-dependence.

**The spike — one op, real numbers, default-off (`#ifdef AZ_USE_CX_BN`, never merged to default):** route `fr_mul` (BN254 `Fr`) through Ledger's `cx_bn_*`/`cx_math_*`, then measure:
1. **Correctness:** byte-identical to `fr_mul` vs bb.js across parity vectors (else migration is dead on arrival).
2. **Both moduli (codex+opus):** confirm `cx_bn_*` accepts a 254-bit custom modulus for **BN254 `Fr` AND Grumpkin `Fq`** — **verified on Speculos with the actual moduli**, not from docs (the failure mode — silent wrong-field reduction or named-curve-only support — doesn't surface until you run it).
3. **Latency + footprint:** full Schnorr-over-Grumpkin sign (mul-dominated via Pedersen + `[k]G`), `cx_bn` vs hand-rolled, ms/sign both schemes + **flash-size AND stack/RAM delta** (codex final-review Minor: `cx_bn` can be correct *and* fast yet Nano-hostile on RAM — measure it).
4. **CT:** `make dudect` with the flag on — does the informational Welch-t collapse toward 0?

**The generalization caveats — stated VERBATIM in the decision doc (opus; this is the deliverable's spine):** (1) **one op ≠ the field+curve layer** (`fr_add`/`fr_sub` conditional reductions, point add/double, `from_bytes` R²-fold all have their own value-dependence — the spike's CT win is *local*); (2) **Speculos ≠ silicon** (QEMU on x86; models functional CT — does it branch on secrets — NOT physical power/EM leakage, which needs a real device + scope, out of scope this arc); (3) **`cx_bn` = trust transfer** (migrating *inherits* Ledger's CT posture; it's a reasonable trust, not a proof).

**Three outcomes + prior (opus, low-confidence, numbers overturn it):** (A) full `cx_bn` migration → a separate M13 arc, **recommended only if `cx_bn` is correct for both moduli AND materially faster** (a perf+CT twofer worth the cost); (B) hand-rolled CT Montgomery — the "roll your own crypto" footgun, recommend **only if** (A) is correctness-blocked; (C) **documented acceptance** matching Mina/Zcash Ledger peers — the likely recommendation, since the residual is a field-mul value-dependence (a power/EM concern Speculos can't measure and software can't fully close). **Deliverable:** `cx-math-decision.md` (the three outcomes + raw numbers + the 3 caveats verbatim + recommendation + confidence + the explicit M13 gate = a *real-silicon* CT check, not the spike). Throwaway prototype **deleted/flag-gated-off** before tagging. → `safe-v18` ("M12 complete; M13 decision recorded").
**Risk/rollback:** epistemic — the spike's measurement taken as the migration's proof. Mitigated by the verbatim caveats + explicit confidence + M13 gated on real silicon. Nothing ships; revert the `#ifdef`.

---

## Security & Adversarial Considerations (MANDATORY)
Threat model: a **malicious/compromised host** (browser/dApp) + secondarily a **local physical attacker** (side-channel). M12 must widen neither surface.

- **B3 / firmware-pinned binding untouched — enforced by a review gate (opus):** a `git diff` of `finalize_and_sign.c` + the binding-compare regions of the deploy handlers must be empty (P0 = only static deletions; P2b = only the parse extraction, nothing in the compare region). No host-supplied salt/profile; no wire bump.
- **The harness must never be *cleaner* than the device (the SHARED BLIND SPOT — codex final review).** All 3 drafts over-focused on "don't fake BOLOS crypto" and under-focused on *parser-equivalence false negatives*: the likeliest way we're all wrong together is a harness *stricter/cleaner* than the real device — reject-path divergence, stale-tail bytes past `lc`, or session-state-cleanup differences — hiding a real device *accept* bug without ever producing a crash. **This affects P2a too**, not just deploy. The defences below (bidirectional differential replay + fuzz-controlled slack bytes + faithful `l4_session_reset` between iters) exist specifically to close it.
- **Fuzz shim divergence (THE dominant M12 risk, brief Q1), both directions:**
  - *False negatives (dangerous — hides a real bug):* concentrated in `buffer.c` + the APDU buffer model. Defences: **vendor `buffer.c` verbatim** (pinned SDK) + **fixed 260-byte APDU buffer** + the **Speculos differential-replay gate**. (a)+(replay) together are the only credible anti-false-negative posture; neither alone suffices.
  - *False positives (invented bugs):* heap-buffer OOB the fixed device buffer wouldn't hit (→ the 260-byte array), and fuzzing *past the parse seam* into stubbed crypto (→ **the P2b split eliminates this by construction** — we never fuzz the crypto tail). Every crash triaged real-fix vs shim-artifact in `lessons/phase-2.md`; a shim-artifact is fixed in the shim, never by weakening the device.
  - *Meta:* asserting the SW ∈ known-set catches "parser accepts malformed input" directly.
- **Dedup drift (brief Q2):** P0 helpers are **pure functions of explicit params** (no global reads → no hidden state to drift), and the binding checks stay in handlers (wrong arg fails closed at the compare). P1's `scheme→id` map is a string-union (compile-time drift = compile error) + lookup-throws (runtime) + device firmware-whitelist (on-device) — three layers. **Dedup is a security *improvement*** (M11's `account_binding.h` notes the copies had already cosmetically diverged).
- **cx_math generalization (brief Q3):** the three verbatim caveats; recommendation carries a confidence level; M13 gated on real-silicon CT, not the spike. Lowest-severity timing class (control-flow already fixed); peer-aligned acceptance is defensible.
- **Supply chain / least privilege:** no new npm deps (device C + host TS on existing `@aztec/*`); libFuzzer/ASan are the clang toolchain (no npm, honours the 7-day-min-age regime by adding nothing). **Vendored `buffer.c`** is a supply-chain-relevant copy → pinned SDK commit + `make verify-buffer` diff is the control. Crypto: P3 recommends **against** hand-rolling CT Montgomery (CLAUDE.md: never roll your own) unless `cx_bn` is correctness-blocked. Nothing touches signing authority, derivation paths, or firmware constants; no CI wiring = no new secret surface.

## Sequencing & dependencies
```
P0 (safe-v15) ──► P1 (safe-v16) ──► P2a+P2b (safe-v17) ──► P3 (safe-v18)
   device           host-only          off-device fuzz        decision doc
   byte-id          robustness         (P2b depends on P0)
```
- **P0 first, hard:** it consolidates the deploy helpers P2b's parse-extraction sits next to → P2b edits a single clean copy. **Strict: P2b depends on P0.**
- **P1 independent** (host-only); placed second as a cheap green checkpoint (no Speculos cycle needed).
- **P2 before P3:** both exercise the off-device build muscle; P2 establishes the `wire_host`/shim pattern P3's mul-bench borrows (soft dep — P3 mainly needs Speculos).
- Every tag: `bun run lint:all && bun test` from root + device build for P0/P2b; `lessons/phase-N.md` + `index.md` per tag.

## Adversarial self-critique — where this plan is most likely wrong (ranked)
1. **The P2b refactor may be rejected as too invasive** (the fork above). Fallback Y is built in, but if you want off-device deploy-parser coverage *without* the refactor, there's no good answer (reimplement BOLOS crypto = bad). Genuine values call. *(opus #1)*
2. **`buffer.c`'s include closure is unverified** (SDK not checked out locally) — if it transitively drags `os.h`/`read.h`/`macros.h`, the "small shim" becomes a partial SDK vendor, possibly forcing a compile-against-real-SDK-headers shape. **Could 2–3× P2's cost** → the shim-sizing spike de-risks it before committing. *(opus #2)*
3. **The P3 prior (lean (C) acceptance) is anchored on the Mina/Zcash precedent**, not this device's numbers — if `cx_bn` is correct for both moduli *and* faster, (A) wins. Treat the (C)-lean as a low-confidence prior; numbers overturn it. *(opus #3)*
4. **P0's "no-op" leans on a parity suite that compiles the crypto layer, not the handler `.c`** → the mandatory on-chain dual-scheme deploy is the real gate; don't tag on parity alone. *(opus #4 / main #3)*
5. **Scope honesty:** P2 fuzzes *single handler invocations*, not malformed APDU *sequences* (BEGIN→APPEND×N→FINALIZE) — session-state-machine bugs stay the domain of `wire-negative.test.ts`-style on-device tests. P2 hardens *per-APDU parsing*. *(opus #5)*
