<!-- codex K1 fault-injection, read-only xhigh -->

### F-K1-1: One skipped callback branch flips Reject to Approve on every reviewed flow
Severity: HIGH — single-fault reject→accept at the final user-intent decision.
Owned: MIXED — NBGL supplies one `confirm` bit, but the app relies on it at a single site with no second app-owned approval gate.
Category: FW-STATEMACHINE
Location: [sign_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/sign_ui.c:49), [deploy_review_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/deploy_review_ui.c:90), [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:198), [master_secret_reveal_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/master_secret_reveal_ui.c:56)
What: every reviewed flow ends in one `if (confirm)` branch into approve vs reject.
Attack-impact: a user can physically reject, and a precisely timed glitch still drives blind-sign, clear-sign, deploy-sign, or privacy-root export.
Evidence:
```c
if (confirm) {
    finalize_after_approval();
} else {
    finalize_rejected();
}
```
Fix-sketch: require a second independent approval latch/check inside the approve path before sign/emit.
Confidence: high
Dedup-check: novel; distinct from F-D-1/AHW-085, which assume approval already happened.

### F-K1-2: Blind-sign approval callback can sign a different hash/path than the user reviewed
Severity: HIGH — single RAM glitch after the review is painted can produce a valid signature over bytes/path not shown on-screen.
Owned: OURS
Category: FW-STATEMACHINE
Location: [sign_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/sign_ui.c:94), [sign_outer_hash.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:126)
What: the UI snapshots `G_context` into display strings, but approval signs by re-reading mutable `G_context.sign_info.outer_hash` and `G_context.bip32_path`.
Attack-impact: host shows benign blind-sign data, user approves, glitch mutates `G_context`, device returns a valid signature for a different hash and/or child key.
Evidence:
```c
format_hash_hex(g_hash_hex, ..., G_context.sign_info.outer_hash, 32);
...
size_t digest_len = cx_hash_sha256(G_context.sign_info.outer_hash, ...);
...
bip32_derive_ecdsa_sign_rs_hash_256(... G_context.bip32_path, ...);
```
Fix-sketch: snapshot reviewed hash/path into immutable approval state and sign only that snapshot.
Confidence: high
Dedup-check: novel; distinct from F-D-1 because this is the blind-sign callback path.

### F-K1-3: Blind-sign OFF is a single-site gate
Severity: HIGH — one skipped branch turns the raw-hash kill-switch from reject into review+sign.
Owned: OURS
Category: FW-STATEMACHINE
Location: [sign_outer_hash.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:111), [sign_outer_hash.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:126)
What: `settings_blind_signing_enabled()` is enforced once, pre-UI; the approval callback never rechecks it.
Attack-impact: with blind signing disabled in Settings, a single instruction-skip still reaches the raw-hash sign path.
Evidence:
```c
if (!settings_blind_signing_enabled()) {
    ... return rc;
}
return ui_display_blind_sign();
```
Fix-sketch: recheck the NVM flag inside `sign_outer_hash_after_approval()` and fail closed on mismatch.
Confidence: high
Dedup-check: distinct from AHW-001 and the blind-sign-toggle remediation; the policy exists but is not FI-hardened.

### F-K1-4: BEGIN_AUTHWIT canonical-path enforcement is single-site and hidden at review
Severity: HIGH — single-fault reject→accept widens signer scope to arbitrary seed-controlled children, and the review does not show the path.
Owned: OURS
Category: FW-STATEMACHINE
Location: [begin_authwit.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_authwit.c:62), [verified_calls_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/verified_calls_ui.c:352), [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:248)
What: canonical Aztec path enforcement happens only in `BEGIN_AUTHWIT`; later review shows only derived `From`/`Scheme`, and signing reuses session path without re-validating canonicality.
Attack-impact: host chooses a non-canonical child path, glitches the BEGIN reject once, and gets a valid clear-signed authwit for that child.
Evidence:
```c
if (!az_bip32_path_is_canonical(G_l4_session.bip32_path, path_len)) {
    return reject(SW_INVALID_PATH_SCHEME);
}
```
```c
g_pairs[n_pairs].item = "From (verified)";
...
bip32_derive_ecdsa_sign_rs_hash_256(... G_l4_session.bip32_path, ...);
```
Fix-sketch: recheck canonical path immediately before signing, and show at least a path/account fingerprint on the clear-sign review.
Confidence: high
Dedup-check: distinct from AHW-064; that added the logical check, this is the remaining FI bypass.

