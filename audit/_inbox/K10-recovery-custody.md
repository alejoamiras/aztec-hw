<!-- codex K10 recovery-custody, read-only xhigh -->

### F-K10-1: Live code ships a single-seed custody model, while the recovery spec still claims split-brain 2-of-2 recovery
Severity: HIGH — the implementation and the documented recovery/security model disagree on the actual compromise boundary.

Owned: OURS

Category: DESIGN

Location: [03-recovery-and-backup.md](</Users/alejoamiras/Projects/aztec-hardware-wallet/architectures/03-recovery-and-backup.md:11>), [03-recovery-and-backup.md](</Users/alejoamiras/Projects/aztec-hardware-wallet/architectures/03-recovery-and-backup.md:77>), [03-recovery-and-backup.md](</Users/alejoamiras/Projects/aztec-hardware-wallet/architectures/03-recovery-and-backup.md:128>), [master-secret.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/master-secret.ts:4), [aztec_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/aztec_secret.c:28), [onboarding.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/onboarding.ts:2), [ConnectPanel.tsx](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/apps/demo-browser/src/panels/ConnectPanel.tsx:139)

What: the recovery doc still says Aztec has two independent secrets, says “HW seed alone” cannot decrypt notes, recommends Design C/D, and explicitly says “Do not derive `sk` from the HW seed.” The shipped code does exactly that: it deterministically derives the Aztec master secret from the BIP-32 child private key, reveals it, and feeds it straight into onboarding so reconnecting the same device/seed reproduces the same account. The UI then tells the user “the device (its seed) is the backup; there’s nothing extra to save.”

Attack-impact: users, integrators, and auditors will defend the wrong asset. In the live implementation, seed/path compromise is not just signing-key compromise; it also reconstructs the protocol root for that path. There is no passphrase/SLIP-39 second factor despite the architecture claiming one. Conversely, operational procedures built around a separate protocol-secret backup are fiction, because that artifact is never created.

Evidence: `03-recovery-and-backup.md` says “HW seed alone … cannot decrypt notes” and “Do not derive sk from the HW seed.” `master-secret.ts` says the secret is “derived deterministically from the BIP-32 secp256k1 child PRIVATE key.” `onboarding.ts` says recovery is “reconnect the device → reveal again.” `ConnectPanel.tsx` says “the device (its seed) is the backup; there's nothing extra to save.”

Fix-sketch: either implement the documented Design C/D flow for real, or rewrite the architecture/UI/docs to explicitly declare the actual single-seed model and its consequence: seed compromise is full compromise for that path’s privacy root, and seed loss strands the account.

Confidence: high

Dedup-check: distinct from AHW-047 and AHW-038. Those cover reveal scope and missing custody documentation; this is the higher-level custody/recovery model contradiction.

### F-K10-2: Shipped onboarding can only recover account indices 0–4
Severity: MED — the protocol/device support arbitrary uint31 account indices, but the only shipped onboarding flow hard-limits recovery to five.

Owned: OURS

Category: APP

Location: [OnboardPanel.tsx](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/apps/demo-browser/src/panels/OnboardPanel.tsx:156), [apdu.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/apdu.ts:125)

What: the UI account picker is hardcoded to `[0, 1, 2, 3, 4]`, while `defaultAztecPath(account)` accepts any `uint31` account index. A user can create or fund a higher-index account in the underlying model, but the shipped recovery/onboarding UI cannot select it.

Attack-impact: a user with funds at `m/44'/AZTEC'/n'/0/0` for `n > 4` is pushed toward a different empty account and can misread that as recovery failure or asset loss.

Evidence: `OnboardPanel.tsx` renders `{[0, 1, 2, 3, 4].map(...)}`. `apdu.ts` accepts any account up to `0x7fff_ffff`.

Fix-sketch: replace the fixed dropdown with a validated free-form index input or an account-discovery flow.

Confidence: high

Dedup-check: novel; distinct from AHW-018, AHW-079, and AHW-094.

**Confirmed clean**
- The same selected path is threaded through reveal and session construction in [OnboardPanel.tsx](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/apps/demo-browser/src/panels/OnboardPanel.tsx:55), and I did not find a new silent wrong-path derivation after AHW-064/AHW-070.
- Device-side authwit binding is fail-closed across path, curve, profile, salt, and account: [begin_authwit.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/begin_authwit.c:58) and [finalize_and_sign.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/finalize_and_sign.c:98).
- Chain binding is present at the signature layer: [parity.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/l4/parity.c:123) includes `consumer`, `chain_id`, and `protocol_version` in `outer_hash`.
- Host compromise after reveal still does not by itself export spend authority; the host gets the privacy root, but signing stays device-resident and mismatched deploy/authwit attempts still fail closed on-device.