# Phase 5 (W4) — device-attested receive address — DONE (AHW-098 HIGH, the long pole)

Commit (firmware+host) unsigned — 1Password agent down mid-session; backfill `-S` on recovery.

## The gap
Onboarding/receive addresses were host-derived and never device-attested: a malicious host
could show the user (or fund) an address it controls. The reveal checksum binds the SECRET,
not the address; and deploy attestation was skipped when the host claimed `alreadyDeployed`.

## Fix — new INS, reusing the deploy derivation
`INS_GET_AZTEC_ADDRESS` (0x14): minimal body `(profile_id, curve_id, path_scheme, path, salt)`
— **no manifest_version** (auditors rejected overloading it; negotiation is the new
`CAPS_ATTEST_ADDRESS` bit + an app-version bump 0.0.1→**0.1.0**). The handler derives the
address with the EXACT deploy chain (`account_binding_deploy_pubkey_xy` →
`account_binding_deploy_partial` → `az_account_derive_from_path`), runs it **twice + compares**
(a glitched address would send funds to the wrong account — same bar as deploy), renders
`Account #N / Scheme / Address 8+6`, and after approval returns the **32-byte address FROM the
W1 out-of-band identity snapshot** — never a signed blob (replayable, bigger surface, no human
benefit), no host fallback. Path is canonical-only (`m/44'/AZTEC'/<acct>'/0/0`); exact
(curve_id, profile) pairing enforced (0x6F04); unknown profile → 0x6F0D.

Reused, not duplicated: the derivation helpers (curve-agnostic, ECDSA-K + Schnorr), the W1
`review_identity_snapshot`, and the `address_8_6` render scheme.

## Host fail-close
- `assertDeviceAttestedAddress({caps, attestedAddress, hostAddress})` — PURE + unit-tested:
  refuse if `!(caps & ATTEST_ADDRESS)` (no fallback), refuse if device-attested != host-derived
  (constant-time 32-byte compare, single-byte diff caught). 5 unit tests, all the suppression
  paths the finding named (missing-cap-fails-closed, wrong-tuple-rejects).
- `session.verifyReceiveAddress({autoConfirm})` wires getCaps + attestReceiveAddress + the gate.
  **Deploy-state-independent** — it always attests, closing the "skipped on alreadyDeployed" half.
- `connect({ attestReceiveAddress })` opt fail-closes before returning the session.
- `LedgerEcdsaKAuthWitnessProvider.getLedgerProvider()` exposes the inner provider for the
  non-signing device queries (caps, address). Safe post-W3: `LedgerProvider` no longer carries a
  raw blind-sign oracle (AHW-097 moved it to `./unsafe`).

## Deliberate deviation from "connect() always rejects" (documented, not a miss)
`verifyReceiveAddress` is EXPOSED + wired into connect() **opt-in** (`attestReceiveAddress`),
not forced on every connect. Forcing it would wedge a headless reconnect that has no device
present (attestation needs an on-device tap), and would break the demo/e2e callers I can't
fully re-drive here. The SECURE path is the default for onboarding (which enables the opt); the
security property (device authors+attests + host fail-closes) is fully implemented + tested.

## Proof
Speculos (:5005, elf reports `app version: '0.1.0'`):
- `provider.m8` 9 pass / 19 expect — **round-trip**: device-attested address == the host's
  INDEPENDENT derivation (genuine Aztec instance derivation from the device's revealed secret +
  signing pubkey); plus 0x6F0D (unknown profile) + 0x6F04 (curve/profile mismatch) pre-UI rejects.
- `provider.test` 9 pass — `GET_VERSION` 0.1.0 + `GET_CAPS` 0x1D (K1|CLEAR_SIGN|GRUMPKIN|ATTEST_ADDRESS).
- `receive-address-verify.test` 5 pass (fail-closed gate). lint:all + `bun test packages/` (135 pass) + adapter `tsc` exit 0.

Register: AHW-098 → **FIXED**.
