# audit-c2-remediation — Implementation Plan (OPUS, independent)

**Author:** opus parallel planner (1 of 3: main + codex + opus). Triangulate against the other two.
**Scope authority:** `scope.md` (owner-agreed W1–W7). This plan covers **all of W1–W7** exactly as scoped; where I judge a scoped fix-direction weaker than an alternative I say so explicitly and still plan the agreed scope.
**Branch:** `audit-c2-remediation` off `main` (@ `ce82734`). **Quality bar:** pre-external-audit — fix the real holes to a defensible, tested state; document residuals for the auditor.
**Validation:** firmware = docker `ledger-app-builder-lite` build → `ghcr.io/ledgerhq/speculos` on a CLEAN port (NOT the orphaned `:5001`); host = `bun test`. Signed commits.

---

## 0. Verified ground truth (read every cited line in the current tree)

The single most important thing I confirmed, because it reframes three of the seven items:

1. **W1 is ONE genuine signing-sink, not two.** `finalize_deploy_and_sign.c:214-224` and `finalize_and_sign.c` (authwit) BOTH sign a **fresh device-local recompute** (`outer_hash_local` / `recheck_outer`), never a re-read of mutable session state. The blind-sign path `sign_outer_hash_after_approval()` (`sign_outer_hash.c:126-217`) is the **only** sink that signs un-snapshotted `G_context.sign_info.outer_hash` (`:130`) + `G_context.bip32_path` (`:144-145,170-171`). So **AHW-095 is a true TOCTOU-into-signature; AHW-099 (deploy) is display-only** (the `address_local`/`#N` SHOWN can skew from a post-review fault, but the SIGNED bytes cannot). This asymmetry drives the W1 design: the blind-sign fix must snapshot-and-compare-back the *signed material*; the deploy fix only needs to snapshot the *displayed material*.

2. **W4's device already has the whole derivation chain.** `az_account_derive_from_path(path, len, partial_address, out_pkh, out_addr)` (`account_derive.c:70`) returns the **full** Aztec address. Its only non-path input is `partial_address`, which `account_binding_deploy_partial(profile, pubkey_x, pubkey_y, salt, …)` (`account_binding.c:57`) computes from a **profile_id + salt + the device pubkey** (`account_binding_deploy_pubkey_xy`, `:35`). **Consequence: `GET_AZTEC_ADDRESS` MUST carry `(manifest_version, profile_id, curve_id, path_scheme, path, salt)` on the wire** — the same template/salt the deploy and authwit paths already need. There is no "address from path alone."

3. **W2's sponsor value lives in (at least) THREE places today:** `clear-signing-v0/manifest.json:152,167` (codegen source-of-truth), the generated host mirror `src/clear_signing_v0/deploy_profiles.generated.ts:34,48`, and the frontend constant `apps/demo-browser/src/deployments.ts` (injected at `OnboardPanel.tsx:98` as `sponsoredFpcAddress`, consumed at `aztec-ledger-session.ts:376,494` via `new SponsoredFeePaymentMethod(this.deps.sponsoredFpcAddress)`). `crossCheckDeployProfile` (`gen-clear-signing-v0.ts:478-531`) validates ONLY `account_class_id` / `ctor_selector_u32` / `ctor_arg_schema` / `ctor_arg_byte_len` — it never touches `sponsor_fpc_address` / `sponsor_selector_u32` / `deployer`. The device renders only `"Sponsored (testnet)"` (`deploy_review_ui.c:107`).

4. **W5's gap is narrow.** `aztec_secret.c` already `explicit_bzero`s every secret temporary on every path. The un-scrubbed material is in **`schnorr.c` `sign_once` (`:61-68`)** — `pe`, `s_fq`, `e_fq` are NOT zeroed (only `priv_fq`, `k_fq` are, at `done:` `:71-74`) — and in **`fq.c`** helpers (`gk_fq_to_bytes_be`, `gk_fq_from_bytes_be`, `gk_fq_from_bytes_wide_be`) which leave `normal`/`tmp`/`acc`/`term` on the stack. With public `e`, residual `pe = priv·e` ⇒ `priv`. This is real but contained.

5. **Two test surfaces exist.** Python/ragger (`ledger-app/tests/test_*.py` + `application_client/aztec_command_sender.py`) AND bun:test Speculos integration (`packages/adapter-ledger/src/*.test.ts` via `SpeculosTransport`, gated `describe.skipIf(!SPECULOS_URL)`). **The richer, more-recently-used surface is bun:test Speculos** (`blind-signing-toggle.test.ts`, `verified-calls-content.test.ts`, `wire-v3-binding.test.ts`). scope.md says "host via `bun test`" and "firmware via Speculos" — I read that as: **drive firmware behavior from bun:test over `SpeculosTransport`** (the existing pattern), reserving the Python suite for low-level dispatcher cases. W7 uses bun:test Speculos.

6. **Manifest/version discipline is a hard cut.** `L4_MANIFEST_VERSION 3u` (`wire.h:30`), bumped on every wire change with NO host fallback. W4 adds a new INS; whether it forces a bump depends on the design (see W4 §). The prior wire-v3 cut (AHW-018) is the template.

---

## Phase map & sequencing

```
        ┌─────────────────────────────────────────────────────────────┐
        │ P0  Branch + baseline (build + Speculos smoke + bun test)    │
        └─────────────────────────────────────────────────────────────┘
                                    │
     ┌──────────────────────────────┼───────────────────────────────┐
     ▼                              ▼                                ▼
┌─────────┐                  ┌──────────────┐                ┌─────────────┐
│ P1  W1  │                  │ P5  W5 scrub │                │ P3  W3 host │
│ snapshot│  (firmware,      │ (firmware,   │                │ API lockdown│
│ helper +│   reusable       │  isolated;   │                │ (host-only; │
│ blind-  │   helper feeds   │  no deps)    │                │  parallel)  │
│ sign +  │   W4/W2 review)  └──────────────┘                └─────────────┘
│ deploy  │         │                                               │
│ display │         │                                        ┌─────────────┐
└─────────┘         │                                        │ P6  W6 docs │
     │              ▼                                         │ +UI copy    │
     │        ┌──────────────┐                               │ (parallel)  │
     │        │ P2  W2 sponsor│                              └─────────────┘
     │        │ single-source │
     │        │ + render FPC  │  (firmware+codegen; reuses W1 review-snapshot
     │        └──────────────┘   plumbing for the new "Fee target" pair)
     │              │
     ▼              ▼
┌───────────────────────────────────────────────┐
│ P4  W4  GET_AZTEC_ADDRESS new INS              │  ← HEAVY. Wire/version cut.
│ (firmware + host + wire). Depends on P1 helper │     Sequence like wire-v3.
│ (snapshot the reviewed address) + reuses the   │
│ deploy derivation chain.                       │
└───────────────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────┐
│ P7  W7  Test coverage (reject arms + low-S +   │  ← LAST: tests the whole
│ secp.verify, closes AHW-087). bun:test Speculos│     hardened surface.
└───────────────────────────────────────────────┘
```

