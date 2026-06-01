# R3 validation — on-device UI-deception findings (skeptic pass)

Validator role: confirm/refute each R3 candidate against the actual C, dedup vs
AHW-001..049, correct over/under-stated severity. Verdicts below. Orchestrator
promotes to `index.md`; this file does NOT write it.

## Verdict table

| Cand | Claim (1-line) | Code check | Dedup | Verdict | Final sev/cat/owned |
|------|----------------|-----------|-------|---------|--------------------|
| R3-01 | Recipient `To` rendered 4+4 AND device-unverified; deploy uses 8+6; budget backwards | CONFIRMED | net-new | **VALID-NEW** | HIGH · APP · OURS |
| R3-02 | Host/codegen `decimals` mis-scales displayed amount 10^N; raw signed amount correct | CONFIRMED | overlaps AHW-035/042 | **PARTIAL (VALID-NEW, narrowed)** | MED · APP · OURS |
| R3-03 | `…` truncation marker is raw U+2026 on a font the app's own comment says lacks non-ASCII | CONFIRMED (code); glyph-render claim UNVERIFIED on HW | net-new | **VALID-NEW** | LOW · APP · OURS |
| R3-04 | Tail `outer_hash` truncated 4+4 while blind-sign shows full 32B | CONFIRMED | net-new | **VALID-NEW** | LOW · APP · OURS |
| R3-05 | "(verified)" on From haloes whole screen; To/amount/symbol unverified | CONFIRMED | pairs R3-01 | **VALID-NEW** | LOW · APP · OURS |
| R3-06 | Mint "WARNING" is an inline pair, not a salient banner/modal | CONFIRMED | net-new | **VALID-NEW** | LOW · APP · OURS |
| R3-07 | SPONSOR renders "Via: Testnet FPC" with no fee amount/cap | CONFIRMED | sibling of AHW-040 | **VALID-NEW** | LOW · APP · OURS |

Counts: **VALID-NEW 6 · PARTIAL 1 · DUP 0 · REJECT 0.** (R3-02 is a PARTIAL that
still earns a distinct record — see below.) Two finder-claimed HIGHs; I keep ONE
at HIGH (R3-01) and **downgrade R3-02 HIGH→MED**.

---

## R3-01 — VALID-NEW · HIGH · APP · OURS — DECISIVE YES

The headline. Every load-bearing fact is literally true in the working tree:

- **Recipient truncation is 4+4.** `verified_calls_ui.c:82-94` `short_hex_field` =
  `0x` + `hex_n(bytes,4)` + U+2026 + `hex_n(bytes+28,4)` → first 4 and last 4
  bytes only; middle 24 bytes (192 bits) never shown. Used for the recipient at
  `:208` `short_hex_field(g_call_to[i], …, c->args[1])`.
- **Recipient is device-unverified.** `append_call.c:142-146`: the only
  address-equality gate is `ct_memcmp32(slot->args[0] /*from*/, consumer)` and
  only for 4-arg TRANSFER verbs. `args[1]` (the `to`) gets ONLY canonical-Fr
  (`:121`) — zero semantic constraint. The recipient is fully attacker-chosen.
- **Deploy uses the STRONGER 8+6.** `deploy_review_ui.c:62-79` `address_8_6` =
  8 leading + 6 trailing bytes (56 bits), and the in-code rationale at `:5-8` /
  `:62-65` explicitly states *"6+4 was 40 bits / brute-forceable"* → upgraded to
  56 bits.
- **Budget is allocated backwards — CONFIRMED.** The deploy address is
  device-VERIFIED (`deploy_review_ui.c:104-105` renders `address_local`, and
  BEGIN proved `address_local == expected`), so on that path display width is a
  *secondary* defense — yet it gets 8+6. The transfer recipient is
  attacker-controlled and UNVERIFIED, so display width is the *only* defense —
  yet it gets the weaker 4+4. The same codebase calls 4+4-class widths
  "brute-forceable" on the path where it matters less and ships exactly that
  width on the path where it's the sole control. The claim is accurate.

