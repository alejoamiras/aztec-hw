# Round 5 — opus — BOLOS app BUILD / MANIFEST / compiler-hardening surface

Angle: `ledger-app/Makefile`, `ledger_app.toml` (both copies), the BIP-32 path/curve
declaration (`PATH_APP_LOAD_PARAMS` / `CURVE_APP_LOAD_PARAMS` / appFlags), SDK
compiler-hardening defaults, memory/stack sizing, toolchain/SDK pinning. NET-NEW only;
de-duped against the 63-finding `audit/index.md`.

Key external facts established (high confidence, cited):
- **`PATH_APP_LOAD_PARAMS` is OS-enforced** at `os_perso_derive_node_bip32` time — the SE
  *refuses* derivation outside the declared prefixes; it is NOT advisory. (Ledger Donjon /
  App-Permissions docs, search-confirmed.) → an app CANNOT derive an Ethereum/Bitcoin key it
  didn't declare. This bounds the path findings below to *intra-app* scope issues, not
  cross-app key theft.
- **SDK compiler defaults** (`ledger-secure-sdk/Makefile.defines`, fetched verbatim):
  `-O$(OPTI_LVL)` default `OPTI_LVL=z` → **`-Oz`**; `-fropi -frwpi` (ROPI/RWPI = BOLOS PIE);
  `-fno-jump-tables`; `-fomit-frame-pointer -momit-leaf-frame-pointer`;
  `-Wall -Wextra -Wvla -Wundef -Wshadow -Wformat=2 -Wformat-security`;
  **`-Werror` is opt-in via `ENABLE_SDK_WERROR` (default 0)**;
  **no `-fstack-protector`, no `_FORTIFY_SOURCE`, no `-ffast-math`** by default.
- **No appFlags declared** in our Makefile; `ENABLE_BLUETOOTH=1` auto-adds
  `HAVE_APPLICATION_FLAG_BOLOS_SETTINGS` (0x200) inside `Makefile.standard_app` (expected /
  justified for BLE; not a finding).

---

## NET-NEW findings

### AHW-R5-01 · MED · BUILD/APP · OURS
**Legacy L2 handlers (blind-sign + both pubkey getters) do NOT enforce the canonical
Aztec path — only `1 ≤ len ≤ 10`.** While the L4 clear-sign handlers
(`begin_authwit.c:58-70`, `begin_deploy_account.c:104-120`, `get_aztec_master_secret.c:105-117`)
all enforce the full `m/44'/AZTEC_COIN_TYPE'/<acct>'/0/0` shape (exactly 5 components,
hardened account, trailing `0/0`), the legacy L2 paths do not:
- `sign_outer_hash.c:76-88` (the **blind-sign** path) — checks only `len != 0` and
  `len ≤ MAX_BIP32_PATH_LEN(=10)`. No `path[0]==44'`, no coin-type, no shape.
- `get_public_key.c:28-43` — same: `len ∈ [1,10]`, nothing else.
- `get_schnorr_pubkey.c:26-40` — same.

