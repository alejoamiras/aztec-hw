# Round 5 — opus — adapter-trezor full surface + dependency-CVE reachability + packages/core depth

Scope: NET-NEW only. Read against `audit/index.md` (63 findings). Explicitly NOT re-reporting
AHW-036 (trezor blind-sign + spoofable `createAuthWitFromIntent` headline), AHW-033 (6-HIGH
swallowed by CI), AHW-037 (`@noble/*` fan-out), AHW-012 (name lies).

Verification method: real code reads + `bun audit` + `bun pm ls --all` + lockfile (`bun.lock`)
+ GitHub Advisory API for every CVE range + inspecting the installed dep source on disk.

---

## ANGLE 2 FIRST — Dependency-CVE reachability (the highest-value net-new result)

AHW-033 catalogued "12 vulns / 6 HIGH (4× systeminformation cmd-injection, 2× undici)" as a
swallowed COUNT. Round 5 did the reachability work AHW-033 explicitly deferred ("triage the 6
HIGH"). Result: **the 6-HIGH headline is materially misleading. 2 of the 6 HIGHs are
unreachable-by-code false positives; the other 4 are real but node/dev-only, never
browser-reachable.** This is net-new and changes the remediation story.

Installed versions (from `bun pm ls --all` + `bun.lock`):
- `systeminformation@5.23.8` ← `@opentelemetry/host-metrics@0.36.2` ← `@aztec/telemetry-client@4.2.1`
  ← `@aztec/pxe@4.2.1` / `@aztec/bb-prover@4.2.1` (`bun.lock:481,223`)
- `undici@5.29.0` ← `@aztec/foundation@4.2.1` (`bun.lock:191,1515`)

### AHW-NEW-R5-01 · MED · BUILD · OURS — Two of the 6 swallowed HIGHs (both undici) are unreachable-by-code false positives; the real 4 are node/dev-only

**Per-CVE reachability classification (all 6 HIGHs + the relevant moderates):**

undici HIGHs — **BOTH FALSE POSITIVE (dead / unreachable-by-code):**
- `GHSA-vrm6-8vpv-qv8q` "Unbounded Memory in WebSocket permessage-deflate Decompression" —
  advisory range `< 6.24.0`, so range-matches `5.29.0`. BUT the vulnerable code path does not
  exist in 5.29.0: `undici/lib/websocket/connection.js:96-97` reads
  `// TODO: enable once permessage-deflate is supported` / `const permessageDeflate = ''`.
  permessage-deflate is hard-disabled in the 5.x WebSocket client → the decompression bug
  is structurally absent. **Classification: DEAD (range-only match).**
- `GHSA-v9p9-hfj2-hcw8` "Unhandled Exception in WebSocket Client (invalid server_max_window_bits)"
  — same `< 6.24.0` range, same disabled permessage-deflate path, same negotiation surface that
  doesn't run in 5.29.0. AND `@aztec/foundation` only ever imports undici's `Agent` +
  `client.request()` HTTP JSON-RPC client (`@aztec/foundation/dest/json-rpc/client/undici.js:3`
  `import { Agent } from 'undici'`; uses `client.request(...)` for POST) — it never touches the
  undici `WebSocket` client at all (the project's WebSocket traffic uses the separately-listed
  `ws` package). **Classification: DEAD (range-only match AND unused subsystem).**
- (undici moderates `GHSA-g9mf-h72j-4rw9` decompression-chain-via-**Fetch**, `GHSA-2mjp` smuggling,
  `GHSA-4992` CRLF — also `< 6.23.0` range matches; `g9mf` is specifically "Node.js **Fetch** API"
  and foundation uses `client.request`, not `fetch`. Moderates, out of HIGH scope, but same
  over-broad-range pattern.)

systeminformation HIGHs — **ALL 4 REAL by version, but NODE-ONLY + only on a telemetry path we never enable:**
- `GHSA-wphj-fx3q-84ch` `fsSize()` (Windows) `< 5.27.14` — 5.23.8 vulnerable. **REAL.**
- `GHSA-hvx9-hwr7-wjj9` `networkInterfaces()` (Linux) `>=4.17.0 <=5.31.5` — vulnerable. **REAL.**
- `GHSA-5vv4-hvf7-2h46` `versions()` (`locate`) `<= 5.30.7` — vulnerable. **REAL.**
- `GHSA-9c88-49p5-5ggf` `wifi.js` retry `< 5.30.8` — vulnerable. **REAL.**
  Reachability: systeminformation uses `child_process`/`exec` in 17 of its lib files — it is
  intrinsically node-only and is excluded from the browser bundle (vite never bundles it; the
  demo-browser deps are pxe-free — see below). It is pulled ONLY for OpenTelemetry host metrics
  via `@aztec/telemetry-client → @opentelemetry/host-metrics`. **Our code never imports telemetry,
  host-metrics, or systeminformation** (grepped all of `packages/` + `apps/`: zero hits). The
  command-injection sinks (`fsSize`/`networkInterfaces`/`versions`/`wifi`) only fire if OTel
  host-metrics is instantiated, which requires a running PXE/prover node with telemetry enabled —
  not exercised by the demo-browser (in-browser PXE, no node telemetry) and not by the node CLI
  demo (`apps/demo` builds an auth witness, never boots PXE telemetry).
  **Classification: NODE-ONLY, and only reachable if a future deployment runs a full node PXE
  with telemetry on. For the shipped PoC surface: effectively DEV/TEST-ONLY.**

elliptic `<=6.6.1` (LOW, `GHSA-848j`) is the only vuln on the demo-browser bundle path
(`vite-plugin-node-polyfills → elliptic`), and it's LOW, not in the 6-HIGH set.

**Net effect on the bottom line:** the browser bundle (the only attacker-remote-reachable
artifact) carries ZERO of the 6 HIGHs. All 4 real HIGHs are node-only on an unused telemetry
path; the 2 undici HIGHs are code-dead. AHW-033's "6 HIGH" framing, surfaced raw to an external
auditor, overstates the live risk by ~3×.

**OURS vs LEDGER:** the systeminformation chain is reachable via `@aztec/pxe` which is a dep of
`adapter-ledger` (`adapter-ledger/package.json` → `@aztec/pxe`) AND demo-browser; the trezor
adapter does NOT pull pxe (its only deps are `core` + `@noble/secp256k1`), so the trezor package
is clean of all 6 HIGHs. The undici chain is via `@aztec/foundation`, which everything pulls.

**Location:** `bun.lock:191/223/481/1515`; `ci.yml:42` (`bun audit` `continue-on-error`);
`undici/lib/websocket/connection.js:96-97` (installed under `.bun/undici@5.29.0/`).

**Concrete impact:** an auditor (or the swallowed CI summary, once AHW-033 is fixed) treating
"6 HIGH" as 6 live HIGHs will mis-prioritise: chasing 2 dead undici CVEs and over-weighting a
node-only telemetry path, while the actually-bundled risk is one LOW (elliptic). Conversely, the
4 systeminformation HIGHs ARE real the moment anyone stands up a node-side PXE/prover with
telemetry (a plausible production topology), so they must not simply be waved off either.

**Fix (specific, ordered):**
1. Add a Bun root `overrides` to `package.json`: `"systeminformation": "^5.31.6"` (clears all 4
   HIGHs; `@opentelemetry/host-metrics@0.36.2` pins `systeminformation: "5.23.8"` EXACTLY in its
   own deps — `bun.lock:481` — so a transitive bump is impossible without an override or an
   upstream `@aztec/telemetry-client`/`@opentelemetry/host-metrics` bump). Verify host-metrics
   still resolves against 5.31.x (the OTel API it uses — `fsSize`/`networkInterfaces`/`cpu` — is
   stable across 5.23→5.31).
2. undici: NO action needed for the 2 HIGHs (code-dead). If you want the audit to go quiet,
   `overrides: "undici": "^6.24.0"` clears the WS HIGHs + the moderates, but confirm
   `@aztec/foundation`'s `Agent`/`request` usage is undici-6 compatible first (5→6 changed some
   internals) — likely a no-op risk but test it. Lower priority than (1).