**Skeptic caveats (don't inflate the attack cost):**
1. The finder's "2^64 to match BOTH ends" is the cost to collide all 8 displayed
   bytes. That is genuinely expensive. The REAL risk is the realistic human who
   eyeballs only the leading 4 bytes (~2^32, trivially grindable as a vanity
   prefix) — which the finding does acknowledge. Severity rests on human
   behavior + the backwards-budget inconsistency, not on a cheap full 8-byte
   collision. Still HIGH: address-poisoning on a HW wallet where display width
   is the entire defense is the canonical attack, and the device is internally
   inconsistent about it.
2. `From` self-case is genuinely safe: `format_from` (`:156-162`) prints `"you"`
   when `addr==consumer`, and for 4-arg transfers `from` is forced `==consumer`
   by `append_call.c:143`, so a non-self `from` cannot reach a transfer row. The
   hole is specifically the recipient. (Note: MINT renders `to` via the same
   4+4 `short_hex_field` at `:232` — same weakness, same fix.)

**Tightened detail (for promotion):** Recipient `To` (and MINT `to`) rendered at
4+4 = 8 of 32 bytes via `short_hex_field` (`verified_calls_ui.c:82-94,208,232`)
while the recipient carries NO device-side constraint (`append_call.c:141-146`
binds only `from==consumer`). The deploy path uses 8+6 and the code itself brands
4+4-class widths "brute-forceable" (`deploy_review_ui.c:5-8,62-65`) — display
budget is inverted relative to which value is verified. Enables look-alike /
address-poisoning recipients that the device renders indistinguishably from the
intended address. **Fix:** render the unverified recipient at full 32 bytes
(paginated), or at minimum reuse `address_8_6` for ALL address fields; add an
explicit "recipient NOT device-verified" caveat. Net-new: NOT AHW-040 (DRIP
unrendered), NOT the deploy-address findings.

---

## R3-02 — PARTIAL → keep as VALID-NEW (narrowed) · MED · APP · OURS — DECISIVE: DISTINCT, but NOT HIGH

Mechanism is literally true:

- `decimals` is a codegen literal in the device registry: `registry.gen.c:7-11`
  (USDC=6, ETH=18, FPC=0, DRIP=0), emitted from `manifest.json` per
  `registry.gen.h:1-5`. The device has no chain query / no independent
  ground-truth for a token's decimals.
- The displayed human amount = `raw / 10^decimals`: `verified_calls_ui.c:210`
  (`cs_format_amount(c->args[2], reg->decimals, …)`), `:234` for MINT.
- `format.c` is faithful to whatever `decimals` it's handed (verified below in
  N-4) — it renders the lie correctly. A wrong `decimals` mis-scales the on-screen
  amount by 10^N while the SIGNED `args[2]` is unchanged and correct. Textbook
  decimals-confusion. The `decimals=0` FPC/DRIP slots prove the field varies and
  is taken at face value (`format.c:62-80` renders a bare integer at decimals=0).

**Distinctness adjudication (the crux):** AHW-042 is the *codegen-coverage* gap
(cross-check never verifies `address`/`decimals`/`symbol`); AHW-035 is the
*provenance* gap (manifest built off mutable `node_modules`). R3-02 is the
**on-device display consequence** with a mitigation NEITHER proposes: also render
the raw integer `args[2]` on-screen next to the decimals-formatted value, so a
wrong `decimals` is visually detectable WITHOUT trusting codegen. That is a
genuinely separate fix at a separate layer (device UI vs build-time cross-check).
**Verdict: keep as a distinct record**, cross-ref AHW-035/042. Do not fold.

**Severity correction — HIGH→MED.** The finder rated HIGH; I downgrade:
- The signed value is correct; this is a *display* deception, not a
  value-substitution. The user is misled about magnitude, which is real, but it
  is strictly weaker than R3-01 (where the attacker substitutes the actual
  recipient that gets signed).
- It requires a wrong `decimals` to *already exist* in committed codegen — i.e.
  it's the user-facing payload of AHW-035 (provenance) / AHW-042 (coverage),
  both rated MED. A display-only consequence of two MED build-gaps should not
  outrank them. MED is the honest tier. (Note AHW-042's own text already cites
  the "mis-displays amounts by 10^N" effect — R3-02's NET-NEW contribution is
  the device-side raw-amount mitigation + the display-layer framing, not the
  threat itself, which is partly pre-existing. Hence PARTIAL.)

