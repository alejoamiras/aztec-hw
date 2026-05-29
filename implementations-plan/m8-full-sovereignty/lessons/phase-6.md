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

## 6c codex review (session waJFTaR6) — CHANGES-NEEDED, fixed

Verdict CHANGES-NEEDED, one real MAJOR. Codex positively cleared: secret
hygiene (no missed wipes — sk/digests/scalars/scalar_be all wiped on every
path), `reject()` clears both session structs, the `az_account_address`
Jacobian lift, stack (biggest locals few-hundred bytes, heavy calls
sequential), and all 3 BOLOS prototypes against the actual Ledger SDK headers
(`bip32_derive_init_privkey_256`, `cx_ecfp_256_private_key_t.d`/`.d_len`,
`cx_hash_sha512`).

- **MAJOR (fixed):** the two BEGIN passes shared one `sk` buffer (derive sk
  once → derive account twice), and FINALIZE likewise. So a fault in
  `az_derive_master_secret` (BIP-32/SHA-512/reduce) poisons both passes
  identically — the self-consistency check didn't cover the sk-derivation step.
  Fix: added `az_account_derive_from_path` (account_derive.c) that re-derives
  sk from the seed per call and wipes it; BEGIN now calls it twice (fully
  independent passes), FINALIZE once. No `sk` buffer shared across passes.
  Re-validated: host parity green (5 pass / 389 expect).
- **MINOR:** "a glitch can't sign a bad deploy" isn't fully true until 6d (the
  deploy outer_hash recompute) lands — FINALIZE still signs the host-claimed
  `claimed_outer_hash`. 6c closes protocol-key spoofing; 6d closes blind-signing
  of a bad outer hash. Building 6d next.

## 6d — deploy outer_hash recompute (codex 6d consult + my parallel trace)

Codex consult + my independent trace of the installed 4.2.1 deploy path
triangulated to the same structure (codex's version-specific advice was wrong —
it read the newer aztec-packages *clone*; I verified the installed dep):

**The deploy authwit = the account entrypoint wrapping ONE `sponsor_unconditionally()`
call** (PRIVATE, 0 args, to = sponsor FPC), same SIGNATURE_PAYLOAD / AUTHWIT_OUTER
construction as transfers:
- call 0: args_hash = Fr(0), selector = sponsor_selector (0x23d77f89), target =
  sponsor_fpc, is_public = false, hide_msg_sender = false, is_static = false
- calls 1-4: canonical padding (args_hash = poseidon2([0], PUBLIC_CALLDATA), ...)
- consumer = the new account address = device-verified `address_local`
- The ctor is NOT in this authwit (it rides in the multicall-wrapped payload).

**TWO bugs/findings the 6d trace surfaced (both real):**

1. **Installed 4.2.1 gates the self-paid path on `deployer === ZERO`** (not
   `from === NO_FROM`, which is the newer clone). So Phase 1's `deployer: ZERO`
   is correct; `from` isn't read. Confirmed Phase 1 is NOT broken on that axis.
2. **LATENT PHASE 1 BUG (fixed here):** the deploy authwit nonce defaults to
   `Fr.random()` per `request()` call (encoding.js:67). My two-pass flow (spy
   captures hash in pass 1, frozen provider asserts it in pass 2) would get
   DIFFERENT nonces -> FrozenWitnessMismatchError -> the deploy would throw on
   testnet. Never caught (Phase 1 is Speculos/testnet-pending). Fix: pin a
   deterministic `txNonce` via `fee.feeEntrypointOptions.txNonce` reused across
   BOTH passes (and fed to the device). This fixes Phase 1 AND enables 6d.

**Files:**
- `l4/deploy_outer_hash.{c,h}` (NEW, host-buildable — poseidon2 only):
  `az_deploy_compute_outer_hash(consumer, chain, version, tx_nonce, sponsor_fpc,
  sponsor_selector)` synthesizes the sponsor authwit + computes outer_hash.
- `handler/finalize_deploy_and_sign.c`: after the 6c recompute, recompute the
  deploy outer_hash from device-authored values + compare to claimed_outer_hash
  (-> SW_HASH_MISMATCH) BEFORE signing. Closes the last blind-sign: the device
  now signs a hash it authored.
- `aztec-ledger-session.ts deployAccount`: deterministic txNonce via
  feeEntrypointOptions in both passes (the Phase 1 fix + 6d enabler).
- `grumpkin_host` CLI `deploy-outer-hash` mode + `deploy-outer-hash-parity.test.ts`:
  16 random vectors, device byte-exact vs the REAL @aztec
  DefaultAccountEntrypoint.wrapExecutionPayload (computed offline, no node).

**Validation:** full M8 suite 18 pass / 1091 expect; typecheck clean. The
device deploy outer_hash matches the genuine entrypoint for 16 vectors + the
sponsor selector matches the manifest pin.

**Security framing (codex + me agree):** 6d is defense-in-depth + restores the
"device authors the signed hash" invariant — not a brand-new hard boundary (a
bogus outer_hash is also caught by the frozen-witness pass-2 on host, or fails
on-chain). The hard sovereignty boundary is 6c (protocol-key spoofing).

## Pending to close Phase 6

1. **Codex review of 6c** (the device wiring).
2. ~~6d — deploy outer_hash recompute~~ DONE (see 6d section above).
3. **Speculos integration**: deploy flow end-to-end + adversarial (swap
   publicKeysHash / expected_address → device rejects at the right SW). Plus the
   Phase 4/6 BOLOS-symbol checks (cx_hash_sha512, bip32_derive_init_privkey_256,
   NBGL enums).