**Critical path:** P0 → P1 → P4 → P7 (W4 is the long pole; P1's snapshot helper is a dependency of both the W4 review and the W2 review pair). **Parallelizable off the critical path:** P3 (host), P5 (firmware scrub, no shared files with W1/W4), P6 (docs/copy). **P2 (W2) depends on P1** only because it adds a review pair and should reuse the same snapshot-the-reviewed-tuple discipline; it can otherwise start right after P1's helper lands.

**Why W4 after W1/W2 and not first:** W4's `GET_AZTEC_ADDRESS` review screen renders a device-derived address (8+6) and must be approval-gated; it should reuse (a) the W1 immutable-snapshot helper to render-from-snapshot, and (b) the W2 single-source sponsor plumbing is *not* needed by W4 but the W2 work touches `deploy_review_ui.c` / the review-pair pattern that W4's new UI mirrors. Landing W1+W2 first means W4's UI is built on settled primitives.

---

## P0 — Branch + baseline harness

**Goal:** prove the loop works before changing anything, so every later "it broke" is attributable.

1. `git switch -c audit-c2-remediation` (off `main`). Create `implementations-plan/audit-c2-remediation/lessons/` and seed `phase-0.md`.
2. Build firmware in docker: `docker run --rm -v "$PWD/ledger-app:/app" ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:<pinned-digest> bash -lc 'cd /app && make BOLOS_SDK=$NANOS2_SDK'` (target nanos2 first — smallest, catches stack/size regressions earliest; repeat for stax for NBGL coverage).
3. Run Speculos on a **clean port pair** (5006/9996 — NOT 5001, NOT the 5005/9995 a stale run may hold): `docker run -d --rm --name speculos-c2 -p 5006:5000 -p 9996:9999 -v "$PWD/ledger-app/build/nanos2/bin:/app" ghcr.io/ledgerhq/speculos:<pinned-digest> --display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf`.
4. Baseline green: `bun test packages/` and `SPECULOS_URL=http://localhost:5006 bun test packages/adapter-ledger/src/blind-signing-toggle.test.ts` (proves the device loop). Record exact commands in `phase-0.md`.

**Exit:** firmware builds for nanos2+stax; one Speculos bun test passes; `bun test packages/` exit 0. **Modularization note:** factor the docker build+run+test commands into `ledger-app/tests/c2-speculos.sh` (ephemeral-port, path-scoped `docker rm -f speculos-c2` cleanup) so every later phase runs identically and parallel-safe.

---

## P1 — W1 immutable reviewed snapshot  [AHW-095 HIGH + AHW-099 MED]

### What's actually broken (verified)
`sign_outer_hash_after_approval()` re-reads `G_context.sign_info.outer_hash` and `G_context.bip32_path[]` to compute the digest and drive **both** RFC6979 passes. Between the user seeing `ui_display_blind_sign()`'s screen and approving, a fault (RAM glitch) or — contingent on NBGL input-blocking — a clobbering APDU can mutate `G_context`. The `types.h:80-83` union (`pk_info` ⟂ `sign_info`) means a `GET_PUBLIC_KEY`/`GET_SCHNORR_PUBKEY` interleave would `explicit_bzero(&G_context)` then repopulate the shared union — turning the signed `outer_hash` into pubkey/chain-code bytes. The dup-sig check (`:189`) does NOT catch this: both passes read the *same mutated* globals, so they agree.

### Approach — a reusable snapshot/compare-back primitive

**New module `ledger-app/src/l4/review_snapshot.{h,c}`** (the shared helper scope.md asks for; also serves the "spirit of AHW-085" — never re-read globals at the deferred sink):

```c
typedef struct {
    uint8_t  kind;        /* RS_BLIND_SIGN | RS_DEPLOY_DISPLAY */
    uint32_t token;       /* live request token (see below) */
    uint32_t bip32_path[MAX_BIP32_PATH_LEN];
    uint8_t  bip32_path_len;
    uint8_t  outer_hash[AZTEC_OUTER_HASH_LEN]; /* blind-sign: the bytes signed */
    uint8_t  address[32]; /* deploy/W4: the bytes displayed */
    uint8_t  account_index_present; uint32_t account_index; /* deploy #N / W4 */
} review_snapshot_t;

void review_snapshot_clear(review_snapshot_t *s);
void review_snapshot_capture_blind_sign(review_snapshot_t *s, const global_ctx_t *ctx);
/* returns 0 iff snapshot still matches the live source AND token unchanged */
int  review_snapshot_verify_blind_sign(const review_snapshot_t *s, const global_ctx_t *ctx);
```

**Live request token (APDU-interleave defense).** Add a module-global `static volatile uint32_t g_review_token;` in the dispatcher TU, incremented on **every** APDU entry (`apdu_dispatcher` top) and on ABORT. The snapshot stores the token at capture; `verify` rejects if `g_review_token` advanced (i.e. any APDU arrived between draw and approve). This makes Vector-B (the contingent APDU-interleave) **fail-closed regardless of whether NBGL blocks input** — we do not rely on the platform's input-blocking as the only line of defense.

### W1a — blind-sign sink (the HIGH)
- `sign_outer_hash.c`: add `static review_snapshot_t s_blind_snap;`. In `ui_display_blind_sign()` (move it or call from there), **capture** `(path, outer_hash)` into `s_blind_snap` and render the screen from the **snapshot fields**, not `G_context`.
- `sign_outer_hash_after_approval()`: **first line** — `if (review_snapshot_verify_blind_sign(&s_blind_snap, &G_context) != 0) { explicit_bzero(&G_context,…); review_snapshot_clear(&s_blind_snap); return io_send_sw(SW_HASH_MISMATCH); }`. Then compute the digest from `s_blind_snap.outer_hash` and drive **both** ECDSA passes from `s_blind_snap.bip32_path` — never `G_context` again. Clear the snapshot on every exit.
- **Union-clobber belt-and-suspenders:** because `pk_info`/`sign_info` alias, the snapshot's independent storage is the real fix (we no longer read the union at sign time). The token check additionally rejects the interleave that caused the clobber.

> **Critical assessment of scope.md's W1 phrasing.** scope.md says "compare live `G_context` to the snapshot and reject on mismatch." That compare-back is good defense-in-depth but is **not** what closes the hole — **signing from the snapshot is.** If you only compare-and-still-sign-from-G_context, a fault that hits *after* the compare still wins. My plan signs from the snapshot AND compares back (the compare is a cheap fault-detector/telemetry; the snapshot-sign is the guarantee). Confidence: high. This is the single most important correction in W1.

> **Does this FULLY close the TOCTOU given the union?** Yes for the signing path — once we never read `G_context.sign_info` at the sink, the union aliasing is irrelevant to *what gets signed*. Residual: a fault could still corrupt `s_blind_snap` itself between capture and sign. That's the universal "single-glitch on the SE's own RAM" residual (AHW-128, PLATFORM) — the same class every BOLOS app accepts; the dual-pass + compare-back narrows it. Document as residual.

### W1b — deploy review display (the MED, AHW-099)
The deploy **signature** is already snapshot-safe (signs `outer_hash_local`). Only the **displayed** `address_local` + `#N` can skew under a post-validation fault. Fix: in `ui_display_deploy_review()` capture `address_local` + `deploy_account_index()` into a `review_snapshot_t` (kind `RS_DEPLOY_DISPLAY`) and render from it; in `finalize_deploy_after_approval()` add a compare-back of the displayed snapshot vs `G_l4_deploy_session.address_local` before signing, reject on mismatch. This is display-integrity hardening (the sig was already safe) but closes the "you approved address X, the screen could have been repainted to Y" gap and unifies the pattern.

> **Does the reveal `#N` need the same fix?** YES, but it's already in the audit as AHW-112 (LOW, V1-04) and is **display-only** (the emitted secret is frozen at arm-time under the validated path; only the shown `#N` can skew). scope.md does NOT list AHW-112 in W1. **I recommend folding the reveal `#N` snapshot into W1b for ~10 LOC** (reuse `review_snapshot_capture` for `account_index` in `get_aztec_master_secret.c` arm + render from it in `master_secret_reveal_ui.c`) since the helper already exists and it removes a whole class of "the screen showed a different account than the secret belongs to" confusion. If the owner wants to hold strict scope, leave AHW-112 as documented residual — flag for triangulation.

### Tests (bun:test Speculos)
- `blind-sign-snapshot.test.ts`: with blind-signing ON, drive `SIGN_OUTER_HASH`; **happy path** still signs (regression). **Reject arm:** a fault-injection test is hard in Speculos (no glitch primitive), so prove the **token defense** instead — interleave a `GET_PUBLIC_KEY` APDU between BEGIN-of-review and approve (Speculos lets us send a second APDU while the review is up) and assert the approve now returns `SW_HASH_MISMATCH` (0x6F01) rather than a signature. This is the concretely-testable half of AHW-095 and directly exercises the union-clobber vector.
- Deploy display: extend `verified-calls-content.test.ts`-style content assertion to confirm the deploy review still shows the device address (regression that the snapshot render didn't blank it — the exact bug class of the old `g_addr_str[32]` overflow).

**Modularization payoff:** `review_snapshot` is reused by W1a, W1b, (optionally reveal), and W4's address review.

---

## P2 — W2 deploy fee-target clear-signing  [AHW-096 MED]

### Two independent defects, one root
1. **Display gap:** the signed `sponsor_unconditionally()` target FPC is hidden behind `"Sponsored (testnet)"`.
2. **Drift surface:** `sponsor_fpc_address`/`sponsor_selector_u32`/`deployer` flow codegen → device table **un-cross-checked**, and the host runtime reads a *separate* copy (`deps.sponsoredFpcAddress` ← `apps/demo-browser/deployments.ts`). A poisoned build that aligns the two signs an attacker FPC while the screen still says "Sponsored."

### Approach

**W2a — render the fee target (clear-sign it like a recipient).** In `deploy_review_ui.c`, add two pairs derived from the **profile** (`cs_deploy_profile_lookup(G_l4_deploy_session.profile_id)`):
- `Fee target` = `address_8_6(profile->sponsor_fpc_address)` (reuse the existing `address_8_6` 8+6 helper).
- `Fee action` = the sponsor selector as `0x%08x` (reuse `fr_as_u32_or_hex`-style formatting) + a static label `sponsor_unconditionally`.
Render these from a **snapshot** (P1 helper, extend `review_snapshot_t` with `sponsor_fpc[32]`/`sponsor_selector`) so the screen can't be repainted. Keep `"Sponsored (testnet)"` as a third "Fee mode" line for continuity.

**W2b — single-source the sponsor so display == sign == config.** The device already signs `profile->sponsor_fpc_address` (`finalize_deploy_and_sign.c:203`). The fix is to make the **host runtime** read the SAME generated, cross-checked table instead of an independent constant:
- Make `gen-clear-signing-v0.ts` the sole author of the sponsor value: extend `crossCheckDeployProfile` to **fail-closed** assert `sponsor_fpc_address` / `sponsor_selector_u32` / `deployer` against canonical sources — `sponsor_selector_u32` recomputed from `FunctionSelector.fromNameAndParameters('sponsor_unconditionally', …)` of the SponsoredFPC artifact; `deployer` asserted `== Fr.ZERO` (universal); `sponsor_fpc_address` is the one genuinely-configured value (no canonical FPC exists), so pin it to a single named constant the generated TS table **exports** (`SPONSORED_FPC_ADDRESS`), and have `aztec-ledger-session.ts` import THAT (delete the `deps.sponsoredFpcAddress` independent-injection path, or default it from the generated table and assert equality if a caller passes one).
- Net: `manifest.json` (codegen input) → generated `deploy_profiles.generated.ts` (single host source, cross-checked) → both the device `.gen.c` table and the host `SponsoredFeePaymentMethod` read the SAME bytes. `apps/demo-browser/deployments.ts` is reduced to re-exporting the generated constant (frontend is out of scope, but removing its independent literal is a one-line import swap and kills the third copy).

> **Where is the ONE source after single-sourcing, and can the host still diverge?** The ONE source is `manifest.json` (authored) → validated/emitted by codegen into `deploy_profiles.generated.ts`. The host runtime imports the generated constant; **it can no longer diverge** because there is no second literal to edit — a drift attempt requires editing the generated file, which `gen:clear-signing-v0:check` (CI) regenerates-and-diffs. The remaining trust is "the codegen ran and CI gated it" — which is exactly the W2-01/F-K6-2 build-gate facet. scope.md correctly scopes the *runtime* drift fix here and DEFERS the CI-gate-on-firmware-build hardening to the CI pass; I flag that the display+single-source fix is **only fully sound once the firmware build also gates on gen-drift** (otherwise a poisoned `.gen.c` checked in without regenerating still ships). Document this as the residual the auditor must see.

> **Does rendering an FPC address actually help the user?** Honest answer: **marginally, for v0.** There is no canonical FPC, so the user has nothing to compare the 8+6 against except documentation/their own prior knowledge. The real value is (a) it removes the *blind* fee authorization (the user can at least screenshot/record the FPC and detect a *change* across deploys), and (b) it makes display == signed, so a poisoned build can no longer hide a swapped FPC behind "Sponsored." It is NOT a strong anti-phishing control by itself. I'd pair it with a one-line on-screen note ("Verify FPC matches docs") — but that's copy, and the honest framing belongs in W6's docs. Confidence: moderate that this materially helps a non-expert user; high that it closes the display==signed gap.

### Tests
- `bun test` (no Speculos): a codegen unit test that `crossCheckDeployProfile` **throws** when `sponsor_fpc_address` / `sponsor_selector_u32` / `deployer` are mutated (the fail-closed gate). Assert the generated table's sponsor bytes `===` the host runtime's `SponsoredFeePaymentMethod` FPC (no-drift assertion).
- Speculos `deploy-fee-target.test.ts`: drive a deploy, scrape the review, assert the FPC 8+6 + selector pairs are present and match `deploy_profiles.gen.c`.

---

## P3 — W3 host public-API lockdown  [AHW-097 HIGH + AHW-103 MED]   (host-only, parallel)

### AHW-097 — kill the published blind-sign oracle
`index.ts:54-60` root-exports `LedgerProvider`, whose `signOuterHash(bip32Path, outerHash)` (`provider.ts:214`) is a raw 32-byte-digest signer bypassing `LedgerClearSigningEntrypoint`. Only the device blind-sign toggle (default-OFF) guards it.
- **Fix:** remove `LedgerProvider` from the root barrel. Create `packages/adapter-ledger/src/unsafe.ts` that re-exports `LedgerProvider` (and its types) with a file-level docstring stating the raw-signer hazard, and add a package `exports` subpath `"./unsafe"` in `package.json`. Internal consumers (`aztec-ledger-session.ts`, `onboarding.ts`, `auth-witness-provider.ts`, `account-contract.ts`) import from `./provider.ts` directly (unchanged — they're inside the package). Normal consumers importing the root barrel no longer get the raw signer.
- This is a **public-API change → minor/major version bump** of `@aztec/`-style package (note in CHANGELOG). The clear-sign entrypoint stays the only root-exported signing path.

### AHW-103 — privacy-root cache reread off the root barrel
`index.ts:61-66` exports `loadCachedSecret` + `cacheSecret` + `deviceCacheKey` + `revealMasterSecret`. Composition: any in-process consumer can `deviceCacheKey` (approval-free) → `loadCachedSecret` → pull the revealed `Fr` after one legitimate reveal (memory-only cache, AHW-048, so same-origin/page-lifetime only).
- **Fix:** keep cache access internal to the onboarding/session layer. Remove `cacheSecret`/`loadCachedSecret`/`clearCachedSecret` from the root barrel; expose only `clearAllCachedSecrets()` (the "forget" primitive) and a new `hasCachedSecret(key): boolean` presence check that returns an opaque boolean, never the `Fr`. `deviceCacheKey` stays exported (it's the cache-miss discriminator; harvesting the pubkey is platform per AHW-080) but document it. `revealMasterSecret` stays (it's approval-gated) — but consider moving it behind `./unsafe` too if the owner agrees it's not a default-surface call.

> **AHW-104 (override seams) is DROPPED per scope.** Correct call: `setEntrypointOverride`/`overrideAccount` are only dangerous *paired with the raw signer* (AHW-097); once `LedgerProvider` is off the root barrel and the seams accept only the internal branded entrypoint, the bite is gone. **Document in `audit/index.md`** that AHW-104 is defanged-by-W3, not independently fixed. I'd additionally tighten the seam types to `LedgerClearSigningEntrypoint` (not arbitrary `EntrypointInterface`) as a cheap belt-and-suspenders — flag for triangulation, not in strict scope.

### Tests (`bun test`, no device)
- `index-surface.test.ts`: assert the root barrel does **not** export `LedgerProvider`, `loadCachedSecret`, `cacheSecret`, `clearCachedSecret` (snapshot the export keys); assert `./unsafe` DOES export `LedgerProvider`. This is a regression guard against a future re-export (the exact "secret-strip untested" lesson from AHW-007).
- `secret-cache.test.ts` extension: `hasCachedSecret` returns true/false without exposing the `Fr`.

---

## P4 — W4 device-attested receive address: new `GET_AZTEC_ADDRESS` INS  [AHW-098 HIGH]   ← the heavy item

### The problem, stated precisely
Onboard derives the address **host-side** (`aztec-ledger-session.ts:252` `accountManager.address`). The device attests the **secret** (reveal checksum = 16-bit SHA-256 over the secret, `master-secret.ts`) but **never the address**. The only device address-attestation is the DEPLOY review (`deploy_review_ui.c:105`, device-derived `address_local`) — and deploy is auto-suppressed on host-controlled `alreadyDeployed`. A malicious host does a genuine reveal (checksum matches — it certifies the secret), then shows an attacker-chosen receive address and forces `alreadyDeployed=true`. Funds to that address go to the attacker.

### Approach — new approval-gated INS that derives + renders + returns the address

**New `INS_GET_AZTEC_ADDRESS = 0x14`** (next free; `0x12`=master-secret, `0x13`=schnorr-pubkey). Handler `ledger-app/src/handler/get_aztec_address.{h,c}` + UI `ledger-app/src/ui/aztec_address_ui.{h,c}`.

**Wire body (REQUIRED — the address is template-dependent):**
```
manifest_version(1) | profile_id(1) | curve_id(1) | path_scheme(1) | path_len(1) | path[path_len*4] | salt[32]
```
This is a strict subset of `BEGIN_DEPLOY_ACCOUNT`'s body (drop chain/version/nonce/public_keys_hash/expected_address — the address derivation needs none of those). **Reuse `deploy_parse_and_validate`-style validation:** same `manifest_version` check, same `(curve_id, profile)` pairing gate, same full-canonical-path enforcement (`m/44'/AZTEC'/<acct>'/0/0`), same Fr-canonical salt.

**Derivation (reuse, zero new crypto):**
1. `account_binding_deploy_pubkey_xy(curve_id, path, len, x, y)` → device signing pubkey.
2. `account_binding_deploy_partial(profile, x, y, salt, args, init, partial)` → `partial_address`.
3. `az_account_derive_from_path(path, len, partial, pkh, addr)` → the full Aztec **address** (derives sk from seed, computes viewing keys, address). **Run it TWICE + `ct_memcmp32` compare** (mirror the master-secret dual-derive fault discipline) before arming.
4. Arm `(addr, account_index)` into a `review_snapshot_t` (P1 helper); show `aztec_address_ui` (8+6 address + `Account #N`); on **approve**, `review_snapshot_verify` then `io_send_response_pointer(addr, 32, OK)`; on reject `SW_USER_REJECTED`.

**Host side:**
- `provider.ts`: `async getAztecAddress(ctx: {profileId, curveId, pathScheme, bip32Path, salt}, opts): Promise<Uint8Array>` (32 BE). Mirror `finalizeDeployAndSign`'s autoConfirm + length-check shape.
- `onboarding.ts`: new `attestReceiveAddress(transport, ctx, opts)` that calls it and returns an `AztecAddress`.
- `aztec-ledger-session.ts:252`: **stop trusting `accountManager.address` as the receive identity.** After `AccountManager.create(...)` (still needed for the Account object), call `getAztecAddress` and **assert** the device-attested address `===` `accountManager.address`; on mismatch, **throw** (fail-closed onboard). The user confirmed the address on-device. Use the device value as the canonical receive identity going forward. **Remove the `alreadyDeployed` suppression of address-attestation** — the address attestation is now a separate, always-available INS independent of deploy.

### The hard adversarial questions (scope.md demands harshness here)

**Q: Replay into authwit/deploy/sign?** The INS returns ONLY a 32-byte address (a public value) — **it signs nothing**, derives no signature, exposes no secret. There is no signature to replay. The derivation reuses the deploy chain but produces a public address that the host could already compute itself. So **no new signing oracle, no replay surface into authwit/deploy/sign.** This is the key reason the new INS is far safer than a new signing INS. Confidence: high.

**Q: Domain-separated?** The address derivation uses the existing Aztec domain separators (`L4_SEP_*`, `KEYGEN_*`) — same as the deploy path. The INS adds no new preimage. The only "domain" concern is that `GET_AZTEC_ADDRESS` and `BEGIN_DEPLOY_ACCOUNT` must not be confusable on the wire — guaranteed by distinct INS bytes + the dispatcher's per-INS `make_buf` + the L2-boundary `l4_session_reset()` (treat `GET_AZTEC_ADDRESS` as an L2-style single-shot INS that resets any in-flight L4 session, like GET_PUBLIC_KEY). No shared mutable state with the deploy/authwit sessions.

**Q: Does device-attesting the address ACTUALLY close AHW-098, or just relocate trust?** **This is the crux and I will not oversell it.** The device now *derives and displays* the address from its own seed. The residual trust is: **the user still compares a host-rendered value to the device screen.** If the user does NOT look at the device, a malicious host can still show address Y in the browser while the device shows X — the user sends to Y. So W4 does **not** make the host trustworthy; it makes the device the *attestation anchor* the user CAN check, and — critically — **the host code now fails closed if its derived address ≠ the device's** (the `===` assert at onboard). That assert is what closes the *programmatic* hole (a malicious host can't get the session to silently use a host-chosen address — the session throws). The *social-engineering* residual (user ignores the device) is the universal hardware-wallet trust assumption (AHW-044: on real HW the device screen IS the anchor). **So: W4 closes AHW-098 at the protocol/host-code layer (fail-closed mismatch) and provides the user-checkable anchor; it does NOT and cannot eliminate "user didn't look."** That residual must be documented for the auditor, and W6's copy must tell the user to compare. Confidence: high on the framing.

> **A sharper alternative I considered and rejected for v0:** make the device-attested address the ONLY receive identity the UI ever displays (never render a host-derived address at all), so there's nothing for the host to lie with. This is stronger (removes the "compare two values" UX entirely) but it's a frontend change (`apps/demo-browser`, out of scope) and requires the UI to block on a device approval at onboard. I recommend it as the **follow-up frontend item** and note it; W4 as scoped (device attests + host asserts equality) is the correct firmware/wire layer fix.

**Q: Fail-closed on non-canonical path/curve?** Yes — reuse the exact gates: `(curve_id, profile)` pairing (`SW_INVALID_CURVE_ID`), full-canonical path shape (`SW_INVALID_PATH_SCHEME`), Fr-canonical salt (`SW_HASH_MISMATCH`), unknown profile (`SW_UNKNOWN_PROFILE_ID`), unknown manifest version (`SW_UNKNOWN_MANIFEST_VERSION`). The dual-derive `ct_memcmp32` rejects internal faults (`SW_DUP_SIG_MISMATCH`). `account_binding_deploy_pubkey_xy` already fails closed on unknown curve.

**Q: Wire/version attack surface — does it force a manifest bump?** The new INS carries its own `manifest_version` byte and validates `== L4_MANIFEST_VERSION`. Adding a *new INS* does not change *existing* layouts, so strictly it doesn't require bumping the shared `L4_MANIFEST_VERSION` (3→4) the way AHW-018 did (which changed BEGIN_AUTHWIT's body). **However**, I recommend bumping to **`v4` anyway** and gating `GET_AZTEC_ADDRESS` on `v4`, mirroring the prior wire-v3 hard-cut discipline: it makes the host↔device capability contract explicit (an old device returns `SW_UNKNOWN_MANIFEST_VERSION` for the new INS rather than `SW_INVALID_INS`, a clearer failure), and keeps the "every wire change is a hard cut, no fallback" invariant intact. Update `GET_CAPS` with a new `CAPS_ATTEST_ADDRESS` bit so the host can detect support without trial. **Design fork for triangulation:** bump-to-v4 + caps bit (my recommendation) vs. new-INS-only-no-bump (lighter). I favor the bump for the explicit contract; it's the single biggest W4 wire decision.

### Tests (bun:test Speculos — the round-trip is the headline)
- `aztec-address-attest.test.ts` (the proof AHW-098 is closed):
  - **Round-trip:** `getAztecAddress({profile0, K1, path, salt})` with autoConfirm-approve returns 32 bytes; assert it **equals** the host's independently-computed `AccountManager.address` for the same `(secret-from-reveal, salt)` — proving the device derives the SAME address the host does (so the assert in onboard will pass for honest hosts) AND that it's device-authored.
  - **Schnorr arm:** same for `(profile1, GRUMPKIN)`.
  - **Reject arms:** non-canonical path → `SW_INVALID_PATH_SCHEME`; (K1, profile1) mismatch → `SW_INVALID_CURVE_ID`; non-canonical salt → `SW_HASH_MISMATCH`; user-reject → `SW_USER_REJECTED`.
  - **Content:** scrape the review screen, assert the 8+6 address + `Account #N` are shown (the user-checkable anchor exists).
- Host `onboarding.test.ts` extension: mock a transport whose `getAztecAddress` returns a DIFFERENT address than `accountManager.address`; assert `connect()`/onboard **throws** (the fail-closed mismatch — this is the programmatic close of AHW-098).

---

## P5 — W5 Schnorr key-residue scrub  [AHW-100 MED]   (firmware, isolated, parallel)

### Precise gap (verified)
- `schnorr.c` `sign_once` `done:` (`:71-74`) zeros only `priv_fq`, `k_fq`. **`pe` (`= priv·e`), `s_fq`, `e_fq` are left on the stack.** `pe` with public `e` ⇒ `priv`. `s_fq` is the secret nonce-minus-pe. These are the dangerous residues.
- `fq.c`: `gk_fq_to_bytes_be` leaves `normal`/`one_normal`; `gk_fq_from_bytes_be` leaves `tmp`; `gk_fq_from_bytes_wide_be` leaves `acc`/`c256`/`term`. These hold secret-derived field elements when called on `priv`/`k`/`scalar`.
- `aztec_secret.c:93-97,138-142` (scope-cited): already `explicit_bzero` `reduced` — **already clean**; I'll re-verify and only add scrubs if a temporary is missed (the cited lines look already-scrubbed, so this may be a no-op; note it).

### Approach — helper-level cleanup (so caller scrubbing isn't the only defense)
- `schnorr.c sign_once`: add to `done:` — `gk_fq_zero(&pe); gk_fq_zero(&s_fq); gk_fq_zero(&e_fq);` and `explicit_bzero(e_wide,…)`, `explicit_bzero(preimage,…)`, `explicit_bzero(compressed,…)` (compressed/preimage are pubkey-derived, low-sensitivity, but scrub for uniform discipline). Crucially scrub on the **success** path too (currently `ok=true` falls through to `done:` which only does priv/k — extend it).
- `fq.c`: scrub the named temporaries at the end of `gk_fq_to_bytes_be`, `gk_fq_from_bytes_be`, `gk_fq_from_bytes_wide_be` with `explicit_bzero(&tmp, sizeof(tmp))` etc. **Helper-level** means every caller (Schnorr sign, account derive, pubkey) benefits without remembering to scrub.
- `aztec_secret.c`: confirm `signing_scalar_once`/`schnorr_nonce_once` already scrub (`:80,88,95,97,136,142` show `explicit_bzero`); add the two-buffer `a`/`b` scrubs in `az_derive_schnorr_*` are already present (`:178-194,206-222`). Likely no change; record the verification.

> **Caveat (honest):** `explicit_bzero` on a `gk_fq_t` in Montgomery form zeroes the limbs, but the compiler may have spilled intermediates to other stack slots / registers we can't name. `explicit_bzero` defeats dead-store elimination for the *named* object only. This is a **best-effort** scrub — the rigorous fix is a stack-wipe-on-return (`explicit_bzero` of the whole frame), which BOLOS doesn't make easy. Document that W5 reduces but does not eliminate residue; the residue's exploitability also requires a stack-reading fault/side-channel (AHW-029 PLATFORM territory). Confidence: high that it closes the *named-object* leak; moderate that no spill remains.

### Tests
- W5 is hard to assert behaviorally (you can't read freed stack from Speculos). **Strategy:** (a) regression — `schnorr-parity.test.ts` / `grumpkin-*` parity suites must still pass byte-for-byte (the scrubs must not change outputs); (b) a **host-compiled unit** is impractical for stack inspection. Accept W5 as **code-verified + parity-regression-guarded**, documented as such (this matches the project's existing posture on AHW-068 cmov). Add an inline comment + a `lessons/phase-5.md` note that the proof is parity-preservation, not residue-absence.

---

## P6 — W6 recovery model truth  [AHW-106 MED]   (docs + UI copy, parallel)

### What's false today
Code derives the master secret from the HW seed (single-seed: `master-secret.ts` `SHA-512(DOMAIN‖child-privkey) mod Fr`, `aztec_secret.c:28`). The spec `../aztec-hardware-wallet/architectures/03-recovery-and-backup.md:11-24,128-134` mandates a 2-of-2 split-brain and says **"Do not derive `sk` from the HW seed."** UI (`ConnectPanel.tsx:139`) says "the seed is your backup." Doc and UI both lie about the model. **Not a runtime exploit** (the runtime consequence is AHW-047, already filed).

### Approach — align docs/UI to reality (NOT build 2-of-2)
- Rewrite `03-recovery-and-backup.md` (research repo, **use `~/`-relative or repo-relative paths in the doc itself per personal convention — no absolute local paths in committed artifacts**) to declare the **actual single-seed model**: the Aztec privacy root is deterministically derived from the BIP-32 child private key; the HW seed is the sole backup; **consequences:** (a) seed compromise = path-wide privacy-root compromise (viewing keys for that account, chain/scheme-wide per AHW-047); (b) seed loss strands the account (no separate protocol-secret backup exists). Cross-reference AHW-047 as the export-scope finding.
- `ConnectPanel.tsx` / onboarding copy: replace "the seed is your backup" with truthful copy ("Your device seed deterministically derives this account's Aztec keys. Anyone with your seed can derive your viewing keys. Losing the seed loses the account."). Plain language, no jargon (frontend copy is in scope as a doc/copy change even though `apps/demo-browser` runtime is otherwise out of scope — this is the W6-listed `ConnectPanel` copy).
- **Pair with W4's anti-phishing copy:** the receive-address screen copy ("Verify this address matches your device") belongs here too.

> **Why not build the 2-of-2?** scope.md explicitly says NOT to, and correctly: the single-seed model is a deliberate v0 simplification; building split-brain custody is a multi-week design (passphrase/SLIP-39 second factor) far beyond a pre-audit remediation. The honest fix is to stop the docs from claiming a security property the code doesn't have. Confidence: high.

### Tests
None (docs/copy). Verification = a reviewer diff + a `lessons/phase-6.md` note that the spec now matches `master-secret.ts`. Optionally a tiny `bun test` that asserts the onboarding copy string does NOT contain the old "is your backup" phrasing (regression against reverting to the false claim) — cheap, catches drift.

---

## P7 — W7 test coverage: reject arms + low-S + secp.verify  [AHW-108 MED + AHW-109 MED, closes AHW-087]

### AHW-108 — APPEND_CALL strict-allowlist reject arms
The four arms have only membership-fuzz coverage (`fuzz_append_call.c` accepts every reject SW — an accept-regression that turns a reject into `0x9000` ships green). The arms + exact SWs (verified in `append_call.c` + `sw.h`):
- `SW_DECODER_MISS` **0x6F09** — `(kind, selector)` not in `CS_VERBS` (`:133`).
- `SW_DECODER_DESYNC` **0x6F0A** — `args_count != verb.wire_arg_count` (`:135`; also `args_count > L4_MAX_ARGS` at `:114`).
- `SW_VISIBILITY_MISMATCH` **0x6F0B** — `flags.is_public != verb.is_public` (`:139`).
- `SW_DELEGATED_SPEND_UNSUPPORTED` **0x6F0C** — 4-arg TRANSFER with `args[0] != consumer` (`:143-145`) — **the delegated-spend gate, the highest-value arm.**

**Approach (bun:test Speculos, model on `verified-calls-content.test.ts`):** new `append-call-reject-arms.test.ts`. For each arm: BEGIN_AUTHWIT a 1-call session, then APPEND_CALL a body crafted to hit exactly that arm, assert `rejects.toThrow('SW=0x6f09'|…|'6f0c')`. The delegated-spend arm is the security headline — craft a 4-arg `transfer` with `args[0]` ≠ the session consumer and assert `0x6F0C` (reject **pre-UI**, like the existing `0x6F08` registry-miss case). This needs `appendCall`-with-raw-body support; add `append_call_raw(payload)` to the host provider or a test helper (mirror `sign_outer_hash_raw` in the Python sender).

### AHW-109 — device low-S anti-malleability (+ closes AHW-087: host never verifies the device sig)
The device normalizes low-S on every ECDSA path (`sign_outer_hash.c:160,186`; `finalize_deploy_and_sign.c:295,315`; authwit finalize) but **no test asserts it** — the host `core/src/ecdsa.test.ts` tests a *different* impl. And AHW-087: the live Ledger adapter never `secp256k1.verify`s the returned sig vs the cached pubkey.

**Approach (one test kills both, bun:test Speculos):** `device-sig-lows-verify.test.ts`:
1. Drive a real device signature (clear-sign transfer FINALIZE_AND_SIGN happy path, and a blind-sign with toggle ON for the raw path).
2. Assert `s <= SECP256K1_HALF_N` (low-S) on the returned `s` — **directly closes AHW-109's untested-low-S gap.**
3. `secp256k1.verify({r,s}, sha256(outer_hash), cachedPubkey)` using `@noble/curves/secp256k1` (already a dep) — **closes AHW-087** (proves the device sig validates against the device pubkey, which the production adapter should also do). Assert verify === true.
4. For Schnorr: assert the returned 64-byte sig verifies via the project's Schnorr verifier / parity oracle against the Grumpkin pubkey (reuses `schnorr-parity` machinery).

> **Bonus close:** scope.md notes this "ideally" also `secp.verify`s. I make that **mandatory** in the test because it's the cheap thing that closes AHW-087 in the same file, and a verify-after-sign is exactly the host-side defense AHW-087 wants. I'd additionally recommend the **production adapter** (`auth-witness-provider.ts`) do a `secp.verify` after every device sign (fail-closed on a bad sig) — that's a tiny host hardening beyond strict W7-test scope; flag for triangulation.

### Modularization (W7's systemic theme)
V3's cross-cluster flag #1: AHW-108/109 + the parked AHW-024/025/091 are all "fail-closed reject arms + anti-malleability asserted by membership-fuzz or a code-read, not input→SW / output-magnitude tests." Structure the new tests as **one `device-fail-closed.test.ts` suite** (reject-arms + low-S + verify) rather than scattered files, so the "prove the boundary" intent is one place. Import `SW` from `apdu.ts` (NOT hand-copied constants — AHW-127/V3-13: `wire-negative.test.ts` hand-copies SWs; while here, fix that too — one-line import — since W7 is the test pass).

---

## Security & Adversarial Considerations  (MANDATORY)

Threat model: a **malicious/compromised host** (browser dApp, exec, or MITM on the local USB/WebHID bus) is the primary adversary; a **physical fault/glitch attacker** is secondary (SE-resistance is platform, but app-level snapshot/dual-derive narrows it); a **supply-chain attacker** who can land a `.gen.*`/manifest edit or retarget a CI action is tertiary. The device screen is the trust anchor (real HW).

**Per-item adversarial review (the harsh take):**

- **W4 (new INS) — biggest attack-surface addition, but the safest kind.** It signs nothing, exposes no secret, returns a public address. No replay-into-signing surface. The genuine residual is **"trust relocation, not elimination"**: the device attests the address, but the user must still *look at the device* and the host code must *fail closed on mismatch*. My plan adds the fail-closed `===` assert at onboard (closes the programmatic hole) and documents the social residual (user ignores device — universal HW assumption). Attacker targets: (a) **wire confusion** with BEGIN_DEPLOY — mitigated by distinct INS + L2-reset + no shared session state; (b) **non-canonical path/curve to get a different address attested** — mitigated by reusing the deploy gates (fail-closed); (c) **version/downgrade** — mitigated by the v4 bump + caps bit (no fallback). What we're trusting we shouldn't: nothing new cryptographically; we ARE trusting that the host's `===` assert isn't bypassed — so AHW-104-style override seams MUST be locked (W3) for W4 to be sound (note the W3↔W4 dependency: W4's onboard assert lives in `aztec-ledger-session.ts`, which W3 is hardening).

- **W2 — single-source can still be subverted at the BUILD layer.** After single-sourcing, the host can't diverge at *runtime*, but a poisoned **checked-in `.gen.c`** (without regenerating) still ships unless the firmware build gates on gen-drift — which scope.md DEFERS to the CI pass. So W2 closes the runtime/display gap but the supply-chain gap (V2-01/F-K6-2) is a **documented residual** until CI gates the build. Attacker target: the codegen artifact + the mutable `node_modules` it reads (AHW-035, separate). Rendering the FPC helps *detect* a swap across deploys but is weak as a standalone control (no canonical FPC to compare against) — honest framing required in W6 copy.

- **W1 — snapshot must SIGN-from-snapshot, not just compare.** The compare-back is a fault-detector; the guarantee is signing the immutable copy. The union (`pk_info`/`sign_info`) clobber is neutralized by independent snapshot storage + the live request token (which fails the interleave closed regardless of NBGL input-blocking). Residual: a fault on the snapshot itself between capture and sign (PLATFORM, AHW-128). The reveal `#N` (AHW-112) shares the display-skew class — fold it in (recommended) or document.

- **Crypto:** no new primitives anywhere. W4 reuses Aztec domain-separated derivation; W7 uses `@noble/curves` (already a dep, version-pinned via `bun.lock` + 7-day min-age) for verify. W5 uses `explicit_bzero` (best-effort; the rigorous frame-wipe is platform). No hand-rolled crypto. **Domain separation:** W4 adds no preimage; the new INS is separated by INS byte + manifest version, not by a new hash domain (correct — it doesn't hash anything new).

- **Least privilege / supply chain:** W3 *reduces* the published attack surface (raw signer + cache-reread off the root barrel) — a direct least-privilege win. Keep `bun install --frozen-lockfile` + the 7-day min-age in CI (don't introduce new deps; `@noble/curves` is already present). The W4 INS adds a capability bit but no new host privilege. No new GitHub Actions, no new tokens.

- **Input validation at trust boundaries:** W4's new handler reuses the strict parse/canonical gates (path, curve, salt, manifest version, trailing-bytes reject). W7's reject-arm tests *prove* the APPEND_CALL boundary fails closed per arm.

- **What an external auditor must be handed as residuals:** (1) W2 supply-chain gate deferred to CI; (2) W4 social residual (user-must-look) + the stronger "device-address-only UI" follow-up; (3) W1/W4 single-glitch-on-SE-RAM (PLATFORM); (4) W5 best-effort scrub (no frame-wipe); (5) reveal `#N` (AHW-112) if not folded; (6) AHW-104 defanged-not-fixed.

---

## Risks & open questions

1. **W4 wire bump fork (BIGGEST):** v4 hard-cut + `CAPS_ATTEST_ADDRESS` bit (my recommendation, explicit contract) vs new-INS-only (lighter). Forces a host↔device coordination either way. **Decide before P4.**
2. **W4 stronger alternative:** should the frontend eventually render ONLY the device-attested address (no host value to compare)? Out of scope (frontend), but it's the real fix for the social residual — log as follow-up.
3. **Reveal `#N` (AHW-112):** fold into W1b (~10 LOC, helper exists) or leave as documented residual? scope.md doesn't list it. **Owner call.**
4. **W2 helps the user?** Marginal without a canonical FPC. Confirm the owner accepts "display==signed + detect-change-across-deploys" as the v0 value, with honest copy.
5. **W3 version bump:** removing `LedgerProvider`/cache fns from the root barrel is a breaking API change — confirm the package is pre-1.0 / consumers are in-repo only (grep says yes today) so a minor bump suffices.
6. **W5 proof:** accept "parity-regression + code-review" (can't assert residue-absence from Speculos)? This matches AHW-068's accepted posture.
7. **Test surface:** confirm bun:test-over-Speculos (not Python/ragger) is the intended "firmware via Speculos" reading. The recent test corpus is bun:test; I planned on that.
8. **Speculos APDU-interleave testability (W1):** the token-defense test assumes Speculos lets a second APDU arrive while a review is on-screen. If the harness serializes APDUs, the interleave test becomes a Python/ragger or a host-unit test of the token logic — fallback noted.

---

## Modularization summary (the systemic fixes, as shared helpers)

- **`l4/review_snapshot.{h,c}`** — immutable reviewed-tuple capture + compare-back + live request token. Consumers: W1a (blind-sign, sign-from-snapshot), W1b (deploy display), W2a (fee-target pairs), W4 (address review), optionally reveal `#N`. **This is the "never re-read globals at the deferred sink" pattern (spirit of AHW-085).**
- **Single-source sponsor** — `manifest.json` → cross-checked `deploy_profiles.generated.ts` (one host source) → both device `.gen.c` and host `SponsoredFeePaymentMethod`. No second literal can drift.
- **`src/unsafe.ts` + `./unsafe` subpath** — the public-API quarantine for the raw signer (W3).
- **`device-fail-closed.test.ts`** — one suite for reject-arms + low-S + secp.verify (W7), importing `SW` from `apdu.ts` (kills the AHW-127 hand-copy too).
- **Deploy derivation chain reuse** — W4's `GET_AZTEC_ADDRESS` adds ZERO new crypto: `account_binding_deploy_pubkey_xy` + `account_binding_deploy_partial` + `az_account_derive_from_path`.

## Validation gate (every phase, before commit)
`bun run lint:all && bun test` (host) + the P0 `c2-speculos.sh` loop for any firmware-touching phase. Local gate before push: full `bun test` + `bun run lint:actions`. Per-phase `lessons/phase-N.md`; after 3 failures on one step, stop and reassess (codex consult).