**Tightened detail (for promotion):** Device `decimals` is 100% codegen/host-
supplied (`registry.gen.c:7-11`) with no on-device ground-truth; the formatter
faithfully scales `raw/10^decimals` (`verified_calls_ui.c:210,234`,
`format.c:23-110`), so a wrong committed `decimals` mis-displays every amount by
10^N while the correct raw `args[2]` is signed. **Fix (net-new, device-side):**
also show the raw integer `args[2]` on the review screen so a wrong `decimals` is
visually catchable. Complements (does not replace) AHW-042 (codegen coverage) +
AHW-035 (provenance).

---

## R3-03 — VALID-NEW · LOW · APP · OURS

Code facts true:
- `short_hex_field` writes raw `\xE2\x80\xA6` (U+2026) between the byte-halves
  (`verified_calls_ui.c:90-92`); `address_8_6` does the same
  (`deploy_review_ui.c:76`).
- The app's OWN comment documents the font limitation:
  `verified_calls_ui.c:135-137` — *"ASCII-only labels — nano S+ NBGL font lacks
  U+2192 (→) and other Unicode glyphs; non-ASCII falls back to substitution
  chars on-screen."* `format_action` was kept ASCII; the address renderers were
  NOT. Half-applied mitigation — accurate.

**Skeptic caveat:** the *consequence* (ellipsis renders blank → `0x2af7c3bd…3e4347c5`
reads as a complete short address) is plausible but UNVERIFIED — nobody has
confirmed on real Nano hardware / ragger snapshot whether U+2026 renders as a
box, a `?`, or nothing. The finding's own fix direction says to verify this. So
this is a real *inconsistency* (the team's stated ASCII discipline is not applied
to security-relevant truncation markers) but the worst-case render is a
hypothesis. LOW is correct; do not raise without a hardware/ragger repro. The
fix is cheap (ASCII `..` separator or a pinned snapshot test).

**Tightened detail:** Truncation marker is raw U+2026 in `short_hex_field` /
`address_8_6` (`verified_calls_ui.c:90-92`, `deploy_review_ui.c:76`) on a font the
app's own comment (`:135-137`) says lacks non-ASCII glyphs — yet the ASCII
discipline applied to labels was not applied to address renderers. If the glyph
falls back to blank, the only "this is truncated" cue disappears (compounds
R3-01). **Fix:** ASCII separator on Nano targets OR a ragger snapshot pinning the
glyph. Distinct from AHW-022/045 (reveal-UI wording).

---

## R3-04 — VALID-NEW · LOW · APP · OURS

- Tail `outer_hash` uses the SAME 4+4 truncation: `verified_calls_ui.c:275`
  (`short_hex_field(g_outer_str, …, outer_hash)`), rendered as the final pair
  `:286-288`.
- The blind-sign path shows the FULL 32 bytes: `sign_ui.c:100`
  (`format_hash_hex(g_hash_hex, …, outer_hash, 32)`), buffer `g_hash_hex[2*32+1]`
  at `:44`. So the supposedly-LESS-safe blind path shows 256 bits; the
  supposedly-MORE-safe clear path shows 64.
- The header comment sells the tail pair as "defense in depth for paranoid users"
  (`verified_calls_ui.c:16`) / "covers byte-level paranoia" (`:268-270`).

**Skeptic note:** correctly NOT an attack — the device recomputes and rejects on
outer_hash mismatch regardless of display. This is a deception about the *value
of the displayed assurance* (you can byte-check only 1/4 of it), plus an
inconsistency vs the blind path. LOW is right.

**Tightened detail:** Clear-sign review truncates the tail `outer_hash` to 4+4 =
64 of 256 bits (`verified_calls_ui.c:275`) while the blind-sign path shows the
full 32 bytes (`sign_ui.c:100`); the comment advertises "byte-level paranoia"
(`:16,268-270`) the field can't deliver. Not exploitable (device recomputes/
rejects), but a misleading self-description + inverted-vs-blind inconsistency.
**Fix:** show full 32B paginated, or drop the truncated pair and the paranoia
claim. Distinct from AHW-006/041 (stale/false comments).

---

## R3-05 — VALID-NEW · LOW · APP · OURS

