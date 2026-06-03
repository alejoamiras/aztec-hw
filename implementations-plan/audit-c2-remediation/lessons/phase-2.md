# Phase 2 (W5) — Schnorr key-residue scrub — DONE ✅

AHW-100 (MED). Firmware-only. Verified: `docker ledger-app-builder-lite make` exit 0 (fresh elf `bin/app.elf` Jun-3 11:06); `-Oz` asm confirms the volatile wipe survives. Signature value unchanged **by construction** (scrub runs after `out_sig` is set + after the dual-pass fault compare). Full Speculos Schnorr parity rides the P7 matrix (value can't change, so this is confirmation not risk).

## The fix
`sign_once` (`schnorr.c`) computed `pe = priv·e` and `s_fq` but only scrubbed `priv_fq`/`k_fq`. **`pe` is the dangerous residue:** `e` is public (in the signature), so leftover `pe` recovers `priv = pe·e⁻¹`. Now ALL secret-derived `gk_fq_t` are wiped (`priv_fq`, `k_fq`, `pe`, `s_fq`), plus the `fq.c` helper temporaries (`gk_fq_from_bytes_wide_be`'s `acc`/`term`, `gk_fq_to_bytes_be`'s `normal`) at the helper level so the secret callers in `aztec_secret.c` are covered by construction.

## The two traps (both real, both avoided)
1. **`gk_fq_zero` inlines → dead-store-eliminable under -Oz.** The first attempt used the existing `gk_fq_zero`. The asm showed only **2 of ~8** calls survived as `bl` — the rest inlined to zero-stores into dead stack slots, which `-Oz` can drop → the secret would **not actually be wiped** and AHW-100 wouldn't truly be fixed. This is the AHW-068 (cmov value-barrier) class.
2. **`explicit_bzero` is wrong here.** It's the codebase's wipe elsewhere (app_main.c) but needs BOLOS `os.h`. `fq.c`/`schnorr.c` are compiled by the **host parity oracle** (plain clang, differential-replay) — pulling `os.h` into these crypto leaf files would break that host build. clangd's "undeclared explicit_bzero" was therefore a TRUE signal here, not the usual SDK-path false-positive.

## The solution
New `gk_fq_secure_wipe(gk_fq_t*)` in `fq.c`/`fq.h`: a `volatile uint64_t*` loop the compiler MUST emit. asm (`build/nanos2/dbg/app.asm`):
```
c0de090a <gk_fq_secure_wipe>:
   movs r1,#0 ; movs r2,#0 ; [loop] cmp r2,#32 ; bxeq lr ; adds r3,r0,r2 ; adds r2,#8 ; strd r1,r1,[r3] ; b .n
```
→ `strd r1,r1,[r3]` with `r1=0` writes 0 over all 32 bytes; volatile ⇒ not elided. Cross-platform (no `os.h` ⇒ host oracle still builds), distinct from the legit zero-element `gk_fq_zero` (kept for `&zero` comparison operands). Defined + 3 `bl` calls + inlined elsewhere (inlining preserves the volatile stores).

## Note
This is the right primitive for the broader AHW-126 "duplicated/weak C scrub" theme too — a shared volatile-wipe. Left scoped to gk_fq_t here; a generic `secure_wipe(void*,size_t)` is the W7/deep-plan follow-up if more types need it.
