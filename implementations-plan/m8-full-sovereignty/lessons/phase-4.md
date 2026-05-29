# Phase 4 — INS_GET_AZTEC_MASTER_SECRET

**Status:** host-testable core validated; BOLOS handler/UI Speculos-pending.
**Branch:** `m8-phase-4-master-secret`.
**Tests:** `master-secret.test.ts` 7 pass (128 random wide-reduce vectors +
boundary cases + derivation formula); full M8 suite 30 pass / 0 fail / 4310 expect.

## What this INS does

Reveals the 32-byte Aztec master secret (`Fr`) for a BIP-32 path, after a
high-friction on-device confirmation:

```
secret = SHA-512( DOMAIN || pubkey_x(32) || pubkey_y(32) ) mod Fr
DOMAIN = "aztec-master-secret-v1" + one NUL byte (23 bytes)
Fr     = BN254 scalar field (0x...f0000001 = poseidon2 fr_t / AZ_FR_P)
```

The host runs the result through Aztec's `deriveKeys(secretKey: Fr)` unchanged
to reconstruct the 4 viewing keys + publicKeysHash. This discloses note-VIEWING
capability, never spend authority (spend needs the device's ECDSA-K signing
key, which never leaves).

## Field subtlety (again — and again it matters)

The master secret is `Fr` = BN254 **scalar** field (`0x...f0000001`) — the
SAME field as poseidon2's `fr_t` and as Grumpkin's COORDINATE field (Phase 3),
but DISTINCT from the Grumpkin SCALAR field `gk_fq_t` (Phase 2, `0x...d87cfd47`).
So the master-secret wide reduction is `fr_from_bytes_wide_be` (poseidon2 fr),
NOT `gk_fq_from_bytes_wide_be`. The Phase 6 viewing-scalar reduction WILL use
the gk_fq one. Three fields in play; keep them straight:

| value | field | modulus | reduce-fn |
|---|---|---|---|
| master secret `sk` | BN254 scalar / Aztec Fr | f0000001 | `fr_from_bytes_wide_be` (P4) |
| viewing scalars | Grumpkin scalar | d87cfd47 | `gk_fq_from_bytes_wide_be` (P6) |
| point coords | BN254 scalar / Aztec Fr | f0000001 | n/a (poseidon2 fr ops) |

## Host-testable core (validated)

- `fr_from_bytes_wide_be` (added to `crypto/poseidon2/fr.{c,h}`): Horner over
  the 64 SHA-512 bytes mod Fr. Chose Horner (64 × `fr_mul`+`fr_add`) over an
  R²-folding variant because it's obviously correct with no CIOS input-range
  subtlety — and it runs once per derivation, so simplicity wins. Host CLI mode
  `wide-reduce <hex128>` added to `poseidon2_host/main.c`.
