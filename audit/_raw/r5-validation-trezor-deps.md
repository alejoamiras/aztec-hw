# R5 validation — adapter-trezor + dependency-CVE reachability + core

Validator role: skeptic. Each candidate verified against real code + `bun audit` + `bun.lock`,
then dedup'd vs AHW-001..063. Verdicts: VALID-NEW / FOLD / DUP / REJECT.

## Verdict table

| Cand | Claim (1-line) | Verified? | Verdict | Final sev/cat/owned |
|------|----------------|-----------|---------|---------------------|
| R5-01 | 2/6 swallowed HIGHs (undici WS) code-dead FP; 4 (systeminformation) real but node-only; browser bundle 0 HIGH; host-metrics pins systeminformation 5.23.8 exactly | YES (reproduced `bun audit`: 12 vulns/6 HIGH; undici 5.29.0 permessage-deflate disabled; foundation imports only `Agent`; bun.lock:481 exact pin) | **FOLD → AHW-033** (preserve full per-CVE verdict as the reachability sub-table) | MED · BUILD · OURS |
| R5-02 | trezor `createAuthWitFromIntent` signs a NON-canonical digest (root: core `computeOuterHashForIntent`); Ledger uses canonical encoder + parity test; trezor has neither | YES (core flattens raw, drops is_public/hide_msg/is_static/tx_nonce/padding/separator; Ledger uses `EncodedAppEntrypointCalls.create`+parity test l4-manifest-parity.test.ts:62) | **VALID-NEW** (distinct from AHW-036 visual-spoof) | MED · DESIGN · OURS |
| R5-03 | trezor `createAuthWitFromIntent` (AHW-036 spoof method) has zero direct unit test | YES (provider.test.ts 126 LOC: only getPublicKeyXY + createAuthWit) | **VALID-NEW** (parallels AHW-004 but distinct package/method) | LOW · TEST · OURS |
| R5-04 | trezor adapter never verifies device sig vs cached pubkey | YES (signAndWrap packs r,s; no `verify` anywhere in adapter-trezor) | **VALID-NEW** | LOW · HOST · OURS |
| R5-05 | subprocess bridge correlates req↔resp by FIFO position only; one stray line desyncs all | YES (pendingResolvers.shift(); comment ":190 unsolicited line — drop silently for now") | **VALID-NEW** | LOW · HOST · OURS |
| R5-06 | `getPublicKeyXY` does a real on-device sign over 32 zero bytes to read pubkey (sign-to-read oracle) | YES (probeDigest = 32 zero bytes; signature discarded; provider.ts:66-79) | **VALID-NEW** (narrow; reframed — see detail) | LOW · DESIGN · OURS |
| R5-07 | whole adapter-trezor package is dead weight (only `apps/demo` consumes it); presented as a peer of shipping Ledger adapter; demo's trezor path runs the broken-hash code while its ledger path is dead | YES (demo-browser is Ledger-only; adapter-trezor consumed only by apps/demo; demo provider typed IntentAuthWitnessProvider, trezor's createAuthWitFromIntent compiles) | **VALID-NEW** (meta-finding; distinct from AHW-028/031/036) | INFO · BUILD · OURS |
| R5-08 | core `formatAmount` host-supplied `decimals` mis-scale (AHW-051 class) + unbounded `10^decimals` work | PARTIAL — mis-scale is the SAME class as AHW-051 but on a DIFFERENT code path; the unbounded-`10^decimals` DoS sub-point is net-new | **FOLD → AHW-051** (carry the unbounded-`10^decimals` clamp as an added sub-point) | (AHW-051 stays MED) |

**Counts: VALID-NEW 5 · FOLD 2 (R5-01→033, R5-08→051) · DUP 0 · REJECT 0.**
By severity of the 5 VALID-NEW: 1 MED (R5-02), 3 LOW (R5-03/04/05/06 minus the one folded — see below), 1 INFO (R5-07).
Correction: VALID-NEW = R5-02 (MED), R5-03 (LOW), R5-04 (LOW), R5-05 (LOW), R5-06 (LOW), R5-07 (INFO) = **6 VALID-NEW**. R5-01 and R5-08 fold. (1 MED, 4 LOW, 1 INFO.)

---

## Tightened detail — VALID-NEW