### F-K1-5: Reveal canonical-path gate is single-site; “Account #N” can hide a different child
Severity: HIGH — single-fault reject→accept plus reveal-what-wasn’t-shown on the privacy-root export path.
Owned: OURS
Category: FW-STATEMACHINE
Location: [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:122), [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:132), [master_secret_reveal_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/master_secret_reveal_ui.c:64), [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:183)
What: exact-path enforcement exists only in one pre-UI block; the review shows only `Account #N`, and approval emits pre-derived `s_secret` without rechecking the full path.
Attack-impact: choose `m/44'/coin'/N'/1/7` or an unhardened account variant, skip the canonical-path reject once, and the device reveals that child’s privacy root while the screen still says `Account #N`.
Evidence:
```c
if (G_context.bip32_path_len != 5u || ... G_context.bip32_path[3] != 0u || G_context.bip32_path[4] != 0u) {
    return io_send_sw(SW_INVALID_PATH_SCHEME);
}
```
```c
g_pairs[n].item = "Account"; g_pairs[n].value = g_account_str;
...
memcpy(response, s_secret, 32);
```
Fix-sketch: snapshot full reviewed path or a full-path fingerprint, revalidate canonicality in `master_secret_reveal_approved()`, emit only from immutable reviewed state.
Confidence: high
Dedup-check: distinct from AHW-070/F-B-2 and AHW-094; those were no-fault maintenance/comment issues.

### F-K1-6: Several advertised “double compute” defenses still collapse to one pass if the lone mismatch branch is skipped
Severity: MED — this weakens the claimed FI hardening, but meaningful exploitation also needs a second perturbation of the computed value.
Owned: OURS
Category: DESIGN
Location: [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:149), [sign_outer_hash.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:189), [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:317), [schnorr.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/schnorr.c:85), [begin_deploy_account.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_deploy_account.c:231)
What: many duplicate-pass defenses use one mismatch check site; skip that one branch and the duplication no longer enforces anything.
Attack-impact: a precise follow-on fault in one pass can survive because the app does not do the `dd_eq32_dir`-style two-site compare outside `aztec_secret.c`.
Evidence:
```c
if (ct_memcmp32(pass1, pass2) != 0) { ... }
if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) { ... }
if (ct_diff64(out_sig, sig2) != 0) { ... }
```
Fix-sketch: use two independent compare sites/directions for these checks too, not one branch.
Confidence: high
Dedup-check: distinct from AHW-025; that was missing glitch-sim coverage, this is the implementation shape.

**Confirmed clean**
- Authwit outer-hash binding is materially triplicated: two pre-UI recomputes plus pre-sign recompute against both stored and claimed hashes in [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:165) and [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:207). I did not find a new single-fault sign-what-wasn’t-shown there beyond indexed AHW-085.
- B3 consumer binding is two-site: pre-UI and pre-sign both call `b3_verify_consumer_is_this_account()` in [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:198) and [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:230).
- Deploy FINALIZE signs a device-local recompute, not a mutable session hash, in [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:198) and [finalize_deploy_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:222); the surviving deploy issue is the already-known F-D-1 post-review TOCTOU.
- Session reset/disarm discipline is explicit and broad in [app_main.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/app_main.c:40), [dispatcher.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/apdu/dispatcher.c:54), and [session.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/session.c:10); I did not find a new stale-session or stale-secret hole.
- The Schnorr scalar/nonce derivations are the one place that are genuinely two-site against a single skip: [aztec_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/aztec_secret.c:182) and [aztec_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/aztec_secret.c:210).