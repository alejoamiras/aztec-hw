# Phase 6 — device publicKeysHash + address verification

**Status:** 6a + 6b validated; 6c (device wiring) written, Speculos-pending;
6d (outer_hash recompute) pending. Codex review of 6c pending.
**Branch:** `m8-phase-6-device-verify`.

## The payoff

This is the M8 privacy-sovereignty win. Before Phase 6 the device trusted the
host's `public_keys_hash` + `expected_address` on a deploy (stored + displayed,
not verified) — so a hostile host could deploy an account with host-controlled
viewing keys and have the device sign it (the M7 BLOCKER #2 gap). After Phase 6
the device derives its OWN viewing keys from its seed, computes publicKeysHash +
address, and REJECTS on mismatch (`SW_DEPLOY_PUBKEY_HASH_MISMATCH=0x6F0F`,
`SW_DEPLOY_ADDRESS_MISMATCH=0x6F0E`).

## Codex design consult (session 019e... "0n1GDEix") — adopted

Asked codex to design the begin/finalize integration before writing it. Its
decisive calls, all adopted:

1. **All 5 Grumpkin mults in BEGIN, pre-review.** BEGIN ends with verified
   publicKeysHash + address in session; FINALIZE only verifies/signs against
   device-authored values.
2. **Derive TWICE before UI + ONCE after approval (option a).** Sharp point on
   my "does a self-recompute even add anything?" question: the host controls
   BOTH claimed values, so "device == host" is NOT a fault check — a single
   glitched pass can be matched by attacker-chosen host values. The
   self-consistency check across independent passes is the integrity anchor;
   host equality is the sovereignty gate; the FINALIZE pass guards the
   BEGIN→sign window.
3. **Cache only PUBLIC outputs** (`public_keys_hash_local` + `address_local`).
   Never cache sk / viewing scalars / pubkeys; FINALIZE re-derives from seed.
4. **Secret hygiene:** sk + 4 viewing scalars stack-local only; explicit_bzero
   the privkey struct, chaincode, SHA-512 in/out, fr_t sk, gk_fq_t scalars,
   scalar encodings. No secret survives an APDU.
5. **Deferred outer_hash recompute** must land in the same phase (6d) — else
   FINALIZE still signs a host-claimed outer_hash blind.
6. **Traps:** display `address_local` not host `expected_address`; reject
   infinity (zero-scalar) rather than hardcoding is_infinite=0; watch stack;
   `SW_DEPLOY_*_MISMATCH` only for host-vs-device (self-mismatch = generic fault).

## 6a (done, committed) — gk_fq wide-reduce

`gk_fq_from_bytes_wide_be` + viewing-scalar derivation proven against 32 golden
vectors × 4 scalars. See commit + grumpkin-fq-wide-parity.test.ts.

## 6b (done, committed) — publicKeysHash + address

`l4/account_keys.{c,h}` (`az_account_public_keys_hash`, `az_account_address`),
host-build + golden parity (64 vectors × 2 = 128 assertions). Pure functions
(poseidon2 + grumpkin only, no BOLOS) so fully host-tested. publicKeysHash
12-field layout confirmed at point.ts:135 (`toFields=[x,y,is_infinite]`).

## 6c (written, Speculos-pending) — begin/finalize wiring

- `l4/aztec_secret.{c,h}` (NEW): extracted `az_derive_master_secret(path,len,sk)`
  from the Phase 4 handler so the reveal INS AND deploy verification derive sk
  identically. Phase 4 handler refactored to delegate.
- `l4/account_derive.{c,h}` (NEW, device-only — uses cx_hash_sha512):
  `az_account_derive_from_secret(sk, partial) -> {publicKeysHash, address}`.
  Composes the host-tested pieces (sk→scalars→pubkeys→hash→address); rejects an
  infinity viewing pubkey. Domain seps NHK/IVSK/OVSK/TSK from constants.gen.ts.
- `l4/session.h`: + `public_keys_hash_local[32]` + `address_local[32]` (public).
- `begin_deploy_account.c`: derive sk → derive account TWICE → ct-compare
  (self-consistency → SW_HASH_MISMATCH) → host equality (→ SW_DEPLOY_*_MISMATCH)
  → cache locals → wipe sk.
- `finalize_deploy_and_sign.c`: 3rd-pass re-derive + compare vs cached locals
  (→ SW_HASH_MISMATCH) before signing.
- `deploy_review_ui.c`: display `address_local` (device-verified), not host
  `expected_address` (codex trap #1).
- Stale M7 "does NOT defend against protocol-key spoofing" trust-model comments
  in begin_deploy_account.c + session.h updated — that gap is now closed.

**Cost:** 10 Grumpkin scalar mults in BEGIN (2 passes × 5) + 5 in FINALIZE, on
top of the partial-address poseidon2 passes. On real hardware (deferred) this is
the dominant deploy-time cost; revisit with the comb optimization at the Phase 5
benchmark if it matters. On Speculos, irrelevant.

## Validation

- 6a + 6b: host-parity green (golden vectors). The full math chain
  sk→publicKeysHash+address is proven piece-wise.
- 6c device wiring: NOT host-buildable (cx_hash_sha512 + bip32). Compiles on the
  BOLOS/Speculos build only. Its correctness = composition of host-tested pieces
  + the verification/parity/wipe logic, which codex reviews + Speculos confirms.
- Full M8 TS suite after 6c: 16 pass / 0 fail / 1074 expect; typecheck clean.

## Pending to close Phase 6

1. **Codex review of 6c** (the device wiring).
2. **6d — deploy outer_hash recompute** (Phase 1 deferred): FINALIZE must
   reconstruct the canonical deploy call list (init + sponsor) from device-
   authored values and recompute outer_hash, comparing to claimed_outer_hash
   before signing. Codex P6 design #5: ship in this phase.
3. **Speculos integration**: deploy flow end-to-end + adversarial (swap
   publicKeysHash / expected_address → device rejects at the right SW). Plus the
   Phase 4/6 BOLOS-symbol checks (cx_hash_sha512, bip32_derive_init_privkey_256,
   NBGL enums).