3. When AHW-033's `$GITHUB_STEP_SUMMARY` write lands, annotate each finding with this reachability
   verdict so the count isn't read as 6 live HIGHs.

---

## ANGLE 1 — adapter-trezor full surface beyond AHW-036

### AHW-NEW-R5-02 · MED · DESIGN · OURS — Trezor `createAuthWitFromIntent` signs a hash that does NOT match Aztec's canonical `EncodedAppEntrypointCalls` (wrong field layout, not merely "decorative")

This is distinct from AHW-036. AHW-036's headline is "the device doesn't verify the visual →
host can spoof the visual." THIS finding is that the *digest itself* the trezor path computes is
**categorically wrong** — it does not correspond to any real Aztec transaction, even if the
visual were honest.

`TrezorEcdsaKAuthWitnessProvider.createAuthWitFromIntent` (`provider.ts:99-104`) calls
`computeOuterHashForIntent` from `@aztec-hwwallet-poc/core` (`intent-utils.ts:38-53`), which
flattens each call as raw `[contractAddress, selector, ...args]`, runs `computeInnerAuthWitHash`,
then `computeOuterAuthWitHash(consumer, chainId, version, inner)`.

The canonical app-payload encoding (`@aztec/entrypoints/dest/encoding.js`, the one the Ledger
adapter actually uses at `clear-signing-entrypoint.ts:156` via `EncodedAppEntrypointCalls.create`)
is per-call SIX fields:
`[args_hash, function_selector, target_address, is_public, hide_msg_sender, is_static]`
where `args_hash = HashedValues.fromCalldata([selector, ...args])` (public) /
`HashedValues.fromArgs(args)` (private), **plus `tx_nonce` appended**, **padded to
APP_MAX_CALLS=5**, hashed with `poseidon2HashWithSeparator(fields, DomainSeparator.SIGNATURE_PAYLOAD)`.