- The header pair is literally `"From (verified)"` (`verified_calls_ui.c:278`).
- `To` (`:208`), `Amount` (`:213,219`), and the token `symbol` (folded into the
  action label `:148-149` and amount `:214`) carry no verified/unverified
  qualifier. The "(verified)" tag attaches only to From.

This is copywriting-as-attack-surface: a lone "(verified)" on the one field that
is verified creates a halo over the fields that actually enable theft (recipient,
amount) — which are exactly the unverified/host-trusted ones (R3-01/R3-02). The
project's own CLAUDE.md treats copy as design surface, so this is in-scope.
LOW, pairs with R3-01. Confirmed.

**Tightened detail:** `"From (verified)"` (`verified_calls_ui.c:278`) is the only
field labeled, haloing the unverified recipient + host-trusted amount/symbol as
if the whole tx were device-verified. **Fix:** drop the qualifier or make
verification status explicit per field. Pairs with R3-01.

---

## R3-06 — VALID-NEW · LOW · APP · OURS

- The mint warning is just another `g_pairs[]` entry: `item="WARNING"`,
  `value="MINTER action"` (`verified_calls_ui.c:240-243`), mixed inline with
  `To`/`Amount`/`Call N/M` in the same `nbgl_useCaseReview` scrolling list
  (`:296`). No modal, no `nbgl_useCaseReviewWithWarning`, no forced ack. Nano is
  monochrome so no color salience. In a ≤5-call payload a mint can sit between
  benign transfers.

Confirmed: the warning is present but not *salient*. Soft deception (the user
technically saw it). LOW. Distinct from AHW-040/041 (DRIP). The finder's
mechanism is exactly right.

**Tightened detail:** Privileged `mint_pub`/`mint_priv` flagged only by an inline
`WARNING: MINTER action` tag-value pair (`verified_calls_ui.c:240-243`) in the
ordinary scrolling list (`:296`) — no banner/modal/forced-ack, visually
identical to benign rows. **Fix:** use NBGL's warning use-case or a pre-review
warning page + forced extra confirm for minter verbs. Distinct from AHW-040/041
(rendering-salience vs not-rendered-at-all).

---

## R3-07 — VALID-NEW · LOW · APP · OURS — sibling of AHW-040, KEEP DISTINCT

- `CS_VERB_SPONSOR` renders a single pair `Via: "Testnet <symbol>"` with
  symbol="FPC" (`verified_calls_ui.c:248-254`, `registry.gen.c:9`). The verb is
  `wire_arg_count=0` (`selectors.gen.c:12`) — so there genuinely is no on-wire
  amount to display. The deploy fee is likewise amount-free
  (`deploy_review_ui.c:107` "Sponsored (testnet)").

