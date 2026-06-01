# R5 validation — BOLOS build / manifest / compiler-hardening batch

Validator pass over `r5-opus-build-hardening.md` (locally AHW-R5-01..09). Skeptic stance;
deduped vs AHW-001..063 (`audit/index.md`). Every `file:line` re-read against HEAD.

## Verdict table

| Cand | Claim (1-line) | file:line verified? | Dedup | Verdict | Final sev/cat/owned |
|------|----------------|---------------------|-------|---------|---------------------|
| R5-01 | L2 blind-sign + 2 pubkey getters skip canonical-path check (only `1≤len≤10`); L4 enforces full 5-comp shape | YES — exact | net-new (AHW-001/053 = blind-sign danger, not path-gate) | **VALID-NEW** | MED · APP · OURS |
| R5-02 | Manifest over-declares `"13'"` SLIP-0013 prefix no handler uses | YES — `Makefile:38` | net-new | **VALID-NEW** (severity cut) | **LOW** · BUILD · OURS |
| R5-03 | Unregistered placeholder coin `1666` baked into default + every CI build; codex HIGH only half-closed | YES — `constants.h:34`, `Makefile:37`, `ledger-app.yml:63`, `final-codex-critique.md:15-16` | net-new (no index entry; AHW-034 is provenance, distinct) | **VALID-NEW** | MED · BUILD · OURS |
| R5-04 | `-Werror` off → warning-clean unenforced; CI only checks exit code | YES — no `ENABLE_SDK_WERROR`/`CFLAGS` in Makefile; `ledger-app.yml:60-64` | net-new | **VALID-NEW** | LOW · BUILD · OURS |
| R5-05 | `-Oz` + barrier-less cmov = unverified branch-free assumption | YES — `point.c:69-77`, cmov sites `:207-209`; no `volatile`/barrier | DISTINCT from AHW-029 (value-dependent fr_mul, not optimizer-de-CT) | **VALID-NEW** | LOW · PLATFORM/APP · MIXED |
| R5-06 | clang version unpinned/unasserted; CT evidence drifts on builder-image bump | YES — image digest-pinned `ledger-app.yml:49`, no toolchain assertion | net-new; cross-refs AHW-034/035 but distinct (toolchain id, not artifact/codegen hash) | **VALID-NEW** | LOW · BUILD · OURS |
| R5-07 | Canonical-path check copy-pasted ×3 device handlers (+4th host copy) | YES — begin_authwit/begin_deploy_account/get_aztec_master_secret all carry it verbatim; `apdu.ts:140-153` mirror | DISTINCT from AHW-008/009 (TS dup-hash / monolith) — C-side security gate | **VALID-NEW** | LOW · BUILD/APP · OURS |
| R5-08 | Root `ledger_app.toml` EMPTY but declared authoritative by nested copy's comment | YES — root `cat -A` = 0 bytes; nested `:2-5` names root authoritative; nested `:8` is the only real config | net-new | **VALID-NEW** | LOW · BUILD · OURS |
| R5-09 | Apex-P icon in Makefile but `apex_p` absent from both toml + CI matrix | YES — `Makefile:30,50`; "NO apex in toml or CI matrix" (grep) | net-new | **VALID-NEW** | INFO · BUILD · OURS |

**Tally: 9 VALID-NEW (2 MED, 6 LOW, 1 INFO), 0 FOLD, 0 DUP, 0 REJECT.**
(Severity adjusted on one: R5-02 MED→LOW. The finder's MED-or-LOW question for R5-02 is
resolved LOW — see below. R5-03 stays MED, R5-01 stays MED.)

---

## Decisive-check results

### R5-01 — CONFIRMED. Severity MED (finder right).
- L2 gate verified loose: `sign_outer_hash.c:80-85`, `get_public_key.c:32-37`,
  `get_schnorr_pubkey.c:29-34` — all three check only `len != 0` && `len ≤ MAX_BIP32_PATH_LEN
  (=10)`. No `path[0]==44'`, no coin-type, no shape, no trailing-component check.
- L4 contrast verified STRICT: `begin_authwit.c:57-70`, `begin_deploy_account.c:104-120`,
  `get_aztec_master_secret.c:104-117` each enforce `path_len==5 && path[0]==0x80000000|44 &&
  path[1]==AZTEC_COIN_TYPE_HARDENED && path[2] hardened && path[3]==0 && path[4]==0`. The
  finder's `:76-88` / `:28-43` / `:26-40` line cites are off by a few lines but point at the
  correct check blocks — the substance is exact.
