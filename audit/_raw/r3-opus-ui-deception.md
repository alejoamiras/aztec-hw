# Round 3 — Opus — On-device review-screen DECEPTION of valid, allowlisted calls

Angle: a call that passes every allowlist/parity/binding gate, yet the on-device
review screen misleads the user. All findings below are about calls that the
device WOULD sign; the deception is in what the screen says vs what gets signed.

Method: read the real C UI (`verified_calls_ui.c`, `deploy_review_ui.c`,
`sign_ui.c`, `master_secret_reveal_ui.c`), the formatter (`clear_signing_v0/format.c`),
the hash path (`l4/parity.c`, `clear_signing_v0/args_hash.c`), the codegen
(`registry.gen.c`, `selectors.gen.c`), and the host label source
(`l4-manifest.ts`, `project-call-intent.ts`, `apdu.ts`). All file:line cites are
from the working tree as read.

NET-NEW count: **7** (R3-01 … R3-07). Two are HIGH. Several flag suspected
overlaps for the validator; I argue why each is distinct from the AHW-### it
neighbors.

Also: **4 explicit NEGATIVE results** (vectors that are actually robust) at the
end — valuable for the external auditor so they don't re-chase them.

---

## R3-01 · HIGH · APP · OURS — Recipient `To` rendered at 4+4 bytes; the *same app* deems 4+4 "brute-forceable" and uses 8+6 for deploy

**file:line:**
- `ledger-app/src/ui/verified_calls_ui.c:82-94` (`short_hex_field`: `0x` + 4 bytes + `…` + 4 bytes)
- used for the recipient at `verified_calls_ui.c:208` (`short_hex_field(g_call_to[i], …, c->args[1])`)
- contrast `ledger-app/src/ui/deploy_review_ui.c:62-79` (`address_8_6`: 8 leading + 6 trailing bytes) with the in-code rationale at `:5-8` / `:62-65`: *"6+4 was 40 bits / brute-forceable"* → upgraded to **56 bits**.
- recipient is NOT verified on-device: `append_call.c:141-146` only checks `from == consumer`; `args[1]` (the `to`) has **zero** device-side constraint beyond canonical-Fr.

**Deception scenario (address poisoning / look-alike recipient):**
A hostile or compromised host builds a *valid, allowlisted* `transfer_pub_pub` USDC
call. It passes every gate (registry hit, verb hit, arg-count, visibility,
`from==consumer`, args_hash parity, outer_hash parity). The recipient `to` is an
attacker address. On a Nano-class screen the user sees only:

```
To   0x2af7c3bd…3e4347c5
```

i.e. the first 4 and last 4 bytes — the middle **24 bytes (192 bits) are never
shown**. The attacker pre-grinds a vanity address colliding on the 8 displayed
bytes (≈ 2^64 work to match BOTH ends — feasible-ish for a determined actor with
GPU/ASIC budget, and *trivially* cheap if the victim only eyeballs the leading 4
bytes, which is the realistic human behavior). The signed `outer_hash` commits to
the FULL 32-byte recipient, so the signature is valid for the attacker address;
the device showed an address that looks identical to the intended one. This is the
canonical hardware-wallet address-poisoning attack, and the device's own display
width is the entire defense — there is no second factor (no name, no prior-recipient
memory, no checksum on the recipient specifically).

The damning part is the **internal inconsistency**: the deploy review (a path where
the address is *device-verified*, `deploy_review_ui.c:104-105`, so display width
matters LESS) uses 8+6 = 56 bits and the code explicitly calls 4+4-class widths
"brute-forceable." The transfer recipient (a path where the address is
*attacker-controlled and unverified*, so display width is the ONLY defense) uses
the weaker 4+4. The security budget is allocated exactly backwards.

**`From` self-case is fine** (`format_from` → `"you"` when `==consumer`,
`verified_calls_ui.c:156-162`, and consumer is device-verified). The hole is
specifically the recipient and any non-self `from` (which can't occur for transfers
given the `from==consumer` gate, but CAN for the address fields rendered via
`short_hex_field` elsewhere).

**Fix direction:** render the recipient `to` at full 32 bytes (paginated /
multi-line) or at minimum reuse `address_8_6` (8+6) for ALL address fields, not
just deploy. Strongly prefer full-address display for the *unverified* recipient —
truncation is acceptable only for device-verified values. Add an explicit
"recipient is NOT verified by the device" caveat, since users wrongly assume
"From (verified)" implies the whole screen is verified.

