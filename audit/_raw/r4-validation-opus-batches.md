# R4 (depth) validation — opus batches (failure-modes + crypto-correctness)

Validator stance: skeptic. Round-4 depth is expected low-yield on a mature codebase; the live
risk is promoting sibling-dups of AHW-001..056. Every cited `file:line` was opened and the claim
checked literally; every candidate was deduped against the 56-finding index.

## Verdict table

| Candidate | Verdict | Final sev/cat/owned OR fold-target | Note |
|-----------|---------|------------------------------------|------|
| R4-01 (app_main dispatch-fail path doesn't reset L4 session) | **FOLD → AHW-017** | detail on AHW-017 | Same invariant, same fix surface (`app_main.c`). Cited line literal: dispatch-fail at `:50-55` does `explicit_bzero(&G_context)` + `return`, no `l4_session_reset()`; parse-fail at `:39-45` (the AHW-017 site) is the sibling. Fold as: "fix must cover BOTH bail-outs — parse-fail `:43` AND dispatch-fail `:53` — ideally one `wipe_all_signing_state()` helper." Not independently exploitable (BEGIN re-gates). |
| R4-02 (deploy `#deploySignOnDevice` no pre-/post-abort on throw) | **VALID-NEW** | MED · HOST · OURS | Confirmed `:198-241`: no `abortAuthwit()` pre-call and no try/catch-abort, vs `#clearSignOnDevice:178` which DOES pre-abort. Distinct from AHW-009 (host concurrency) — this is device-session cleanup on the error path. Availability/UX wedge (opaque 0x6F11), not a signing-integrity break. **Tightened:** the report's own note that `#clearSignOnDevice` pre-aborts but does NOT post-abort on a finalize throw is correct and should be part of the same fix. |
| R4-03 (in-flight mutex / floating rejected promise on synchronous-prologue throw) | **FOLD → AHW-009** (fix) + thin VALID detail | detail on AHW-009 | Cited lines literal (`:328-428`, `:593-632`): both methods build `work = (async()=>{…})()` then assign `this.inflight = work` AFTER the IIFE has started. The TOCTOU dup is already AHW-009. **Net-new sliver = the unhandled-rejection / floating-promise window** when the synchronous prologue rejects before `inflight` is assigned. Same one-statement refactor closes both. Fold the FIX into AHW-009; record the rejection failure-mode as an AHW-009 detail line. Not worth a new ID. |
| R4-04 (dead SW 0x6F10 `_TWICE` and 0x6F07 `_NOT_IMPLEMENTED`) | **VALID-NEW** | LOW · APP · OURS | Verified by grep: `SW_DEPLOY_CONTEXT_TWICE` appears ONLY in `sw.h:28` (def) + `apdu.ts:226` (mirror) — never returned. `SW_NOT_IMPLEMENTED` only `sw.h:17` + a poseidon2 README line. Second-BEGIN returns 0x6F11 (`begin_deploy_account.c:174`), collapsing two distinct conditions onto one SW. Distinct defect class from AHW-006 (misleading *comment* on a *live* SW) — this is *unreachable* code. |
| R4-05 (armed `s_secret`/`s_armed` invisible to `l4_session_reset`) | **VALID-NEW** | LOW · APP · OURS | Confirmed structurally: `l4_session_reset` (`l4/session.c:9-12`) only `explicit_bzero`s the two L4 structs; `s_secret`/`s_armed` are file-static in `get_aztec_master_secret.c:52-54` — a DIFFERENT translation unit, so the reset provably cannot reach them. `disarm()` on handler-entry (`:83`), approve (`:172`), reject (`:186`). Not currently exploitable (single-threaded blocking IO; no interleaving path found — I looked). Latent coupling: safety is an implicit io-loop property, not an enforced invariant. Distinct surface from AHW-038 (host-side heap forget). |
| R4-06 (`fromHex` no hex validation → garbage→zero-bytes) | **FOLD → AHW-011** | second bullet on AHW-011 | Cited literal `speculos-transport.ts:158-164`: `Number.parseInt(slice,16)` with no `/^[0-9a-fA-F]{2}$/` guard; `NaN`→`Uint8Array` coerces to 0. Same trust boundary as AHW-011 (the *shape* cast), but content vs shape. Fail-closed in practice: verified WebHID transport has ZERO `fromHex`/`parseInt` (raw bytes, prod path unaffected), and `provider.ts` has uniform exact-length gates (`!==3/4/64/FR_BYTES`) + `requireOk(sw)` on every response. Speculos is trusted local test transport. Add as AHW-011 detail: "also the hex *content* is unvalidated in `fromHex` — launders non-hex into zero-bytes; 3-line `/^[0-9a-fA-F]{2}$/` fix." Not worth a new ID. |
| R4-07 (`getCaps` never gates connect → late opaque SW_INVALID_CURVE_ID) | **FOLD → AHW-043** | detail on AHW-043 | Confirmed `getCaps` has exactly one non-test reference (its own def `provider.ts:51`) + one test caller (`provider.test.ts:64`) — re-validates AHW-043's "test-only." This is the *failure-mode* framing of the same dead-code finding (no graceful "device can't do Schnorr" degrade; late 0x6F04 after the user is prompted; forward-compat hazard). Net-new ANGLE, not a net-new defect. Fold as the "consequence/why-it-matters" on AHW-043. |
| NEW-R4-C-01 (poseidon2 smoke-vector labels misleading: `zero_hex` = hash-of-EMPTY) | **VALID-NEW** | LOW · TEST · OURS | Label-clarity defect in the golden-vector JSON + generator. Distinct artifact from AHW-029 (side-channel/aliasing) and AHW-015 (the `deviceOuterHashForIntent` anchor comment) — agree with the finder. Values are correct, parity asserts sound; the names mislead a reviewer (the reporter self-documents getting fooled). Auditor-confusion class. *Numeric reproduction (bb.js 4.2.1 recompute) not re-run by validator — accepted on methodology (host CLIs verified to exist, see below).* |
| NEW-R4-C-02 (`schnorr_grumpkin_pubkey` dead/confusing canonical-priv pre-check) | **VALID-NEW** | LOW · APP · OURS | Verified literal `schnorr.c:14-20`: `gk_fq_from_bytes_be(&tmp, priv_be)` parses, `gk_fq_zero(&tmp)` immediately discards, `grumpkin_scalar_mul_generator` consumes RAW `priv_be`. Reads as a no-op/bug; is actually canonical-encoding policy guard + secret scrub. Functionally correct (`[k]G==[k mod n]G`). Distinct from AHW-029. Readability/audit-clarity. (Minor: the report's inline line annotations are ±a line vs the file, but the code substance is exact.) |

## Negative-results credibility (crypto report)

Spot-checked the methodology, NOT a full re-run. The report claims it ran the repo's own host CLIs
(compiled from the shipped `src/crypto/*.c`) on edge scalars. **All three CLIs exist on disk:**
`ledger-app/tests/blake2s_host/blake2s_cli`, `ledger-app/tests/grumpkin_host/grumpkin_cli`,
`ledger-app/tests/poseidon2_host/poseidon2_cli` (+ matching `*_host/` source dirs and golden-vector
JSON). The described approach — running these CLIs on `[n]G→∞`, `P+(−P)`, blake2s 64/65/128/129-byte
block boundaries, wide-reduce at the modulus — is a real, reproducible technique against artifacts
that genuinely exist. **The "6/6 primitives confirmed mathematically clean" negative is trustworthy
to record as auditor-facing** (Montgomery field params, Grumpkin curve/EC, Poseidon2, Pedersen,
Blake2s, Schnorr, ECDSA-K1, L4/deploy outer-hash). The two LOW nits above are the only net-new yield.

## Tally

- **VALID-NEW: 4** — R4-02, R4-04, R4-05, NEW-R4-C-01, NEW-R4-C-02 → *correction: 5* (see summary; R4-02 + R4-04 + R4-05 + C-01 + C-02).
- **FOLD: 4** — R4-01→AHW-017, R4-03→AHW-009, R4-06→AHW-011, R4-07→AHW-043.
- **DUP: 0.**
- **REJECT: 0.**

(9 candidates = 5 VALID-NEW + 4 FOLD.)