- **CRUCIAL nuance — confirmed as a CORRECTLY-BOUNDED external fact, NOT repo-verifiable.**
  The `PATH_APP_LOAD_PARAMS` OS-enforcement (SE refuses `os_perso_derive_node_bip32` outside
  declared prefixes) is a Ledger-platform property; it is NOT observable in this repo's source.
  The finder cites it as search-confirmed (Donjon / App-Permissions docs). I take it as
  high-confidence external fact (it is well-documented Ledger behavior). On that basis the
  bound holds: the loose L2 gate cannot reach a non-Aztec (BTC/ETH) subtree → NOT cross-app
  key theft → correctly **MED, not HIGH**. The residual is intra-Aztec: blind-sign / pubkey
  issuance under any non-canonical path inside `44'/<coin>'` (and `13'`, R5-02), e.g.
  `m/44'/1666'/0'/0/999` or deeper. The clear-sign L4 path rejects all such with 0x6F03; the
  blind-sign path signs them — worst gate on the most dangerous (least-reviewed) surface.
  **Caveat for the external auditor:** the MED rating is *contingent on the OS scope-lock
  actually being enforced for this app's flags*. If that ever weren't true (e.g. an SDK/flag
  edge case, or a non-Ledger port), R5-01 escalates toward HIGH. Worth a one-line confirmation
  against the production SDK at audit time. Recategorize to **APP** (handler logic), not BUILD
  — the finder's BUILD/APP tag is fine but the substance is an app-handler gate.
- `get_public_key.c` also rejects `display`/p1=1 with `SWO_INCORRECT_P1_P2` (`:57-59`) — so the
  pubkey path has no on-device confirmation either way; the laxity is purely about *which* path
  it'll derive a pubkey for, not a confirmation bypass.

### R5-02 — CONFIRMED, but severity LOW (finder's lower bound), and one nuance the finder MISSED.
- `Makefile:38`: `PATH_APP_LOAD_PARAMS = "44'/$(AZTEC_COIN_TYPE)'" "13'"` — confirmed. The
  `13'` (SLIP-0013) prefix is granted; no device handler derives under it. `apdu.ts:54-55`
  confirms SLIP_0013 is "reserved … device rejects them today"; `PATH_SCHEME.SLIP_0013_AZTEC=1`
  is unused. So the SE-enforced derivation surface is broader than any code path → real
  least-privilege gap. Net-new.
- **NUANCE THE FINDER OMITTED (lowers severity):** the `13'` grant is NOT an accidental
  over-declare — it was a *deliberate, codex-endorsed* decision. `final-codex-critique.md:16`
  (the same critique R5-03 leans on): *"Keep SLIP-0013 available for compatibility."* The
  finder frames `13'` as careless scope-creep; it's actually a documented forward-compat
  reservation for Trezor-parity (`plan-final.md:99`). That doesn't refute the least-privilege
  observation (declared ≠ used is still a real defense-in-depth erosion, and combined with
  R5-01 the OS *will* let a host blind-sign under `m/13'/…`), but it (a) makes "drop it" a
  decision-with-tradeoffs, not a clean fix, and (b) drops this from MED to **LOW**: it's a
  pure declared-vs-used delta with no value-bearing handler behind it, the same defense-in-depth
  tier as the other R5 LOWs. Fix is conditional: drop `"13'"` *until* SLIP-0013 ships, OR keep
  it and document the intentional forward-grant — but if kept, it MUST be paired with R5-01's
  fix so the unused lane can't be blind-signed under.

### R5-03 — CONFIRMED. Severity MED. Distinct from index. Prior-codex link is EXACT.
- `constants.h:34` literally `#define AZTEC_COIN_TYPE 1666`; `Makefile:37`
  `AZTEC_COIN_TYPE ?= 1666`; CI `ledger-app.yml:63` runs bare `make BOLOS_SDK=…` with NO
  `AZTEC_COIN_TYPE=` override → every CI/Speculos/ragger artifact + any no-arg local `make`
  bakes `m/44'/1666'`. Host side matches: `apdu.ts:88-101` default 1666. Override mechanism
  exists on both sides but is unused where it ships.