**OURS vs LEDGER:** OURS (our handler logic). The OS scope-lock (`PATH_APP_LOAD_PARAMS`)
still confines derivation to the declared `44'/<coin>'` (and `13'`, see R5-02) subtrees, so
this is **not** cross-app key extraction. The residual risk is *intra-Aztec*: a malicious
host can make the device **blind-sign an `outer_hash`** — or hand out a pubkey — under any
non-canonical Aztec path it likes, e.g. `m/44'/1666'/0'/0/999`, `m/44'/1666'/0'/1/0`, or a
deeper `m/44'/1666'/0'/0/0/0`. The clear-sign path would reject all of these with
`0x6F03`; the blind-sign path signs them. So the *weakest, least-reviewed* signing surface
(blind-sign — already flagged dangerous in AHW-001/AHW-053) also has the *loosest* path
gate, an inconsistency an attacker steers toward. It also lets a host fingerprint/segregate
keys across the `0/0` plane the canonical model says shouldn't exist.
**file:line:** `ledger-app/src/handler/sign_outer_hash.c:76-88`,
`get_public_key.c:28-43`, `get_schnorr_pubkey.c:26-40` (contrast: `begin_authwit.c:57-70`).
**Risk:** weak-path blind-sign / off-canonical key issuance inside the Aztec subtree;
worst gate on the worst path.
**Fix:** call a shared `assert_canonical_aztec_path()` (the L4 5-component check) from all
three L2 handlers — OR explicitly document that blind-sign/pubkey are intentionally
path-permissive within the OS-locked subtree and justify why. Cheapest: hoist the L4 check
(it's copy-pasted 3× already — see R5-07) into one helper and call it everywhere.

---

### AHW-R5-02 · MED · BUILD · OURS
**Declared BOLOS path scope is BROADER than any code path uses: the `13'` (SLIP-0013)
prefix is granted at OS level but no handler derives under it.**
`Makefile:38`: `PATH_APP_LOAD_PARAMS = "44'/$(AZTEC_COIN_TYPE)'" "13'"`. The second
prefix grants the OS-enforced right to derive the entire `m/13'/...` SLIP-0013 identity
subtree. But **every device handler rejects non-`44'` paths**: the L4 handlers force
`path[0]==(0x80000000|44)` and `path_scheme==L4_PATH_SCHEME_DEFAULT(=0)`
(`begin_authwit.c:47,58`); the L2 handlers (per R5-01) derive whatever they're handed but
the host adapter (`apdu.ts:140-153` `assertCanonicalAztecPath`) only ever builds `44'/...`.
The `13'` lane is documented as a *future Trezor-parity/migration* compatibility scheme
(`plan-final.md:99`, `apdu.ts:54-61` `PATH_SCHEME.SLIP_0013_AZTEC` marked "reserved …
device rejects them today"). So the manifest over-declares: it widens the SE-enforced
derivation surface for the blind-sign/pubkey INSes (R5-01) to a *second, entirely unused*
subtree.
**OURS vs LEDGER:** OURS (Makefile manifest). Least-privilege violation: declared scope
must equal used scope.
**file:line:** `ledger-app/Makefile:38`.
**Risk:** Combined with R5-01, the OS will actually let a host blind-sign / extract a pubkey
under `m/13'/<anything>` even though the project considers SLIP-0013 unimplemented — an
attacker-reachable derivation namespace nobody reviews or renders. Defense-in-depth erosion;
also a likely Ledger-review finding (they scrutinize path scope on submission).
**Fix:** drop `"13'"` from `PATH_APP_LOAD_PARAMS` until the SLIP-0013 lane actually ships.
Re-add it only when a handler honors `path_scheme=1` and the UI renders `m/13'` accounts.

---

### AHW-R5-03 · MED · BUILD · OURS
**The shipped/CI build bakes the *unregistered placeholder* coin type `1666` into every
artifact — directly contradicting codex's own pre-merge HIGH that said not to.**
`final-codex-critique.md:15-16` explicitly: *"High: do not hardcode SLIP-44 `1666` into
executable code … unregistered placeholder, not a safe production default … use a symbolic
`AZTEC_COIN_TYPE`/build-time override."* The build-time override mechanism was added
(`Makefile:37` `AZTEC_COIN_TYPE ?= 1666`, `constants.h:33-35`, `apdu.ts:88-101`) — but the
**default is still `1666`**, `constants.h:34` still literally `#define AZTEC_COIN_TYPE 1666`,
and **CI builds it with no override** (`ledger-app.yml:63` runs bare
`make BOLOS_SDK=...`). So every CI artifact, every Speculos/ragger run, and any local
`make` without the flag ships `m/44'/1666'`. The override exists but isn't *used* where it
matters, so codex's HIGH is only half-closed.
**OURS vs LEDGER:** OURS. **NB severity:** scoped MED because (a) it's a PoC and (b) the
host (`apdu.ts:88`) + device (`constants.h:37`) agree on the same default, so nothing breaks
*today*. It bites the day SLIP-0044 registers `1666` to someone else, or the day a real
Aztec coin type is assigned and an old `1666` Ledger account becomes unreachable/forked. A
hardware wallet's derivation path is a permanent commitment — shipping a placeholder is a
latent forced-migration / address-collision liability.
**file:line:** `ledger-app/constants.h:34`, `ledger-app/Makefile:37`, CI `ledger-app.yml:63`.
**Risk:** permanent path commitment to a squattable, unregistered coin type; forced
account migration once a real type lands; cross-wallet collision if `1666` is later
registered elsewhere.
**Fix:** (1) request/assign a real Aztec SLIP-0044 coin type before any non-PoC release and
make it the default; (2) until then, fail the build (or print a loud banner + embed a
`AZTEC_COIN_TYPE_IS_PLACEHOLDER` marker in `GET_VERSION`) when no override is passed, so a
placeholder build can never silently masquerade as production. Pairs with AHW-034 (firmware
provenance) — both are "what exactly did we ship" gaps.

---

### AHW-R5-04 · LOW · BUILD · OURS
**`-Werror` is OFF, so the project's "compiles without warnings" assurance is unenforced —
and Ledger's submission guideline *requires* warning-clean.** SDK default
`ENABLE_SDK_WERROR ?= 0` (Makefile.defines); our `Makefile` never sets it, and never sets
its own `-Werror`. So `-Wall -Wextra -Wvla -Wundef -Wshadow -Wformat=2 -Wformat-security`
all fire as **warnings only** — a build with new warnings (incl. `-Wvla`, the compiler-level
guarantor of the "no VLAs/alloca" claim in the index's confirmed-clean list, and `-Wshadow`,
which catches the exact variable-shadowing class that causes subtle crypto bugs) still exits
0. CI (`ledger-app.yml:60-64`) only checks `make` exit code + `ls bin/`, so warnings are
invisible. Ledger's own coding guideline (search-confirmed): *"The application must compile
without errors or warnings … warnings must not be silenced."* We neither enforce nor surface
them.
**OURS vs LEDGER:** OURS (we choose whether to opt into `ENABLE_SDK_WERROR`).
**file:line:** `ledger-app/Makefile` (absence of `ENABLE_SDK_WERROR=1`), CI
`ledger-app.yml:60-64`.
**Risk:** silent warning regressions; the `-Wvla`/`-Wshadow` safety nets the audit *relies
on* (negative-results list) can rot un-noticed; near-certain Ledger-submission rejection.
**Fix:** set `ENABLE_SDK_WERROR=1` in the Makefile (or `CFLAGS += -Werror`), and have CI
fail on warnings. Verify the tree is already clean first (it should be — it's been built 4×
in CI).

---

### AHW-R5-05 · LOW · PLATFORM/APP · MIXED
**`-Oz` + the bitmask `cmov` constant-time primitives have no compiler barrier, so the
branch-free property is an *unverified compiler assumption* at the shipped optimization
level.** The CT crypto leans on masked selects: `grumpkin_point_cmov` (`point.c:69-77`,
`mask = 0 - flag`, `and/or` blend), and the cmov-based exceptional-case handling in
`grumpkin_point_double`/`add_affine` (`point.c:80-228`). None use `volatile`, an `__asm__`
barrier, or a `optimize("no-...")` pragma. Under aggressive `-Oz` (our shipped level — SDK
default `OPTI_LVL=z`, and our Makefile doesn't override), the compiler is *formally permitted*
to pattern-match `(a & ~m)|(b & m)` and lower it to a conditional branch / predicated move,
which on some cores reintroduces a data-dependent timing edge. In practice clang/-Oz on
Cortex-M almost always keeps it as branch-free `and/orr` (and ARMv7-M `it`/`csel` is itself
single-cycle constant-time), so the *practical* risk is low — but it is an assumption the
code never pins, and the optimization level that could violate it is exactly the one we ship.
**OURS vs LEDGER:** MIXED — the `-Oz` default is LEDGER-PLATFORM-imposed (you build under
their SDK; overriding `OPTI_LVL` for the whole app is discouraged and may break the size
budget), but adding a per-function barrier / `volatile` accumulator is OURS.
**Distinct from AHW-029** (that's the *value-dependent* `fr_mul`/`gk_fq_mul` timing
residual, an algorithmic property independent of the optimizer). This is specifically the
*compiler-may-de-CT-the-cmov* risk, which AHW-029 doesn't cover.
**file:line:** `ledger-app/src/crypto/grumpkin/point.c:69-77` (and the cmov sites :207-209).
**Risk:** theoretical reintroduction of a scalar-bit-dependent branch by the optimizer;
silent if the compiler version changes (ties to R5-06).
**Fix:** mark the cmov mask `volatile` (cheapest barrier), or route selects through the
certified `cx_` constant-time ops on the production silicon path (the AHW-029 cert path), and
add a disassembly check (`arm-none-eabi-objdump` grep for a branch in the cmov) to CI. At
minimum, document that the CT property is verified only at the *current* `-Oz` + toolchain
pin and must be re-checked on bump.

---

### AHW-R5-06 · LOW · BUILD · OURS
**Toolchain (clang/arm-none-eabi) is pinned only transitively via the builder image
digest — no explicit compiler-version assertion — so a builder-image bump silently changes
the codegen the constant-time argument depends on.** Reproducibility rests entirely on
`ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1d…` (pinned by
digest in both `README.md:35` and `ledger-app.yml:49` — good). But the *clang version* inside
that image is never asserted anywhere in the repo; the Makefile records no
`MIN_CLANG_VERSION`/expected toolchain, and the built `app.elf` hash isn't recorded against a
toolchain id. The CT story (R5-05, AHW-029, AHW-019) and the `dudect` result are all bound to
*whatever clang that digest happens to ship* — a future "bump intentionally" (the comment at
`ledger-app.yml:47-48` invites it) can change instruction selection (cmov→branch,
vectorization, `fr_mul` schedule) with green CI and no signal that the constant-time
evidence is now stale.
**OURS vs LEDGER:** OURS (we control the assertion + the bump discipline); the *compiler
choice* itself is LEDGER-PLATFORM (clang is mandated by the SDK).
**file:line:** `ledger-app/Makefile` (no toolchain assertion), `ledger-app.yml:47-49`,
`README.md:35`.
**Risk:** silent codegen drift invalidating the side-channel evidence on an image bump;
non-reproducible "what compiler built the audited binary."
**Fix:** record the clang `--version` + the builder digest in the build log/artifact and in
`GET_VERSION` provenance; on any image bump, re-run `dudect` + the disassembly CT check
(R5-05) and re-record `app.sha256` per (digest, clang-version). Cross-ref AHW-034 (firmware
provenance) + AHW-035 (codegen provenance) — same "pin the inputs that decide the bytes"
theme.

---

### AHW-R5-07 · LOW · BUILD/APP · OURS
**The canonical-path enforcement is copy-pasted across 3+ device handlers (and a 4th host
copy) — drift risk on a security-critical gate.** The exact `m/44'/AZTEC'/<acct>'/0/0`
check appears near-verbatim in `begin_authwit.c:58-70`, `begin_deploy_account.c:104-120`,
`get_aztec_master_secret.c:105-117`, plus the host mirror `apdu.ts:140-153`. The
`finalize_and_sign.c:89` comment itself says *"This is the 3rd copy of the same 6-line
derivation."* If one copy is updated (new coin type, depth change, a 6th component) and
another isn't, the device's signing surface fragments — some INSes enforce a stricter/looser
path than others, exactly the inconsistency R5-01 already exploits between L2 and L4.
**OURS vs LEDGER:** OURS. Same modularity class as AHW-008 (duplicated canonical-hash) and
AHW-009 (monolith), but a *distinct* duplicated block (path-scope, not outer-hash, and
device-side C not host TS) → net-new.
**file:line:** `ledger-app/src/handler/begin_authwit.c:58-70`,
`begin_deploy_account.c:104-120`, `get_aztec_master_secret.c:105-117`.
**Risk:** divergent path enforcement across signing INSes after a one-sided edit.
**Fix:** one `static int assert_canonical_aztec_path(const uint32_t*, uint8_t)` in a shared
TU, called by all path-bearing handlers (closes R5-01 and R5-07 together).

---

### AHW-R5-08 · LOW · BUILD · OURS
**The top-level `ledger_app.toml` (the one ragger actually reads for the device matrix) is
EMPTY / a stub, while the nested `ledger-app/ledger_app.toml` documents it as the source of
truth — manifest-of-record confusion + a self-contradicting comment.**
`ledger-app/ledger_app.toml:2-5` states: *"Ragger reads the top-level `../ledger_app.toml`
for the matrix lookup; this copy stays present for `ledger-app/` to remain a self-describing
Ledger project."* But the top-level `ledger_app.toml` (repo root) is **0 lines / empty**
(verified `cat` returns nothing). So the file that's *declared authoritative* defines no
`devices`, no `build_directory`, no `sdk`; the only real metadata lives in the nested copy
that the comment says is *not* the one used. CI side-steps this entirely (`ledger-app.yml`
hard-codes the SDK matrix in `strategy.matrix.sdk`, never reading either toml), which is why
it's gone unnoticed — but for an actual Ledger submission / `ledgerctl` flow the
manifest-of-record is empty.
**OURS vs LEDGER:** OURS.
**file:line:** repo-root `ledger_app.toml` (empty), vs `ledger-app/ledger_app.toml:2-8`.
**Risk:** broken/ambiguous manifest for submission + ragger-from-root; an auditor reading
the comment trusts a file that carries no config; the `apex`/`apex_p` device (iconned in the
Makefile, see R5-09) is absent from *both* toml device lists.
**Fix:** make ONE toml authoritative (populate the root one to match the nested
`devices`/`build_directory`/`sdk`, or delete the root stub and fix the comment + point ragger
at the nested file). Keep the device list in sync with the Makefile's icon targets.

---

### AHW-R5-09 · INFO · BUILD · OURS
**Manifest/Makefile device-list inconsistency: the Makefile ships an Apex-P icon +
NBGL-for-nano, but neither `ledger_app.toml` lists `apex_p`, and Nano S (non-plus) is
implicitly dropped.** `Makefile:30` sets `ICON_APEX_P` and `:50`
`ENABLE_NBGL_FOR_NANO_DEVICES=1`, implying Apex / NBGL-nano intent, but both toml
`devices = [...]` lists (nested `:8`) enumerate only `nanox, nanos+, stax, flex` — no
`apex_p` — and CI's matrix likewise omits it. Conversely `ICON_NANOX`/`ICON_NANOSP` exist but
no plain `nanos` (correct — Nano S is EOL/unsupported by recent SDKs, so this part is fine).
The Apex-P asymmetry is the live one: an icon for a target neither declared nor built.
**OURS vs LEDGER:** OURS. INFO (cosmetic/build-hygiene; no security impact — an undeclared
device simply isn't built).
**file:line:** `ledger-app/Makefile:30,50` vs `ledger-app/ledger_app.toml:8`.
**Risk:** none direct; build-matrix vs manifest drift, future "why won't Apex build" churn.
**Fix:** either add `apex_p`/`apex` to the toml device lists + CI matrix, or drop the unused
`ICON_APEX_P` line until Apex is a real target.

---

## Confirmed-clean — negatives (assurance; auditor-facing)

- **No dangerous appFlags declared.** Our Makefile sets *no* `HAVE_APPLICATION_FLAG_*`
  manually. The only flag that lands is `BOLOS_SETTINGS (0x200)`, auto-added by
  `Makefile.standard_app` because `ENABLE_BLUETOOTH=1` on nanox/stax/flex — required &
  justified for BLE (Ledger's own pattern). **No `GLOBAL_PIN`, no `LIBRARY`, no
  `DERIVE_MASTER`-equivalent, no raw seed access.** (Makefile:49; SDK standard_app confirmed.)
- **Curve scope is minimal & correct.** `CURVE_APP_LOAD_PARAMS = secp256k1` (Makefile:33) —
  K1 only. Grumpkin/Schnorr keys are *computed* from a K1 BIP-32 child
  (`aztec_secret.c:31,68` `bip32_derive_init_privkey_256(CX_CURVE_256K1, …)`), so no extra
  OS curve grant is needed; R1 is correctly NOT declared (no R1 surface shipped). The OS
  won't let the app pull an ed25519/r1 node. Tight.
- **Path scope is OS-enforced, not advisory** (Ledger Donjon/App-Permissions
  search-confirmed). So even the loose L2 handlers (R5-01) and the stray `13'` grant (R5-02)
  **cannot** reach a Bitcoin/Ethereum subtree — no cross-app key extraction. The findings are
  intra-app least-privilege, correctly bounded.
- **Position independence on by default:** `-fropi -frwpi` (ROPI/RWPI) — the BOLOS analogue
  of PIE; we inherit it, don't disable it. (Makefile.defines, fetched verbatim.)
- **`-fno-jump-tables` on by default** — eliminates the compiler-generated switch jump-table
  data-dependent-load class for free; helps (doesn't fully solve) CT. We don't override it.
- **`-Wvla` is in the default warning set** → the index's "no VLAs/alloca" confirmed-clean
  claim is compiler-backed (modulo R5-04: it's only a *warning* without `-Werror`).
- **No `-ffast-math` / `-funsafe-math-optimizations`** anywhere (SDK default omits it; our
  Makefile adds none). No FP in the crypto path anyway, but clean.
- **No stray `CFLAGS`/`OPTI_LVL`/optimization override** in our Makefile — only
  `DEFINES += AZTEC_COIN_TYPE=…` and `DEFINES += $(EXTRA_DEFINES)`. We don't weaken any SDK
  hardening default. (Makefile:39-42.)
- **`EXTRA_DEFINES` passthrough is empty by default** → shipped build is byte-identical to a
  no-arg `make`; the `CX_MATH_SPIKE` route is opt-in (AHW-021 already owns the
  release-build guard; not re-reported — though note the spike .c lives in
  `APP_SOURCE_PATH=src`, so it's always *parsed/linked-considered*, only the INS wiring is
  `#ifdef`'d).
- **Builder image + Speculos image are digest-pinned** (`ledger-app.yml:49,107`,
  `README.md:35,49`) with an explicit "do not use :latest" note — supply-chain-correct at the
  container layer (the *toolchain-version* gap inside it is R5-06, a finer point).
- **Stack/recursion:** the deepest crypto path (`grumpkin_scalar_mul_generator` →
  `mul_affine_core`, `mul_generator.c:38-66`) is **iterative** (nested `for`, no recursion),
  with a handful of fixed `grumpkin_point_t` stack temps. No recursion, no VLAs, no
  attacker-length-driven stack buffer in the handlers/l4 (grep-confirmed: no `[128]+` stack
  arrays). No stack-overflow-into-globals primitive found. (The 7×32B `secp256k1`/`grumpkin`
  scratch in `aztec_secret.c` is fixed-size, zeroed.)
- **No stack canary / `_FORTIFY_SOURCE`** — absent, but this is **LEDGER-PLATFORM-imposed**
  (BOLOS doesn't ship `-fstack-protector`; the SE provides its own stack-overflow/MPU
  protections and a libc without `__chk` variants). **Document-only — not fixable in our
  Makefile** without diverging from the SDK. Recorded so the auditor doesn't chase it as an
  app bug.
- **`reject_dispatch` invariant** (dispatcher.c:52-57) wraps every non-9000 dispatcher exit
  in `l4_session_reset()` — the L2 path-scope laxity in R5-01 does NOT additionally corrupt
  session lifetime (that's the separate AHW-017 parse-bail path).

---

## Honest read

This angle is **genuinely net-new and productive — not mostly-clean.** 9 NET-NEW findings
(0 critical/high, **3 MED, 5 LOW, 1 INFO**). The *hardening-flags* sub-angle is largely
**reassuring** (the SDK gives us `-Oz -fropi -frwpi -fno-jump-tables` + a strong warning set
for free, no fast-math, no weakened flags, no dangerous appFlags, K1-only curve scope) — the
only flag gaps (no canary/FORTIFY) are platform-imposed and document-only. The *value* is in
the **manifest / path-scope** sub-angle, which the prior 63 findings never touched:

1. **R5-01 + R5-02 (both MED)** are the real catch — the loosest path gate sits on the
   *blind-sign* path (the most dangerous one), and the BOLOS manifest over-declares a whole
   unused `13'` subtree. OS scope-locking saves it from being HIGH (no cross-app theft), but
   it's a textbook least-privilege miss and a likely Ledger-submission flag.
2. **R5-03 (MED)** resurfaces a codex pre-merge HIGH that was only *half*-closed: the
   override mechanism shipped, but `1666` is still the baked default in `constants.h` and in
   every CI artifact — a permanent-path placeholder liability nobody re-checked.
3. **R5-04/05/06 (LOW)** are the assurance-decay trio: `-Werror` off (warning-clean
   unenforced + Ledger-guideline-violating), the cmov→branch compiler risk at `-Oz` with no
   barrier (distinct from AHW-029), and an unasserted clang version that silently invalidates
   the CT evidence on a builder bump.
4. **R5-07/08/09** are modularity/manifest-hygiene (duplicated path gate, empty
   manifest-of-record, Apex icon drift).

Top items:
- **MED** AHW-R5-01 — blind-sign + pubkey getters skip canonical-path check
  (`sign_outer_hash.c:76-88`, `get_public_key.c:28-43`, `get_schnorr_pubkey.c:26-40`).
- **MED** AHW-R5-02 — unused `13'` SLIP-0013 prefix over-declared in OS path scope
  (`Makefile:38`).
- **MED** AHW-R5-03 — unregistered placeholder coin type `1666` baked into every CI/default
  build (`constants.h:34`, `Makefile:37`, `ledger-app.yml:63`).
- **LOW** AHW-R5-04 — `-Werror` off; warning-clean unenforced (`Makefile`, `ledger-app.yml`).
- **LOW** AHW-R5-05 — `-Oz` + barrier-less `cmov` = unverified branch-free assumption
  (`point.c:69-77`).
- **LOW** AHW-R5-06 — clang version unpinned/unasserted; CT evidence drifts on image bump.
- **LOW** AHW-R5-07 — canonical-path check duplicated across 3 handlers.
- **LOW** AHW-R5-08 — top-level `ledger_app.toml` empty despite being declared authoritative.
- **INFO** AHW-R5-09 — Apex-P icon vs toml/CI device-list drift.