### AHW-NEW-R5-02 · MED · DESIGN · OURS — Trezor signs a non-canonical Aztec digest (no parity test)
`TrezorEcdsaKAuthWitnessProvider.createAuthWitFromIntent` (provider.ts:99-104) → core
`computeOuterHashForIntent` (intent-utils.ts:38-53), which flattens each call as raw
`[address, selector, ...args]` and does `computeOuterAuthWitHash(consumer, chainId, version,
computeInnerAuthWitHash(flat))`. This does NOT match Aztec's canonical per-call SIX-field
`EncodedAppEntrypointCalls` layout `[args_hash, selector, target, is_public, hide_msg_sender,
is_static]` + tx_nonce + pad-to-5 + `SIGNATURE_PAYLOAD` separator. Divergence on every axis:
args un-hashed, `is_public`/`hideMsgSender`/`isStatic` ignored (the CallIntent CARRIES them at
intent.ts:48-52), tx_nonce absent, no padding, wrong separator. Core's own docstring concedes it
(intent-utils.ts:30-37: "DIFFERS from EncodedAppEntrypointCalls.hash() … Closing that gap is a
Phase-B-final step"). **Ledger closed it** (clear-signing-entrypoint.ts:156-157 uses
`EncodedAppEntrypointCalls.create(exec.calls, nonce).hash()`) **AND has a parity test**
(l4-manifest-parity.test.ts:62 asserts device == `EncodedAppEntrypointCalls.create`). **Trezor
never did, and has no parity test** — intent-utils.test.ts:75-109 only checks determinism /
arg-sensitivity / padding-invariance of the broken fn against ITSELF, so the wrongness is invisible
to CI. Distinct from AHW-036 (which is "device doesn't verify the visual → host can spoof the
shown text"); THIS is "the digest itself is structurally wrong even if the visual is honest."
**Impact:** wiring Trezor into a real send (which the package's own Phase-B story invites) signs a
64-byte ECDSA over a digest the on-chain `EcdsaKAccount` verifier never recomputes → authwits
rejected (functional DoS); and the signed structure has no is_public/nonce binding (latent
replay/cross-context risk if a future path loosens validation). `isIntentAuthWitnessProvider`
(core provider.ts:35-41) returns true for this provider, so capability-detection routes callers
INTO the broken path — closed by the same fix.
**Fix:** make trezor use the canonical `EncodedAppEntrypointCalls` path (share the Ledger encoder),
OR delete `createAuthWitFromIntent` from trezor + `computeOuterHashForIntent` from core (no correct
consumer remains), OR — minimum — add a parity test mirroring l4-manifest-parity.test.ts so the
divergence is red CI, and rename the method to flag it demo-only.
**Caveat (see R5-07):** the package is dead weight; this is "a real bug in a package recommended
for deletion." Catalog individually (the broken hash also LIVES in core, a shared lib, where it
outlives any trezor-package deletion).

### AHW-NEW-R5-03 · LOW · TEST · OURS — Trezor's `createAuthWitFromIntent` (the AHW-036 spoof method) is untested
provider.test.ts (126 LOC) exercises only `getPublicKeyXY` + `createAuthWit` (blind). No test
constructs a CallIntent and calls `createAuthWitFromIntent` — its visual build
(`buildIntentVisual`→`formatIntentForDevice`, provider.ts:135-137), hash derivation, and
AuthWitness assembly off the intent path are unexercised at the provider level. Parallels AHW-004
(Ledger seam untested) but for the trezor adapter's spoof method, hence a separate TEST entry.
**Fix:** one test asserting the visual contains the intent labels + (once R5-02 fixed) the
AuthWitness requestHash equals the canonical outer hash.

### AHW-NEW-R5-04 · LOW · HOST · OURS — Trezor host never verifies the device signature vs the cached pubkey
`signAndWrap` (provider.ts:110-128) takes transport `(r,s)`, low-s-normalises, packs to 64 bytes,
wraps in AuthWitness — with NO ECDSA verify against `challengeHidden` + `cachedXY`. Grep confirms
zero `verify` in adapter-trezor. A flaky bridge, the FIFO desync (R5-05), or a malicious transport
can hand back a structurally-valid-but-wrong 64-byte sig and the adapter emits it as an
authorization. `@noble/secp256k1` (already a dep) has `verify`; cached pubkey is in hand.
**Fix:** `secp.verify(sig, challengeHidden, compressed)` before returning; throw on mismatch.
Cheap host-side defense-in-depth.

### AHW-NEW-R5-05 · LOW · HOST · OURS — Subprocess bridge matches req↔resp by FIFO position only
`TrezorlibSubprocessTransport` (trezorlib-subprocess-transport.ts:182-192) matches each stdout line
to `pendingResolvers.shift()` by arrival order, no request id; comment at :190 concedes
"unsolicited line — log? drop silently for now." Any out-of-band bridge line (warning, partial
write, debug print) desyncs every subsequent call onto the next request's resolver — a
`sign_identity` could resolve with another call's JSON, and with no verify (R5-04) a mismatched
sig/pubkey is wrapped silently. Emulator-only today but this is the "real device" transport the
package advertises for Phase B+.
**Fix:** monotonic request id echoed by the bridge, match on it; error/drop unmatched lines loudly
rather than letting them shift the queue.

### AHW-NEW-R5-06 · LOW · DESIGN · OURS — `getPublicKeyXY` does a real on-device sign over 32 zero bytes to read the pubkey (sign-to-read)
`getPublicKeyXY` (provider.ts:66-79): no get-pubkey API in the SLIP-0013 namespace, so it issues a
`signIdentity` with `challengeHidden` = 32 zero bytes and discards the signature, keeping only
`compressedPublicKey`. On a real Trezor this is a user-approval prompt to produce a genuine ECDSA
signature over a FIXED known digest H=0…0 every time the pubkey is read before any sign — a
fixed-message signature (deterministic per key under RFC-6979, observable on the bridge/wire) and a
UX wart (approving "sign" to learn an address). Narrow: fires only when `getPublicKeyXY()` is
called before any `createAuthWit*`. **Skeptic note:** the documented oracle severity is mild —
RFC-6979 makes it deterministic so it leaks one signature on a constant message, not a nonce-reuse
hazard; and the demo warms the cache via a real sign first. LOW is correct, arguably borderline
INFO. Kept LOW because on real hardware it is a genuine sign-to-read approval that shouldn't exist.
**Fix:** cache pubkey from the first real sign only (require callers to sign once before reading),
or use pure-JS `@trezor/protobuf` `GetPublicKey` when the real-device transport lands, or at
minimum document sign-to-read on the method.

### AHW-NEW-R5-07 · INFO · BUILD · OURS — adapter-trezor is dead weight presented as a peer of the shipping Ledger adapter
Shipping artifact is `apps/demo-browser` — Ledger-only (deps: adapter-ledger + core + aztec.js +
bb-prover; NO adapter-trezor; verified package.json). adapter-trezor is consumed ONLY by `apps/demo`
(the dead CLI; AHW-028/031 establish apps/demo is unbuilt/unrun, only typechecked). So
adapter-trezor's live footprint is: (a) ci.yml:36 typechecks it, (b) `bun test` runs its unit
tests, (c) apps/demo imports it. It is on NO user-facing path. ~few-hundred LOC of crypto-adjacent
adapter (carrying the R5-02 broken-hash + R5-04 no-verify + R5-05 desync issues) is cross-referenced
as an equal of the production Ledger adapter (adapter-ledger/package.json:5
"Mirrors @aztec-hwwallet-poc/adapter-trezor"; index.ts headers cross-reference as peers). **Verified
asymmetry:** apps/demo (index.ts:177) calls `backend.provider.createAuthWitFromIntent(intent)` on a
provider typed `IntentAuthWitnessProvider`; the Ledger seam refactor DELETED Ledger's
`createAuthWitFromIntent` (AHW-028) but Trezor's still exists and compiles — so apps/demo's trezor
path would actually RUN the broken-hash code while its ledger path is dead. Distinct from AHW-036
(a code hole) and AHW-028/031 (apps/demo dead / inverted CI): this is the META-finding that the
whole package shouldn't be in the audit blast radius as an audited-grade peer.
**Fix:** decide explicitly — mark adapter-trezor `"private": true` + add an "EXPERIMENTAL,
Phase-A only, NOT a shipping adapter, blind-sign + non-canonical hash" banner at index.ts top, OR
cut it from CI typecheck/test scope, OR delete it with apps/demo (AHW-028 already recommends
deleting apps/demo).

---

## R5-01 — reachability verdict (FOLD into AHW-033, preserved as a sub-table)

`bun audit` reproduced EXACTLY: **12 vulns, 6 HIGH, 5 moderate, 1 low** (matches AHW-033's count).

| CVE | pkg | range | installed | Verdict |
|-----|-----|-------|-----------|---------|
| GHSA-vrm6-8vpv-qv8q (WS permessage-deflate unbounded mem) | undici | <6.24.0 | 5.29.0 | **DEAD** — 5.29.0 permessage-deflate hard-disabled (`websocket/connection.js:96-97` `const permessageDeflate = ''` / `// TODO: enable once permessage-deflate is supported`); foundation imports only `Agent` (HTTP), never the WS client (verified `@aztec/foundation@4.2.1/dest/json-rpc/client/undici.js:3` `import { Agent } from 'undici'`) |
| GHSA-v9p9-hfj2-hcw8 (WS server_max_window_bits unhandled exc) | undici | <6.24.0 | 5.29.0 | **DEAD** — same disabled WS subsystem + unused-by-foundation |
| GHSA-wphj-fx3q-84ch (`fsSize` Windows cmd-inj) | systeminformation | <5.27.14 | 5.23.8 | **REAL**, node-only |
| GHSA-hvx9-hwr7-wjj9 (`networkInterfaces` Linux cmd-inj) | systeminformation | <=5.31.5 | 5.23.8 | **REAL**, node-only |
| GHSA-5vv4-hvf7-2h46 (`versions`/`locate` cmd-inj) | systeminformation | <=5.30.7 | 5.23.8 | **REAL**, node-only |
| GHSA-9c88-49p5-5ggf (`wifi.js` retry cmd-inj) | systeminformation | <5.30.8 | 5.23.8 | **REAL**, node-only |

Plus (out of HIGH scope, same over-broad-range pattern): undici moderates GHSA-g9mf (Fetch-API
decompression — foundation uses `client.request`, not `fetch`), GHSA-2mjp (smuggling), GHSA-4992
(CRLF); a new `ws` moderate (GHSA-58qx) + `uuid` moderate (GHSA-w5hq) on the aztec.js/pxe path;
`elliptic@6.6.1` LOW (GHSA-848j) via `demo-browser › vite-plugin-node-polyfills` — the only vuln on
the BROWSER bundle path, and it's LOW.

**Reachability of the 4 real systeminformation HIGHs:** systeminformation is `child_process`/`exec`-
based and node-only; pulled solely via `@aztec/telemetry-client → @opentelemetry/host-metrics`
(`bun audit` names the paths `demo-browser › @aztec/bb-prover` and `adapter-ledger › @aztec/pxe`).
Our code never imports telemetry/host-metrics/systeminformation; the cmd-injection sinks fire only
if OTel host-metrics is instantiated (a running node-side PXE/prover with telemetry on) — not
exercised by demo-browser (in-browser PXE, no node telemetry) nor the node CLI demo. So for the
SHIPPED PoC surface they're effectively dev/test-only, BUT they go live the moment anyone stands up
a node-side PXE/prover with telemetry — a plausible production topology, so not a pure wave-off.
**adapter-trezor is clean of all 6 HIGHs** (its only deps are core + `@noble/secp256k1`).

**Bottom line:** the browser bundle carries ZERO of the 6 HIGHs; AHW-033's raw "6 HIGH" framing,
shown to an external auditor, overstates live risk ~3×.

**Override fact (verified):** `@opentelemetry/host-metrics@0.36.2` pins `systeminformation: "5.23.8"`
EXACTLY (bun.lock:481) — a transitive bump is impossible without a root `overrides`
(`"systeminformation": "^5.31.6"`, clears all 4 HIGHs) or an upstream telemetry-client/host-metrics
bump. undici needs no action for the 2 dead HIGHs (an `overrides: "undici": "^6.24.0"` would quiet
the audit but requires confirming foundation's `Agent`/`request` usage is undici-6 compatible).

**Recommendation: FOLD into AHW-033, not standalone.** AHW-033 is already the
`bun audit`-swallows-6-HIGH finding and explicitly DEFERRED "triage the 6 HIGH." R5-01 IS that
deferred triage — it is enrichment/reclassification of the same finding, not a new defect. A
standalone entry would double-count the same CVE set. Fold it in as the reachability sub-table above
(preserving the per-CVE verdict), and pair the override fact with AHW-033's existing
`$GITHUB_STEP_SUMMARY` fix so the count isn't read as 6 live HIGHs. High-value either way — but it
belongs ON AHW-033.

---

## R5-08 vs AHW-051 — FOLD

AHW-051 = host/codegen `decimals` mis-scales the displayed amount by 10^N (raw amount unaffected),
on the LEDGER on-device display path (`verified_calls_ui.c:210`, source `registry.gen.c`). R5-08 is
the SAME mis-scale CLASS on a DIFFERENT path: core `formatAmount` (intent-utils.ts:112-120) used by
`formatIntentForDevice` → trezor `challenge_visual`, source `IntentLabels.amountDecimals`
(intent.ts:61, host-supplied, no ground truth). Same root cause (host-trusted decimals), same
mitigation direction (render raw integer alongside scaled; treat decimals as untrusted).
**Net-new sub-point worth keeping:** `formatAmount` has no upper bound on `decimals` — a host
passing `decimals: 1e6` makes `10n ** BigInt(decimals)` a multi-million-digit BigInt → CPU/memory
blowup in the host process before display (unvalidated-input → unbounded-work at a trust boundary,
host-side, internal demo → LOW class).
**Recommendation: FOLD into AHW-051** as "also on the trezor host-render path (core
`formatAmount`), AND add: clamp `decimals` to a sane max (≤38) — currently unbounded
`10^decimals` DoS." Distinct enough to note, not distinct enough for its own ID (same defect class,
same fix family).

---

## Cross-cutting recommendation — cataloging the trezor findings given R5-07 (dead weight)

R5-07 says the package is dead weight recommended for removal. Do R5-02/03/04/05/06 still warrant
individual entries, or roll up under R5-07? **Recommendation: catalog R5-02 individually; note
R5-03/04/05/06 as "in a package recommended for deletion (R5-07)" but keep their IDs.** Reasoning:
1. **R5-02's defect LIVES in `packages/core`** (`computeOuterHashForIntent`), a shared lib — it
   outlives any adapter-trezor deletion. It must be catalogued on its own merits (delete-from-core
   OR make-canonical), independent of the package's fate.
2. R5-03/04/05/06 are package-local (provider.ts / transport). If the orchestrator adopts "delete
   adapter-trezor," they evaporate — so they're conditional. But the external-audit register should
   still LIST them (an auditor who opens the package will hit them) with an explicit
   "mitigated-by-deletion-per-R5-07" tag, so they're neither lost nor over-weighted.
3. R5-07 itself is the INFO meta-finding ("shouldn't be in the blast radius"); it FRAMES the others
   but doesn't subsume them — an auditor needs both the frame AND the specifics.
Practical: promote R5-02 (MED) + R5-07 (INFO) as full entries; promote R5-03/04/05/06 (LOW) as
entries tagged "scope: package recommended for deletion (see R5-07)."

---

## Honest net-new-vs-repetition read

Round 5 is **past the high-yield zone but not yet pure repetition.** Of 8 candidates: 6 VALID-NEW
(1 MED, 4 LOW, 1 INFO) + 2 FOLD, **0 DUP, 0 REJECT** — every claim verified true against code/deps.
But the SUBSTANTIVE weight is thin:
- The single most valuable result (R5-01) is an ENRICHMENT of an existing finding (AHW-033), not a
  new defect — and it's the one I'm folding. It is genuinely high-value (kills the "6 live HIGH"
  misread), but it's reclassification, not discovery.
- R5-02 (MED) is the only real net-new DEFECT, and it sits in a package R5-07 says to delete — so
  its live blast radius is near-zero (the broken hash has no correct consumer; the demo that calls
  it is dead). Its value is "shared-lib landmine in core" + "no parity test," not active exploit.
- R5-03/04/05/06 are textbook contained-package quality/hardening LOWs in dead code. Real, correct,
  low-impact, and several are explicitly mitigated by the R5-07 deletion recommendation.
- R5-07 is a useful META frame (cut the dead package) but INFO.
- R5-08 is the SAME class as AHW-051 on a parallel path (fold), with one genuinely-new sub-point
  (unbounded `10^decimals`).
The 0-DUP/0-REJECT rate looks strong but is inflated by the angle being genuinely unrun before
(nobody had triaged the CVEs or read the trezor intent path in depth). The diminishing-returns
signal is in the SEVERITY/IMPACT profile, not the reject rate: one MED defect in dead code, the
headline result being an enrichment, and the rest LOW/INFO hardening in a package recommended for
deletion. This round clears the bar (verified net-new findings exist) but is the last high-confidence
yield from the trezor+deps angle — the next pass here would be true repetition.
