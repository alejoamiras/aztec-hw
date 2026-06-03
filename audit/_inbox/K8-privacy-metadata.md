<!-- codex K8 privacy/metadata, read-only xhigh -->

### F-K8-1: `APPEND_CALL` exposes verb, recipient, token, and amount on the local wire
Severity: MED — a passive USB/WebHID observer learns full transaction semantics, including raw amounts, before approval.
Owned: MIXED
Category: WIRE
Location: `packages/adapter-ledger/src/clear-signing-entrypoint.ts:169-172`; `packages/adapter-ledger/src/l4-manifest.ts:283-308`; `ledger-app/src/handler/append_call.c:93-124`
What: each `APPEND_CALL` APDU carries `selector`, `target`, `flags`, `args_count`, and full raw `args[]`; body size is `98 + 32*args_count`, so both contents and shape leak.
Attack-impact: a USB/WebHID sniffer, Speculos MITM, or browser-side hook on transport sees transfer vs mint vs sponsor/drip, token kind, recipient, and raw amount; the 0/2/4-arg size pattern also fingerprints the verb family.
Evidence: `const out = new Uint8Array(3 * FR_BYTES + 2 + call.args.length * FR_BYTES);`; `buffer_read_bytes(... slot->args[i], L4_FR_BYTES)`
Fix-sketch: if local-bus privacy matters, pad `APPEND_CALL` to a constant envelope and accept that true confidentiality needs a different transport trust model than raw WebHID/USB.
Confidence: high
Dedup-check: distinct from AHW-040/050/051/081/082/083; those are UI/log/RPC issues, not APDU-payload leakage.

### F-K8-2: “Forget session” clears the cache but leaves the revealed privacy root in the embedded wallet DB
Severity: MED — after the user clicks forget, a same-origin page/extension with a lingering session reference can still recover the viewing root without another Ledger prompt.
Owned: OURS
Category: DESIGN
Location: `packages/adapter-ledger/src/session-embedded-wallet.ts:46-73`; `apps/demo-browser/src/panels/ConnectPanel.tsx:76-83`
What: `registerExternalAccount()` stores `secretKey: secret` in the in-memory wallet DB, while the only forget path calls `clearAllCachedSecrets()` and drops UI state.
Attack-impact: a co-resident browser page/extension can retain or reach the live session object, read the wallet DB copy, and re-derive viewing keys after the user believed the session was forgotten.
Evidence: `await this.walletDB.storeAccount(address, { ... secretKey: secret, salt, ... })`; `clearAllCachedSecrets(); setState({ kind: 'idle' });`
Fix-sketch: add explicit session teardown on forget/disconnect and scrub/remove the wallet DB account record that carries `secretKey`.
Confidence: high
Dedup-check: distinct from AHW-048 and AHW-079; those covered storage/cache behavior, not this second in-memory retention point after forget.

### F-K8-3: Onboarding silently leaks the derived account address to the RPC operator
Severity: MED — merely onboarding, with no deploy or transfer, reveals a stable account identifier to the node side.
Owned: OURS
Category: DESIGN
Location: `apps/demo-browser/src/panels/OnboardPanel.tsx:106-115`; `packages/adapter-ledger/src/aztec-ledger-session.ts:60-70`; `packages/adapter-ledger/src/aztec-ledger-session.ts:468-470`
What: onboarding automatically calls `session.isDeployed()` as a “best-effort” status check; the session uses deterministic salt by default, so the queried address is stable across reconnects.
Attack-impact: the RPC operator learns which account was onboarded, when it reconnects, and can link repeated sessions even if the user never sends a tx.
Evidence: `ref.alreadyDeployed = await Promise.race([ session.isDeployed(), ... ])`; `const meta = await this.deps.session.getContractMetadata(this.accountAddress);`; `DEFAULT_ACCOUNT_SALT: Fr = Fr.ZERO`
Fix-sketch: defer the deploy-status probe until the user explicitly opens a deploy action, or gate it behind an opt-in.
Confidence: high
Dedup-check: distinct from AHW-082; that finding was about proxy visibility into RPC/simulation/tx traffic generally, not this onboarding-time dormant-account probe.

### F-K8-4: BEGIN frames redundantly send device-derivable account identity in clear
Severity: LOW — metadata only, but it gives a bus observer a stable account/template linkability channel that the device could derive locally.
Owned: OURS
Category: WIRE
Location: `packages/adapter-ledger/src/project-call-intent.ts:25-39`; `packages/adapter-ledger/src/l4-manifest.ts:223-278`; `ledger-app/src/handler/begin_authwit.c:81-103`; `packages/adapter-ledger/src/deploy-context.ts:73-107`; `ledger-app/src/handler/begin_deploy_account.c:145-156,255-314`
What: authwit BEGIN sends `consumer` even though the host always sets it to `this.address`, and deploy BEGIN sends `publicKeysHash` and `expectedAddress` even though the device re-derives both and later verifies them.
Attack-impact: a USB/WebHID observer learns the full account address, scheme/profile, and deploy publicKeysHash in clear, including on rejected flows.
Evidence: `return { consumer, chainInfo, calls };`; `consumer: addressToFrBytes(intent.consumer)`; deploy encoder includes `ctx.publicKeysHash` and `ctx.expectedAddress`; firmware compares `pkh_pass1`/`addr_pass1` to those host fields.
Fix-sketch: let the device use its own derived account identity internally and, if the host needs a check, exchange only a short confirmation digest instead of raw identity fields.
Confidence: high
Dedup-check: distinct from AHW-079; that was an approval-free pubkey pseudonym/cache issue, not repeated cleartext account-identity exposure in the signing wire.

**Confirmed clean**
- The revealed privacy root is no longer persisted to `sessionStorage`/`localStorage`/`IndexedDB`; [secret-cache.ts](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/packages/adapter-ledger/src/secret-cache.ts:1) is memory-only, and firmware disarms the armed reveal secret on approve/reject/reset in [get_aztec_master_secret.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_aztec_master_secret.c:65).
- Reveal UI no longer exposes the full BIP-32 path; it shows `Account #N` plus a 4-hex checksum in [master_secret_reveal_ui.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/ui/master_secret_reveal_ui.c:64).
- `GET_PUBLIC_KEY` and `GET_SCHNORR_PUBKEY` return only `X||Y`; chain code is not exported in [get_public_key.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_public_key.c:67) and [get_schnorr_pubkey.c](/Users/alejoamiras/Projects/aztec-hardware-wallet-poc/ledger-app/src/handler/get_schnorr_pubkey.c:53).