Core's helper diverges on EVERY axis:
- args are inlined raw, NOT pre-hashed into `args_hash`;
- `is_public` / `hide_msg_sender` / `is_static` are absent from the hashed fields (the
  `CallIntent` even *carries* `isPublic`/`hideMsgSender`/`isStatic` — `intent.ts:48-52` — and
  `computeOuterHashForIntent` ignores all three);
- `tx_nonce` is absent (so no per-tx binding at all);
- no padding to 5;
- `computeInnerAuthWitHash` uses a different generator/separator than `SIGNATURE_PAYLOAD`.

Core's own docstring admits it (`intent-utils.ts:30-37`: "DIFFERS from
`EncodedAppEntrypointCalls.hash()` used by the real account entrypoint. Closing that gap is a
Phase-B-final step"). The Ledger side closed it; the Trezor side never did and is the sole
remaining consumer of the broken helper (grep: `computeOuterHashForIntent` is imported only by
trezor `provider.ts` + the `apps/demo` CLI + core's own test).

**OURS vs LEDGER:** Ledger uses canonical `EncodedAppEntrypointCalls` AND has a parity test
(`l4-manifest-parity.test.ts:62` asserts device==`EncodedAppEntrypointCalls.create`). Trezor uses
the broken core helper AND has NO parity test — `intent-utils.test.ts:75-109` only checks
determinism + arg-sensitivity + padding-invariance of the *broken* function against ITSELF,
never against the canonical encoding. So the wrongness is invisible to CI.

**Concrete impact:** anyone who follows the package's own Phase-B story and wires Trezor into a
real send would sign a 64-byte ECDSA over a digest the on-chain `EcdsaKAccount` verifier never
recomputes → auth witnesses are rejected (functional DoS), OR — worse if a future code path
loosens validation — the signature attests to a structure with no `is_public`/nonce binding,
re-openable for replay/cross-context confusion. It is a latent correctness landmine sitting under
a method exported as part of a security-relevant interface.

**Fix:** make trezor's `createAuthWitFromIntent` use the canonical `EncodedAppEntrypointCalls`
path (share the Ledger adapter's encoding), OR delete `createAuthWitFromIntent` from the trezor
provider + delete `computeOuterHashForIntent` from core entirely (it has no correct consumer),
OR — minimum — add a parity test mirroring `l4-manifest-parity.test.ts` so the divergence is a
red CI, and re-label the method `__INTERNAL_DEMO_ONLY_brokenHash`.

### AHW-NEW-R5-03 · LOW · TEST · OURS — Trezor's spoofable `createAuthWitFromIntent` path has ZERO direct unit test (the AHW-036 headline method is untested)

AHW-036 names `createAuthWitFromIntent` as the spoof surface, but `provider.test.ts` (126 LOC)
tests only `getPublicKeyXY` + `createAuthWit` (blind). There is NO test that constructs an intent
and calls `provider.createAuthWitFromIntent` — its visual-build (`buildIntentVisual` →
`formatIntentForDevice`, `provider.ts:135-137`), its hash derivation, and the
signature/AuthWitness assembly off the intent path are entirely unexercised at the provider level.
Parallels AHW-004 (Ledger's central seam untested) but for the trezor adapter's spoof method.
**Fix:** one test asserting the visual contains the intent labels + the AuthWitness `requestHash`
equals the (canonical, once R5-02 is fixed) outer hash.

### AHW-NEW-R5-04 · LOW · HOST · OURS — Trezor adapter never verifies the device-returned signature against the cached pubkey (silent acceptance of a bad/garbled signature)

`signAndWrap` (`provider.ts:110-128`) takes the transport's `(r,s)`, low-s-normalises, packs to
64 bytes, and wraps in an `AuthWitness` — **with no ECDSA verify** of `(r,s)` against
`challengeHidden` and the cached pubkey. A flaky bridge (the line-delimited JSON subprocess —
`trezorlib-subprocess-transport.ts`), a desync between request/response in the
`pendingResolvers` FIFO (see R5-05), or a malicious transport can hand back a structurally-valid
64-byte signature that does not verify, and the adapter emits it as an authorization. The cached
pubkey is right there (`cachedXY`), and `@noble/secp256k1` (already a dep) has `verify`.
**OURS vs LEDGER:** worth checking the Ledger side does a recompute/verify; the device itself
fault-hardens (3× recompute per the firmware findings), but the *host adapter* doing a cheap
verify is defense-in-depth the trezor host skips entirely. **Fix:** `secp.verify(sig,
challengeHidden, compressed)` before returning; throw on mismatch.

### AHW-NEW-R5-05 · LOW · HOST · OURS — Subprocess bridge correlates requests↔responses by FIFO position only; a single dropped/extra line desyncs every subsequent call onto the wrong resolver

`TrezorlibSubprocessTransport` (`trezorlib-subprocess-transport.ts:182-192`) matches each stdout
line to the head of `pendingResolvers` by order (`pendingResolvers.shift()`), with no request id.
The comment at `:190` even concedes the failure mode: "unsolicited line — log? drop silently for
now." If the Python bridge ever emits an out-of-band line (a warning to stdout, a partial write,
a debug print), every in-flight and future request resolves against the *next* request's
response — i.e. a `sign_identity` could resolve with the JSON meant for a different call, and
since there's no verify (R5-04) a mismatched signature/pubkey could be wrapped silently.
Emulator-only today, but this is the "real device" transport the package advertises for Phase B+.
**Fix:** add a monotonic request id echoed by the bridge and match on it; drop/error unmatched
lines loudly instead of letting them shift the queue.

### AHW-NEW-R5-06 · LOW · DESIGN · OURS — `getPublicKeyXY` performs a real on-device ECDSA sign over 32 zero bytes purely to read the public key (sign-to-read)

`getPublicKeyXY` (`provider.ts:66-79`) has no get-pubkey API in the SLIP-0013 namespace (true,
per the transport docstring), so it issues a `signIdentity` with `challengeHidden =` 32 zero bytes
and discards the signature, keeping only `compressedPublicKey`. On the emulator this is free, but
on a real Trezor it is a user-approval prompt to **produce a genuine ECDSA signature over a fixed,
known digest H=0…0** every time pubkey is read before any sign. That signature is observable on
the bridge/wire (and is deterministic per key under RFC-6979) — a fixed-message signature oracle,
and a UX wart (an approval to "sign" just to learn an address). Narrow (only when
`getPublicKeyXY()` is called before any `createAuthWit*`; the demo warms the cache via a real
sign first, so it rarely fires), but it's a real design smell distinct from anything filed.
**Fix:** cache the pubkey from the first *real* sign only and require callers to sign at least
once before reading; or use a pure-JS `@trezor/protobuf` `GetPublicKey` if/when the real-device
transport lands; or at minimum document the sign-to-read on the method.

### AHW-NEW-R5-07 · INFO · BUILD · OURS — the entire adapter-trezor package is dead weight wired only into the dead `apps/demo` + a CI typecheck/test; an auditor will burn time on a non-shipping package

The shipping artifact is `apps/demo-browser` (Ledger-only: its deps are `adapter-ledger` + core,
NO `adapter-trezor`). adapter-trezor is consumed ONLY by `apps/demo` (the dead CLI — AHW-028/031
already establish `apps/demo` is unbuilt/unrun, only typechecked). So adapter-trezor's live
footprint is: (a) `ci.yml:36` typechecks it, (b) `bun test` runs its 33 unit tests, (c) `apps/demo`
imports it. It is on NO user-facing path. This is itself an auditor-surface finding: ~450 LOC of
crypto-adjacent adapter (with the R5-02 broken-hash + R5-04 no-verify + R5-05 desync issues) is
presented as a peer of the production Ledger adapter (the package descriptions cross-reference each
other as equals) but ships to no one. Worse, `apps/demo` is half-broken asymmetrically: AHW-028
says `apps/demo` references the *deleted* `createAuthWitFromIntent` — true for the **Ledger**
backend (the seam refactor deleted it there), but the **Trezor** backend's
`createAuthWitFromIntent` still exists and compiles, so `apps/demo`'s trezor path would actually
*run* the broken-hash code while its ledger path is dead. **Fix:** decide explicitly —
mark adapter-trezor `"private": true` + add a top-of-README/index "EXPERIMENTAL, Phase-A only,
NOT a shipping adapter, blind-sign + non-canonical hash" banner (today `index.ts:1-10` reads as a
straight peer of the Ledger package), OR cut it from CI typecheck/test scope so it isn't presented
as audited-grade, OR delete it with `apps/demo` (AHW-028 already recommends deleting `apps/demo`).
Distinct from AHW-036 (a code-level hole) — this is the meta-finding that the package shouldn't be
in the audit blast radius at all.

### Trezor — checked & clean (negative results, so the auditor doesn't re-chase)

- `unpackTrezorSecp256k1Signature` (`provider.ts:146-156`) and `decompressPubkey`
  (`provider.ts:162-185`): exact-length checks (65 / 33), explicit `0x02/0x03` prefix gate,
  re-checks noble's uncompressed output is `65 && 0x04`. Fail-closed, no off-by-one. Clean.
- `hexToBytes` (`trezorlib-subprocess-transport.ts:212-226`): odd-length reject + per-byte NaN
  reject. Clean (contrast the laundering bug AHW-011/R4-06 found in the *Speculos* transport's
  `fromHex`; trezor's is correct).
- `buildAztecIdentity` (`identity.ts:50-63`): integer + non-negative + `< 2^31` bounds. Clean.
- low-s normalisation is applied host-side (`normalizeLowS`) even though the device already signs
  low-s — idempotent, harmless. Marker byte `signature[0]` is sliced off correctly (`:153`).
- `close()` idempotency + pending-resolver drain on exit/error (`:111-181`) is handled correctly
  (the EventEmitter `error` handler caches rather than throws — good).

---

## ANGLE 3 — packages/core depth

The published-API rigor praised in earlier rounds (exact-equality length checks, fail-closed
packers) holds. Two net-new items, one of them the R5-02 root cause.

### (covered above) `computeOuterHashForIntent` is the core-located root of AHW-NEW-R5-02
The broken hash LIVES in `packages/core/src/intent-utils.ts`, not in the trezor package — it's a
shared-lib correctness defect that simply has no correct consumer left (Ledger stopped using it).
Filed under R5-02; flagging here so the core-depth angle isn't read as "nothing found."

### AHW-NEW-R5-08 · LOW · APP · OURS — core `formatAmount` has the same host-supplied-`decimals` mis-scale as AHW-051, on the trezor display path, AND silently mis-renders when `decimals` exceeds the fractional width

`intent-utils.ts:112-120` (`formatAmount`, used by `formatIntentForDevice` →
trezor `challenge_visual`) scales `amount` by `10^amountDecimals` where `amountDecimals` is
host-supplied (`IntentLabels.amountDecimals`, `intent.ts:61`) with no ground truth — the same
class as AHW-051 (Ledger device `decimals` mis-scale) but on the trezor host-rendered string,
which is additionally unverified by the device (AHW-036). Beyond that: `frac.toString()` is NOT
left-padded to `decimals` before the `padStart` (it IS padded — `:118` `.padStart(decimals,'0')`,
OK) — but if `amount`'s fractional part has FEWER digits than `decimals` the padStart is correct;
the genuine wart is there's no upper bound on `decimals` (a host passing `decimals: 1e6` makes
`10n ** BigInt(decimals)` a multi-million-digit BigInt → CPU/memory blowup in the host process
before display). Bounded blast radius (host-side, internal demo), hence LOW, but it's an
unvalidated-input → unbounded-work path at a trust boundary.
**Fix:** clamp `decimals` to a sane max (e.g. ≤ 38) and reject otherwise; render the raw integer
amount alongside the scaled value (mirrors the AHW-051 fix); treat host `decimals` as untrusted.

### core — checked & clean (negative results)

- `ecdsaPreimage` (`ecdsa.ts:34-43`): asserts 32-byte input, SHA-256, returns a fresh view.
  Correct preimage per the project's Aztec facts (`sha256(outer_hash.to_be_bytes())`, not EIP-191/
  Keccak). Clean.
