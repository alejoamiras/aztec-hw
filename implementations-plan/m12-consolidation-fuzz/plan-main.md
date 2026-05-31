# M12 — Consolidation + Fuzz — MAIN draft (1 of 3)

Tier-A protocol. This is the **main** independent draft; siblings: `plan-codex.md`, `plan-opus.md`. Consolidation → `plan.md` after the dual audit. Owner decisions baked in: **P2 fuzzer = 3 handlers / local / fix-findings**; **P3 cx_math = prototype-spike** (decision + throwaway prototype + measurements, NOT the migration). Locked-down B3 binding is untouched (owner-ratified M11 P5).

## Reframe
M12 is **consolidation + assurance**, not new capability. Three of four phases (P0/P1 dedup+metadata, P3 decision) are low-LoC; the real engineering is **P2** (the off-device handler-fuzz shim). The arc's value: shrink the binding surface, kill host-side hardcoding, and put *automated* adversarial pressure on the exact code path an attacker controls (malformed APDUs into the wire parser) — plus turn the last crypto question (the field-arith residual) from an assumption into an evidence-backed decision.

The single biggest unknown is **P2's shim cost**: `grumpkin_host` already compiles the device crypto `.c` off-device behind `hostshim/os.h`, but the *handler* seam pulls in more BOLOS surface (`io_send_sw`, `buffer_t`, the `G_l4_*` session globals, and — only at finalize — NBGL UI). Scoping the fuzzer to the **parse + state-machine** path (begin/append/deploy-begin) and stubbing UI as no-ops keeps the shim thin and the signal honest.

## Common validation gates (reused from M11)
- **Host parity (from repo ROOT):** `bun test packages/adapter-ledger/src/grumpkin-*.test.ts packages/adapter-ledger/src/pedersen-parity.test.ts packages/adapter-ledger/src/schnorr-*.test.ts packages/adapter-ledger/src/deploy-outer-hash-parity.test.ts` (ROOT so the `bunfig.toml` `expect.addEqualityTesters` preload applies — running from the package dir silently breaks every `@aztec/foundation` import).
- **Nano S+ build:** `cd ledger-app && docker run --rm -v "$PWD:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1d… make BOLOS_SDK=/opt/nanosplus-secure-sdk` → rebuild `bin/app.elf`, reload Speculos.
- **Speculos handler tests:** `SPECULOS_URL=http://localhost:5001 bun test …/wire-negative.test.ts …/b3-consumer-binding.test.ts` (the fail-closed seam, on the real elf).
- **On-chain e2e:** `cd apps/demo-browser && bunx playwright test e2e/schnorr-full-flow.e2e.ts` (+ `TRANSFER_MODE=` / the deploy-review specs) — the decisive no-human proof for any deploy/binding-adjacent change.
- **dudect:** `cd ledger-app/tests/grumpkin_host && make dudect` — the algorithmic CT gate (host proxy, not device µarch — an explicit residual).
- Per phase: gate green → logged self-review → `safe-vN` tag (signed).

---

## P0 — Deploy-helper dedup (→ `safe-v15`, small)
**Problem:** `deploy_derive_pubkey_xy` + `deploy_compute_partial` are duplicated across `ledger-app/src/handler/begin_deploy_account.c` and `finalize_deploy_and_sign.c` (the 2 copies M11 P4 explicitly left). Both derive the deploy signing pubkey from `G_l4_deploy_session.bip32_path` (scheme-dispatched: secp256k1 for ECDSA, Grumpkin for Schnorr) and recompute the partial/complete address from (pubkey, profile, salt=0).
**Approach:** extract into the existing `ledger-app/src/l4/account_binding.{c,h}` (it already owns `account_binding_secp256k1_pubkey_xy`). Add `account_binding_deploy_pubkey_xy(session, out_x, out_y)` (curve-dispatched) + `account_binding_deploy_partial(...)`. Both handlers delegate one-line. Pure semantic no-op — the extracted code is byte-for-byte the current logic; the only change is its home.
**Validate:** host parity (`deploy-outer-hash-parity`, `grumpkin-account-parity`) byte-identical; nanos2 `-Werror` build clean; `deploy-review.e2e.ts` + `schnorr-deploy-review.e2e.ts` on Speculos; **one real on-chain deploy** (ECDSA + Schnorr fresh index) green — a deploy-address regression is the only thing that matters and it only shows on-chain. → `safe-v15`.
**Risk/rollback:** a drift here ships a *wrong deploy address* (deploy to the wrong account) — silent and serious. Gate = byte-identical parity + on-chain deploy before tag. Rollback = revert (no-op).

