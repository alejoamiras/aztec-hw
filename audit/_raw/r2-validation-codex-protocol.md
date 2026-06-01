# Round 2 — VALIDATION of codex protocol/crypto candidates (C-PROTO-1..3)

Validator (separate subagent) checked each codex candidate against the INSTALLED `@aztec/*@4.2.1`
source, the canonical Noir in `~/Projects/aztec-packages`, our host adapter, and the BOLOS C app.
Codex stated subtle protocol claims confidently; one headline is REFUTED, two are VALID-NEW.

## Verdict table

| Cand | Codex sev | Verdict | Final sev | Cat | Owned | Note |
|------|-----------|---------|-----------|-----|-------|------|
| C-PROTO-1 | HIGH | **PARTIAL** (headline REFUTED, narrow residue VALID-NEW) | **MEDIUM** | DESIGN | OURS | Deploy is NOT replayable (init nullifier). Real residue: replayable *public* clear-signed txs re-bill SponsoredFPC. |
| C-PROTO-2 | HIGH | **VALID-NEW** (severity confirmed) | **HIGH** | DESIGN | OURS | One reveal = full cross-chain, cross-scheme privacy ROOT (4 master keys). Not in index. |
| C-PROTO-3 | MED | **VALID-NEW** | **MEDIUM** | HOST | OURS | Revealed root persisted in sessionStorage; cache key path-only (scheme-blind). Distinct from AHW-038/045. |

Net: 2 VALID-NEW (1 HIGH, 1 MED) + 1 PARTIAL promoted as a MED residue.

---

## C-PROTO-1 — DECISIVE: deploy is NOT replayable; codex's headline is REFUTED. Narrow MED residue stands.

**Replayable (the deploy authwit, as codex framed it)? NO.**

Line evidence:
- `account.nr:75-78` (canonical `authwit/account.nr`): the `tx_nonce` nullifier is pushed **only** `if cancellable` — `let tx_nullifier = poseidon2_hash_with_separator([app_payload.tx_nonce], DOM_SEP__TX_NULLIFIER); self.context.push_nullifier(tx_nullifier);`. Codex's premise ("tx_nonce nullified only when cancellable=true") is **CORRECT**.
- `aztec-ledger-session.ts:378` hard-codes `cancellable: false` for the deploy. So the deploy's entrypoint emits **no** tx-nonce nullifier. ✔ codex.
- SponsoredFPC has **zero** one-shot guard — `sponsored_fpc_contract/src/main.nr:13-18`: `sponsor_unconditionally()` just `set_as_fee_payer()` + `end_setup()`, "covers transaction fees for users unconditionally." No nullifier/nonce/state. ✔ codex.
- **BUT** the deploy constructor is `#[initializer]` (`ecdsa_k_account_contract/src/main.nr:25-26`; same for Schnorr), which emits the contract-**init nullifier** (`emit_public_init_nullifier.nr` + the private init nullifier `computeSiloedPrivateInitializationNullifier`, asserted in `base_wallet.js:371`). A replay of the deploy app_payload re-runs the constructor → **init-nullifier collision → tx rejected.** The deploy is self-protected and **cannot** be replayed to re-bill the sponsor. **Codex's specific "replayable DEPLOY sponsor authwit" claim is REFUTED.**

**What IS real (the residue, VALID-NEW, downgraded HIGH→MED):**

The device-signed *outer* authwit (over `EncodedAppEntrypointCalls = calls + tx_nonce`, via `computeOuterAuthWitHash`) carries **no protocol-level replay nullifier** when `cancellable=false` — and `cancellable=false` is the framework DEFAULT for **every** tx, not just the deploy (`base_wallet.js:33` `this.cancellableTransactions = false`; passed at `:79`). So replay protection for ANY clear-signed tx rests **entirely** on whichever nullifiers its *inner* calls emit:
- Deploy → init nullifier → safe.
- Private transfers (`transfer_private_to_*`) → note nullifiers → replay = double-spend → safe.
- **Purely-public flows** (`drip_to_public`, public self-transfer with `nonce=0n` at `session.ts:568`, i.e. no inner `authorize_once` authwit-nullifier) → **no protocol nullifier** → a hostile host that retained the device witness can resubmit the SAME signed payload via `DefaultEntrypoint`/`DefaultAccountEntrypoint` with no new device approval; SponsoredFPC re-bills and the public state transition re-executes. Sponsor-fund griefing + unwanted public re-execution (NOT user-fund theft; the from==self transfer just moves the user's own public balance again).

This is **codex's framing inverted**: not deploy-specific (deploy is the one verb that's safe), but a property of clear-signed public txs generally.

