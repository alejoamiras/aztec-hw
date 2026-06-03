<!-- codex K3 apdu-statemachine, read-only xhigh -->

### F-K3-1: Blind-sign review can be APDU-clobbered before approval
Severity: HIGH — if a second APDU is accepted while the blind-sign review is on-screen, the device can sign different `(path, outer_hash)` bytes than the user reviewed; that is a direct authorization-integrity break.

Owned: OURS

Category: FW-STATEMACHINE

Location: `ledger-app/src/app_main.c:55-60`, `ledger-app/src/ui/sign_ui.c:49-55,94-121`, `ledger-app/src/handler/sign_outer_hash.c:73-120,126-177,219-223`, `ledger-app/src/types.h:76-83`, `ledger-app/src/handler/get_public_key.c:25-72`, `ledger-app/src/handler/get_schnorr_pubkey.c:23-60`, `ledger-app/src/handler/get_aztec_master_secret.c:99-180`, `ledger-app/src/handler/abort_authwit.c:10-16`

What: `SIGN_OUTER_HASH` arms a deferred approval out of mutable global `G_context`. The review UI renders from that global, returns, and the later approval callback signs by rereading the same global instead of an immutable reviewed snapshot. A foreign single-shot APDU can zero or repopulate `G_context` before approval; `ABORT` does not cancel this pending blind-sign state at all.

Attack-impact: Start `SIGN_OUTER_HASH`, wait until the device shows the blind-sign review, inject `GET_PUBLIC_KEY` / `GET_SCHNORR_PUBKEY` / `GET_AZTEC_MASTER_SECRET` / `ABORT`, then let the user approve the original screen. On a transport path that allows the second APDU, the signature is produced from post-review state, not the reviewed request. With `GET_PUBLIC_KEY`, the effect is especially concrete: the same union storage that held `sign_info.outer_hash` is repopulated with pubkey bytes.

Evidence: `handler_sign_outer_hash()` ends with `return ui_display_blind_sign();`; `ui_display_blind_sign()` wires approval to `sign_outer_hash_after_approval()` and returns `0`; `app_main()` then immediately goes back to `io_recv_command()` on any nonnegative dispatcher return. `get_public_key.c` begins with `explicit_bzero(&G_context, sizeof(G_context));`, and `sign_outer_hash_after_approval()` later hashes `G_context.sign_info.outer_hash` and signs with `G_context.bip32_path`. `types.h` stores `pk_info` and `sign_info` in the same union. The repo’s own skipped Python test notes the raw APDU socket “returns immediately instead of waiting for button presses,” i.e. a known non-blocking path (`ledger-app/tests/test_sign_outer_hash.py:3-12`).

Fix-sketch: Add a dedicated pending-review struct for blind-sign containing an immutable reviewed `(path, outer_hash)` snapshot plus a live request token. Any new APDU, including `ABORT`, must clear that token. Approval must verify the token and sign only the frozen local snapshot, never `G_context`.

Confidence: high

Dedup-check: distinct from in-flight `F-G-1`. That one is a post-review RAM-fault TOCTOU on the same sink; this is a pure APDU-sequencing/cancellation bug requiring no fault injection.

**Confirmed clean**
- `APPEND_CALL` before `BEGIN_AUTHWIT` is rejected and wipes session state: `ledger-app/src/handler/append_call.c:83-86,42-44`.
- `FINALIZE_AND_SIGN` before a normal streamed authwit is rejected; the only accepted no-append case is the intentional `call_count == 0` header: `ledger-app/src/handler/finalize_and_sign.c:152-153`, `ledger-app/src/handler/begin_authwit.c:101-116`.
- `FINALIZE_AND_SIGN` twice does not preserve stale authwit state; success resets before the status UI: `ledger-app/src/handler/finalize_and_sign.c:347-353`.
- `BEGIN_DEPLOY_ACCOUNT` during a live authwit is rejected and wipes both session structs: `ledger-app/src/handler/begin_deploy_account.c:168-178`.
- `FINALIZE_DEPLOY_AND_SIGN` before `BEGIN_DEPLOY_ACCOUNT` is rejected on state: `ledger-app/src/handler/finalize_deploy_and_sign.c:89-92`.
- Mid-stream `GET_VERSION`, `GET_CAPS`, `GET_PUBLIC_KEY`, `GET_SCHNORR_PUBKEY`, `SIGN_OUTER_HASH`, and `GET_AZTEC_MASTER_SECRET` do reset L4 state, so authwit/deploy partials do not resume across those boundaries: `ledger-app/src/apdu/dispatcher.c:69-178`.
- Reveal armed-state does not carry across flows: `l4_session_reset()` disarms it, and both reveal callbacks disarm too: `ledger-app/src/l4/session.c:10-15`, `ledger-app/src/handler/get_aztec_master_secret.c:183-203`.
- `BEGIN_AUTHWIT` double-begin is a full reset/restart, not stale carry-over: `ledger-app/src/handler/begin_authwit.c:29-30`.