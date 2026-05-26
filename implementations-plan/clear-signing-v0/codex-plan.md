# Clear-signing v0 — Codex xhigh independent plan

> Note: codex ran in read-only sandbox and could not write directly. This file is
> the verbatim response captured from the codex session
> `019e65b9-fbbc-7412-a07f-36404fdba3ad` (see
> `/var/folders/.../codex-bfpTWSYg/response.md`).

## 1. Problem Statement

L4 solved the wrong problem well. It proves that the host and device can agree on
an `outer_hash`, but it still asks the user to approve opaque host-provided
semantics. Today the host can choose `args_hash`, show some friendly text
off-device, and the Ledger only verifies that the same opaque bytes made it into
the Poseidon path. That is integrity of framing, not integrity of intent.

For v0, the device should stop being a hash cop and start being a narrow FT
intent verifier. Because scope is intentionally closed, the right design is not
"best-effort decoding with fallback." It is "strict allowlist or no signature."

Clear-signing v0 is a small formally-bounded language for Aztec FT authwits. The
host may transport the proposal, but the device must own contract identity,
selector meaning, amount scaling, and `args_hash` recomputation. Unknown calls
do not degrade to raw hex inside this path.

## 2. Wire-Format Extension

Keep streaming. Extend `APPEND_CALL`. Don't add INSes; don't chunk.

- `MANIFEST_VERSION = 2`
- Body: `claimed_args_hash[32] | selector[32] | target[32] | flags[1] | args_count[1] | raw_args[args_count][32]`
- `L4_MAX_ARGS = 4` (4-arg transfers + 2-arg mints; 226-byte body fits in 255-byte APDU)
- Parser branches on `session.manifest_version` for short transitional period; adapter defaults to v2 immediately.

## 3. On-Device `args_hash` Recompute

Two-stage:
- `APPEND_CALL v2`: canonical-Fr check raw args, verify `args_count` matches selector table, recompute `args_hash`, compare, reject on mismatch.
- `FINALIZE_AND_SIGN`: existing three-pass shape, but `l4_compute_outer_hash` now derives each call's `args_hash` from STORED RAW ARGS on every pass. The session stores raw args + metadata, NOT a trusted hash. Closes the glitch window between append and finalize.

Sign step still consumes the just-validated local buffer (preserves the L4 TOCTOU fix).

## 4. Registry + Decoder

Single local source-of-truth manifest in THIS repo. Generate both TS and C tables from it. Do NOT depend on sibling repo paths at build time. Use faucet `deployments.json` as cross-check, not authority.

Registry table (exactly 5 slots):
- USDC token
- ETH token
- Dripper utility
- reserved zero
- reserved zero

Selector table keyed by `(kind, selector, expected_is_public, arg_count, action_enum)`. Hardcode the six approved signatures in the local manifest; derive selectors from those literal signatures. CI compares against pinned `@defi-wonderland/aztec-standards` artifact as a drift detector, not authority.

**Strict allowlist (the v0 thesis):**
- registry miss → reject
- selector miss → reject
- arity mismatch → reject
- visibility mismatch → reject

No raw-hex fallback inside clear-signing. Blind signing requires the legacy `SIGN_OUTER_HASH` INS.

## 5. UI Design

Header: Path / Account / Chain / Calls.
Per call: Asset (symbol + decimals + short address) / Action (Priv→Pub, Pub→Pub, Mint Pub, etc.) / To / Amount (exact decimal from raw integer + on-device decimals).

Extra invariant: for 4-arg transfer functions, **`from` MUST equal `consumer`**. Otherwise reject. PoC UI cannot honestly explain delegated spend; remove that surface.

Decimals fully device-side. No host symbols, no host decimals, no scientific notation. NBGL budget: 4 + 4*5 + 1 = 25 pairs worst case, tolerable.

## 6. TS Adapter Changes