**Dedup:** adjacent to **AHW-003** (host doesn't constrain unsigned `cancellable`/fee-mode/authwits on the tx path) but **distinct**: AHW-003 is a host MUTATING unsigned fields *before* proving; C-PROTO-1-residue is post-approval **REPLAY** of a fully-valid device witness, and the fix is different (one-shot sponsor binding / mandatory cancellable-nullifier on public verbs, vs. host-side field guards). Codex's "tangential to AHW-003" note is accurate. **VALID-NEW** as a MED, with the corrected (non-deploy) framing.

**VALID-NEW detail (promote):**
> **MED · DESIGN · OURS — Clear-signed *public* txs have no outer-authwit replay nullifier; SponsoredFPC re-bills.** With `cancellable=false` (the `BaseWallet` default, `base_wallet.js:33`), the account `entrypoint` emits no tx-nonce nullifier (`account.nr:75-78`), so the device-signed outer authwit over `calls+tx_nonce` is, by itself, replayable. Replay protection therefore depends solely on the inner calls' nullifiers: deploy (init nullifier) and private transfers (note nullifiers) self-protect, but purely-public flows (`drip_to_public`, public self-transfer, `session.ts:490-501,568`) emit none. A hostile host can retain the in-band device witness (`clear-signing-entrypoint.ts:183-186`) and resubmit the identical payload via `DefaultEntrypoint`, with no new device prompt; the unconditional `SponsoredFPC.sponsor_unconditionally` (`sponsored_fpc_contract/src/main.nr:13-18`) re-pays each time and the public state transition re-runs. Blast radius = sponsor-fund griefing + unwanted public re-execution (not user-fund theft). **NB:** codex filed this as a *deploy* drain; the deploy is in fact the one self-protected verb (`#[initializer]` init-nullifier collision on replay) — the issue is public clear-signed txs, not deploy. **Fix dir:** force `cancellable=true` (so the tx-nonce nullifier is emitted) for clear-signed public verbs, or make the sponsor authorization one-shot, or drop the unconditional SponsoredFPC for production onboarding.

---

## C-PROTO-2 — VALID-NEW, HIGH confirmed. One reveal exports the full privacy ROOT, cross-chain + cross-scheme.

**Verified claims:**
- Revealed secret = `reduce_Fr(SHA-512("aztec-master-secret-v1\0" ‖ secp256k1-child-priv))` — `aztec_secret.c:28-62` (`MASTER_SECRET_DOMAIN[23]`, SHA-512, `fr_from_bytes_wide_be`). Scoped only by BIP-32 path. ✔
- That one `Fr` expands into **ALL FOUR** master privacy keys on the host: `deriveKeys(secretKey)` (`@aztec/stdlib/src/keys/derivation.ts:95-124`) derives NHK_M (`:98`), IVSK_M (`:99`), OVSK_M (`:100`), TSK_M (`:101`). Not a minimal note-read capability — the full nullifier-hiding + incoming-viewing + outgoing-viewing + tagging root. ✔
- Address derivation **excludes chainId**: `computeAddress(publicKeys, partialAddress)` (`derivation.ts:50-62`) and `computePreaddress` (`:46-48`) take only public-keys + partial address. No chainId/version. So the SAME revealed secret reproduces the SAME viewing identity on every Aztec chain. ✔
- Both schemes consume the SAME revealed secret host-side: `OnboardPanel.tsx:85-90` passes the one `secret` into `connect({ secret, scheme })` for both `ecdsa` and `schnorr`; `connect` runs `deriveKeys(secret)` regardless of scheme (`aztec-ledger-session.ts:245,252`). ✔ — both scheme-accounts at a path share one privacy root, correlatable as one identity.

**Codex over-statement to CORRECT (severity unchanged):** codex lumps "schemes" implying spend authority is shared. It is **not** — the export is the *privacy* root only. The Schnorr signing scalar is rooted in the BIP-32 child priv, **not** the exportable master secret (`aztec_secret.c:90-92`: "Rooting in the BIP-32 child priv (not the host-exportable master secret) keeps spend authority off the reveal surface"), and the ECDSA signing key never leaves the device. The on-device reveal UI is correct that it grants viewing, not spending (`master_secret_reveal_ui.c:83` "Lets this computer see your notes. Not spending."). So the finding is **privacy-root export**, not spend export — still HIGH (privacy is the entire value proposition of Aztec), but the detail must not claim spend leakage.

**UI under-representation (the net-new sting):** both the device screen (`master_secret_reveal_ui.c:82-84` "Reveal Aztec viewing key" / "Account #N") and the host (`OnboardPanel.tsx:139,189` "Derive Account #N viewing keys") frame the export as **per-account note-viewing**. Neither states it is the **privacy ROOT** for that BIP-32 path that (a) deanonymizes activity across **all** Aztec chains (chainId-independent address) and (b) covers **both** ECDSA and Schnorr accounts at that path, correlating them as one identity. A user reasonably believes they exposed one account's incoming notes; they actually exposed the cross-chain, cross-scheme privacy graph for that path.

**Dedup:** NOT a dup. **AHW-016** = no rate-limit on the derivation surface (amplification). **AHW-022** = reveal *success-dismiss* reuses "Transaction signed" wording. **AHW-038** = "Forget" doesn't zeroize. None addresses the **SCOPE** of what the reveal exports or the chainId/scheme correlation. **VALID-NEW.**

**VALID-NEW detail (promote):**
> **HIGH · DESIGN · OURS — "Reveal viewing key" exports the path-wide privacy ROOT across all chains and both schemes.** The reveal returns `reduce_Fr(SHA-512(domain ‖ secp256k1-child-priv))` (`aztec_secret.c:28-62`), which `deriveKeys` (`@aztec/stdlib derivation.ts:95-124`) expands into ALL FOUR master privacy keys — NHK_M/IVSK_M/OVSK_M/TSK_M — not a scoped note-read grant. Address derivation excludes chainId (`derivation.ts:46-62`), so the same secret reproduces the same viewing identity on every Aztec network; and both ECDSA and Schnorr account sessions at a path consume the same secret (`OnboardPanel.tsx:85-90`, `aztec-ledger-session.ts:245`), so one approval correlates both as one identity. The device + host UI frame it as per-account note-viewing ("Reveal Aztec viewing key / lets this computer see your notes", `master_secret_reveal_ui.c:82-84`; "Derive Account #N viewing keys", `OnboardPanel.tsx:189`) and materially under-represent that scope. (Spend authority is correctly NOT exported — Schnorr scalar + ECDSA key stay device-side, `aztec_secret.c:90-92`; this is a privacy-root, not spend, disclosure.) **Fix dir:** state in both UIs that the reveal exports the Aztec privacy ROOT for that path, observable across networks and both schemes; and/or add purpose/scheme/chain domain-separation to the exported viewing material if protocol-compatible.

---

## C-PROTO-3 — VALID-NEW, MED. Revealed root in sessionStorage; cache key is scheme-blind.

**Verified claims:**
- The revealed root is persisted in `sessionStorage`: `secret-cache.ts:38-42` `cacheSecret` writes `secret.toBuffer().toString('hex')` to both an in-memory `Map` AND `sessionStore().setItem(STORAGE_PREFIX + key, hex)`. Survives reload within the tab (the file's own doc says so, `:9-14`). ✔
- After one approved reveal the full `Fr` sits in JS memory + sessionStorage; any same-origin XSS / injected script / extension with storage access reads it with NO new Ledger prompt (`loadCachedSecret` `:45-49` returns it silently). ✔
- Cache key is **path/device-pubkey scoped, NOT scheme-scoped**: `deviceCacheKey` (`onboarding.ts:69-75`) = secp256k1 signing pubkey `x‖y` at that path — the SAME pubkey regardless of Aztec scheme. `OnboardPanel.tsx:64` computes the key with no scheme component. So onboarding Account #N as ECDSA then switching the dropdown to Schnorr at the same index → `loadCachedSecret` HIT → the secret is reused with **no second device approval** (`OnboardPanel.tsx:65-67` sets "cached" and skips `revealMasterSecret`). ✔ codex.

**Nuance (does not change MED):** the scheme-reuse is not a privilege escalation — both schemes at a path legitimately derive the same privacy keys from the same secret (see C-PROTO-2). The bite is UX/consent + persistence: (a) the UI tells the user "Each scheme is its own account" (`OnboardPanel.tsx:184-185`) yet silently reuses one reveal for both, and (b) the root persists at rest in sessionStorage where the file's own threat model ("treat the browser as untrusted — XSS/extension access ≡ reading the viewing root", `secret-cache.ts:11-14`) acknowledges it is exfiltratable. The persistence is a deliberate design choice (documented), but for a HW-wallet whose entire pitch is "secret never at rest off-device," persisting the derived privacy root to web storage is an auditor-flag worth cataloging.

**Dedup:** distinct from **AHW-038** (forget-path doesn't zeroize *heap* secrets — GC timing; about teardown, not at-rest persistence) and **AHW-045** (cached re-onboard renders literal `"cached"` instead of the checksum — a display gap; C-PROTO-3 is the underlying *persistence + scheme-blind reuse*, the cause AHW-045 only surfaces). Same code region as AHW-045 but different defect. **VALID-NEW.**

**VALID-NEW detail (promote):**
> **MED · HOST · OURS — Revealed privacy root persisted in sessionStorage; cache key is scheme-blind.** `cacheSecret` writes the full revealed `Fr` (hex) to `sessionStorage` (`secret-cache.ts:38-42`), so after one approval the privacy root survives reloads within the tab and is readable by any same-origin XSS / injected script / storage-capable extension with no new Ledger prompt (`loadCachedSecret` `:45-49`). The file's own doc concedes "treat the browser as untrusted — XSS/extension access ≡ reading the viewing root" (`:11-14`). Separately, the cache key is the secp256k1 pubkey at the path (`onboarding.ts:69-75`, used scheme-agnostically at `OnboardPanel.tsx:64`), so switching ECDSA↔Schnorr at the same account index silently reuses the cached secret with no second approval — while the UI claims "Each scheme is its own account" (`OnboardPanel.tsx:184-185`). For a HW wallet whose model is "secret never at rest off-device," at-rest persistence of the derived privacy root is the core issue. Distinct from AHW-038 (heap-zeroize on forget) and AHW-045 (the "cached" display string, which is a downstream symptom of this reuse). **Fix dir:** memory-only (drop the sessionStorage write), shortest lifetime, re-reveal after reload; if persistence is kept, gate it behind explicit opt-in + an at-rest-disclosure warning, and incorporate scheme into the cache key (or prompt on scheme switch).