- `master-secret.ts` (host reference + spec): `deriveMasterSecretFromPubkeyXY`,
  `reduceWideToFr` (= Aztec's `Fr.fromBufferReduce`), `AZTEC_MASTER_SECRET_DOMAIN`,
  `masterSecretChecksum`. NOT a second crypto impl — the reduction IS Aztec's.
- `master-secret.test.ts`: 128 random wide-reduce vectors device-vs-`Fr.fromBufferReduce`,
  boundary cases (0, p-1, p, p+1, 2^512-1), determinism, and a
  device-composed check (TS SHA-512 → device `wide-reduce` == reference) that
  proves the device path `cx_hash_sha512` + `fr_from_bytes_wide_be` reproduces
  the spec, modulo SHA-512 being a trusted primitive.
- Host wiring: `INS.GET_AZTEC_MASTER_SECRET = 0x12` (apdu.ts) +
  `provider.getAztecMasterSecret(path, opts)` (path-only wire like GET_PUBLIC_KEY
  + an autoConfirm hook since the reveal gates on approval).

## BOLOS device code (Speculos-pending)

- `handler/get_aztec_master_secret.{c,h}`: parse path, canonical-prefix gate
  (44'/AZTEC' — same as begin_deploy_account), derive secret TWICE + ct-compare
  (fault hardening, mirrors duplicate-sign), compute the 4-hex confirm checksum,
  arm + show the reveal UI. `*_approved` emits the 32 bytes then `explicit_bzero`s
  the armed secret; `*_rejected` wipes + SW_USER_REJECTED. Secret stays
  file-static; only path (G_context) + checksum cross to the UI.
- `ui/master_secret_reveal_ui.c`: NBGL review (TYPE_OPERATION) with Path +
  Confirm pairs and "exposes note visibility, not spending" wording.
- `types.h` INS enum + `apdu/dispatcher.c` case (L4 boundary: resets any
  in-flight session, like GET_PUBLIC_KEY). `APP_SOURCE_PATH += src` auto-globs
  the new files into the device build.

## Open items for the Speculos pass (flagged for codex review)

1. **`cx_hash_sha512` signature** — used as `cx_hash_sha512(in, len, out, sizeof out)`
   returning 64, mirroring the `cx_hash_sha256` usage in finalize_deploy. Verify
   the exact BOLOS prototype on first build.
2. **`STATUS_TYPE_OPERATION_SIGNED` / `_REJECTED`** — used for the post-reveal
   NBGL status screen (semantically a reveal, not a tx sign). If the enum names
   differ in this SDK version, fall back to `STATUS_TYPE_TRANSACTION_*` (proven
   in deploy code). Noted inline.
3. **`TYPE_OPERATION`** for `nbgl_useCaseReview` — deploy uses `TYPE_TRANSACTION`.
   Confirm TYPE_OPERATION renders acceptably; otherwise reuse TYPE_TRANSACTION.
4. End-to-end (BIP-32 child → pubkey → secret) only verifiable on Speculos;
   the math is validated, the glue is not.

## Codex review outcome (session 019e73ce) — BLOCKER-FOUND, fixed

Verdict: **BLOCKER-FOUND.** `fr_from_bytes_wide_be` confirmed algebraically
sound; host parity coverage judged correct. But the derivation source was
broken:

1. **BLOCKER — secret derived from PUBLIC material.** The original derivation
   hashed `pubkey_x || pubkey_y`, but `GET_PUBLIC_KEY` already returns X||Y with
   NO confirmation. A hostile host could call GET_PUBLIC_KEY, compute
   `SHA-512(domain||X||Y) mod Fr` offline, and recover the "secret" + viewing
   keys WITHOUT the reveal gate — collapsing the feature's security premise.
   (Opus's original spec text had the same X||Y slip; I propagated it.) **Fix:**
   derive from the BIP-32 PRIVATE child scalar — `SHA-512(DOMAIN || privkey_d) mod
   Fr` via `bip32_derive_init_privkey_256`. SHA-512 is one-way, so the gated
   disclosure doesn't leak the signing key, but the secret is now underivable
   without the device seed. Host reference + tests updated to
   `deriveMasterSecretFromPrivkey`. **Phase 6 unaffected** — it verifies
   `sk → publicKeysHash/address` for arbitrary `sk` (golden vectors), independent
   of how `sk` is obtained.
2. **MAJOR — unverified NBGL enums.** Switched `TYPE_OPERATION` /
   `STATUS_TYPE_OPERATION_*` to the app-proven `TYPE_TRANSACTION` /
   `STATUS_TYPE_TRANSACTION_*` (the OPERATION variants might not exist in this
   SDK = hard compile failure). Slightly-off success wording accepted.
3. **MINOR — looser path gate.** Bumped the `< 2` prefix check to
   `< L4_MIN_BIP32_PATH` (5), matching the deploy/authwit policy.
4. **MINOR — incomplete wipe.** `explicit_bzero` now covers `cdigest` and
   `s_checksum` (both secret-derived) for a consistent discipline.
5. **NIT — comment** `[0..2]` → `[0..1] (2 bytes)`.

Re-validated: typecheck clean, master-secret.test.ts 7 pass. The derivation
formula in the tests now hashes the privkey scalar; the device sources it from
BIP-32 (Speculos-verified later).

Still flagged for Speculos: `bip32_derive_init_privkey_256` exact prototype +
`cx_ecfp_256_private_key_t.d_len` field (standard crypto_helpers.h, but unbuilt
here), plus the cx_hash_sha512 / NBGL symbols from the original list.

## Why not also build the device handler host-side?

It depends on BOLOS (`os.h`, `cx.h`, `io.h`, NBGL) which has no host build. The
only mathematically-novel part (`fr_from_bytes_wide_be`) was extracted into
poseidon2 and IS host-parity-tested. The handler is glue: path parse → trusted
SHA-512 → tested wide-reduce → NBGL. Codex inspection + Speculos cover it.