**Adjudication vs AHW-040 (DECISIVE):** keep as a SEPARATE finding, do NOT fold.
- Same honesty-class (a signed, outer_hash-bound call rendered without its
  security-relevant economic content), but a DIFFERENT verb (SPONSOR vs DRIP)
  and a DIFFERENT failure mode: AHW-040 is *renders nothing* ("Call DRIP", zero
  pairs — a missing render case); R3-07 *renders a tidy "Via" line that implies
  completeness* while omitting fee/cap. The fix is per-verb (state "fee amount
  not constrained by this review"), so it doesn't ride AHW-040's fix.
- Severity: AHW-040 is HIGH because DRIP is a 2-arg verb whose to/amount ARE on
  the wire yet are dropped (real omitted content). SPONSOR is arg_count=0 — there
  is no on-wire amount, so the omission is honest; the defect is the misleading
  *label* implying completeness. That's a copy/honesty issue → LOW, not HIGH.
  Severity correctly stated by the finder.

**Tightened detail:** `CS_VERB_SPONSOR` renders only `Via: Testnet FPC`
(`verified_calls_ui.c:248-254`) with no fee cap/amount; arg_count=0
(`selectors.gen.c:12`) means none is on-wire, but the screen should SAY "fee
amount not constrained by device" rather than present a complete-looking label.
**Fix:** state the limitation on-screen; render a max-fee arg if a future FPC verb
carries one. Sibling of AHW-040 (different verb + different failure: misleading-
by-omission label vs not-rendered).

---

## Confirmed-clean NEGATIVE results (checked & sound — auditor may skip)

**N-1 · Flags bound into inner_hash → no display-vs-sign gap — SOUND (spot-checked).**
`parity.c:62-67` (`emit_call_fields`) binds `is_public`, `hide_msg_sender`,
`is_static` as three separate Fr fields per call into the SIGNATURE_PAYLOAD
(`L4_PAYLOAD_FIELD_COUNT = 5×6+1`, six fields/call: args_hash, selector, target,
is_public, hide_ms, is_static — `:35-36,57-70`). Flag bits come from the same
`call->flags` (`wire.h:52-55`) that `format_mode` displays
(`verified_calls_ui.c:111-131`) and that `append_call.c:137-139` validates
`is_public==verb.is_public`. `cs_compute_args_hash` (`args_hash.c:6-43`) does
exclude flags, but the flags are bound at the inner_hash layer instead, so the
signed payload commits to exactly the displayed bits. **Confirmed: no gap on
flags.** (Caveat for completeness: `is_public` additionally drives the args_hash
separator choice in `args_hash.c:27-33`, so flipping it also breaks the
args_hash recompute — double-bound.)

**N-2 · Multi-call masking / overflow — SOUND (spot-checked).**
`call_count` is hard-capped at `L4_MAX_CALLS=5` at BEGIN
(`begin_authwit.c:95`, `wire.h:30`). `VC_PAIR_CAPACITY=32`
(`verified_calls_ui.c:52`). Worst case: 3 headers (From/Chain/Calls, `:278-280`)
+ 5 calls × max 5 pairs (TRANSFER: label+From+To+Amount+Flags, `:217-225`) + 1
outer_hash = **29 ≤ 32**. The loop guard `n_pairs + 5 <= VC_PAIR_CAPACITY`
(`:282`) reserves 5 slots per call before each render, and the max pairs any verb
emits is exactly 5 (TRANSFER) — so no in-progress call can overrun, and the guard
is satisfied for all 5 calls. No "first call only" rendering, no "N more"
elision; NBGL paginates rather than dropping pairs. **Confirmed: a benign call
cannot bury a malicious one via overflow.** (Minor doc nit: the file comment at
`:51` says "4 headers" but the code emits 3 — slack in the bound's favor, not a
defect.)

**N-3 · In-allowlist symbol collision — SOUND (today).**
`symbol` keyed by device-verified `target_address` via `cs_registry_lookup`
(`registry.gen.c:14-19`), consumed at `render_call_pairs:183`. The 4 non-empty
slots have distinct symbols (USDC/ETH/FPC/DRIP) at distinct addresses
(`registry.gen.c:7-10`). The attacker can only choose which *real, allowlisted*
contract to call; no two slots share a symbol. **Confirmed clean for the current
registry.** Standing caveat (carried by AHW-042): rests on codegen emitting
correct symbols + no future duplicate-symbol slot; a codegen uniqueness assert
would harden it. No live deception today.

**N-4 · `cs_format_amount` arithmetic correctness — SOUND.**
`format.c` is plain locale-free fixed-point: no scientific notation, no thousands
separators, no sign, always ≥1 fractional digit (`:103-107` trims trailing zeros
but stops at `dot_pos+2`, never eating whole-number magnitude). High-16-bytes-set
rejected (`:31-33`); `decimals>30` rejected (`:34`). The divmod-by-10 loop
(`:8-16`) is standard big-endian long division. **Confirmed: the arithmetic on a
GIVEN decimals is faithful** — the only surviving amount deception is the
*decimals source* (R3-02), not the rendering math. (AHW-027 already flags the
missing fuzz vectors.)

---

## Orchestrator summary

- Promote **6 VALID-NEW** + **1 PARTIAL-but-distinct** (R3-02) = 7 new records.
- R3-01 stays HIGH (only finder HIGH I uphold). R3-02 **downgraded HIGH→MED**.
  R3-03/04/05/06/07 confirmed at LOW.
- Cross-refs to add: R3-01 ↔ R3-03/R3-05 (compounding); R3-02 ↔ AHW-035/AHW-042;
  R3-07 ↔ AHW-040.
- All 4 negatives confirmed sound → record as auditor-facing "checked & clean."
