<!-- codex K2 side-channel, read-only xhigh -->

### F-K2-1: Branchy low-S normalization leaks hidden ECDSA `s` information
Severity: HIGH — every K1 signature branches on secret-derived `s`, and the normalization itself has byte-by-byte secret-dependent control flow.

Owned: OURS

Category: FW-CRYPTO

Location: [ledger-app/src/handler/sign_outer_hash.c:45](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:45>), [ledger-app/src/handler/sign_outer_hash.c:159](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:159>), [ledger-app/src/handler/finalize_and_sign.c:63](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:63>), [ledger-app/src/handler/finalize_and_sign.c:308](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:308>), [ledger-app/src/handler/finalize_deploy_and_sign.c:59](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:59>), [ledger-app/src/handler/finalize_deploy_and_sign.c:295](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:295>)

What: the app decides whether to normalize `s` with a secret-dependent branch, then runs a borrow chain with per-byte branching.

Attack-impact: a timing/power/EM observer learns whether the pre-normalized ECDSA `s` exceeded `n/2`, plus borrow-pattern information from `n - s`. That bit/pattern is not otherwise exposed after low-S normalization, so this is real nonce/key-derived leakage on every K1 signature.

Evidence:
```c
if (s_is_high(s)) {
    low_s_normalize(s);
}
```
```c
if (v < 0) {
    v += 256;
    borrow = 1;
} else {
    borrow = 0;
}
```

Fix-sketch: compute both `s` and `n-s`, derive a mask from a branchless high/low test, and cmov-select the final `s`; do not let the high-S predicate or borrow propagation reach control flow.

Confidence: high

Dedup-check: distinct from AHW-029 (portable-C arithmetic baseline), AHW-068 (cmov barrier), and AHW-019 (comment-truth only).

### F-K2-2: “Branch-free” Grumpkin path still uses short-circuit zero/equality predicates on secret limbs
Severity: HIGH — the Schnorr / Grumpkin path still contains limb-by-limb early exits on secret-derived field elements inside scalar-mul/sign code.

Owned: OURS

Category: FW-CRYPTO

Location: [ledger-app/src/crypto/grumpkin/point.c:19](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/grumpkin/point.c:19>), [ledger-app/src/crypto/grumpkin/point.c:164](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/grumpkin/point.c:164>), [ledger-app/src/crypto/grumpkin/fq.c:74](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/grumpkin/fq.c:74>), [ledger-app/src/crypto/schnorr.c:58](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/schnorr.c:58>), [ledger-app/src/crypto/grumpkin/mul_generator.c:45](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/grumpkin/mul_generator.c:45>), [ledger-app/src/l4/account_derive.c:27](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/account_derive.c:27>)

What: the helpers used to detect zero/equality in the supposedly hardened Grumpkin path are written with C short-circuit boolean chains.

Attack-impact: timing/EM varies with the first non-zero limb of secret-derived `Z`, `H`, `r_orig`, `e_fq`, and `s_fq`. Those predicates sit inside `[priv]G`, `[k]G`, Schnorr signing, Schnorr pubkey export, and viewing-key derivation, so repeated traces leak internal state of the private-scalar and nonce paths.

Evidence:
```c
return a->limbs[0] == 0 && a->limbs[1] == 0 && a->limbs[2] == 0 && a->limbs[3] == 0;
```
```c
return a->limbs[0] == b->limbs[0] && a->limbs[1] == b->limbs[1] &&
       a->limbs[2] == b->limbs[2] && a->limbs[3] == b->limbs[3];
```
```c
uint8_t h_zero = fr_is_zero(&H) ? 1u : 0u;
uint8_t r_zero = fr_is_zero(&r_orig) ? 1u : 0u;
```

Fix-sketch: replace these with fixed-work limb accumulators (`or`/`xor` over all 4 limbs) and derive flags branchlessly; then audit emitted `-Oz` code the same way AHW-068 did for `cmov`.

Confidence: high

Dedup-check: distinct from AHW-029 because this is explicit secret-dependent control flow in our glue/helpers, not just uncertified portable arithmetic residuals; distinct from AHW-068 because the cmov barrier does not harden these predicates.

### F-K2-3: ECDSA duplicate-signature fault check still uses short-circuit `memcmp`
Severity: MED — the fault-defense compare on secret-derived signature bytes is timing-variable on the mismatch path.

Owned: OURS

Category: FW-CRYPTO

Location: [ledger-app/src/handler/sign_outer_hash.c:189](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/sign_outer_hash.c:189>), [ledger-app/src/handler/finalize_and_sign.c:330](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:330>), [ledger-app/src/handler/finalize_deploy_and_sign.c:317](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:317>)

What: the ECDSA duplicate-sign guard uses `memcmp` instead of a fixed-length CT compare, unlike the Schnorr path.

Attack-impact: if an attacker can induce or observe a mismatch, the compare leaks whether divergence was in `r` or `s` and where the first differing byte occurs. Those bytes are secret/nonce-derived and the reject path becomes a prefix oracle.

Evidence:
```c
if (memcmp(r, r2, 32) != 0 || memcmp(s, s2, 32) != 0) {
    return reject(SW_DUP_SIG_MISMATCH);
}
```

Fix-sketch: replace with one 64-byte CT compare or two `ct_memcmp32` calls ORed together before the branch.

Confidence: med

Dedup-check: novel; no indexed AHW covers this ECDSA duplicate-sign comparison surface.

**Confirmed clean**
- `outer_hash`, `args_hash`, `consumer`, `public_keys_hash`, `address`, and master-secret double-derive checks are using fixed-length XOR-accumulating helpers, not `memcmp`: [append_call.c:64](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/append_call.c:64>), [begin_deploy_account.c:50](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_deploy_account.c:50>), [finalize_and_sign.c:56](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:56>), [finalize_deploy_and_sign.c:53](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_deploy_and_sign.c:53>), [get_aztec_master_secret.c:58](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:58>).
- Schnorr’s duplicate-sign check is CT: [ledger-app/src/crypto/schnorr.c:22](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/schnorr.c:22>) and [ledger-app/src/crypto/schnorr.c:86](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/crypto/schnorr.c:86>) use `ct_diff64`; the dual-derive compare in [ledger-app/src/l4/aztec_secret.c:157](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/aztec_secret.c:157>) is fixed 32-byte work in both directions.
- I did not find a new remediation-added secret-dependent branch in settings/path/reveal code; the path/settings gates are on public inputs only: [path_canonical.c:5](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/path_canonical.c:5>), [settings.c:16](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/settings.c:16>), [get_public_key.c:45](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_public_key.c:45>), [get_schnorr_pubkey.c:42](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_schnorr_pubkey.c:42>), [get_aztec_master_secret.c:149](</Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:149>).
