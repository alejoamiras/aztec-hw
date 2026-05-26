# L4 — verified-calls signing, end-to-end (L4.2 → L4.7)

## Verdict
Aztec Ledger app now signs ONLY after device-recomputed `outer_hash` matches the
host's claim, with the user reviewing target/selector/mode for each call. The
host is no longer the sole authority on what gets signed.

Pinned to aztec-packages `2770bcb…`; SDK image `ledger-app-builder-lite@sha256:852e1def…`.

## What landed (and why)

### Wire shape (L4.2)
`l4/wire.h` enforces canonical-Fr BE for every Fr field, restricts `function_selector` to
fit in u32, and gates `manifest_version=1` / `curve_id=K1` / `path_scheme=0` /
`path_len ∈ [5,10]` / `call_count ∈ [0,5]`. APDU bodies fit in a single 255-byte frame
(BEGIN: 1+1+1+1+4N+128+1 = 137..181 B; APPEND: 97 B; FINALIZE: 32 B; ABORT: 0 B).

The `path_scheme=0` choice (vs. the SLIP-0013 / SLIP-44 reserved IDs in
`packages/adapter-ledger/src/apdu.ts`) is deliberate — L4 only honors the canonical
`m/44'/AZTEC_COIN_TYPE'/account'/0/0` layout; future schemes get explicit IDs and a
device-side dispatch.

### State machine (L4.3)
Three states only — `L4_IDLE`, `L4_HEADER_PARSED`, `L4_CALLS_COMPLETE`. We picked
"buffer all calls, hash at finalize" over a streaming sponge because **fault hardening
needs to recompute the same inputs three times in independent passes** — buffering the
raw call data makes that trivial. RAM cost is ~1.1 KB for the buffered manifest + ~280
B for the sponge during permutation; fits the Nano S+ budget with margin.

`call_count == 0` is allowed (the BEGIN handler transitions directly to
`L4_CALLS_COMPLETE`) — pure tx_nonce-only authwits are a valid Aztec scenario for paying
gas without a call.

### Parity + fault hardening (L4.4 + L4.6)
Three independent recompute passes in `finalize_and_sign.c`:

1. Pass 1 — recompute `outer_hash`, compare to `claimed_outer_hash`.
2. Pass 2 — recompute again, compare to claim **and** to pass-1 result (defeats single-bit glitches).
3. Pass 3 — inside `finalize_after_approval` (after UI), recompute one more time and compare to the stashed value AND the claim.

Plus the existing L2 dup-sig check (sign twice, compare r/s). Total: 3 hash recomputes
+ 2 sign calls + ~5 32-byte comparisons before bytes leave the device.

`l4/parity.c` synthesizes the canonical `FunctionCall.empty()` padding on-device — the
host never streams padding bytes. This means a malicious host that lies about
`call_count` (sends N+1 APPENDs after declaring N) gets rejected by the APPEND handler
itself (`calls_received >= call_count` → reject).

### NBGL UI (L4.5)
`ui/verified_calls_ui.c` is `nbgl_useCaseReview` (NOT blind-sign), with per-call
breakdown into 3 separate tag-value pairs:

- "Call X/N target": `0xabcd…1234`
- "Call X/N selector": `0xa9059cbb (2835717307)` if it fits in u32, else hex
- "Call X/N mode": `PUBLIC,HIDE_SENDER,STATIC` glyphs

`args_hash` per-call is deliberately omitted (deep plan §4 marks it as advanced-detail;
the outer_hash binds it cryptographically anyway). Subtitle carries the deep-plan §4
warning: "INTERNAL build. Addresses and selectors are raw, unverified values."

### Adapter switch (L4.7)
`packages/adapter-ledger/src/l4-manifest.ts` is the host-side mirror of `l4/parity.c` —
parity-tested via the L4.1 host harness for the 4 golden scenarios. `LedgerProvider`
gains `beginAuthwit/appendCall/finalizeAndSign/abortAuthwit`. The pre-existing
`createAuthWitFromIntent` is now the L4 streaming path, not the decorative
host-only-hash fallback.

## Key gotchas — would have eaten hours

### 1. BOLOS clang doesn't expose `__uint128_t` on 32-bit ARM (carried over from L4.1)
Host build of the Fr backend was green; first device build exploded. Fix: schoolbook
32-bit limb decomposition for the 64×64 → 128 product. See L4.1 lesson.