**Overlap note for validator:** NOT AHW-040 (that's DRIP unrendered). NOT the
deploy-address findings. This is the transfer-recipient truncation width +
backwards budget. Net-new.

---

## R3-02 · HIGH · APP/BUILD · OURS — `decimals` is 100% host/codegen-supplied and unverified; a wrong value silently mis-scales every displayed amount by 10^N (and the formatter faithfully renders the lie)

**file:line:**
- `registry.gen.c:7-11` — `.decimals` is a literal in the generated table (USDC=6, ETH=18, FPC=0, DRIP=0), emitted by codegen from `manifest.json`.
- `verified_calls_ui.c:210` / `:234` — `cs_format_amount(c->args[2], reg->decimals, …)`: the displayed human amount is `raw / 10^decimals`.
- `format.c:23-110` — the formatter is bounds-correct (verified) but has NO notion of "is this the right decimals" — it does exactly what `reg->decimals` says.
- AHW-042 already flags that codegen never cross-checks `address`/`decimals`/`symbol`.

**Why this is net-new vs AHW-042:** AHW-042 is a *build/codegen coverage* finding
("the cross-check doesn't verify these fields"). R3-02 is the **on-device
display-deception consequence**, which is the angle of this round and is materially
more severe in framing: even with a perfectly clean codegen run, the `decimals`
value is *definitionally* a host-trusted display parameter — the device has no
independent source of truth for a token's decimals (it can't query chain). A single
wrong digit (e.g. USDC committed as `decimals=5` instead of 6) makes the device
render a 10.0 USDC transfer as "100.0 USDC" or "1.0 USDC" — the signed amount
(`args[2]`) is unchanged and correct, but the **human sees a 10× wrong number and
approves it**. This is a pure display-vs-meaning gap that no parity/allowlist gate
can catch, because the raw `args[2]` is faithfully signed; only the *rendering* is
wrong. It is the textbook "decimals confusion" deception.

The DRIP/FPC entries with `decimals=0` are the live proof that the field varies and
is taken at face value: a `decimals=0` token renders `args[2]` as a bare integer
(`format.c:62-80`), so the SAME 32-byte amount that means "1.5 USDC" at decimals=6
would read as "1500000.0" at decimals=0 — a 10^6 visual swing driven entirely by a
codegen-emitted byte.

**Worth flagging adversarially:** decimals comes from `manifest.json` →
`registry.gen.c`. The supply-chain path that feeds it (AHW-035 provenance gap: the
manifest is built off a *mutable* `node_modules` artifact) means a compromised
`@defi-wonderland/aztec-standards` bump could flip a decimals value and every device
would mis-display amounts with green CI. R3-02 is the *user-facing payload* of that
supply-chain weakness.

**Fix direction:** (a) device-side: there is no clean fix without an on-chain
decimals oracle, so at minimum the review screen should ALSO show the raw integer
amount (the actual signed `args[2]` as a bare integer) next to the
decimals-formatted one, so a wrong decimals is visually detectable; (b) codegen:
cross-check decimals against chain/artifact (AHW-042) AND content-hash-pin the
manifest (AHW-035). The display-side raw-amount belt-and-suspenders is the net-new
mitigation specific to this finding.

**Overlap note:** complements AHW-042 (codegen coverage) and AHW-035 (provenance) —
neither of those proposes the on-device raw-amount display, and neither frames the
device-display deception. Validator: keep as distinct display-layer finding or fold
the *mitigation* into AHW-042; the threat framing is net-new either way.

---

## R3-03 · MED · APP · OURS — The `…` truncation marker is raw U+2026 on a font the app's OWN comment says can't render non-ASCII; on Nano the only "this is abbreviated" cue may vanish or merge the two byte-halves

**file:line:**
- `verified_calls_ui.c:90-93` — `short_hex_field` writes raw bytes `\xE2\x80\xA6` (U+2026 `…`) between the two 4-byte halves.
- `deploy_review_ui.c:76` — `address_8_6` does the same.
- `verified_calls_ui.c:135-137` — the app's OWN comment: *"ASCII-only labels — nano S+ NBGL font lacks U+2192 (→) and other Unicode glyphs; non-ASCII falls back to substitution chars on-screen."* — `format_action` was deliberately kept ASCII for this reason, but `short_hex_field`/`address_8_6` were NOT.

