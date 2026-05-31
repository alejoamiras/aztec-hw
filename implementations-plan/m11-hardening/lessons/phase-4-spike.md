# M11 P4 spike — private-mode `from`-binding (codex Minor / opus flag): NO GAP

**Question (opus/codex):** does the B3 self-spend gate bind `from` for the PRIVATE transfer modes, or only public — i.e. could the device sign a private transfer where `from` ≠ the account (delegated spend) without rejecting?

**Investigation:**
- `finalize_and_sign.c::b3_verify_consumer_is_this_account` recomputes the account address and cross-checks `consumer` — the gate for drip. For transfers, the comment (`finalize_and_sign.c:118-121`) notes APPEND_CALL additionally pins `from == consumer`.
- `append_call.c:141-146`: `if (verb_is_4arg_transfer(verb->verb)) { if (ct_memcmp32(slot->args[0], consumer) != 0) reject(SW_DELEGATED_SPEND_UNSUPPORTED); }`.
- `verb_is_4arg_transfer` (`append_call.c:71-81`) returns true for ALL four: `TRANSFER_PRIV_PUB`, `TRANSFER_PRIV_PRIV`, `TRANSFER_PUB_PRIV`, `TRANSFER_PUB_PUB`.
- manifest.json: all four transfer verbs have `args = ["from","to","amount","nonce"]`, `wire_arg_count = 4`. So `args[0]` is `from` (the spender) in EVERY mode, public and private alike. The only public/private difference is the `is_public` visibility flag (checked separately at `append_call.c:137-139`).

**Conclusion: NO GAP.** `from == consumer` is enforced for all 4 transfer modes (the check is visibility-independent and `from` is uniformly `args[0]`). Together with B3 (`consumer == this account`), the device enforces `from == consumer == account` — self-spend only; delegated spend is rejected with `SW_DELEGATED_SPEND_UNSUPPORTED` — for public AND private transfers.

**Impact:**
- P6 (4-mode on-chain matrix) is VALIDATION ONLY — no binding fix needed.
- `safe-v13`'s "provisional pending spike" note in plan.md is CLEARED.
- Residual to verify in P6: that the host actually places `from` at `args[0]` for each mode (the device enforces it, so a host bug fails closed, not open) — covered by the on-chain matrix.
