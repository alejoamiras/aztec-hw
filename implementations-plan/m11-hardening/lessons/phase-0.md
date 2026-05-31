# M11 P0 — validation infra + baselines (DONE)

## Flash-size baseline (safe-v8 elf, nanos2)
`arm-none-eabi-size build/nanos2/bin/app.elf`: **text=45138, data=0, bss=40960** (dec=86098).
→ P3 size-regression gate: the CT point-core rewrite must keep `text` within budget (allow ~+2–3 KB for complete-formula add/double; flag if it balloons).

## dudect timing-leak harness (`tests/grumpkin_host/dudect.c`, `make dudect`)
Welch t-test over `grumpkin_scalar_mul_generator`, two classes: FIX (scalar=1, max leading-zeros) vs RND (uniform 32B). Crops slow decile per class. `|t| > 5.0` ⇒ leak ⇒ exit 1.

**Baseline on current (branchy) mul — LEAK as expected:**
```
FIX(k=1): mean=15799 ns   RND: mean=169531 ns   Welch t = -2522.56  → LEAK DETECTED
```
The 10× gap is the infinity fast-path in `grumpkin_point_double`/`grumpkin_point_add_affine`: while `acc` is ∞ (all leading-zero scalar bits) both take cheap early-returns, so a small scalar runs ~10× faster than a full-width one — leaking the leading-zero count (and the `H==0` add branch).

**P3 success criterion:** after removing the 3 data-dependent branches (2 infinity short-circuits + `H==0`), FIX and RND converge → `|t| ≤ 5.0` → `make dudect` exits 0, WHILE scalar-mul parity stays byte-identical (7/7) and flash/latency stay within budget.

**Caveat (codex Major):** this is a HOST, ALGORITHMIC gate — it catches secret-dependent CONTROL FLOW, not device µarch leakage. The full DPA/EMA story (incl. `fr_t`/`fq_t` arithmetic constant-timeness) is the documented residual / deferred `cx_math` milestone. Sign-latency on real hardware is a separate perf concern; host ~170µs/scalar-mul is only a relative proxy.

Next: P1 (dual-derive nonce/scalar + hygiene).