**Deception scenario:** On Nano S+/Nano X the U+2026 ellipsis may render as a
substitution glyph (box/`?`) or, worse, as nothing/whitespace. The ellipsis is the
*only* signal to the user that the address is truncated and that bytes are hidden in
the middle. If it renders blank, `0x2af7c3bd…3e4347c5` becomes `0x2af7c3bd3e4347c5`
— which reads like a *complete, short* 8-byte address rather than a truncated
32-byte one. A user who has learned "Aztec addresses are long" might still be fooled
into thinking they're seeing the whole thing, and an attacker who controls the
recipient (R3-01) benefits: the missing ellipsis removes the visual prompt to scroll
/ verify the full value. Even when it renders as a box, the inconsistency erodes the
"the device shows clean data" trust model.

The team already KNOWS this font limitation (the `format_action` comment proves it)
and applied the ASCII-only discipline to labels but not to the address renderers —
a half-applied mitigation.

**Fix direction:** use an ASCII separator (`..` or ` ... ` or `:`) in
`short_hex_field`/`address_8_6` on Nano targets, OR verify (on real Nano hardware /
ragger snapshot) that U+2026 is in the font and add a snapshot test pinning it. Do
NOT leave a security-relevant truncation marker dependent on an unverified glyph.

**Overlap note:** AHW-022/045 are reveal-UI wording; this is address-render glyph
safety. Distinct. The string-safety vector (#5 of the brief) lands here.

---

## R3-04 · MED · APP · OURS — `outer_hash` (the only byte-level cross-check on the screen) is ALSO truncated to 4+4; "defense in depth for paranoid users" is defeated by showing 8 of 32 bytes

**file:line:**
- `verified_calls_ui.c:275` — `short_hex_field(g_outer_str, …, G_l4_session.outer_hash)` — the tail "outer_hash" pair uses the SAME 4+4 truncation.
- `verified_calls_ui.c:286-288` — rendered as the final pair.
- contrast the blind-sign path `sign_ui.c:100` / `:84-92` (`format_hash_hex`) which shows the **FULL 32-byte** outer_hash (`g_hash_hex[2*32+1]`).

**Deception scenario:** The header comment (`verified_calls_ui.c:16` and `:268-270`)
sells the tail `outer_hash` pair as "defense in depth for paranoid users" / "covers
byte-level paranoia" — the idea being a careful user cross-checks the device's
outer_hash against the host's. But it's truncated to 4+4 = 8 bytes. A paranoid user
comparing 8 of 32 bytes gets 64 bits of assurance, not 256. More to the point: the
*blind-sign* UI (the supposedly LESS safe path) shows the FULL hash
(`sign_ui.c:100`), while the *clear-sign* UI (the supposedly MORE safe path)
truncates it. So the one field that is meant to be the user's escape hatch for
"verify the exact bytes" is weaker on the path that advertises byte-level paranoia.
This isn't an attack on its own (the device recomputes and rejects on mismatch
anyway), but it's a deception about the *value of the displayed assurance*: the
screen implies "you can byte-check this" when you can only check 1/4 of it.

