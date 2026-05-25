# aztec-hardware-wallet-poc

Hardware-wallet signing for [Aztec Network](https://aztec.network/) — proof-of-concept implementation.

> **Status**: Phase A. Trezor adapter against the Trezor emulator, blind-sign internal demo.
>
> **Research basis**: companion repo at `../aztec-hardware-wallet/` — see [`architectures/poc-recommendation.md`](../aztec-hardware-wallet/architectures/poc-recommendation.md) for the sequenced plan and [`architectures/08-decision-matrix.md`](../aztec-hardware-wallet/architectures/08-decision-matrix.md) for the rationale.

## Quick start

```bash
bun install
bun run test:all
```

## Layout

```
packages/
├── core/             Shared types: extended AuthWitnessProvider (Option A)
├── adapter-trezor/   Trezor adapter — Phase A target
└── adapter-ledger/   Ledger adapter — Phase C target (production)
apps/
└── demo/             CLI demo: emulator → sign outer_hash → verify
```

## Scheme

- **v0 ship**: ECDSA-K1 via Aztec's `EcdsaKAccount`.
- **First PoC vendor**: Trezor (research velocity via open firmware + emulator).
- **Production v0 vendor**: Ledger (custom device app + Ledger Live distribution).
- **Eliminated for v0**: GridPlus Lattice1 (no public raw-digest signing API).

## Conventions

Inherits the global stack from `~/.claude/CLAUDE.md` and per-project notes from [`CLAUDE.md`](CLAUDE.md). Highlights:

- Bun as PM + runtime + test runner.
- Biome for lint + format.
- 7-day npm `minimumReleaseAge` (supply-chain protection).
- Conventional commits via commitlint; lint-staged on pre-commit.

## License

TBD.