- Prior-codex tie verified VERBATIM: `final-codex-critique.md:15-16` — *"High: do not hardcode
  SLIP-44 `1666` into executable code … no entry for `1666` … an unregistered placeholder, not
  a safe production default … use a symbolic `AZTEC_COIN_TYPE` / build-time override."* The
  finder's read is correct: the codex HIGH was only *half*-closed (mechanism shipped, default
  still placeholder, CI still builds the placeholder). `l2-codex-review-fixes.md:47` logs the TS
  side (MINOR #6) as "override, default 1666 placeholder" — same half-close.
- NOT in the index. AHW-034 (firmware provenance) and AHW-035 (codegen provenance) are the
  nearest neighbors ("what did we ship") but neither concerns the *coin-type value*. Distinct.
- MED is right for a PoC (host+device agree today, nothing breaks now); the bite is the
  permanent-path-commitment / forced-migration / squatting liability once a real type lands or
  1666 is registered elsewhere. Keep at MED with the "scoped because PoC" annotation.

### R5-04 — CONFIRMED. LOW.
- No `ENABLE_SDK_WERROR`, no `CFLAGS += -Werror`, no `OPTI_LVL` anywhere in `Makefile` (grep
  clean). SDK default `ENABLE_SDK_WERROR ?= 0` (external SDK fact, plausible/standard). CI
  `ledger-app.yml:60-64` only runs `make` + `ls -la bin/` — warnings invisible. The
  `-Wvla`/`-Wshadow` safety nets the index's negatives lean on are warnings-only without
  `-Werror`. Net-new. (The Ledger-submission-guideline angle is an external claim, plausible,
  not repo-verifiable — keep it as supporting, not load-bearing.)

### R5-05 — CONFIRMED. DISTINCT from AHW-029 → keep separate. LOW/MIXED.
- `point.c:69-77` `grumpkin_point_cmov`: `mask = 0 - (flag&1)`, `(p & ~mask)|(src & mask)` blend,
  no `volatile`, no `__asm__` barrier, no `optimize` pragma. cmov sites `:207-209`. Confirmed.
- The `-Oz` ship level is the SDK default and our Makefile doesn't override it (grep clean) —
  so the optimizer that *could* lower the mask-blend to a predicated/branch form is exactly the
  one in the shipped build. This is the *compiler-may-de-CT-the-cmov* risk.
- AHW-029 is the *value-dependent* `fr_mul`/`gk_fq_mul` residual — an algorithmic property
  independent of the optimizer. R5-05 is orthogonal (it'd bite even if fr_mul were perfectly
  CT). **Keep as a separate finding; do NOT fold into AHW-029.** The finder is right. Practical
  risk is low (clang/-Oz on Cortex-M almost always keeps and/orr; ARMv7-M predication is itself
  single-cycle CT) — LOW is correct. MIXED owner is right (`-Oz` is platform-imposed; the
  per-function `volatile`/barrier + a CI disasm grep is ours).

### R5-06 — CONFIRMED. LOW. Distinct.
- Builder image digest-pinned (`ledger-app.yml:49`, and `README.md:35` per finder) — good — but
  no `MIN_CLANG_VERSION` / toolchain assertion anywhere in the Makefile, and no
  (digest, clang-version) → app.sha256 record. The CT evidence (R5-05, AHW-029, dudect) is bound
  to whatever clang that digest ships; the workflow comment `:47-48` *invites* intentional bumps.
  Distinct from AHW-034/035 (those pin the firmware-source / codegen-artifact, not the compiler
  identity). Net-new, LOW.

### R5-07 — CONFIRMED. DISTINCT from AHW-008/009 → net-new. LOW.
- The exact 5-component canonical check appears verbatim in three device TUs
  (`begin_authwit.c`, `begin_deploy_account.c`, `get_aztec_master_secret.c`) plus the host
  mirror `apdu.ts:140-153` (4th copy). Confirmed by direct read of all three. AHW-008 is the
  duplicated canonical-*hash* block (TS, tx-vs-deploy); AHW-009 is the 649-LOC monolith. R5-07 is
  a duplicated **path-scope security gate in C** — different artifact, different layer, different
  blast-radius (divergent path enforcement across signing INSes after a one-sided edit — the very
  L2/L4 split R5-01 exploits). Distinct modularity finding. Fix closes R5-01 + R5-07 together
  (hoist `assert_canonical_aztec_path()` into a shared TU, call from L2 + L4). LOW.

### R5-08 — CONFIRMED. LOW.
- Root `ledger_app.toml`: `cat -A` returns nothing → 0 bytes, empty. Nested
  `ledger-app/ledger_app.toml:2-5` comment declares the root authoritative ("Ragger reads the
  top-level `../ledger_app.toml`"); nested `:6-8` carries the only real config
  (`devices = ["nanox","nanos+","stax","flex"]`, `build_directory`, `sdk`). So the
  declared-authoritative file is empty; the real metadata is in the copy the comment says is NOT
  used. CI side-steps both (matrix hard-coded in `ledger-app.yml:53-57`). Manifest-of-record
  confusion for a real `ledgerctl`/submission flow. Net-new, LOW.

### R5-09 — CONFIRMED. INFO.
- `Makefile:30` `ICON_APEX_P`, `:50` `ENABLE_NBGL_FOR_NANO_DEVICES=1`; grep confirms no `apex`
  in either toml or the CI matrix. Icon for a target neither declared nor built. No security
  impact (undeclared device isn't built). INFO. (Nano-S-absent half is correctly benign — S is
  EOL.)

---

## Finder's negatives — spot-checks (credibility)

- **Deepest crypto path is iterative / no-VLA / no stack-overflow primitive — CONFIRMED.**
  `mul_generator.c:38-66`: `mul_affine_core` is double-and-add-always, two nested `for` loops
  (32 bytes × 8 bits), fixed `grumpkin_point_t acc`/`tmp` stack temps, no recursion, no VLA.
  `grumpkin_scalar_mul_generator` just sets up generator coords and calls it. `account_derive.c`
  drives it via fixed `[32+4]`/`[64]`/`[32]` buffers. Grep for `[≥100]` stack arrays in
  `handler/` + `l4/` returned nothing. The negative is solid.
- **Stack-canary / `_FORTIFY_SOURCE` absence is BOLOS-platform-imposed, not our omission —
  ACCEPTED (external).** Not repo-verifiable (it's an SDK/libc property), but it's correct that
  our Makefile adds no `-fno-stack-protector` (nothing to disable) and BOLOS ships without
  `__chk` variants + provides its own MPU/stack protections. Document-only is the right call; do
  NOT raise it as an app bug. Credible.
- **No weakened SDK hardening flags — CONFIRMED.** Makefile adds only `DEFINES +=
  AZTEC_COIN_TYPE=…` and `DEFINES += $(EXTRA_DEFINES)`; no `CFLAGS`/`OPTI_LVL`/`-ffast-math`
  override (grep clean). `EXTRA_DEFINES` empty by default → shipped build == no-arg `make`.
- **cxmath_spike caveat — CONFIRMED & worth surfacing.** `handler/cxmath_spike.c` lives under
  `APP_SOURCE_PATH=src`, so it's always parsed/link-considered; only the INS wiring is
  `#ifdef CX_MATH_SPIKE`. This matches AHW-021's existing ownership of the release-build guard —
  R5 correctly does NOT re-report it. Good dedup discipline by the finder.

---

## Honest net-new-vs-repetition read

This angle is **genuinely net-new and productive — the skeptic's prior of "mostly dup at
finding 64+" did NOT hold here.** 9/9 survive (0 dup, 0 reject); the only correction is one
severity cut (R5-02 MED→LOW) and one re-category (R5-01 BUILD→APP). Reasons it's real:

1. The **manifest / path-scope** sub-angle (R5-01/02/03/08/09) was entirely untouched by
   AHW-001..063 — the prior rounds hit handler *logic*, host *seams*, UI *deception*,
   supply-chain *CI*, but never the BOLOS *manifest* (`PATH_APP_LOAD_PARAMS`, coin-type bake,
   toml-of-record). That's a structurally different surface.
2. **R5-01 is the only material catch** (MED): the loosest path gate sitting on the blind-sign
   path is a real, exploitable-within-bounds inconsistency, and it's the kind of thing a Ledger
   submission review flags. It's correctly NOT a dup of AHW-001/053 (those are "blind-sign is
   dangerous"; this is "the path gate on it is the weakest of all INSes").
3. **R5-03 (MED)** is a legitimate "half-closed prior HIGH" — verifiable against
   `final-codex-critique.md:15-16` verbatim. Not in the index.
4. **R5-05 vs AHW-029** is a clean distinction (optimizer-de-CT vs algorithmic value-dependence)
   — the finder didn't lazily fold it, and shouldn't.

Caveats lowering my enthusiasm slightly: the LOW/INFO tail (R5-04/06/07/08/09) is real but
low-stakes — assurance-hygiene and build-matrix drift, the kind of thing that's genuinely net-new
*by location* but wouldn't move an attacker's needle. And **three of the load-bearing facts
(OS path-lock enforcement, SDK `-Werror`/canary defaults, Ledger submission guidelines) are
EXTERNAL** — I confirmed the *repo-side* of each (the loose gate, the missing `-Werror`, the
empty toml) but cannot verify the *Ledger-platform* side from this tree. They're all
high-plausibility standard Ledger behavior; flag them to the external auditor for a one-line
SDK confirmation rather than treating them as repo-proven. R5-01's MED rating in particular is
*contingent* on the OS scope-lock holding — that contingency should travel with the finding.

Promote all 9. Suggested final IDs preserve the 2-MED / 6-LOW / 1-INFO split above.