**Fix direction:** show the full 32-byte outer_hash (paginated) on the clear-sign
review, matching `sign_ui.c`, OR drop the truncated tail pair and the
"byte-level paranoia" claim (it's currently a comfort blanket, not a control).

**Overlap note:** AHW-006/041 are stale/false COMMENTS; this is a real display
weakness + a misleading self-description of the control's value. Distinct.

---

## R3-05 · LOW · APP · OURS — "From (verified)" label invites the user to trust the WHOLE screen as verified; recipient/amount/symbol are not

**file:line:**
- `verified_calls_ui.c:278` — header pair `"From (verified)"`.
- but `To` (`:208`, unverified — R3-01), `Amount` (`:213`, decimals host-trusted — R3-02), and the token `symbol` (`:148-149`, codegen-trusted) carry NO "verified"/"unverified" qualifier.

**Deception scenario:** A "(verified)" tag on the From field, with nothing labeling
the other fields, creates a halo: the user reasonably infers the device verified the
*transaction*, when it only verified that the sender is this account. The fields that
actually matter for theft — recipient and amount — are the unverified/host-trusted
ones. This is a copywriting-as-attack-surface issue (the frontend addendum in the
project's own CLAUDE.md treats copy as part of the design surface). The single
"(verified)" word does real damage to the user's threat model.

**Fix direction:** drop the "(verified)" qualifier (it's noise the user can't act
on) OR make verification status explicit per field (e.g. recipient shown full + a
note that the device cannot vouch for it being the intended party). Pairs with R3-01.

**Overlap note:** distinct from all comment-staleness findings; this is live
on-screen copy.

---

## R3-06 · LOW · APP · OURS — Mint "WARNING / MINTER action" is rendered as an ordinary tag-value pair, not a banner; trivially scrolled past and visually identical to benign rows

**file:line:**
- `verified_calls_ui.c:240-243` — the mint warning is just another `g_pairs[]` entry: `item="WARNING"`, `value="MINTER action"`.
- it is mixed inline with `To`/`Amount`/`Call N/M` pairs in the same scrolling list (`nbgl_useCaseReview`, `:296`).

**Deception scenario:** A privileged `mint_pub`/`mint_priv` call (which on
aztec-standards tokens is a minter-only action that creates supply) is flagged only
by a row that reads `WARNING: MINTER action`, visually indistinguishable from the
`From`/`To`/`Amount` rows around it, on a list the user is habituated to scroll
through and confirm. There's no modal, no distinct color (Nano is monochrome), no
forced acknowledgement. In a multi-call payload (up to 5), a mint can sit between two
benign transfers and read as just-another-pair. NBGL has dedicated warning/alert
affordances (`nbgl_useCaseReviewWithWarning`-style) that this doesn't use. The
"warning" is present but not *salient* — which for a privileged action is a soft
deception (the user technically saw it, but the UI did nothing to make it land).

**Fix direction:** use NBGL's warning/alert use-case (or a pre-review warning page)
for mint verbs, not an inline pair; force an explicit extra confirmation for
minter actions.

**Overlap note:** AHW-040/041 are about DRIP; this is about MINT salience. Distinct
verb, distinct issue (rendering-salience vs not-rendered-at-all).

---

## R3-07 · LOW · APP · OURS — `Sponsor` verb renders "Via: Testnet FPC" with no fee AMOUNT and no payee detail; user authorizes a fee-paying call shown as a bare label

**file:line:**
- `verified_calls_ui.c:248-254` — `CS_VERB_SPONSOR` renders a single pair `Via: "Testnet <symbol>"` (symbol = "FPC", `registry.gen.c:9`), arg_count=0 (`selectors.gen.c:12`).
- the deploy fee shows `"Sponsored (testnet)"` (`deploy_review_ui.c:107`) — also amount-free.

**Deception scenario:** The sponsor/fee-payment call is part of what the user signs
(it's in the call list and bound into the outer_hash), but the review shows only
"Via: Testnet FPC" — no fee cap, no max amount, no indication of what the FPC is
authorized to pull. For a PoC on a testnet faucet-style FPC this is low blast radius,
but as a *clear-signing principle* it's the same defect class as AHW-040: a signed
call rendered without its security-relevant economic content. A user cannot tell a
benign sponsored fee from one that (if the FPC contract allowed it) drains more. The
arg_count=0 verb genuinely has no on-wire amount to show, which is the honest
limitation — but then the screen should SAY "fee amount not constrained by this
review," not present a tidy "Via" line that implies completeness.

**Fix direction:** if the FPC verb carries no amount, state that explicitly on-screen
("fee amount not shown / not capped by device"); if a future FPC verb carries a max-fee
arg, render it. Aligns the sponsor path with the honesty bar AHW-040 sets for DRIP.

**Overlap note:** sibling-in-spirit to AHW-040 but a DIFFERENT verb (SPONSOR vs DRIP)
and a different failure (renders a misleading-by-omission label vs renders nothing).
Validator: keep distinct; the fix is per-verb.

---

# NEGATIVE RESULTS (vectors checked and found ROBUST — do not re-chase)

**N-1 · Flags (STATIC / HIDE_MSG_SENDER / PUBLIC) display-vs-sign — ROBUST.**
I expected a gap because `cs_compute_args_hash` (`args_hash.c:6-43`) excludes the
flags. But `l4/parity.c:62-67` (`emit_call_fields`) DOES bind `is_public`,
`hide_msg_sender`, and `is_static` as three separate Fr fields per call into the
inner_hash (SIGNATURE_PAYLOAD), and `l4-manifest-parity.test.ts` anchors the host
mirror (`l4-manifest.ts:168-178`, which includes the same three flags) to the
CANONICAL `EncodedAppEntrypointCalls` + `computeOuterAuthWitHash` of the installed
`@aztec` 4.2.1. So the flags shown in the "Flags" pair (`format_mode`,
`verified_calls_ui.c:111-131`) are genuinely the same bits that are hashed and
signed. No display-vs-sign gap on flags. (The PUBLIC flag is additionally bound via
the args_hash separator choice.) Vector #6 is closed for flags.

**N-2 · Multi-call masking / "N more" truncation — ROBUST.**
`call_count` is hard-capped at `L4_MAX_CALLS=5` at BEGIN (`begin_authwit.c:95`).
`VC_PAIR_CAPACITY=32` (`verified_calls_ui.c:52`). Worst-case pairs = 3 headers +
5 calls × ≤5 pairs (TRANSFER) + 1 outer_hash = 29 ≤ 32. The loop guard
`n_pairs + 5 <= VC_PAIR_CAPACITY` (`:282`) is satisfied for all 5 calls; no call is
ever silently dropped, and NBGL paginates rather than truncating the pair list.
There is no "first call only" rendering and no "N more" elision. A benign call cannot
bury a malicious second one via overflow. Vector #4 is closed. (The real multi-call
risk is per-field — R3-01/02/06 — not call-count completeness.)

**N-3 · Token-symbol spoofing within the allowlist — ROBUST (today).**
`symbol` is keyed by device-verified `target_address` (`registry.gen.c:14-19` →
`render_call_pairs:183`), and the 5 registry slots have distinct symbols
(USDC/ETH/FPC/DRIP) with distinct addresses. The attacker cannot influence which
symbol renders except by choosing which *real, allowlisted* contract to call, and
those are distinct audited testnet tokens. No two allowlist slots share a symbol, so
no in-allowlist symbol collision. (Caveat: this rests on the codegen emitting correct
symbols — see AHW-042 — and on no future duplicate-symbol slot being added; worth a
codegen assertion that symbols are unique, but no live deception today.) Vector #3 is
closed for the current registry.

**N-4 · `cs_format_amount` numeric *correctness* (scientific notation / grouping /
sign / magnitude-hiding) — ROBUST.**
The formatter (`format.c`) is plain fixed-point: no scientific notation, no thousands
separators (`format.h:9` "locale-free"), no sign, always ≥1 digit after the dot, and
trailing-zero trim never removes whole-number magnitude (it stops at `dot_pos+2`,
`format.c:103-107`). High-16-bytes-set is rejected (`:31-33`), decimals>30 rejected
(`:34`). The only amount-deception vector that survives is the *decimals parameter*
itself (R3-02) — the arithmetic on a given decimals is faithful. (AHW-027 already
notes the missing fuzz vectors; I confirm no NEW arithmetic-rendering deception
beyond the decimals-source issue.) Vector #2's "scientific/grouping/trim" sub-vectors
are closed; only the decimals-source sub-vector (R3-02) is live.

---

# Summary for orchestrator

- **R3-01 (HIGH, APP):** recipient `To` shown 4+4 bytes & UNVERIFIED, while deploy uses 8+6 and the code itself calls 4+4 "brute-forceable" — `verified_calls_ui.c:82-94,208` vs `deploy_review_ui.c:62-79`. Address-poisoning, budget allocated backwards.
- **R3-02 (HIGH, APP/BUILD):** `decimals` is host/codegen-trusted with no device ground-truth; wrong value mis-scales displayed amount by 10^N while the correct raw is signed — `registry.gen.c:7-11`, `verified_calls_ui.c:210`. Display-payload of AHW-035/042; net-new mitigation = show raw integer amount on-device.
- **R3-03 (MED, APP):** `…` truncation marker is raw U+2026 on a font the app's own comment (`verified_calls_ui.c:135-137`) says lacks non-ASCII glyphs — `:90-93`, `deploy_review_ui.c:76`. Marker may vanish/merge halves on Nano.
- **R3-04 (MED, APP):** tail `outer_hash` truncated to 4+4 while blind-sign shows full 32B — `verified_calls_ui.c:275` vs `sign_ui.c:100`. "Byte-level paranoia" claim covers only 64 of 256 bits.
- **R3-05 (LOW, APP):** "(verified)" on From haloes the whole screen; recipient/amount/symbol are not verified — `verified_calls_ui.c:278`.
- **R3-06 (LOW, APP):** mint "WARNING" is an inline tag-value pair, not a salient banner/modal — `verified_calls_ui.c:240-243`.
- **R3-07 (LOW, APP):** SPONSOR verb renders "Via: Testnet FPC" with no fee amount / no cap — `verified_calls_ui.c:248-254`. Same honesty class as AHW-040, different verb.

NEGATIVE (robust, don't re-chase): flags are bound+verified (N-1); multi-call cannot
overflow/mask at cap 5 / capacity 32 (N-2); no in-allowlist symbol collision today
(N-3); amount arithmetic is faithful — only the decimals *source* deceives (N-4).

Overlap flags for validator: R3-02 ↔ AHW-035/042 (distinct: display layer +
raw-amount mitigation); R3-07 ↔ AHW-040 (distinct verb). All others net-new.
