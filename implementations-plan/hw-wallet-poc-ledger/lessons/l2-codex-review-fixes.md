# L2 — codex review fixes

## Verdict
Codex's L2 review (session `019e646c-f91e-74c0-86d6-2ffcc861ccde`) returned **2 BLOCKER + 2 MAJOR + 3 MINOR**, all fixed. 19/19 integration tests still green after the changes.

## Key correctness bug uncovered

**BOLOS `snprintf` does NOT support `%lu`.**

`/opt/nanosplus-secure-sdk/src/os_printf.c` guards the `%l` branch behind `HAVE_SNPRINTF_FORMAT_LL`, which is **not** defined by default on nanos+. When that branch isn't taken, `%lu` falls through to the `default:` arm and returns `-1`.

How it manifested: `format_bip32_path` in `src/ui/sign_ui.c` used `snprintf(... "/%lu%s", (unsigned long) v, suffix)`. snprintf wrote `/` then bailed at `%l` and returned `-1` — but the original code did `if (n < 0 || ...) break;` and the caller (`ui_display_blind_sign`) silently kept the truncated `m/` string. The boilerplate-vintage code path **looked** like it worked but was always producing a malformed UI string.

The bug only surfaced once codex's BLOCKER #1 forced the function to **fail** instead of silently truncate. With the strict-validation patch in place, every blind-sign attempt returned `0x6985` immediately. Adding `PRINTF` traces to the handler + UI showed:

```
=> handler_sign_outer_hash: size=53 offset=0
   path_len=5
   after consume: offset=53 size=53
=> ui_display_blind_sign entry
   format_bip32_path=0 path='m/'        ← snprintf wrote "/" then aborted
   reject: format_bip32_path failed
<= SW=6985 | RData=
```

Fix: switch to `"/%u%s"` with `(unsigned) v`. The path components are masked to 31 bits (`p & 0x7FFFFFFFu`) before this point, so the cast is lossless on Cortex-M (where `int` is 32-bit).

## Supported `snprintf` specifiers on BOLOS

From `os_printf.c`:

- `%c %d %s %u %x %X %p` — unconditional
- `%H %h` — hex-buffer (Ledger-specific helper)
- `%l` — only when built with `HAVE_SNPRINTF_FORMAT_LL`, and only `%ll[udxX]`

So **never use `%lu`/`%ld`** in device code unless the build defines `HAVE_SNPRINTF_FORMAT_LL`.

## Other findings + fixes

| Severity | Finding | Fix |
|---|---|---|
| BLOCKER #1 | Path validation too weak (host `>>> 0`, device len-only check, UI silent truncate) | strict `Number.isInteger` + uint32 range on host; `path_len > 0` + trailing-bytes reject on device; UI buffer 80B → 160B and refuses on overflow |
| BLOCKER #2 | L2 acceptance "EcdsaKAccount flow" test missing | new `ecdsa-k-account.test.ts` reproduces `EcdsaKBaseAccountContract.getAuthWitnessProvider()` shape (constructor args + AuthWitness layout) |
| MAJOR #3 | `GET_PUBLIC_KEY` returned 96B (X‖Y‖chain_code) instead of 64B (X‖Y) per plan §215 | drop chain_code from device response + host expects 64B |
| MAJOR #4 | `bip32_derive_ecdsa_sign_rs_hash_256` called with `CX_RND_RFC6979 \| CX_LAST` — off-contract per `lcx_ecdsa.h` | drop `\| CX_LAST` (sole supported flags: `CX_RND_TRNG`, `CX_RND_RFC6979`) |
| MINOR #5 | `apdu.ts SW.HASH_MISMATCH=0x6a82` collided with `SWO_FILE_NOT_FOUND`; sw.h uses 0x6F01 | move host codes to 6Fxx to mirror device |
| MINOR #6 | TS `AZTEC_COIN_TYPE = 1666` baked | `process.env.AZTEC_COIN_TYPE` override, default 1666 placeholder |
| MINOR #7 | `GET_PUBLIC_KEY` p1=1 (display) advertised then discarded | dispatcher rejects p1≠0 with `SWO_INCORRECT_P1_P2` |

## Process notes

- Codex picked these up in a single xhigh pass against the L2 commit. The "looks fine" list (sha256 boundary, secp256k1 constants, low-S, r‖s packing, zeroize discipline) gave us cheap confidence on the parts that didn't get flagged.
- The snprintf bug would have been silent forever without codex's strict-validation push. Worth noting: codex's BLOCKER on path validation surfaced a latent correctness bug, not just a hardening recommendation.
