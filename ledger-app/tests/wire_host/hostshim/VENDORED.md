# Vendored BOLOS SDK files (`lib_standard_app`)

These are **verbatim copies** from the Ledger BOLOS SDK, pinned at **`v26.1.6`**
(`nanosplus-secure-sdk`, the same SDK the device build links —
`ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite@sha256:852e1def…`).

| file | why vendored |
|---|---|
| `buffer.{c,h}` | the APDU wire reader — **the thing under test**; every parser bug is a buffer-cursor bug, so the harness must run the *real* reader, never a reimplementation |
| `read.{c,h}`, `varint.{c,h}`, `write.{c,h}` | `buffer.c`'s closure (`read_u*_be`, varint, write helpers) |
| `bip32.{c,h}` | `buffer_read_bip32_path` support (`buffer.h` includes it) |
| `macros.h`, `status_words.h` | small define-only headers (`UNUSED`, the `SWO_*` ISO status words — pinned so the harness's known-SW assertions + the Speculos differential-replay use the device's exact values) |

`os.h` and `io.h` here are **shims** (not vendored): `os.h` provides `explicit_bzero`;
`io.h` captures the emitted status word into `g_wire_host_last_sw` instead of writing
USB. They are the only divergence from the device, and they touch no parser logic.

## Drift control
A stale vendored copy that diverges from the SDK silently weakens the fuzzer
(false negatives). `make verify-vendored` diffs these against the pinned SDK image
and fails on any difference. It now **fails closed** when docker is unavailable
(can't verify ≠ verified; `VERIFY_VENDORED_ALLOW_NO_DOCKER=1` downgrades to an
advisory skip). **Run it before trusting any fuzz/differential-replay result** —
it is intentionally NOT a build prerequisite (that would force docker on every
iterative fuzz build).

**SDK-version coupling (codex P7 Major-3):** this drift check pins the SDK to
`v26.1.6` (the image hash above), but the *firmware* build uses whatever
`BOLOS_SDK` the caller passes (`ledger-app/Makefile`). If those diverge, the
harness fuzzes one buffer-reader revision while the device ships another, and the
differential-replay's faithfulness claim breaks. **When bumping the SDK, re-pin
BOTH the firmware `BOLOS_SDK` and this image hash together, then re-vendor.**

Closure is light by construction — none of these pull `os.h`/`cx.h` or any
crypto/USB surface (verified at vendoring time), which is why the off-device build
is faithful rather than a partial-SDK reimplementation.
