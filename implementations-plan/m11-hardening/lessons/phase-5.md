# M11 Phase 5 — authwit binding generality: DECISION (chose B over the planned wire-bump)

**Outcome: do NOT ship the planned authwit-v3 wire-bump (option A). Keep the
existing fail-closed, firmware-pinned binding (option B). This diverges from the
locked plan decision ("version-bump clean break for the authwit wire") on the
strength of an adversarial finding the consult surfaced — flagged for the user to
override on return if they want the generality.**

## What P5 was supposed to do (option A)
Bump the authwit manifest version so `BEGIN_AUTHWIT` CARRIES `salt` + `profile_id`,
and have B3 (`finalize_and_sign.c:112` `b3_verify_consumer_is_this_account`)
recompute the bound address from those carried values — enabling the wallet to
sign for accounts deployed with non-zero salt or alternate account-contract
profiles. Clean break, no back-compat.

## Why we're not doing it (codex consult `019e7fc1-…`, verdict B)
B3's entire value is that the device derives the bound address from data it
**trusts** — its own BIP32-derived signing pubkey + viewing keys, plus
**firmware constants** (`salt = Fr.ZERO`, profile pinned via `cs_deploy_profile_lookup(0)`
/ `SCHNORR_ACCOUNT_CLASS_ID`). The host has no account-selection knob beyond the
path and the claimed `consumer`, which B3 cross-checks (`ct_memcmp32(addr, consumer)`
→ `SW_AUTHWIT_CONSUMER_MISMATCH 0x6F12`, `finalize_and_sign.c:180`).

Option A moves `salt` + `profile_id` from firmware constants to **host-supplied
wire fields** that feed the address preimage (`deploy_address.c:83`). codex's key
point: this does **not** make the check vacuous (the device's own pubkey is still
mixed in, so a host can't generally forge an arbitrary third party's address),
**but it weakens the guarantee**:

> Today B3 proves "this is *the one* firmware-defined account this key controls."
> After A it only proves "this is *some host-selected sibling* account this key
> controls." The host gains account-selection power.

For a PoC whose stated goal is **hardening, not features**, A adds attack surface
and wire complexity to enable generality the demo never uses (it deploys only
zero-salt, profile-0/1 accounts). The current code already **fails closed** on any
non-default account — the secure default is already in place.

## What option A would have REQUIRED to be as safe (codex's bar — for the future)
If the user does want the generality later, A must ship ALL of:
1. `profile_id` is a **firmware-whitelisted index only**, never a raw
   class_id/deployer tuple off the wire (mirror the deploy-side curve/profile
   pairing enforcement).
2. `salt` validated canonical Fr and persisted in session.
3. Fail-closed on absent/malformed/mixed-version bodies.
4. B3 recompute kept both pre-UI and pre-sign (unchanged).
5. **Review UX that explicitly surfaces non-zero salt / alternate profile + the
   bound address** — a truncated address alone (`verified_calls_ui.c:262`) is not
   enough; without this the user can't tell they're authorizing a non-default
   account. This is the expensive part, and on a PoC it would ship *untested*
   (the demo never exercises non-zero salt) — untested security UX is a liability.

codex's bottom line, quoted: *"If you are not willing to ship that UX and test
surface, do not ship P5."* We are not, for a PoC. Hence B.

## What "implementing B" means
The current code **already is** B: it fails closed (`0x6F12`) on any account whose
recomputed address ≠ the claimed `consumer`, rejects unknown manifest versions
(`begin_authwit.c:33`), and documents the zero-salt/pinned-profile assumption
(`finalize_and_sign.c:108-111`, `sw.h:39`). P5's deliverable is therefore the
**decision itself** — we evaluated A, found it a net de-hardening, and kept B —
plus an executable proof of the fail-closed property (the B3 reject test;
previously only the address-recompute *half* was covered, by the parity tests).

## Divergence flag (for the user)
The plan locked "version-bump clean break for the authwit wire." This phase
overrides that based on the consult's adversarial finding. If you want the
non-zero-salt / multi-profile generality, re-open A with codex's 5-point bar above
— the demo does not need it and the override keeps the binding maximally tight.