## P1 — T1.3 metadata-driven profile-id (→ `safe-v16`, small, host-only)
**Problem:** `packages/adapter-ledger/src/aztec-ledger-session.ts` hardcodes the deploy `profileId` per scheme (ECDSA=0, Schnorr=1). Adding a profile means editing two places (codegen + this constant).
**Approach:** resolve `profileId` from the generated `deploy_profiles` metadata (the clear-signing codegen output consumed on the host) keyed by scheme/class-id. Single source of truth = the codegen.
**Validate:** a unit test pinning the resolved `profileId` to the current values for BOTH schemes (regression pin — must not change); `provider.test.ts` / integration; one on-chain deploy each scheme. → `safe-v16`.
**Risk/rollback:** low — host-only, and the **device still validates the profile against its firmware whitelist** (`cs_deploy_profile_lookup`), so a host error fails closed (device rejects). No security surface change. Rollback = revert to the constant.

## P2 — libFuzzer/ASan handler-seam harness (→ `safe-v17`, moderate — the real work)
**Goal:** automated adversarial pressure on the untrusted-input parsers. We IMPLEMENT a harness + shim; the libFuzzer/ASan/UBSan engines are clang built-ins (no new deps).
**Approach:** new `ledger-app/tests/wire_host/`:
- **Shim layer** (the lift): extend the `grumpkin_host/hostshim` pattern to the handler seam — stub `io_send_sw` (capture the SW), provide `buffer_t` (reuse the REAL `buffer.c` if it's host-portable; only stub what isn't), define the `G_l4_session` / `G_l4_deploy_session` globals, and **no-op the NBGL UI** calls. Keep it THIN and document every deviation from BOLOS.
- **Targets:** (1) `begin_authwit` from raw bytes; (2) `append_call` with a pre-seeded valid session (the parsing-heaviest, most attacker-shaped input); (3) the deploy-begin parser. Compile the REAL handler `.c` + shim with `clang -fsanitize=fuzzer,address,undefined`.
- **Corpus:** seed from `wire-negative.test.ts` cases + a couple of valid manifests; run to coverage-plateau locally; triage + **fix** any crash/OOB/UB.
**Validate:** harness builds + runs ASan+UBSan clean over the plateau; corpus replays clean; each finding cross-checked against the real handler logic (not a shim artifact) before fixing; the existing `wire-negative` + `b3-consumer-binding` Speculos tests still green (the fuzzer is additive). → `safe-v17`.
**Risk/rollback:** see Security §. Rollback = the harness is test-only; any handler fix is a normal reviewed change with its own parity/Speculos gate.

## P3 — cx_math residual decision (prototype-spike) (→ `safe-v18`, decision only)
**Goal:** decide migrate-vs-accept the field-arith timing residual (`fr_mul`/`fq_mul` value-dependence — the dudect leading-zero signal) with REAL numbers.
**Approach:**
1. **Desk:** confirm from Ledger BOLOS docs/SDK whether `cx_bn_mod_mul` / `cx_math_*` (a) support arbitrary 256-bit moduli (BN254 `Fr`, Grumpkin `Fq`) and (b) carry any documented constant-time guarantee (and whether it's operand-size/modulus dependent).
2. **Prototype (throwaway, flag-gated `-DCX_MATH_FRMUL`, off by default):** an alternative `fr_mul` via `cx_bn_mod_mul`. Hand-rolled stays the default.
3. **Measure:** (a) **parity** — cx_bn `fr_mul` byte-identical to hand-rolled (else the migration is dead on arrival); (b) **latency** — sign-cycle timing on Speculos with the flag on vs off, measured over a **realistic op count** (a full Pedersen hash or a `[k]G`, NOT a single `fr_mul` — the syscall overhead × thousands of ops is the real cost and one op extrapolates badly); (c) **CT** — dudect with the flag on (does it actually close the leading-zero signal?).
4. **Decision doc** (`implementations-plan/m12-consolidation-fuzz/cx-math-decision.md`): recommend **full cx_bn migration (→ M13)**, **hand-rolled constant-time Montgomery**, or **documented acceptance** (peer-aligned), with the numbers + the honesty caveats below.
**Validate:** prototype parity green; latency + dudect numbers recorded; decision doc written + (if GO) an M13 stub plan. → `safe-v18`. The throwaway prototype is removed or left flag-gated off — it does NOT enter the default build.
**Risk/rollback:** spike, not a migration — no production code changes. Rollback = delete the flag-gated prototype.

---

## Security & Adversarial Considerations
- **P0 dedup → silent wrong-address.** The deploy path is on-chain-proven; a semantic drift in the extracted helper computes a *different* account address → the device clear-signs a deploy for the wrong account (or fails). It's silent at the unit level. **Trust anchor:** the bb.js parity oracle + a real on-chain deploy before tagging. No new attacker surface (refactor).
- **P1 profile-id → fail-closed.** Host metadata-parse bug → wrong profile → the device's firmware whitelist rejects it. The codegen metadata is **build-time, not attacker-controlled**. No new surface. (If the host could be tricked into a *valid-but-wrong* profile, the device still binds the address to that profile + the user reviews it — but for the demo's single profile per scheme this is moot.)
- **P2 fuzzer — the adversarial centerpiece, double-edged.**
  - *Right tool:* malformed APDUs into the wire parser is exactly where a malicious host attacks; libFuzzer+ASan+UBSan on the real handler `.c` is the highest-value assurance in this arc.
  - *Shim divergence (the main hazard):* if the shim's `buffer_t`/`io` behaves unlike BOLOS, we get **false negatives** (a real device bug never manifests) or **invented bugs** (a shim artifact we waste time "fixing," potentially breaking the real handler). **Mitigations:** reuse the REAL `buffer.c`; stub only the unavoidable (`io_send_sw`, syscalls, UI); document every deviation; cross-check each finding against device logic before fixing; keep the fuzzer scoped to parse+state (UI stays covered by Speculos e2e).
  - *Supply chain:* engines are clang built-ins — no new npm/C deps, no `minimumReleaseAge` exposure.