### 2. NBGL Nano `nbgl_useCaseReview` clips to 3 lines per value
We initially had a 4-line per-call value (Target/Selector/Mode/args_hash) — codex's
review flagged it. The 4th line silently clipped on Nano. Fix: split into 3 separate
tag-value pairs per call, drop args_hash from the display (it's bound by outer_hash).

Total pair count budget: 4 headers + 3 per call + outer_hash. With max 5 calls, 20 pairs
total — well within NBGL's pagination limits, and Speculos confirms it renders cleanly.

### 3. NBGL reviewTitle shows on EVERY page, not just intro
Initial autoConfirm matched on "Authorize Aztec calls" — which is the title text shown
on the intro page AND on every subsequent content page. The auto-confirm pressed
"both" too early (still on the intro) and approved nothing meaningful.

Fix: match the `finishTitle` instead, which is unique to the final approve page.
"Sign Aztec authorization?" appears only there. L2 uses "Sign Aztec outer_hash?" — both
start with "Sign Aztec", so a single hint string works for both flows.

### 4. The dispatcher's non-handler early returns also count as "non-9000 paths"
codex L4 BLOCKER: my initial dispatcher returned bad-CLA / bad-INS / bad-P1P2 SWs
WITHOUT clearing `G_l4_session`. So a host could: BEGIN, send a deliberately malformed
APDU mid-stream (gets non-9000 back), then resume with another APPEND — the session was
still live.

Fix: wrap every dispatcher early return through `reject_dispatch()` which calls
`l4_session_reset()` first. The spec says "any non-9000 zeros session state" — this
makes it literally true at every code path, not just inside handlers.

### 5. L2 INSes and L4 session sharing is a mental-model leak
codex L4 MAJOR: even on SUCCESS, calling GET_PUBLIC_KEY in the middle of an L4 session
shouldn't be allowed. The L4 manifest is supposed to be atomic. Fix: L2 INSes (GET_*,
SIGN_OUTER_HASH) ALSO `l4_session_reset()` on entry. An L4 session must be
BEGIN → APPEND → FINALIZE in tight order, with no L2 ops interleaved.

### 6. Test autoConfirm must navigate exactly the right page count
The naïve approach (press right N times for some fixed N) breaks every time the page
count changes — and L4 adds +6 pages for a 1-call manifest vs L2. Fix: use Speculos's
`/events` API to detect the approve page by text, and `clearEvents` to reset between
APDUs. Same heuristic powers the integration tests and the demo's autoConfirm.

### 7. Reset Speculos's event queue every approve
Without `DELETE /events` at the start of `autoConfirm`, the queue accumulates from prior
test runs / setup probes. The polling check sees stale "Sign Aztec…" hits from the
previous test and prematurely both-presses on the intro screen.

## Test scope

| Suite | What it proves |
|---|---|
| Poseidon2 host parity (14/14) | Fr arithmetic + permutation + sponge match aztec-packages |
| Speculos integration L2 (createAuthWit) | L2 blind-sign still works alongside L4 |
| Speculos integration L4 (createAuthWitFromIntent) | BEGIN/APPEND/FINALIZE end-to-end; signature verifies under Aztec `Ecdsa.verifySignature` |
| Ragger pytest harness (nanosp + nanox) | Device-side state machine rejects (APPEND-before-BEGIN, FINALIZE-before-BEGIN); ABORT idempotent; GET_CAPS advertises K1\|CLEAR_SIGN |
| Demo end-to-end | apps/demo/src/index.ts → real device → barretenberg verifier OK |

Total: 66 bun tests + ragger device tests + demo passes against Speculos.

## What L4 deliberately did NOT do (deferred / out-of-scope)

- **No ABI decoding.** Selector is shown as raw hex (and the human-readable
  decimal when it fits in u32). No allowlist, no contract registry.
- **No private-call args_hash path.** Currently public calls only
  (`computeCalldataHash([selector, ...args], PUBLIC_CALLDATA)`); private calls
  use `fromArgs` which goes a different way. Marked as TODO in
  `l4-manifest.ts:encodeRealCall`.
- **No `args_hash` on-device display.** Deep plan §4 marks it as advanced-detail
  for larger screens; nano screens are tight enough that omitting it is the right
  trade-off. The outer_hash binds it cryptographically.
- **No security audit.** This is internal-PoC. The "INTERNAL build" subtitle is
  non-negotiable until a real audit clears the codepath. L5 (Schnorr-Grumpkin)
  is when the audit gate fires.

## Status of recommendations from the L4 deep plan (codex xhigh)

| Plan section | Status |
|---|---|
| §1 Poseidon2 port strategy | Done in L4.1; used portable Montgomery instead of BOLOS bignum (lesson noted) |
| §2 Wire format | Implemented as specified |
| §3 Outer-hash reconstruction | Mirrors `EncodedAppEntrypointCalls.hash()` byte-for-byte |
| §4 UI labels | "Verified calls" framing + raw-values warning |
| §5 Security & adversarial review | All BLOCKER + MAJORs from device-side review applied |
| §6 Implementation phases | Followed L4.0..L4.7 cut |
| §7 Best autonomous session cut | We exceeded — full L4 arc end-to-end this session |