- `packEcdsaSignature` (`:52-63`): exact 32/32 length gates, refuses DER/`v`. Clean.
- `normalizeLowS` (`:94-103`): correct `s <= n/2` test and `n - s` fold for both curves; constants
  `SECP256K1_N`/`SECP256R1_N` verified against the standard values. Note `normalizeLowS` is typed
  `'secp256k1' | 'secp256r1'` but the trezor caller passes `'secp256k1'` — consistent. Clean.
- `beBytesToBigInt` / `bigIntToBeBytes` (`:105-128`): the BE round-trip is correct;
  `bigIntToBeBytes` fail-closes on negative input AND on overflow (`v !== 0n` after the loop).
  Clean — this is the kind of fail-closed boundary the earlier rounds praised; it holds.
- `isIntentAuthWitnessProvider` (`provider.ts:35-41`): a `typeof === 'function'` duck-type. Benign;
  note it returns true for the trezor provider whose `createAuthWitFromIntent` is the broken-hash
  R5-02 method — so capability-detection would route a caller INTO the broken path. Folded into
  R5-02 (the fix there — make it canonical or delete it — closes this too).

---

## Summary line counts
NET-NEW: 8.
- AHW-NEW-R5-01 · MED · BUILD — CVE reachability triage: 2 of 6 swallowed HIGHs (undici) are dead false positives; 4 (systeminformation) real but node/dev-only, zero browser-reachable.
- AHW-NEW-R5-02 · MED · DESIGN — trezor `createAuthWitFromIntent` signs a NON-canonical hash (root: core `computeOuterHashForIntent`), no parity test.
- AHW-NEW-R5-03 · LOW · TEST — trezor `createAuthWitFromIntent` (the AHW-036 spoof method) has zero direct unit test.
- AHW-NEW-R5-04 · LOW · HOST — trezor adapter never verifies the device signature against the cached pubkey.
- AHW-NEW-R5-05 · LOW · HOST — subprocess bridge correlates req↔resp by FIFO position only; one stray line desyncs everything.
- AHW-NEW-R5-06 · LOW · DESIGN — `getPublicKeyXY` does a real on-device sign over 32 zero bytes to read the pubkey (sign-to-read oracle).
- AHW-NEW-R5-07 · INFO · BUILD — whole adapter-trezor package is dead weight (only `apps/demo` consumes it), presented as a peer of the shipping Ledger adapter.
- AHW-NEW-R5-08 · LOW · APP — core `formatAmount` host-supplied `decimals` mis-scale + unbounded `10^decimals` work at a trust boundary.

By severity: 0 CRITICAL, 0 HIGH, 2 MED, 5 LOW, 1 INFO.