- **P3 cx_math — trading a known devil for an opaque one.** Migrating to `cx_bn` swaps our (parity-verified but value-dependent) field mul for Ledger's (audited but opaque, and **not guaranteed CT for custom moduli**) one. **Hazards:** (a) over-trusting the CT claim → dudect-with-flag-on is the empirical check; (b) one-op latency not generalizing → measure a full hash; (c) closing `fr_mul` alone is necessary-not-sufficient (the rest of the field layer may still leak) — the decision doc must say so; (d) the *hand-rolled CT Montgomery* option is the "roll your own crypto" trap — weight against it unless `cx_bn` is unviable. The whole point of the spike is to make this an **evidence-based** call, not a vibe.

## Sequencing & dependencies
P0 → P1 → P2 → P3, single `m12` branch, `safe-vN` per phase. P2 and P3 are independent of P0/P1 (and each other); the order is risk-batched (cheap safe wins first, then the moderate fuzzer, then the decision). **Escape hatch:** if P2's shim balloons past ~the moderate budget, land P3 (the cheap, high-clarity decision) *before* finishing P2, and consider narrowing P2 to begin_authwit + append_call (drop deploy-begin) — the two highest-value targets.

## Self-critique (where this draft is most likely wrong)
1. **P2 is the soft estimate — but the surface is now measured (verified this draft).** `begin_authwit.c` is thin (os/io/buffer/session/wire — no `cx_*`, no UI). `append_call.c` is moderate-but-tractable: it adds the `args_hash` + `registry.gen`/`selectors.gen` codegen surface, all pure/host-portable via the existing poseidon2 shim — still no `cx_*` and no UI. `begin_deploy_account.c` is HEAVY: it pulls `cx.h`, `crypto_helpers.h` (bip32 pubkey derive) **and** `ui/display.h`. **Refinement:** firmly scope P2 to **begin_authwit + append_call** (the highest untrusted-input value at the lowest shim cost — append_call's registry/allowlist/args path is where an attacker's bytes do the most), and treat **deploy-begin as a stretch goal** gated on whether stubbing `cx_*` + `bip32_derive_get_pubkey` + UI is cheap. The earlier "spike-within-P2" worry is largely resolved: begin_authwit will compile under a near-trivial shim.
2. **P3's host-dudect is a proxy** (the M11 caveat): a "CT closed" result is host-level, not device-µarch — the decision doc must not overclaim. And measuring a "full hash" still isn't a real signing trace.
3. **P0 looks trivial but is the highest blast-radius** (wrong deploy address). It must not skip the on-chain gate to save time.
4. **P1 assumes the codegen metadata exposes profileId in a host-consumable shape** — if it doesn't, P1 grows a small codegen change (still benign). Verify the generated artifact's shape first.
