# Phase 5 — host privacy + comment-truth sweep

Commits unsigned (1Password down).

```
[x] P5 — host + comment-truth — DONE (AHW-019 deferred with rationale)
  [x] AHW-048 (HARD ITEM e): revealed privacy root is MEMORY-ONLY (secret-cache.ts) — no
      sessionStorage. Reload re-reveals (one tap). secret-cache.test.ts already memory-only.
  [x] AHW-079: deviceCacheKey pubkey's PERSISTENT-pseudonym half dissolved by the memory-only
      cache; kept as the key for cross-device/index cache-MISS; residual is approval-free
      getPublicKey (platform, AHW-080). Documented at the call site.
  [x] AHW-006: apdu.ts "reserved: M8" labels → LIVE deploy-sovereignty gates.
  [x] AHW-041: preflight.ts + manifest.json no longer claim device-side DRIP token-kind
      enforcement (append_call.c doesn't validate it; device renders a "token" fallback; the
      HOST preflight is the only reject). Corrected the dangerous claimed-more-than-exists.
  [x] AHW-020: "single-pass" Schnorr derivation comments → DUAL-derived (VERIFIED both finalize
      paths call az_derive_schnorr_signing_scalar, dual in aztec_secret.c M11 P1).
  [x] dead adapter-trezor mirror refs removed from auth-witness-provider/index/provider headers.
  [~] AHW-019: DEFERRED — see lesson below.
```

## Lessons

### Comment-truth findings split by DIRECTION — and the direction decides the risk
- **Overstated** (claims MORE security than exists): AHW-041 — "enforced device-side in
  append_call" was false. These are DANGEROUS; fixed first.
- **Understated** (code MORE hardened than docs): AHW-006 ("reserved" live gates), AHW-020
  ("single-pass" but dual-derived). Lower harm, but I VERIFIED the code before rewriting (the
  finding's ⚠) — AHW-020 only after confirming both finalize paths call the dual-derive scalar fn.
- **AHW-019 deferred**: the finding ITSELF warns "overstating side-channel resistance is the worst
  direction" + "confirm against the dudect result first". point.c is branch-free at the op level,
  but asserting the OVERALL mul is constant-time (no bit-length leak) needs the dudect timing
  result, which is out-of-env. The current comments are conservatively SAFE ("NOT
  side-channel-resistant"); correcting the early-return→cmov mechanism could read as a stronger
  claim, so it stays gated. Leaving a conservative-but-stale comment beats overstating CT.

### secret-cache: memory-only is a real behavior change, but pre-decided
sessionStorage survived reloads + was same-origin-readable (XSS exfil of the privacy root with no
new prompt). Memory-only means a reload re-reveals. The live in-RAM value is still readable while
present (unavoidable). The cache key is scheme-blind ON PURPOSE — the secret is the ONE privacy
root, identical for ECDSA/Schnorr at a path (the single reveal authorized both).

### Speculos files each need their OWN fresh device
The full-suite combined run had 1 timeout-fail: provider.test.ts's blind-signing beforeAll (ON)
bled into blind-signing-toggle's "starts OFF" precondition on the SHARED emulator. Every file
passes in isolation. Device tests must run per-file-isolated (the parallel-safe-E2E principle in
CLAUDE.md) — a single shared Speculos interleaves NVM/UI state across files.
