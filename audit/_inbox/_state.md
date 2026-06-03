# Catalog Campaign C2 — orchestrator state (source of truth across cron/agent wakes)

Loop driver: cron **e3e7b737** (`*/30`). Started **2026-06-02T15:38-0300**. Backstop +4h = **2026-06-02T19:38-0300**.

**STOP when ANY:** (1) NEW Crit+HIGH this campaign **>= 50**; (2) diminishing returns (a full wave yields 0 surviving new HIGH/CRIT and is mostly dupes/INFO); (3) now >= backstop (19:38).
**On STOP:** `CronDelete e3e7b737` + PushNotification (one-line outcome) + write a C2 summary block into `audit/index.md`.

**Scope:** FIRMWARE (`ledger-app/src`) + aztec.js WIRE (`packages/adapter-ledger/src`, `packages/core/src`). **NOT** frontend (`apps/*`).
**Numbering:** existing register = AHW-001..083 (ALL triaged/fixed). NEW findings start **AHW-084**. Dedup against the 83 before indexing.
**Highest-value target:** the 31 remediation commits just merged (`settings.{c,h}` NVM blind-sign toggle, `path_canonical.{c,h}`, wire-v3 in `begin_authwit.c`/`finalize_and_sign.c`/`l4/account_binding.c`/`wire.h`, the `clear-signing-entrypoint.ts` rewrite, `secret-cache.ts` memory-only) — newer than the prior campaign, never independently red-teamed.
**Tagging:** `OURS` vs `LEDGER-PLATFORM` (BOLOS SDK / nbgl / OS / device-hardware design we cannot modify) vs `MIXED`.

## Tally (NEW this campaign only)
- new_med: 3 | new_low: 7 | new_info: 1  (wave 1 indexed) | new_crit: 0 | new_high: 0
- **crit+high: 0 / 50**
- indexed_through: **AHW-094** (wave 1: AHW-084..094 = 11 added + 2 folds →AHW-070/010; index header bumped 83→94)
- waves complete: 1 | NOT at diminishing returns (11 accepted / 0 rejected). Continuing to wave 2.

## Finding schema (every agent + the validator use this)
```
### F-<AGENT>-<n>: <concise title>
- Severity: CRITICAL|HIGH|MED|LOW|INFO — <1-line justification>
- Owned: OURS | LEDGER-PLATFORM | MIXED — <if LEDGER/MIXED, name the SDK/OS/nbgl/hw element>
- Category: FW-STATEMACHINE | FW-CRYPTO | FW-UI | WIRE | DESIGN | BUILD | TEST | MODULARITY
- Location: <path:line(s)>
- What: <the defect, concretely>
- Attack/impact: <red-team scenario (actor, vector, gain) — or maintainability impact for quality findings>
- Evidence: <code excerpt / precise reasoning; cite what you actually read>
- Fix sketch: <1-2 lines for the later deep-plan>
- Confidence: high | med | low
- Dedup-check: <nearest existing AHW-### + why distinct, or "novel">
```

