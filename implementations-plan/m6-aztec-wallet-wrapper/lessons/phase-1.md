# M6 phase 1 — implementation lessons

Logged during the AFK autonomous run. Format: each entry is a non-trivial
decision, codex consult, or surprise — what was wrong/unclear, what was
chosen, why.

## M6.0 — Dripper into slot 3 + DRIP_PUB

### Course-correction: SponsoredFPC address was NEVER wrong

Plan-final.md §3.1 originally pinned the BLOCKER as "M5 has the sandbox
address; testnet needs `0x153bddd…ca4f`". This was based on faulty
pre-research. Reality:

- `@aztec/constants:7` hardcodes `SPONSORED_FPC_SALT = BigInt(0)` —
  protocol-pinned, network-independent.
- Nulo's testnet faucet (`packages/faucet/src/contracts/sponsored-fpc.ts:1`)
  imports that constant and uses it against
  `https://rpc.testnet.aztec-labs.com`.
- The `0x153bddd…ca4f` address came from the accelerator's OWN custom-salt
  FPC deployment (their CI secret `SPONSORED_FPC_SALT`), not anything
  canonical. The salt=0 instance IS deployed on testnet at `0x254082…1257`.

The M5 manifest was already correct. The codex final-critique "BLOCKER" was
overcorrecting on stale evidence. Reverting the swap dissolved the entire
sandbox/testnet phasing conflict and let me restore M6.3 sandbox e2e.

**Lesson:** verify pre-research with a fresh look at upstream constants when
it claims a blocker. Don't trust earlier-session findings without
re-derivation when the cost of being wrong is meaningful work loss.

### Selector computation pattern for new verbs

For DRIP_PUB I computed the selector inline via the same API the codegen's
cross-check uses (`FunctionSelector.fromNameAndParameters`), then pinned
the result in manifest.json. The cross-check then re-derives it from the
artifact at codegen time and refuses to emit if drift.

Alternative considered: leave selector as `0x00000000` placeholder, let
codegen fail with the computed value in the error message, copy back into
manifest. Rejected — that's a 2-pass dance for a one-shot operation.

### Cross-slot decimals rule

Dripper's own registry entry has `decimals=0` (the Dripper does not "have"
decimals — it mints tokens). The amount format on-device for DRIP_PUB
looks up `args[0]` in the registry, asserts TOKEN-kind, then uses THAT
token's decimals for formatting. Coded as an explicit `args[0]` registry
lookup in both `append_call.c` (fail-closed) and `verified_calls_ui.c`
(defense-in-depth).

### CHECK_MODE drift detector vs biome format

Codegen emits the TS files, then biome-formats them. The CHECK_MODE drift
detector compared fresh-generated content against committed (formatted)
content → false-positive drift. Fix: pipe the fresh content through
`bunx biome format --stdin-file-path=<file>` before comparison so we
diff apples-to-apples.

## M6.1 — Provider refactor + WebHID transport

### LedgerTransport.send autoConfirm signature

The casts `transport as SpeculosTransport` in provider.ts were there
because SpeculosTransport's `send()` had an extra `autoConfirm` 2nd arg
that the base interface didn't know about. Two options:

1. Widen `LedgerTransport.send` to accept the optional callback. Concrete
   transports use it or ignore it.
2. Have provider.ts feature-detect via `if ('send' in transport && ...)`.

Picked (1) — cleaner, single dispatch, no runtime branching. The cost is
that `AutoConfirmContext` now lives in `transport.ts` (so the interface
doesn't import from a concrete transport). Re-exported from
`speculos-transport.ts` for back-compat with existing imports.

### WebHID disconnect handling

Real-device tests will be at M6.5, but the disconnect path is worth
modelling now: `@ledgerhq/hw-transport-webhid` emits a `disconnect` event
when the user unplugs the device. We surface it as
`WebHidDeviceDisconnectedError` so the UI can prompt reconnect rather
than spinning forever on a hung exchange. `close()` is idempotent across
disconnects (no-op if already disconnected).

### Deps location

`bun add --filter=...` landed deps in the root package.json instead of
the adapter-ledger workspace. Workspaces hoist them so things ran; the
shape is wrong. Fixed in `066bbd1`: `bun remove` from root, `cd` to
adapter-ledger + `bun add` from there.

## M6.2 — SessionEmbeddedWallet

(TBD — entering this phase next.)
