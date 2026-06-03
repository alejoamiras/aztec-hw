<!-- Harvested from codex session 019e89b9-021d-71e1-8183-7d16065e2c98 (read-only, xhigh). Scope: deploy signing path. -->

### F-D-1: Post-review TOCTOU in deploy FINALIZE lets mutable session state diverge from what was reviewed
- Severity: MED — breaks clear-sign trust under a realistic fault/glitch attacker: the user can approve one `Address/#N`, while the signature is produced from later-mutated deploy state
- Owned: OURS
- Category: FW-STATEMACHINE
- Location: `ledger-app/src/ui/deploy_review_ui.c:90-126`, `ledger-app/src/handler/finalize_deploy_and_sign.c:153-205`
- What: The review screen snapshots `Account`/`Address` from `G_l4_deploy_session`, then the approval callback re-reads mutable session fields instead of carrying forward the freshly derived locals. FINALIZE checks `recheck_partial` against `G_l4_deploy_session.partial_address_local`, derives `p6_addr` from `G_l4_deploy_session.partial_address_local`, compares it to `G_l4_deploy_session.address_local`, then recomputes the signed outer hash from `G_l4_deploy_session.address_local`.
- Attack/impact: A malicious host with fault capability can glitch RAM after the review is rendered, or after the `p6_addr` compare, so the user approves the old `Address/#N` but the app signs a deploy for a different path/salt/profile/address carried in mutated session state.
- Evidence: `deploy_review_ui.c:100-105` shows `"#%u"` from `deploy_account_index()` and `address_8_6(..., G_l4_deploy_session.address_local)`; `deploy_review_ui.c:90-93` calls `finalize_deploy_after_approval()` later. In FINALIZE: `ct_memcmp32(recheck_partial, G_l4_deploy_session.partial_address_local)` (`finalize_deploy_and_sign.c:153-155`), `az_account_derive_from_path(... G_l4_deploy_session.partial_address_local, p6_pkh, p6_addr)` (`:174-177`), `ct_memcmp32(p6_addr, G_l4_deploy_session.address_local)` (`:182-183`), then `az_deploy_compute_outer_hash(G_l4_deploy_session.address_local, ...)` (`:199-205`).
- Fix sketch: Freeze the reviewed deploy identity before showing UI, and in the approval path build/sign from fresh locals (`recheck_partial`, `p6_pkh`, `p6_addr`) rather than re-reading `G_l4_deploy_session.*`; also re-compare against the original BEGIN claims, not only cached locals.
- Confidence: high
- Dedup-check: nearest `AHW-085` — same “FINALIZE consumes cached mutable state” family, but distinct: this is deploy-path display/account-identity TOCTOU after review, not authwit `args_hash` re-derivation

### F-D-2: Deploy `fee_mode` is dead metadata; sponsored semantics are assumed, not enforced
- Severity: LOW — not a malicious-host-only exploit today, but it is a fail-open deploy-fee design gap that will matter the moment profiles evolve
- Owned: OURS
- Category: DESIGN
- Location: `ledger-app/src/clear_signing_v0/deploy_profiles.gen.h:23-33`, `ledger-app/src/l4/deploy_outer_hash.h:4-18`, `ledger-app/src/l4/deploy_outer_hash.c:54-72`, `ledger-app/src/ui/deploy_review_ui.c:106-112`
- What: The deploy profile struct carries `fee_mode`, but runtime deploy signing never reads it. The C path hardcodes one PRIVATE `sponsor_unconditionally()` call in `az_deploy_compute_outer_hash`, and the review UI hardcodes `Sponsored (testnet)`.
- Attack/impact: Today both compiled profiles are EXTERNAL/sponsored, so I do not see a live hostile-host exploit beyond known AHW-062. But if a future manifest/build introduces a self-funded or otherwise different deploy fee mode, the firmware will not fail closed; it will still review/sign as if the deploy were sponsored.
- Evidence: `deploy_profiles.gen.h:29-31` defines `sponsor_fpc_address`, `sponsor_selector_u32`, and `fee_mode`; `deploy_outer_hash.h:4-18` says the signed deploy authwit is a single `sponsor_unconditionally()` call; `deploy_outer_hash.c:54-72` hardcodes that call plus canonical padding; `deploy_review_ui.c:107` formats `"Sponsored (testnet)"`.
- Fix sketch: Enforce `profile->fee_mode == CS_FEE_MODE_EXTERNAL` in the deploy path and reject anything else until explicitly implemented; do not hardcode fee semantics in the hash builder/UI.
- Confidence: high
- Dedup-check: nearest `AHW-062` — distinct: AHW-062 is the protocol-level “fee/gas not signed” residual, while this is the app ignoring its own deploy-profile `fee_mode` metadata instead of fail-closing

**Confirmed clean**
- I could not find a malicious-host-only path that bypasses the BEGIN sovereignty gates: `handler_begin_deploy_account` double-derives signing-material/partial address, then double-derives `publicKeysHash` and `address` from the seed and rejects on either host mismatch (`begin_deploy_account.c:184-315`).
- I could not break the current curve/profile pairing at BEGIN without faulting RAM: K1 is only accepted with `CS_DEPLOY_ARG_SCHEMA_ECDSA_K_PUBKEY_XY`, and GRUMPKIN only with `CS_DEPLOY_ARG_SCHEMA_SCHNORR_PUBKEY_XY` (`begin_deploy_account.c:73-89`).
- I did not find a current blind-sign hole in deploy outer-hash construction: FINALIZE recomputes the deploy outer hash locally from device-held values and compares it to the host claim before signing (`finalize_deploy_and_sign.c:191-224`), and `deploy_outer_hash.c` matches `parity.c`’s padding layout.
- I did not find an off-by-one / length / endian bug in `deploy_address.c`: selector encoding, 64-byte-fr ECDSA ctor hashing, 2-Fr Schnorr ctor hashing, and the `2 -> 3 -> 2` Poseidon field counts are internally consistent.
- I did not find a second-APDU host mutation path in normal flow: dispatcher boundaries reset L4 state, BEGIN only accepts `L4_IDLE`, and FINALIZE requires `L4_DEPLOY_CONTEXT`; the live weakness I found is the post-review fault window, not a normal APDU interleaving bug.