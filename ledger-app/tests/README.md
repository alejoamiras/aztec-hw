# Aztec Ledger app — ragger / pytest test harness (L3)

Mirrors the L3 deliverable in `../../implementations-plan/hw-wallet-poc-ledger/plan-final.md` §216. Runs against Speculos on `nanosp` and `nanox`.

## Local run

```bash
cd ledger-app
python3 -m venv .venv
source .venv/bin/activate
pip install -r tests/requirements.txt

# Build the ELFs for both Nano targets
for sdk in nanosplus-secure-sdk nanox-secure-sdk; do
  docker run --rm -v "$(pwd):/app" -w /app \
    ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest \
    bash -c "rm -rf build && make BOLOS_SDK=/opt/$sdk"
  mkdir -p tests/elfs/${sdk%-secure-sdk}
  cp bin/app.elf tests/elfs/${sdk%-secure-sdk}/app.elf
done

# Run the matrix
pytest --device nanosp tests/
pytest --device nanox tests/
```

## Coverage

| File | What it covers |
|---|---|
| `test_get_version.py` | GET_VERSION smoke |
| `test_get_caps.py` | GET_CAPS advertises CAPS_K1 only on L2 |
| `test_get_public_key.py` | On-curve point, golden-vector pubkey, malformed-APDU defenses |
| `test_sign_outer_hash.py` | Happy path with low-S enforcement, user reject, malformed APDU |
| `test_dispatcher.py` | Bad CLA / INS / P1-P2 rejections, L4 INS bytes reserved in L2 build |

## Golden vectors

`golden_vectors/k1_outer_hash.json` pins the device pubkey + (eventually) the (r, s) signature pair under Speculos's default seed. The seed is fixed by Speculos; bumping it requires regenerating the vector. L4 will additionally pin an `aztec-packages` commit so the outer-hash recomputation parity test can be regenerated against the upstream encoding.

## Ragger conventions

Tests follow Ledger's official `ragger` framework. Standard fixtures:
- `backend` — Speculos backend wrapping the ELF.
- `firmware` — `Firmware.NANOSP` / `Firmware.NANOX`.
- `navigator` — drives button presses / touch taps.

For sign-flow tests, use the `backend.exchange_async` context manager + `navigator.navigate(...)` pattern. `backend.last_async_response` holds the APDU response after the navigator completes.