## Wave log
### Wave 1 — launched 2026-06-02 15:38
- **A** (codex 5.5 xhigh, read-only): FW state-machine / APDU parsing / authwit+deploy binding. bg=`by6owxyh6`, prompt=`/tmp/codex-c2a-fw-statemachine-20260602-1538.md`. Harvest RESPONSE_FILE -> `_inbox/A-codex-fw-statemachine.md`. STATUS: **DONE** (codex session 019e89a3; raw 0C/0H/1M/2L. F-A-1 MED = FINALIZE re-hashes cached `call->args_hash`, never recomputes from stored raw args → advertised "M5.2 three-pass re-derivation from raw args" (session.h) is re-hashing cached state; APPEND→FINALIZE fault uncaught — comment-truth + hardening gap, high-conf, vs AHW-025; F-A-2 LOW = `account_binding_deploy_partial` defaults unknown schema→ECDSA, MODULARITY; F-A-3 LOW = binding/finalize tail `__builtin_trap`s out of fuzz/replay oracle, TEST). Strong negatives: can't sign host claim, B3 holds, no deploy↔authwit replay, reset discipline solid. PENDING validation.
- **B** (opus general-purpose): FW crypto + UI render-vs-sign + NVM/settings/blind-sign + reveal + path_canonical. agentId=`a9604117d9e5009b0` -> `_inbox/B-opus-fw-crypto-ui.md`. STATUS: **DONE** (raw 0C/0H/1M/2L; F-B-1 MED = STATIC/HIDE_MSG_SENDER flags rendered only in TRANSFER arm, not MINT/DRIP/SPONSOR — render-vs-sign, AHW-040 class; F-B-2 LOW = 4th canonical-path copy in reveal handler vs AHW-070; F-B-3 LOW = reveal UI docstring claims full path, shows "Account #N"). All 4 device guarantees HOLD; cmov barrier verified. PENDING validation.
- **C** (opus general-purpose): WIRE host (adapter-ledger/src + core/src): policy guard completeness, wire-v3 host threading, secret-cache, type-safety at the boundary. agentId=`a70b24c585bd3e5a8` -> `_inbox/C-opus-wire-host.md`. STATUS: **DONE** (raw 0C/0H/1M/5L/1INFO; 6 OURS + 1 MIXED. F-C-2 MED = 4 poseidon2 domain separators hardcoded in l4-manifest.ts:37-40 vs @aztec/constants, no equality assert → silent host↔device desync on SDK bump (fail-closed SW_HASH_MISMATCH); F-C-3 LOW = live adapter never secp.verify's device sig (AHW-075 principle but that was scoped to the DELETED trezor pkg → novel for live adapter); F-C-1/4/5/6 LOW, F-C-7 INFO). assertClearSignPolicy COMPLETE — no new unsigned-field gap; only gasSettings(=AHW-062)+feePayer residual. secret-cache memory-only confirmed; salt/profileId 32-BE correct, overflow throws. PENDING validation.
- Validator: opus reads `_inbox/*` + `index.md`, validates + dedups -> `_inbox/validated-wave1.md`. agentId=`a2552da0d2b5bf149`. STATUS: **running** (launched 15:52). Orchestrator then appends ACCEPTED to `index.md` as AHW-084+, updates tally, and decides wave 2 vs stop.

### Wave 1 raw totals (pre-validation): 0 CRIT · 0 HIGH · 3 MED · 9 LOW · 1 INFO = 13 candidates. Crit+HIGH contribution = 0.
### Wave 1 INDEXED: 11 accepted (0C/0H/3M/7L/1I) AHW-084..094 + 2 folds. Register 83→94. Raw in `_raw/c2/`.

### Wave 2 — launching ~16:04 (rotate scope, diverse; dedup vs AHW-001..094)
- **D** (codex 5.5 xhigh, read-only): DEPLOY path security — `begin_deploy_account.c` / `finalize_deploy_and_sign.c` / `deploy_address.c` / `deploy_outer_hash.c` / `aztec_secret.c` + deploy side of `account_binding.c`. Address+public_keys_hash derivation, BEGIN-vs-FINALIZE 2-site re-verify, salt/profile in address derivation, self-funding fee. prompt=`/tmp/codex-c2d-deploy-20260602-1600.md`. -> `_inbox/D-codex-deploy.md`
- **E** (opus): FW MEMORY-SAFETY + APDU lifecycle — `apdu/dispatcher.c` / `app_main.c` / `G_io_apdu_buffer` reuse / every parse-fn bound / integer+length handling / `cxmath_spike.c` reachability / `clear_signing_v0/format.c` adversarial input. -> `_inbox/E-opus-fw-memsafety.md`
- **F** (opus): MODULARITY + TEST-COVERAGE holistic (the explicit "how modularized + well-tested are we" ask) across `ledger-app/` + `packages/adapter-ledger`. Monoliths, duplication, untested security paths, happy-path-only suites. -> `_inbox/F-opus-modularity-tests.md`
- LAUNCHED 16:04: D bg=`b6j1uwbb1`, E agentId=`a8b6a53f034c21cb2`, F agentId=`ad4b37547454634e6`.
- **D DONE** (16:09, codex session 019e89b9): 2 findings, 0C/0H. F-D-1 MED = post-review TOCTOU in deploy FINALIZE — review snapshots Account/Address from `G_l4_deploy_session`, approval path re-reads MUTABLE session fields instead of the fresh derived locals → a glitch after the review screen signs a different address than approved (distinct from AHW-085: deploy identity TOCTOU vs authwit args_hash); F-D-2 LOW = deploy `fee_mode` is dead metadata, `Sponsored (testnet)` hardcoded not enforced → won't fail-closed if a future profile differs (distinct from AHW-062, protocol-level). Strong negatives: BEGIN sovereignty double-derive holds, curve/profile pairing holds, no blind-sign hole, deploy_address math clean. -> `_inbox/D-codex-deploy.md`.
- **E DONE** (16:09, opus): **firmware in scope is MEMORY-SAFE — the strong negative is the headline** (0 corruption bugs across dispatcher/app_main/5 parse fns/cxmath_spike/format.c; counts capped before indexing, parsers bounded by recv_len + trailing-byte reject, no VLA/alloca/recursion). 3 findings, 0C/0H: F-E-1 LOW MIXED = `make_buf` trusts `cmd->lc` as body size → over-read defense delegated wholesale to unpinned BOLOS `apdu_parser` (un-asserted SPOF); F-E-2 LOW OURS = `cxmath_spike` case skips `l4_session_reset` (only INS that does) + uncapped ≤65535 field-mul loop, no release-build guard (net-new vs AHW-021); F-E-3 INFO = `fr_as_u32_or_hex` `unsigned` shift. -> `_inbox/E-opus-fw-memsafety.md`. PENDING validation.
- **F DONE** (16:08, opus): 6 findings (2 MED / 4 LOW), all OURS. F-F-1 MED = `append_call` strict-allowlist reject arms (0x6F09/0A/0B/0C incl delegated-spend gate) have NO targeted negative test (fuzzer only checks SW∈known-set → an accept-regression to 0x9000 ships green); F-F-2 MED = device low-S anti-malleability + `SW_DUP_SIG_MISMATCH`(0x6F06) asserted by NO test (the "malleability enforced" confirmed-clean rests on a code read); F-F-3..6 LOW (UI-renderer monolith, dup `ct_memcmp32`/`low_s_normalize` primitives, hand-copied SW consts, entrypoint branch-select untested). Flagged possible E/F overlap on append_call. -> `_inbox/F-opus-modularity-tests.md`. PENDING validation.
- **G ADDED (codex 5.5 xhigh) — CRYPTO/SIGNING SECURITY** (user flagged codex-on-safety as VERY important; rebalancing): malleability/low-S, nonce/RNG, key zeroization, fault + side-channel on the ACTUAL sign paths (`sign_outer_hash`/`finalize_and_sign`/`finalize_deploy_and_sign`/`schnorr.c`/`aztec_secret.c`). Directly probes F-F-2's untested low-S enforcement. prompt=`/tmp/codex-c2g-crypto-signing-20260602-1610.md`. bg=`ba6wazewd`. STATUS: running (launched 16:10). -> harvest to `_inbox/G-codex-crypto-signing.md`.
- **RATIO POLICY (updated):** codex now LEADS security red-teaming (was 1 codex:2 opus/wave). Print codex session id in every status. Validate D+E+F+G together -> `_inbox/validated-wave2.md`. Then index AHW-095+.

### Wave 3 — launched ~16:15 (overlaps G; idle-slot fill on user re-issue; codex-led)
- NOTE: cron e3e7b737 already scheduled — a re-issued prompt = CONTINUE, NOT a second schedule. Do not CronCreate again.
- **H** (codex xhigh): wire-protocol fidelity + codegen/manifest PROVENANCE (host `l4-manifest.ts` ↔ device `wire.h`/parse; `deploy_profiles.gen.h` + token codegen display-vs-sign). prompt=`/tmp/codex-c2h-wire-codegen-20260602-1615.md`. bg=`b4lw9a8n5`. -> harvest `_inbox/H-codex-wire-codegen.md`. STATUS: running (launched 16:15).
- **J** (opus): onboarding + attestation + sovereignty trust-chain (can a host present a host-chosen address as device-verified? replay? cache poisoning?). -> `_inbox/J-opus-onboarding-attestation.md`. STATUS: launched.
- Validation batching: wave-2 (D+E+F+G) validates when G lands; wave-3 (H+J) after. All dedup vs `index.md` AND in-flight findings in this `_state.md`.

## STATUS @ 16:16 — AUTHORITATIVE (supersedes "running" notes above)
### Completed, awaiting validation:
- **D** codex (deploy): 1 MED (F-D-1 deploy-FINALIZE TOCTOU) + 1 LOW. `_inbox/D-codex-deploy.md`
- **E** opus (memsafety): MEMORY-SAFE; 2 LOW + 1 INFO. `_inbox/E-opus-fw-memsafety.md`
- **F** opus (modularity/tests): 2 MED + 4 LOW. `_inbox/F-opus-modularity-tests.md`
- **G** codex (crypto/signing, session FGUBwNMi): **1 HIGH (F-G-1 blind-sign approval re-reads mutable G_context → post-review fault signs different hash/path than reviewed) + 1 MED (F-G-2 Schnorr `pe=priv*e` not scrubbed → key-equivalent residue)**. Strong negatives: low-S enforced, RFC6979 nonce (no RNG), signs only device-local recompute, B3 re-run before sign, canonical Schnorr. `_inbox/G-codex-crypto-signing.md` (harvested)
- **H** codex (wire/codegen, session 019e89c4): **1 HIGH (F-H-1: deploy-profile `sponsor_fpc_address`/`sponsor_selector_u32`/`deployer` are manifest-trusted, hidden behind UI "Sponsored (testnet)", NEVER canonical-verified at codegen/CI/runtime → poisoned build signs a different sponsor call than shown; codegen `crossCheckDeployProfile` checks only class-id/ctor)**. VERY strong negatives: BEGIN_AUTHWIT/APPEND_CALL/BEGIN_DEPLOY wire order + args_hash rules + outer-hash padding all match host↔device EXACTLY; device double-recomputes & overwrites host per-call hashes; deploy finalization device-authored. Distinct from AHW-035/084 + F-D-2. `_inbox/H-codex-wire-codegen.md` (harvested).
- **J** opus (onboarding/attestation): **1 HIGH (F-J-1 onboard/receive address NEVER device-attested → host can present a host-chosen addr as "device-verified"; SEND/DEPLOY binding IS sound) + 1 MED (F-J-2 pubkey fetched approval-free from 2 provider instances w/ no cross-check → selective-MITM identity split) + 1 LOW**. `_inbox/J-opus-onboarding-attestation.md`

### SYSTEMIC (deep-plan as ONE fix): **F-G-1 (blind-sign) + F-D-1 (deploy) + AHW-085 (authwit args) = "approve/finalize re-reads MUTABLE global state instead of an immutable reviewed snapshot → post-review fault signs/binds ≠ what was shown."** 3 sites, same root.

### Raw HIGH/CRIT pending validation: **3 HIGH (F-J-1, F-G-1, F-H-1)** → crit+high ≈ 3/50. TWO systemic themes: (1) post-review mutable-state TOCTOU [F-G-1 blind-sign / F-D-1 deploy / AHW-085 authwit]; (2) host-trusted/unattested field reaches signing or "verified" display [F-J-1 onboard addr / F-H-1 deploy sponsor+deployer / cf AHW-084 domain-sep / AHW-086 flags].

## BURST B1 (one-time, user-requested @ 16:16) — 10 codex xhigh, parallel, distinct angles, each prompted lead-auditor (decompose into sub-reviews). Explicit user override of the 3-cap.
- K1 fault-injection (cross-cutting) bg=`b2lb3ogig`
- K2 side-channel (timing/power/EM) bg=`byq3hbygn`
- K3 APDU state-machine exhaustive sequencing bg=`bf151bd93`
- K4 crypto-correctness vs Aztec spec bg=`bggtfjcx1`
- K5 dual-scheme (K1 vs Schnorr) confusion bg=`b2v0jgag7`
- K6 build/supply-chain/reproducibility bg=`b37kvpheq`
- K7 consumer-API-misuse (adversarial dApp) bg=`bfw0dppp4`
- K8 privacy/metadata leakage bg=`b9167erd1`
- K9 fail-open status-word taxonomy bg=`bums1yavw`
- K10 recovery/custody/derivation bg=`bicz1b8vx`
Harvest each codex RESPONSE_FILE -> `_inbox/K{n}-<slug>.md` on completion. Then validate ALL pending (D,E,F,G,H,J + K1..K10) in BATCHED validators (≤3 concurrent). Index AHW-095+.

## LOOP TRIGGER STOPPED @ 16:44 — `CronDelete e3e7b737` done (no more heartbeats). Validation (V1/V2/V3) still in flight (background, not cron-driven) — will finish → consolidate → index → final report. This is the "stop the loop" action; pending work completes in-session.

## STOP DIRECTIVE (user, 16:34)
After ALL 10 burst + pending land → validate full set → index AHW-095+ → write C2 final summary into `index.md` → **`CronDelete e3e7b737`** to stop the loop. **NO new waves/agents.** User is present → NO PushNotification on stop.

### Burst harvest log (severities pre-validation):
- **K2** side-channel: 3 sub-HIGH (F-K2-1 branchy low-S leaks `s`; F-K2-2 short-circuit predicates on secret limbs; F-K2-3 dup-sig memcmp not CT) — dedup carefully vs AHW-029(PLATFORM)/AHW-068/AHW-019. `_inbox/K2-side-channel.md`
- **K5** scheme-confusion: **CLEAN NEGATIVE** (0 new; dual-scheme binding sound — folds to AHW-018/092). `_inbox/K5-scheme-confusion.md`
- **K8** privacy/metadata: 4 (MED F-K8-1 APPEND_CALL exposes verb/recipient/token/amount to passive USB observer pre-approval; MED F-K8-2 "Forget" leaves revealed root in embedded-wallet DB; MED F-K8-3 onboarding leaks addr to RPC operator; LOW F-K8-4 BEGIN sends device-derivable identity) — dedup vs AHW-082/048/038/080/079. `_inbox/K8-privacy-metadata.md`
- **K9** fail-open: 4 (MED F-K9-1 SW_HASH_MISMATCH conflates host-mismatch/malformed/recompute-fault; MED F-K9-2 SW_DUP_SIG_MISMATCH also covers reveal dual-derive fault; LOW F-K9-3 GET_PUBLIC_KEY leaks raw SDK err; LOW F-K9-4 verified-calls fails open on unrenderable call, cf AHW-086) — `_inbox/K9-failopen-taxonomy.md`
- **K1** fault-injection: 5 HIGH + 1 MED — F-K1-1 (reject→accept on one skipped branch), F-K1-2 (blind-sign post-review = **MERGES F-G-1/F-K3-1**), F-K1-3 (blind-sign-OFF single-site gate), F-K1-4 (authwit canonical-path single-site), F-K1-5 (reveal canonical-path single-site), F-K1-6 MED (double-compute collapse). NEEDS heavy consolidation + OURS-vs-PLATFORM (SE/BOLOS glitch-resistance) calibration. `_inbox/K1-fault-injection.md`
- **K3** apdu-statemachine: 1 HIGH (F-K3-1 blind-sign APDU-clobber = MERGES F-G-1/F-K1-2). `_inbox/K3-apdu-statemachine.md`
- **K4** crypto-correctness: **CLEAN NEGATIVE** (no novel; poseidon2/pedersen/blake2s/grumpkin + hash construction match Aztec canonical). `_inbox/K4-crypto-correctness.md`
- **K6** build-supplychain: 3 HIGH (F-K6-1 mutable GH-action refs in fw gate; F-K6-2 workflow compiles unchecked `*.gen.*` = maybe MERGES F-H-1; F-K6-3 CI self-blesses the ELF, no reproducible rebuild) + 1 MED (F-K6-4 SDK identity unrecorded). `_inbox/K6-build-supplychain.md`
- **K7** consumer-api: 2 HIGH (F-K7-1 root-exported `signOuterHash` blind-sign oracle; F-K7-2 root-exported reveal + no-prompt reread) + 1 MED (F-K7-3 override seams). `_inbox/K7-consumer-api-misuse.md`
- **K10** recovery-custody: 1 HIGH (F-K10-1 single-seed impl vs spec's 2-of-2 claim — CALIBRATE, likely MED) + 1 MED (F-K10-2 onboarding indices 0-4 only). `_inbox/K10-recovery-custody.md`

## ALL 10 BURST IN @ 16:36. Raw HIGH candidates ≈15 (F-J-1,F-G-1,F-H-1,F-K1-1..5,F-K3-1,F-K6-1/2/3,F-K7-1/2,F-K10-1) — EXPECT heavy consolidation (blind-sign triple→1; K1 fault cluster→1-2 systemic w/ PLATFORM split; F-H-1↔F-K6-2; supply-chain dedup vs AHW-034/035; K7 vs AHW-002; K10-1→maybe MED). 2 clean negatives (K4,K5).

## VALIDATION LAUNCHED @ 16:36 — 3 opus validators (theme-split, disjoint files, ≤3 concurrent). Assign LOCAL refs; ORCHESTRATOR assigns global AHW-095+ at consolidation.
- **V1** (`a5578db8`): fault/signing/state — D,G,K1,K3,K9 -> `validated-V1.md`. **DONE: 1 HIGH (V1-01 blind-sign signs unsnapshotted G_context — absorbs F-G-1/F-K1-2/F-K3-1) + 7 LOW + 1 INFO.** KILLED inflation: F-K1-1→INFO/PLATFORM (universal BOLOS one-branch confirm), F-K1-4→LOW (FALSE; B3 re-binds path→consumer at sign), F-K1-5→LOW (backwards; secret frozen under validated path), F-K9-1/2→LOW (fail-closed observability). F-D-1 + AHW-085 = MED siblings, NOT HIGH (deploy/authwit FINALIZE sign FRESH local recompute). Flag: V1-01 Vector-B (APDU-interleave) likely defeated by NBGL input-blocking → HIGH rests on the fault vector. Flag for memsafety: `types.h:80-83` pk_info/sign_info union overlap.
- **V2** (`af9186f1`): supply-chain/API/attestation/custody — H,J,K6,K7,K10 -> `validated-V2.md`. **DONE: 3 HIGH + 6 MED + 1 LOW (0 rejected — all real).** HIGH: V2-01 (F-H-1⊕F-K6-2 merged: unverified codegen→signed deploy-profile sponsor/deployer + gen tables; distinct from AHW-035), V2-05 (F-K7-1 root-exported `signOuterHash` blind-sign oracle; distinct from now-CLOSED AHW-002), V2-08 (F-J-1 onboard addr never device-attested). DOWNGRADES: F-K6-1→MED (CI hygiene, images digest-pinned, PARKED-class), F-K7-2→MED (same-origin/in-process), F-K10-1→MED (doc↔impl; runtime consequence=AHW-047, no double-count). FOLD F-K6-4→build-provenance MED. Flag: V2-05+V2-07 together = full clear-sign bypass; reinforces systemic "unattested host field → signed/verified" theme.

### Running validated HIGH total: 4 (V1-01; V2-01; V2-05; V2-08). V3 pending (expect MED/LOW + 2 negatives, ~0 HIGH).
- **V3** (`a8be7122`): memsafety/quality/sidechannel/privacy + negatives — E,F,K2,K4,K5,K8 -> `validated-V3.md`
NEXT after all 3 land: consolidate → index AHW-095+ → C2 final summary in index.md → **CronDelete e3e7b737 (STOP)**.

## ✅ C2 COMPLETE @ 16:48 — VALIDATED, INDEXED, LOOP STOPPED
- V1: 1 HIGH + 7 LOW + 1 INFO. V2: 3 HIGH + 7 MED + 1 LOW. V3: 2 MED + 7 LOW + 1 INFO + 3 negatives. + theme-split leftovers F-D-1 MED, F-G-2 MED, F-D-2 LOW.
- **Indexed AHW-095..129 (35 new): 4 HIGH · 11 MED · 18 LOW · 2 INFO. Register 94 → 129.** 4 folds (AHW-029/021/025/093). 3 negatives → Confirmed-clean (memory-safe, crypto-correctness, dual-scheme).
- 4 HIGH: AHW-095 (blind-sign unsnapshotted) · AHW-096 (codegen→signed deploy-profile) · AHW-097 (root signOuterHash oracle) · AHW-098 (onboard addr not attested).
- cron `e3e7b737` DELETED (CronList empty). Raw transcripts in `audit/_raw/c2/`. **Loop fully stopped per owner.** Next when owner ready: deep-plan the 4 HIGH + 6 systemic themes.
