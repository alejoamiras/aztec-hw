# `aztec-ledger` extraction — boundary-purist plan

> Framing: **dependency hygiene above all.** The deliverable is judged by one
> question — does the published `aztec-ledger` package compile and run with a
> dependency closure that contains **zero** `@aztec/pxe`, `@aztec/wallets`,
> `@aztec/noir-contracts.js`, `@defi-wonderland/aztec-standards`, and zero
> generated FT registry? Everything else is secondary. I traced every non-test
> import in `packages/adapter-ledger/src/`; the boundary is achievable, but there
> is exactly **one** load-bearing knot to cut and **one** shared-codegen
> constraint that the naive "move the manifest to the demo" answer gets wrong.

## 1. Problem / goal

`packages/adapter-ledger/` is a PoC package: it mixes the genuinely reusable
"use a Ledger as an Aztec signer" SDK with M6-demo glue (an in-browser
`EmbeddedWallet` subclass, a `Contract`/`AccountManager` session orchestrator,
and a hard-coded clear-signing registry for four specific testnet contracts).
The reusable surface is welded to `@aztec/pxe` + `@aztec/wallets` +
`@aztec/noir-contracts.js` purely through that glue. A downstream wallet/dApp
that wants Ledger signing should not be forced to pull a PXE server or the Noir
contract artifacts into its bundle.

**Goal:** carve a `private:true`, publish-quality `aztec-ledger` package whose
runtime dependency closure is `@aztec/{aztec.js,accounts,entrypoints,foundation,stdlib}`
(as **peerDependencies**) + `@ledgerhq/hw-transport*` + `@noble/secp256k1` — and
**nothing else**. The PoC glue moves to `apps/demo-browser`. `private:true` until
the BOLOS app is on Ledger Live; the package is otherwise shaped exactly as if it
were about to be published (exports map, peer-dep model, subpaths, no `src/` leaks).

Fixed (owner-decided, not relitigated): `core` stays a separate package; three
transports (WebHID + node-hid + Speculos) behind `LedgerTransport`,
subpath-exported; `@aztec/*` → peerDependencies; CI skipped; firmware + wire
protocol unchanged; ECDSA-R1 dropped; preserve AHW-097 `./unsafe` gating +
AHW-098 attested-receive-address fail-closed.

## 2. Package topology after

```
packages/
├── core/                      → @aztec-hwwallet-poc/core   (UNCHANGED, stays private; pure types+crypto)
│       deps: @aztec/{aztec.js,entrypoints,foundation,stdlib}   (already peer-shaped in spirit)
└── aztec-ledger/              → aztec-ledger               (NEW name; private:true; the SDK)
        peerDeps: @aztec/{aztec.js,accounts,entrypoints,foundation,stdlib}
        deps:     @ledgerhq/hw-transport, @ledgerhq/hw-transport-webhid,
                  @ledgerhq/hw-transport-node-hid, @noble/secp256k1,
                  @aztec-hwwallet-poc/core (workspace:*)
        exports:  "."            → src/index.ts        (signer SDK: contracts, provider, entrypoint, transports-barrel)
                  "./unsafe"     → src/unsafe.ts       (AHW-097 raw signer; deliberate import)
                  "./transports/webhid"    → src/webhid-transport.ts
                  "./transports/node-hid"  → src/node-hid-transport.ts   (NEW file)
                  "./transports/speculos"  → src/speculos-transport.ts   (+approver/settings)
apps/demo-browser/
        + src/session/session-embedded-wallet.ts   (MOVED from adapter)
        + src/session/aztec-ledger-session.ts       (MOVED from adapter)
        + src/clear-signing-v0/{manifest.json, registry.generated.ts, selectors.generated.ts, preflight.ts}  (MOVED)
        deps gain: nothing new — it already has @aztec/{pxe via wallets? no}, noir-contracts.js, aztec-standards
```

