# M12 Phase 0 — deploy-helper dedup → `safe-v15`

## What was duplicated
`begin_deploy_account.c` and `finalize_deploy_and_sign.c` held byte-identical copies of three statics:
- `derive_signing_pubkey_xy` — a 1-line delegate to `account_binding_secp256k1_pubkey_xy` (M11 P4 collapsed the body but left two wrappers).
- `deploy_derive_pubkey_xy` — scheme dispatch (GRUMPKIN → Schnorr scalar → `[k]G`; K1 → secp256k1 child).
- `deploy_compute_partial` — schema dispatch (Schnorr 2-Fr vs ECDSA-K 64-byte ctor args), both sharing the init/salted/partial chain.

The M11 `account_binding.h` comment already anticipated this ("Was 3 near-identical copies… Centralizing removes the drift").

## Design decisions
- **Absorb into `account_binding`, not a new `deploy_binding.{c,h}`.** codex's draft argued for a separate module (layering hygiene); opus argued to absorb (the new helpers *call* `account_binding_secp256k1_pubkey_xy` and *are* account-identity computation). Chose **absorb** — CLAUDE.md's single-responsibility rule cuts for it: account-binding = "derive this device's account-identity inputs from a path + profile." codex's final review agreed the absorption is fine but said update the module contract comment — done (the header now states the broadened scope).
- **PURE param-driven helpers — no `G_l4_deploy_session` reads inside the module** (opus, codex-confirmed). The originals reached into the global (`.salt`, `.curve_id`, `.bip32_path`). The shared helpers take `curve_id` / `bip32_path` / `salt` as explicit params. Wins: (a) unit-testable in isolation (CLAUDE.md: "if a unit can't be unit-tested in isolation it's too big"), (b) no hidden coupling to drift against, (c) P2b's future parse seam can drive them without faking the session. The two call sites already hold the session in scope and pass `.salt`/`.curve_id` explicitly.
- **Binding *checks* stay in the handlers.** The new module only derives — it never decides. The deploy P6 address recompute + cross-check (the security gate) is untouched in both handlers, so a wrong arg fails closed at the address compare (defence in depth).

New surface (`account_binding.h`): `account_binding_deploy_pubkey_xy(curve_id, path, path_len, out_x, out_y)` + `account_binding_deploy_partial(profile, pk_x, pk_y, salt, out_args, out_init, out_partial)`. Bodies lifted **verbatim** (globals → params), preserving the `explicit_bzero(priv,…)` scrub on the GRUMPKIN path.

## Validation
- ✅ **nanos2 `-Werror` build links clean** — `account_binding.c` + both handlers compile with the real SDK headers. (The editor/IDE clang flags `os.h not found` + cascading `SWO_*`/`buffer_t`/`explicit_bzero` "undeclared" — pure IDE-lacks-`-I$(BOLOS_SDK)` noise, present even in untouched files; the docker build is the real gate and it passes.)
- ✅ **host parity 6/6** (`deploy-outer-hash-parity`, `grumpkin-account-parity`, `schnorr-partial-parity`). **Honest caveat (opus):** these compile the *crypto* layer (`deploy_address.c`, `account_keys.c`), NOT the moved handler wrapper — so they prove the *math* is unchanged but do NOT exercise the dedup itself. P0's real gate is on-device.
- ✅ **begin_deploy recompute, both wrapper branches, on real elf:** `deploy-fresh-account` ECDSA #2 (K1 branch) + `schnorr-deploy-review` Schnorr #1 (GRUMPKIN branch) both reached the device deploy review with `errorBanner=""` — the device recomputed the address via the moved wrapper, it matched the host `expected_address` (else reject-before-review), and the review appeared.
- ✅ **finalize_deploy wrapper + sign + on-chain, Schnorr #1:** fresh on-chain Schnorr deploy (`0x1b9e8bb0…`) green — `deploy err=""` (did NOT self-skip → real deploy), then drip + transfer (tx `0x270c8af8…`). Exercises `finalize_deploy`'s pass-3 recompute through the wrapper (GRUMPKIN) + the sign path end-to-end.
- (running) **finalize_deploy K1 on-chain, ECDSA #2:** via the new `SCHEME=ecdsa` env on `schnorr-full-flow`. Completes the plan's mandatory **dual-scheme** on-chain gate.

### Stale-index lesson (cost two false-alarm 15-min e2e hangs)
The deploy-review specs hardcoded index #0/#2, which prior demo runs had already deployed on testnet → the `Deploy account` button is absent → the test times out on its "must be undeployed" precondition, **before** the device runs anything. This looked alarming but never touched the wrapper. Fix folded into P0: the deploy specs now take the index via `SCHNORR_INDEX`/`ACCOUNT_INDEX` env (defaults preserved), so a fresh index can always be targeted. Schnorr #0/#2/#4 are deployed; #1/#3 were fresh. **Do not tag `safe-v15` on parity/build alone — the on-device recompute + the on-chain deploys are the gates that actually exercise the move.**

## Risk posture
Pure semantic no-op: the helper is a pure function of its args; the binding check stays in the handler. A globals→params slip would change the derived address → caught by the on-device recompute (fail-closed) + the mandatory on-chain deploy. Rollback = revert the commit (byte-identical behavior).