- `packages/adapter-ledger/src/l4-manifest.ts`: stop rejecting private calls; mirror Aztec's public/private split; extend `AzCall` with `argsCount` + `rawArgs`; emit v2 bodies; preflight every call against the same tables the device uses.
- New: `packages/adapter-ledger/src/clear_signing_v0/{registry,selectors}.generated.ts` + `preflight.ts`
- New: `packages/adapter-ledger/scripts/gen-clear-signing-v0.ts` — same generator emits C tables under `ledger-app/src/clear_signing_v0/`.

Host preflight fails fast on unsupported contract/selector/visibility/arg-count/missing-decimals. Device remains final authority.

Regression tests: public hash parity, private hash parity, zero-arg private semantics, missing raw args, registry miss, token/selector mismatch, decimals spoof attempt, `from != consumer` rejection.

## 7. Alpha-Testnet End-to-End Test

The decisive tx MUST exercise the PRIVATE `fromArgs` path. Otherwise we haven't proven the new work.

Sequence:
1. Node client → `https://rpc.testnet.aztec-labs.com`. PXE wrapper following `aztec-starter/src/utils/setup_wallet.ts:6`.
2. Register SponsoredFPC + USDC + ETH instances in PXE (faucet's `sponsored-fpc.ts:11` pattern).
3. Instantiate `LedgerEcdsaKAccountContract`; create via `wallet.createAccount({ secret, contract, salt })` per `aztec-packages/yarn-project/end-to-end/src/e2e_account_contracts.test.ts:50`.
4. Deploy with `getDeployMethod().send({ from: AztecAddress.ZERO, fee: { paymentMethod: sponsoredFpc } })`.
5. Fund the Ledger account's private USDC from an external funded wallet (NOT through Dripper clear-signing — out of scope for this milestone).
6. Submit `transfer_private_to_public` or `transfer_private_to_private` for a small USDC amount. THIS is the decisive tx.
7. Verify post-state via `balance_of_private` + `balance_of_public`.

Failure modes:
- losing `secret`/`salt` for the custom account
- forgetting PXE contract instance registration
- chain/version mismatch (Nulo pins alpha-testnet to chain `11155111` + rollup `4127419662` per `nulo-2/packages/faucet/src/lib/chain-info.ts:21`)
- self-transfer nonce semantics (Aztec tests show non-zero self nonce can fail)
- private note sync lag after funding

## 8. Security & Adversarial Considerations

- Host args lie → device recomputes from raw args, rejects before user sees screen.
- Host claims "USDC" for non-USDC address → registry lookup is address-keyed; host never injects symbol/decimals.
- Strip raw args → strict-allowlist rejects (no fallback).
- Mismatched (contract, selector, args) → decoder key includes kind + selector + visibility + arity. `from == consumer` invariant for transfers.
- Glitch attacks → no single recompute. Append-time recompute + three-pass finalize from raw args.
- Supply-chain compromise of aztec-standards → local manifest is reviewed authority; pinned package is drift detector only.
- Registry squatting → operational mitigation (pin chain/version + addresses, rebuild on redeploy). Residual v0 weakness; document honestly.

Extra risks worth naming: host/device version skew (one generator, fail fast on version mismatch); amount-formatter bugs (test max u128, zero, sub-unit, long ETH decimals).

## 9. Phasing, Success, Deliverables, Open Questions

Phase 1: freeze manifest + selector strings + registry source file.
Phase 2: v2 wire parsing + raw-arg session storage + on-device public/private re-hashing.
Phase 3: registry decode + semantic UI.
Phase 4: TS adapter + Speculos tests.
Phase 5: alpha-testnet w/ Ledger-backed custom account + private USDC transfer.

Success:
- device rejects unsupported (contract, selector, visibility, arity, missing raw args)
- device displays token, action, recipient, exact amount for supported FT calls
- private-call `fromArgs` implemented + parity-tested
- real alpha-testnet tx from Ledger-backed account is mined, exercising a PRIVATE FT transfer

Open questions:
- Dripper decoding in this milestone, or secondary helper?
- Manifest v1 compat after v2 host migration?
- How `secret`/`salt` persists across repeatable testnet runs?