I am **renaming the directory** `packages/adapter-ledger` → `packages/aztec-ledger`
so the folder name matches the published name. Half-measures (keep the folder,
rename only the `package.json` `name`) rot: every `grep` for the package leads to
a misleadingly-named dir. The internal scoped name `@aztec-hwwallet-poc/core`
stays (it's private, never published), but the SDK takes the bare
`aztec-ledger` name now so the exports map / peer-dep wiring is exercised today.

## 3. File-move map — reusable vs glue (each verified by its imports)

I read every non-test `.ts` in `src/` and listed its `./` + `@aztec/*` + vendor
imports. The closure splits cleanly. **REUSABLE = SDK** (stays in
`aztec-ledger`); **GLUE = demo** (moves to `apps/demo-browser`).

### REUSABLE — verified zero pxe/wallets/noir/registry in transitive closure

| File | External imports | Verdict |
|---|---|---|
| `apdu.ts` | none | core wire constants |
| `transport.ts` | none (→apdu) | the `LedgerTransport` interface |
| `provider.ts` | none (→apdu, deploy-context, l4-manifest, transport) | APDU driver; **GET_VERSION/GET_CAPS live here** |
| `l4-manifest.ts` | `@aztec/{foundation,stdlib}`, core | **registry-AGNOSTIC** manifest CODEC — operates on `CallIntent`/`AzCall` only |
| `deploy-context.ts` | none (→apdu) | **registry-agnostic** deploy/`GET_AZTEC_ADDRESS` encoder |
| `project-call-intent.ts` | `@aztec/{aztec.js,stdlib}`, core | pure `ExecutionPayload`→`CallIntent` shape transform; **no registry** |
| `account-contract.ts` | `@aztec/{accounts,stdlib}` | ECDSA-K `AccountContract` |
| `schnorr-account-contract.ts` | `@aztec/{accounts,foundation,stdlib}` | Schnorr `AccountContract` |
| `ledger-account-contract-base.ts` | `@aztec/{accounts,aztec.js,entrypoints,stdlib}` | shared base |
| `auth-witness-provider.ts` | `@aztec/{aztec.js,stdlib}`, core | provider + `createClearSigningEntrypoint` seam |
| `clear-signing-entrypoint.ts` | `@aztec/{entrypoints,foundation,stdlib}`, core | **the signing seam** — see knot below |
| `receive-address-verify.ts` | none (→apdu) | **AHW-098 fail-closed** |
| `master-secret.ts`, `secret-cache.ts` | `@aztec/foundation` | secret reveal/cache |
| `onboarding.ts` | `@aztec/foundation` (→master-secret, provider, secret-cache) | reveal-or-reuse |
| `unsafe.ts` | none (→apdu, provider, transport) | **AHW-097** raw signer |
| `speculos-transport.ts` / `-approver.ts` / `-settings.ts` | none (→apdu, transport) | Speculos transport |
| `webhid-transport.ts` | `@ledgerhq/hw-transport-webhid` (→apdu, transport) | WebHID transport |

### GLUE — verified to pull the heavy deps; MOVE to `apps/demo-browser`

| File | The dep it drags in | Verified by |
|---|---|---|
| `session-embedded-wallet.ts` | `@aztec/pxe`, `@aztec/wallets` | direct `import … from '@aztec/pxe/server'` + `@aztec/wallets/embedded` (only file in the whole package that does) |
| `aztec-ledger-session.ts` | `@aztec/noir-contracts.js` (SponsoredFPC artifact) + `session-embedded-wallet` + `clear_signing_v0/deploy_profiles.generated` | only file importing `noir-contracts`; imports the session wallet |
| `clear_signing_v0/registry.generated.ts` | — (data) | hard-codes 4 testnet addresses (USDC/ETH/FPC/DRIP); demo-specific |
| `clear_signing_v0/selectors.generated.ts` | — (data) | hard-codes the aztec-standards FT verb table |
| `clear_signing_v0/preflight.ts` | the two generated tables above | **the registry knot** |
| `clear-signing-v0/manifest.json` + `scripts/gen-*.ts` | `@defi-wonderland/aztec-standards`, `@aztec/noir-contracts.js` | codegen-time only (devDeps) |

**`oracle/` stays in the SDK package but is test-only:** it's imported by 9
`*.test.ts` files and **not** in the barrel. It pulls only `@aztec/foundation` +
`@aztec/stdlib`. It is the parity oracle for the device crypto tests. Keep it as
`src/oracle/` (no export); it never enters the published runtime surface.

**`deploy_profiles.generated.ts` is the ambiguous one.** Unlike the FT registry
(demo contracts), the deploy profiles encode the *account contract* class-ids +
ctor selectors for `EcdsaKAccount`/`SchnorrAccount` — those are framework
artifacts, not demo deployments, and the device's deploy flow needs them. But it
is generated by the same script that emits the FT registry, and it's consumed
only by `aztec-ledger-session.ts` (glue). **Decision:** the SDK does *not* ship a
deploy-profiles table. `aztec-ledger-session.ts` (the orchestrator that uses it)
moves to the demo and carries `deploy_profiles.generated.ts` with it. The SDK's
`provider.beginDeployAccount(ctx: DeployContext)` already takes a fully-formed
`DeployContext` (profileId is just a `number` field) — the SDK never needs the
profile *table*, only the caller does. Verified: `deploy-context.ts` imports only
`./apdu.ts`; the profile constants live entirely in the generated file + its sole
consumer.

## The registry knot, and how I cut it (the central boundary decision)

The only thing tying the **reusable signing seam** to the **demo registry** is:

```
account-contract.ts ─▶ auth-witness-provider.ts ─▶ clear-signing-entrypoint.ts
                                                          │
                                                          └─▶ clear_signing_v0/preflight.ts ─▶ {registry,selectors}.generated.ts
```

`clear-signing-entrypoint.ts` calls `preflightIntent(intent)` once, inside
`#clearSignOnDevice`, *before* streaming to the device. Read the file headers:
preflight is an explicit **host-side UX convenience** — "Device remains the final
authority — the adapter never trusts the preflight result; it just surfaces a
cleaner developer experience." The device independently recomputes the
`outer_hash` and rejects on mismatch (`SW_HASH_MISMATCH`); the host registry
check is **not** a security gate. This is the lever.

**Can the manifest CODEC be registry-agnostic? Yes — it already is.**
`l4-manifest.ts` (`buildL4Manifest`, `encodeBeginAuthwitBody`,
`encodeAppendCallBody`, `deviceOuterHashForIntent`) and `deploy-context.ts` import
**zero** registry. They operate on `CallIntent`/`AzCall`/`AzManifestHeader` —
opaque field arrays. The codec ships in the SDK untouched.

**Must the SDK ship a registry or take one as a param?** Neither, for the codec.
The registry is *only* the preflight allowlist. The clean cut: **remove the
`preflightIntent` call from `clear-signing-entrypoint.ts`** and make preflight an
**optional injected hook**.

```ts
export interface ClearSigningEntrypointOptions {
  readonly bip32Path: readonly number[];
  // …existing…
  /** Optional host-side allowlist preflight. Returns/throws BEFORE the APDU
   *  stream. The device is still the sole authority (recompute + SW_HASH_MISMATCH);
   *  this only yields a clean TS error instead of an opaque 0x6F0x. */
  readonly preflight?: (intent: CallIntent) => void;
}
// in #clearSignOnDevice:
this.options.preflight?.(intent);   // was: preflightIntent(intent)
```

The demo supplies `preflight: preflightIntent` (its registry-backed function)
when it builds the entrypoint via `LedgerProviderOptions`. The SDK ships with
`preflight` undefined → no registry, device-authoritative, still correct.
`projectExecutionPayloadIntoCallIntent` is registry-agnostic and stays in the SDK
(needed by the entrypoint itself).

I considered two rejected alternatives:
- **(A) SDK ships a registry interface + a default empty registry.** Rejected:
  adds a published type (`Registry`, `RegistryEntry`, `VerbEntry`) that exists
  only to serve a *non-security* host hint. That is API surface for a feature the
  device doesn't trust. Boundary purism says: don't publish a type whose only job
  is demo UX. A bare `(intent) => void` hook leaks nothing.
- **(B) Keep preflight in the SDK, hard-code an empty registry.** Rejected: dead
  code in the published package, and it tempts a future maintainer to "just add
  the testnet addresses back."

The injected-hook cut is minimal (one call site, one optional field), preserves
the demo's exact UX, and makes the boundary *structural* — the SDK literally
cannot import the registry because the file is gone from the package.

## 4. Phases

**Phase 0 — boundary lockfile (do this first, it's the acceptance test).**
Add `src/boundary.test.ts` that walks the SDK's barrel + `./unsafe` +
transport-subpath entrypoints and asserts the transitive import set contains no
`@aztec/pxe`, `@aztec/wallets`, `@aztec/noir-contracts.js`,
`@defi-wonderland/aztec-standards`, and no `./clear_signing_v0/`. This fails today
(via the preflight knot) and is the green-light for every later phase. Implement
by static-parsing imports (Bun's transpiler `scan.imports`, or a regex walk over
the resolved file set) rather than runtime `import()` (which would need a device).

**Phase 1 — cut the registry knot.** Make `preflight` an injected hook in
`clear-signing-entrypoint.ts`; thread it through `LedgerProviderOptions` →
`createClearSigningEntrypoint`. Move `clear_signing_v0/{registry,selectors}.generated.ts`
+ `preflight.ts` out of the SDK (destination decided in Phase 3). SDK tests that
referenced the registry move with it.

**Phase 2 — sever the wallet/session glue.** Drop `session-embedded-wallet.ts`,
`aztec-ledger-session.ts` (+ its `deploy_profiles.generated.ts`) from the SDK
barrel and package; relocate to the demo. Remove their exports from `index.ts`.
This deletes the `@aztec/pxe`/`@aztec/wallets`/`@aztec/noir-contracts.js`
edges from the SDK. `core` is untouched.

**Phase 3 — relocate glue + the shared codegen (the constraint others miss).**
The gen script (`scripts/gen-clear-signing-v0.ts`) writes **both**
`ledger-app/src/clear_signing_v0/*` (C device tables) **and** the host TS tables.
The `manifest.json` is the **firmware's** source of truth, not the demo's. So I do
**not** bury the manifest under `apps/demo-browser`. Instead:
- `manifest.json` + `scripts/gen-*.ts` move to a repo-root `clear-signing-v0/`
  (sibling of `ledger-app/`), reflecting that it's a firmware+demo shared asset,
  not an SDK or demo-private one.
- The script's TS output target changes to
  `apps/demo-browser/src/clear-signing-v0/*.generated.ts`.
- The C output target (`ledger-app/src/clear_signing_v0/`) is unchanged.
This keeps the firmware codegen path intact while removing the registry from the
SDK. (Owner check via codex if the root-level placement vs `ledger-app/`-local is
contentious — it's an architecture fork.)

**Phase 4 — package shaping for publish quality.** Rename dir → `packages/aztec-ledger`;
set `name: "aztec-ledger"`, `private: true`, `version`, `license`, `repository`,
`files`/`publishConfig`, the exports map with the three transport subpaths +
`./unsafe`; move `@aztec/*` to `peerDependencies` (+ matching
`peerDependenciesMeta` only if any are truly optional — they are not) and a
`devDependencies` copy pinned to `4.2.1` so the workspace still type-checks; add a
`prepack`/`build` if we emit `.d.ts` (decide: ship `src/` TS via `exports`
pointing at `.ts`, as today, or compile to `dist/` — see open questions).

**Phase 5 — node-hid transport (new third transport).** It does **not** exist —
`@ledgerhq/hw-transport-node-hid` appears only in comments, and there is no
`node-hid-transport.ts`. Create `src/node-hid-transport.ts` implementing
`LedgerTransport` over `@ledgerhq/hw-transport-node-hid` (mirror
`webhid-transport.ts`: wrap `Transport.exchange`, prepend `CLA`, map SW). Add the
dep + the `./transports/node-hid` subpath. Speculos + WebHID transports get the
same subpath treatment (they currently sit behind only the root barrel).

**Phase 6 — co-versioning discipline (firmware↔SDK).** Section 6 + 8.

## 5. Critical files

- `clear-signing-entrypoint.ts` — the seam; the one call-site edit (Phase 1) that
  makes or breaks the boundary. Touch nothing about the
  `#assertClearSignPolicy` / stream-A-claim-B / canonical-hash logic.
- `l4-manifest.ts` + `deploy-context.ts` — the registry-agnostic codec; move
  verbatim, they're the proof the boundary holds.
- `index.ts` — the published surface; every removed export (session wallet,
  `AztecLedgerSession`) is a boundary win. Re-audit it reads only SDK files.
- `unsafe.ts` — AHW-097; keep behind `./unsafe`, never re-export from root.
- `receive-address-verify.ts` — AHW-098 fail-closed; stays in SDK, unchanged.
- `scripts/gen-clear-signing-v0.ts` — retarget TS output (Phase 3), keep C output.
- `package.json` — peer-dep model, exports map, `private:true`.

## 6. Security & Adversarial Considerations (mandatory)

This is a **published signing SDK**. Threat model spans supply chain, the raw
signer surface, secret hygiene, version-mismatch, and metadata leakage.

- **Supply chain (publish-quality even while private).** Inherit the repo's
  7-day `minimumReleaseAge` and frozen lockfile. `@aztec/*` as
  **peerDependencies** means a consumer can't be silently downgraded to a
  malicious `@aztec/*` by *our* dep tree — they own the version. Pin
  `@ledgerhq/hw-transport*` + `@noble/secp256k1` with caret + lockfile; `@noble`
  is the battle-tested choice for secp256k1 (correct — don't roll our own).
  Provenance: when the package eventually publishes, use npm trusted-publisher +
  `--provenance`, never an `NPM_TOKEN` in YAML. `files`/`publishConfig` must
  exclude `oracle/`, all `*.test.ts`, golden-vector JSON, and the relocated
  codegen — ship only the runtime surface so an attacker can't pivot off bundled
  test fixtures or the registry.
- **The `unsafe` raw-signer surface (AHW-097).** `unsafeSignOuterHash` signs an
  arbitrary 32-byte digest with no manifest review (device blind-sign toggle is
  the only backstop, default OFF). Preserve the gating *structurally*: it lives
  behind the `./unsafe` subpath, takes a `LedgerTransport` (not a `LedgerProvider`)
  so it's not a method on the root driver, and is **never** re-exported from `.`.
  The boundary test must assert `./unsafe` is reachable only via its own subpath
  and that the root barrel does not transitively export `unsafeSignOuterHash`.
  Publishing makes this surface *more* exposed (any dependent can
  `import 'aztec-ledger/unsafe'`), so the subpath name itself is the warning
  label — keep it literally `unsafe`.
- **No-secret-persistence.** AHW-103 already removed the raw cache read/write from
  the barrel (`loadCachedSecret`/`cacheSecret` are private; only
  `clearAllCachedSecrets`/`hasCachedSecret` are public). The session wallet's
  `ephemeral: true` (no IndexedDB for the master secret) is **demo** code and
  leaves with it — good; the SDK ships no persistence at all. Re-verify after the
  move that no SDK file writes a secret to storage, and that `secret-cache.ts`'s
  retained surface is forget-only.
- **Firmware-mismatch fail-closed (the co-versioning teeth).** `GET_VERSION`
  (major/minor/patch) + `GET_CAPS` (uint32 bitmask) + `MANIFEST_VERSION = 3` are
  the negotiation surface. AHW-098 already fails closed when
  `CAPS.ATTEST_ADDRESS` is absent. Generalize: the SDK must expose a
  `assertCompatibleDevice(version, caps, required)` that fail-closes when the
  device's `MANIFEST_VERSION`/caps are below what the installed wire encoders
  assume. **Adversarial case:** a downgraded/rogue device advertising an older
  manifest version could otherwise be coaxed to misparse a v3 stream. The host
  encoders hard-code `MANIFEST_VERSION = 3`; the device rejects an unknown
  version (`UNKNOWN_MANIFEST_VERSION = 0x6f02`), but the SDK should also refuse
  *before* streaming if `GET_VERSION`/caps don't satisfy the encoder's
  assumptions — never "best-effort downgrade." Publish a documented
  `MIN_SUPPORTED_APP_VERSION` constant co-located with the wire constants.
- **No APDU-payload logging.** Verified: `provider.ts` has **zero**
  `console`/`logger`/`debug` statements. The APDU bodies carry account addresses,
  selectors, tx nonces, and the salt — logging them leaks account/tx metadata
  (deanonymization across the otherwise-private Aztec flow). Make this a *tested*
  invariant: the boundary test (or a dedicated lint) asserts no
  `console.*`/`process.stdout` in SDK runtime files. The Speculos transport may
  log (it's a test transport) but lives behind `./transports/speculos` and is not
  on the production path; gate any logging it does behind an explicit opt-in flag,
  never default-on.
- **Transport trust boundary.** All three transports are untrusted pipes; the
  device is the authority. The `LedgerTransport` interface must not grow a
  capability that lets a transport observe/alter the signed `outer_hash`
  out-of-band. Keep `send()` byte-in/byte-out; the `AutoConfirmContext` (Speculos
  button-driving) must remain Speculos-only and inert for WebHID/node-hid (it
  already is — they ignore the callback).

## 7. Verification (including the boundary proof)

1. **Boundary proof (the headline acceptance test).** `src/boundary.test.ts`
   statically resolves the import closure of `src/index.ts`, `src/unsafe.ts`, and
   each `./transports/*` entry, and asserts the set excludes
   `@aztec/pxe`, `@aztec/wallets`, `@aztec/noir-contracts.js`,
   `@defi-wonderland/aztec-standards`, and any `clear_signing_v0/`/registry path.
   Green = boundary holds. This is non-negotiable and must run in `bun test`.
2. **Peer-dep proof.** A throwaway check (or the boundary test) parses
   `package.json` and asserts every `@aztec/*` is in `peerDependencies`, none in
   `dependencies`. Optionally `npm pack --dry-run` (or `bun pm pack`) and inspect
   the tarball: it must contain only runtime `.ts` + `package.json` + README,
   **no** `oracle/`, `*.test.ts`, golden vectors, or codegen.
3. **`unsafe` reachability.** Assert root barrel does not export
   `unsafeSignOuterHash`; assert `aztec-ledger/unsafe` does.
4. **Behavioral parity.** Existing parity + wire tests (`l4-manifest-parity`,
   `wire-*`, `schnorr-parity`, `grumpkin-*`, `provider.m8`) stay green — the codec
   moved verbatim, so byte-output must be identical. The Speculos integration
   matrix (`describe.skipIf(!SPECULOS)`) proves device round-trips unchanged.
5. **Demo still builds.** `apps/demo-browser` type-checks + `vite build` after it
   absorbs the session wallet, `AztecLedgerSession`, the registry, and supplies
   `preflight` to the SDK. The demo's `import … from '@aztec-hwwallet-poc/adapter-ledger'`
   sites rewrite to `aztec-ledger`; verify the names it needs (`AztecLedgerSession`,
   `LedgerTransport`, `PhaseId`, `SubmitResult`, `createWebHidTransport`,
   `LedgerProvider`, `SpeculosTransport`, `WebHidNotSupportedError`,
   `clearAllCachedSecrets`, `defaultAztecPath`, `revealOrReuseMasterSecret`) — note
   `AztecLedgerSession` is now *demo-local*, so those imports split between
   `aztec-ledger` (SDK) and a local `./session/` path.
6. **Gate:** `bun run lint:all && bun test` (the project gate). CI workflow itself
   is skipped per scope, but the local gate is the merge bar.

## 8. Risks / open questions

- **`AztecLedgerSession` is in the demo's required import set but is glue.** This
  is the sharpest tension with the demo's current API. The demo imports
  `AztecLedgerSession` as a type *and* value. Moving it to `apps/demo-browser/src/session/`
  is correct (it pulls noir + the session wallet), but it means the SDK no longer
  offers a one-call "session" convenience. **Position:** that's the right boundary
  — a session orchestrator that registers specific demo contracts and wraps an
  `EmbeddedWallet` is an *application* concern, not a signer-SDK concern. If a
  future consumer wants sugar, ship a *separate* `aztec-ledger-session` package
  later; do not pollute the signer SDK to save the demo one import rewrite.
- **Shared codegen placement.** Root `clear-signing-v0/` vs `ledger-app/`-local
  vs demo-local. I argue root (firmware+demo shared); reasonable people prefer
  `ledger-app/clear-signing-v0/` since firmware is the primary consumer. Either
  keeps the SDK clean; pick via codex (architecture fork). **Hard constraint
  regardless:** the SDK package must not contain the manifest or any generated FT
  table.
- **Ship `.ts` or compile to `dist/`?** Today exports point at `src/*.ts`
  (Bun/`allowImportingTsExtensions`). For genuine publish-quality, a consumer on
  plain `tsc`/node needs `.d.ts` + JS. **Position:** since it's `private:true`
  now, keep `src/*.ts` exports (zero build step, matches the Bun-first ethos) but
  add a `build` script (tsc → `dist/` + `.d.ts`) wired to `prepack`, so the day it
  goes public the only change is flipping `exports` to `dist/`. Document this in
  the package README. Don't gold-plate a dist pipeline that isn't consumed yet.
- **R1 dead constants in `core/ecdsa.ts`.** `SECP256R1_N`/`normalizeLowS('secp256r1')`
  remain though R1 is out of scope. They're harmless pure constants in `core`
  (not the SDK boundary), so leave them — ripping them out is scope creep and
  `core` isn't what we're shaping. Flag only.
- **`peerDependencies` strictness vs the monorepo.** With `@aztec/*` as peers, the
  workspace needs them as `devDependencies` (or hoisted at root) for type-check.
  Verify `bun install` resolves the peer against the root `4.2.1` and doesn't warn
  about an unmet peer; if it does, add the `devDependencies` mirror in
  `aztec-ledger/package.json`.
- **Generated-file drift after the move.** The gen script's `--check` mode (CI
  drift guard) now targets the demo path; ensure the relative-path math in
  `gen-clear-signing-v0.ts` (`REPO_ROOT`-anchored) is updated, or the check
  silently passes against a stale path. This is a foot-gun — cover it with a
  re-run of `gen:clear-signing-v0:check` in the local gate.
