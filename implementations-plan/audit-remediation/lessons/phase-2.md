# Phase 2 — device UI (firmware C) + the validation loop

## Firmware validation loop WORKS in this env (corrected — I was wrong earlier)
Earlier I declared firmware "blocked" after checking the *system* Python. Wrong: the project venv
+ docker have everything. The confirmed write→build→validate loop:
1. **Build:** `docker run --rm -v "$PWD/ledger-app:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest bash -c "make BOLOS_SDK=/opt/nanosplus-secure-sdk"` → `ledger-app/build/nanos2/bin/app.elf` (build/ is gitignored).
2. **Speculos:** `docker run -d --name speculos-aztec --rm -p 5001:5000 -p 9999:9999 -v "$PWD/ledger-app/build/nanos2/bin:/app" ghcr.io/ledgerhq/speculos:latest --display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf` (poll `POST :5001/apdu`).
3. **Validate:** `SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/<test>.ts`.
Proven: clean rebuild → fresh elf; Speculos runs it; `getPublicKeyXY` + `b3-consumer-binding` pass.
- **Note:** `ledger-app/.venv/bin/speculos` (0.26.8) + ragger also present (alt to docker speculos).
- **Gap that remains:** the TESTNET matrix (network + funded account) — Speculos covers device behavior.
- **clangd diagnostics** on the .c files are false positives (no SDK include path in the IDE); the docker build is the real compiler.

## Checklist
```
[x] P2 — device UI — COMPLETE (all items proven on the FRESH elf via AHW-046, 15 assertions green)
  [x] AHW-050 — short_hex_field 8+8 (was 4+4); g_call_from/to buffers 24→40.
  [x] AHW-052 — ASCII ".." marker (was U+2026, which the Nano font lacks).
  [x] AHW-040 — DRIP render: "Drip" + Amount (token decimals/symbol via args[0] cross-slot lookup) +
      "To: you (drip)". AHW-046 asserts NOT "Call DRIP" (the old unrendered bug) + "you (drip)".
  [x] AHW-051 — format_amount_with_raw: "<scaled> <SYM> (raw <int>)" on transfer/mint/drip; buffer 2×.
      AHW-046 asserts "1.5 USDC (raw 1500000.0)" etc. — magnitude can't be hidden by a wrong decimals.
  [x] AHW-053 — FULL outer_hash on the tail (was 8+8). NBGL paginates it "(1/2)/(2/2)"; AHW-046 strips
      those tags and asserts the exact 64-hex appears contiguously.
  [x] AHW-054 — review subtitle scopes verification honestly ("Account verified on-device; amounts +
      recipients are host-provided"). AHW-046 asserts it.
  [x] AHW-055 — mint WARNING forced to top of its own page (forcePageStart) + "creates new supply".
  [x] AHW-047/022 — reveal "privacy root" wording + custom "Privacy root revealed" status
      (nbgl_useCaseStatus, not STATUS_TYPE_TRANSACTION_SIGNED). AHW-046's reveal step matches "root?".
  [x] AHW-046 — verified-calls-content.test.ts (Speculos screen-text assertions) — THE gap that hid
      AHW-040. ONE multi-verb authwit driven through the review on the ACCEPT path; 15 assertions.
```

## Lessons (this session)

### CRITICAL: an orphaned Speculos container ran a STALE elf for most of the session
A `speculos-aztec-playwright` container (up 18h from a prior session) held port 5001. My
`docker run --name speculos-aztec -p 5001:5000 … >/dev/null 2>&1` SILENTLY FAILED on the port
collision, and my `curl :5001/apdu` readiness probe PASSED because the OLD container answered. So
every "B3 no-regression" this session validated the 18-h-old elf, not my fresh builds. The AHW-046
**content test exposed it** (render showed 4+4 / U+2026 / "Call DRIP" / no-raw — all pre-fix).
- **Fix:** run my own Speculos on a clean, non-colliding port (5005/9995), and `docker inspect` to
  confirm the container is mine + mounts `ledger-app/build/nanos2/bin`. Re-ran B3 + AHW-046 there.
- **Takeaways:** (1) NEVER `>/dev/null` a `docker run` whose success you depend on — check the
  container actually started. (2) A readiness probe that hits a shared port proves *something*
  answers, not that YOUR build answers — verify the mount/version. (3) B3 reject is UI-independent,
  so it's a WEAK freshness signal; only a content/render test proves the UI elf is fresh. (4) AHW-046
  retroactively validates AHW-040/050/051/052 on the fresh elf (they'd only been checked vs the orphan).

### show-full: the nbgl value-alias is counterproductive on Nano (dropped)
HARD-ITEM (c) wanted recipient "8+8 (+show-full)". I first wired the canonical nbgl alias
(`aliasValue` + `extension.fullValue`). On Nano it SHRINKS the inline value to fit the alias
affordance → the recipient collapsed from a fully-visible 8+8 to `0x…8 bytes..partial…` — a
regression of AHW-050, the exact "over-truncation" the user said to avoid. **Decision (user's stated
priority = 8+8 visible wins):** keep the recipient a plain, fully-visible 8+8 (wraps across lines),
and deliver show-full via the now-complete outer_hash (AHW-053), which cryptographically commits to
the exact recipient. The alias remains the right choice on Stax/Flex, but we build/test Nano.

### Reaching the verified-calls review on the ACCEPT path (the AHW-046 recipe)
B3 (`finalize_and_sign.c`) recomputes the account address from the SESSION path + signing pubkey +
master-secret viewing keys with **salt = Fr.ZERO, profile 0** (= DEFAULT_ACCOUNT_SALT). To make B3
accept, `consumer` must equal that address: getPublicKey(path) + getAztecMasterSecret(path) →
deriveAztecKeysFromMasterSecret → getContractInstanceFromInstantiationParams(EcdsaKAccountContractArtifact,
{constructorArgs:[x,y], salt:Fr.ZERO, publicKeys, deployer:ZERO}).address. (provider.m8's salt=Fr(5)
was just an arbitrary deploy-gate value, NOT the B3 salt.) Speculos drive gotchas: NBGL paginates
wrapped values into many pages (scroll-until-marker, not a fixed count); capture each page BEFORE
advancing (else clearEvents wipes the intro title); push captures into a shared sink DURING the
scroll (the final 'both' unblocks the host APDU and races a return-value assignment).

## Remaining phases
- P3 — `blind_signing` NVM toggle + Settings UI (HARD ITEM a) + path-canon (AHW-064) + rate-limit (AHW-016) + cmov (AHW-068).
- P4 — B3 wire-v3 (salt+profile_id, derive-don't-trust) — codex consult first, then implement + Speculos negative tests + fuzz/differential-replay regen.
- testnet matrix — needs network + funded account (out of this env).
