# Plan (DX framing): extract `aztec-ledger` — the "use a Ledger as an Aztec signer" SDK

> One of three parallel drafts. This one is **consumer-DX / public-API-first**: start from
> what a third-party dev wants to type, design the surface, then derive topology + file moves.
> Owner-fixed scope is taken as given (separate `core`, three transports, `@aztec/*` peer,
> CI skipped, firmware/wire unchanged, R1 dropped, `./unsafe` gating + attested-receive
> fail-closed preserved).

## 1. Problem / goal

Today the reusable signer logic lives in `packages/adapter-ledger/` under the throwaway name
`@aztec-hwwallet-poc/adapter-ledger`. It works (the demo drives real testnet flows through it),
but it is shaped for an internal monorepo, not for an outside consumer:

- The package name screams "PoC". The barrel (`src/index.ts`) exports **31 symbols** — driver
  internals (`LedgerProvider`, `INS`, `SW`, `CLA`, `AzCall`, `AzManifestHeader`), onboarding
  primitives, deploy-context encoders — flat, with no signal about which 3 a normal consumer
  actually needs vs. which 28 are plumbing.
- `exports["."]` points straight at `./src/index.ts` with `allowImportingTsExtensions` + `noEmit`
  (root `tsconfig.json`). There is **no build output** — an external `npm i` consumer would get
  raw `.ts` with `.ts` import specifiers, which only a bundler with TS-extension resolution can
  load. Not publish-quality.
- Errors surface as `throw new Error("GET_VERSION failed: SW=0x6d00")` (`provider.ts:291`) — a
  consumer cannot `catch` on a type or branch on a code.
- There is **no connect entry point**. The demo (`ConnectPanel.tsx`) hand-rolls
  `transport === 'speculos' ? new SpeculosTransport(...) : await createWebHidTransport()` then
  `new LedgerProvider(txp).getVersion()`. Every consumer would re-implement transport selection
  and the version/caps handshake.
- **No node-hid transport exists.** The brief lists three transports; the repo ships only WebHID
  + Speculos. Comments (`transport.ts:24`, `speculos-transport.ts:5`) *reference*
  `@ledgerhq/hw-transport-node-hid` as the desktop path, but it is unimplemented. It must be
  **created** here.

**Goal:** ship `aztec-ledger` as a `private: true`, publish-*quality* package: a small curated
public API, a real dual ESM build (browser + node-safe entry, plus a `./unsafe` subpath and
per-transport subpaths), typed errors, a documented connect/handshake flow, and a README whose
"30-second" example actually compiles. `private: true` stays until the firmware is on Ledger Live;
quality (build, types, error taxonomy, consumer-smoke) does not wait.

**Non-goal / out of scope (owner-fixed):** merging `core` in; adding/removing transports beyond
the three; firmware or wire-protocol changes; ECDSA-R1; turning CI on.

## 2. The proposed PUBLIC API

Design principle: **a consumer never names an APDU, a status word, or a `LedgerProvider`.** Those
become internal. The root export is a connect function, the returned objects, the typed errors,
and the small set of value types a caller legitimately threads (paths, schemes, the account
object). Three tiers:

### Tier 1 — root (`aztec-ledger`): the 90% surface

```ts
// --- connect + handshake -------------------------------------------------
export interface ConnectOptions {
  transport: LedgerTransport;          // built via a subpath helper (tier 2)
  scheme?: AccountScheme;              // 'ecdsa' (default) | 'schnorr'
  accountIndex?: number;               // 0 (default); → defaultAztecPath(index)
  /** Minimum app version the host requires. Handshake fails closed below this. */
  minVersion?: { major: number; minor: number; patch: number };
}

export interface LedgerDeviceInfo {
  readonly version: { major: number; minor: number; patch: number };
  readonly capabilities: {            // decoded GET_CAPS bitmask — no raw numbers
    readonly ecdsaK1: boolean;
    readonly grumpkin: boolean;
    readonly clearSign: boolean;
    readonly attestAddress: boolean;
  };
  readonly bip32Path: readonly number[];
}

/**
 * Open + verify a Ledger running the Aztec app. Runs GET_VERSION then GET_CAPS,
 * FAIL-CLOSED: throws LedgerVersionError if the app is missing/too old, or
 * LedgerCapabilityError if a capability the chosen scheme needs is absent
 * (e.g. scheme:'schnorr' but !caps.grumpkin, or !caps.clearSign at all).
 * Returns a handle that has NOT yet touched keys.
 */
export function connectLedger(opts: ConnectOptions): Promise<LedgerConnection>;

export interface LedgerConnection {
  readonly device: LedgerDeviceInfo;
  /** Non-signing pubkey export (no device approval). */
  getSigningPublicKey(): Promise<{ x: Uint8Array; y: Uint8Array }>;
  /**
   * The sovereignty step: one device approval reveals the viewing-key root; a
   * second device approval attests the receive address (fail-closed by default).
   * Returns an object that plugs into @aztec/aztec.js.
   */
  createAccount(opts?: CreateAccountOptions): Promise<LedgerAztecAccount>;
  close(): Promise<void>;
}

export interface CreateAccountOptions {
  /** Speculos-only button driver; real devices ignore it (human taps). */
  autoConfirm?: (ctx: AutoConfirmContext) => Promise<void>;
  /** Opt OUT of on-device receive-address attestation. Default: attest (fail-closed). */
  attestReceiveAddress?: boolean;
  salt?: Fr;                           // default DEFAULT_ACCOUNT_SALT (Fr.ZERO)
}

// --- the returned account: the thing aztec.js consumes -------------------
export interface LedgerAztecAccount {
  readonly address: AztecAddress;
  readonly completeAddress: CompleteAddress;
  readonly scheme: AccountScheme;
  /** The @aztec/aztec.js AccountContract — pass to AccountManager / deploy. */
  readonly accountContract: AccountContract;
  /** The reviewed clear-signing entrypoint for an already-deployed account. */
  createEntrypoint(): EntrypointInterface;
  /** The revealed viewing-key root + a human-checkable checksum. */
  readonly viewingSecret: { secret: Fr; checksum: string };
}

// --- typed errors (tier shared, re-exported at root) ---------------------
export {
  LedgerError, LedgerStatusError, LedgerVersionError, LedgerCapabilityError,
  LedgerUserRejectedError, LedgerHashMismatchError, LedgerTransportError,
  LedgerAddressMismatchError, LedgerBlindSigningDisabledError,
} from './errors.ts';

// --- value types a caller legitimately threads --------------------------
export type { LedgerTransport, AutoConfirmContext } from './transport/types.ts';
export type { AccountScheme } from './account.ts';
export { defaultAztecPath, DEFAULT_ACCOUNT_SALT } from './paths.ts';
export type { LedgerDeviceInfo, LedgerConnection, LedgerAztecAccount } from './connect.ts';
```

`connectLedger` + `LedgerConnection.createAccount` collapse the demo's Connect→Onboard two-step
(`ConnectPanel` + `OnboardPanel`) into one ergonomic, fail-closed flow that still exposes both
device approvals. The full demo session orchestration (`AztecLedgerSession`, USDC/Dripper verbs,
`SubmitOptions`/`PhaseId`) is **demo glue, not SDK** — it stays in `apps/demo-browser` (see §4), so
the published API stays about "be an Aztec signer," not "drive Wonderland's testnet token."

### Tier 2 — transport subpaths

Each transport is its own subpath so a node consumer never bundles WebHID and a browser consumer
never bundles `node-hid`. The factory shape is uniform:

```ts
// aztec-ledger/webhid
export function createWebHidTransport(): Promise<LedgerTransport>;
export { WebHidNotSupportedError, WebHidDeviceDisconnectedError } from './errors.ts';

// aztec-ledger/node-hid   ← NEW (does not exist today)
export function createNodeHidTransport(opts?: { path?: string }): Promise<LedgerTransport>;

// aztec-ledger/speculos
export function createSpeculosTransport(opts?: SpeculosTransportOptions): LedgerTransport;
export type { SpeculosTransportOptions, ButtonId } from './transport/speculos.ts';
```

### Tier 3 — `aztec-ledger/unsafe` (gated, unchanged semantics)

```ts
export function unsafeSignOuterHash(
  transport: LedgerTransport, bip32Path: readonly number[],
  outerHash: Uint8Array, opts?: { autoConfirm?: ... },
): Promise<{ r: Uint8Array; s: Uint8Array }>;
```

Importing it stays a deliberate, auditable act (preserves AHW-097). Its module header keeps the
"NOT exported from root" warning.

### Usage example, per transport

```ts
// BROWSER (WebHID)
import { connectLedger } from 'aztec-ledger';
import { createWebHidTransport } from 'aztec-ledger/webhid';

const conn = await connectLedger({ transport: await createWebHidTransport() });
const account = await conn.createAccount();            // 2 device taps
// → drop account.accountContract into @aztec/aztec.js AccountManager / deploy.

// NODE / DESKTOP (node-hid)
import { connectLedger } from 'aztec-ledger';
import { createNodeHidTransport } from 'aztec-ledger/node-hid';

const conn = await connectLedger({
  transport: await createNodeHidTransport(),
  scheme: 'schnorr',
});

// TEST / CI (Speculos emulator)
import { connectLedger } from 'aztec-ledger';
import { createSpeculosTransport } from 'aztec-ledger/speculos';

const transport = createSpeculosTransport({ baseUrl: 'http://localhost:5000' });
const conn = await connectLedger({ transport });
const account = await conn.createAccount({
  autoConfirm: async ({ press, sleep }) => { await sleep(200); await press('both'); },
});
```

## 3. Package topology + exports map

`package.json` (name `aztec-ledger`, `private: true`, `version: 0.1.0`). `@aztec/*` move to
`peerDependencies` (owner-fixed); `@ledgerhq/*` and `@noble/secp256k1` stay `dependencies`;
`@aztec-hwwallet-poc/core` becomes a published-name peer/dependency (`aztec-ledger-core` or kept
`workspace:*` while private — see open Q1). Because a build now exists, exports point at `dist/`:

```jsonc
{
  "name": "aztec-ledger",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".":          { "types": "./dist/index.d.ts",            "import": "./dist/index.js" },
    "./webhid":   { "types": "./dist/transport/webhid.d.ts", "import": "./dist/transport/webhid.js" },
    "./node-hid": { "types": "./dist/transport/node-hid.d.ts","import": "./dist/transport/node-hid.js" },
    "./speculos": { "types": "./dist/transport/speculos.d.ts","import": "./dist/transport/speculos.js" },
    "./unsafe":   { "types": "./dist/unsafe.d.ts",            "import": "./dist/unsafe.js" }
  },
  "files": ["dist"],
  "peerDependencies": { "@aztec/accounts": "4.2.1", "@aztec/aztec.js": "4.2.1", "@aztec/entrypoints": "4.2.1", "@aztec/foundation": "4.2.1", "@aztec/stdlib": "4.2.1" },
  "dependencies": { "@ledgerhq/hw-transport": "^6.35.2", "@ledgerhq/hw-transport-webhid": "^6.35.2", "@ledgerhq/hw-transport-node-hid": "^6.29.0", "@noble/secp256k1": "^3.1.0" },
  "scripts": { "build": "tsdown", "typecheck": "tsc --noEmit", "test": "bun test" }
}
```

**Build:** add a bundler-emitter (`tsdown`, the Bun-friendly `tsc`+rollup wrapper that emits ESM
JS **and** `.d.ts`). This is mandatory because the root `tsconfig` is `noEmit` and uses `.ts`
import specifiers — a publish-quality package must ship `.js` with rewritten specifiers + types.
Five entry points map 1:1 to the exports map. Source keeps `.ts` extensions for Bun dev/test;
the build rewrites them. (Codex consult candidate: `tsdown` vs `tsc --build` + a specifier
rewrite — `tsdown` wins on multi-entry + `.d.ts` in one pass, but verify it respects the
`@aztec/*` externals so peers aren't bundled.)

Note: `@aztec/pxe`, `@aztec/wallets`, `@aztec/noir-contracts.js`, `@defi-wonderland/aztec-standards`
**drop out of this package entirely** — they are pulled only by `session-embedded-wallet.ts`,
`aztec-ledger-session.ts`, and the codegen scripts, all of which move to the demo (§4). Shrinking
the peer set is itself a DX win: a consumer of an Aztec *signer* should not transitively need a PXE
server impl.

## 4. File-move map (derived from the API, not the other way round)

The cut line: **does an outside "use a Ledger as a signer" consumer need it?** If yes → stays and
is reachable from a tier-1/2/3 export. If it's demo orchestration or testnet-token glue → moves to
`apps/demo-browser/src/session/`.

### Stays in `aztec-ledger` (rename `packages/adapter-ledger` → `packages/aztec-ledger`)

Proposed internal layout (folders give the barrel structure the flat `src/` lacks today):

| New path | From | Role |
|---|---|---|
| `src/connect.ts` | **NEW** | `connectLedger`, `LedgerConnection`, handshake (wraps `LedgerProvider.getVersion`/`getCaps`), fail-closed checks |
| `src/account.ts` | **NEW** thin facade | builds `LedgerAztecAccount` from the contract + provider + reveal + attest |
| `src/errors.ts` | **NEW** + absorb `webhid-transport.ts` error classes | full typed taxonomy (§6) |
| `src/paths.ts` | extracted from `apdu.ts` | `defaultAztecPath`, `hardened`, `assertCanonicalAztecPath`, `AZTEC_COIN_TYPE*` |
| `src/account-contract.ts` | unchanged | `LedgerEcdsaKAccountContract` |
| `src/schnorr-account-contract.ts` | unchanged | `LedgerSchnorrAccountContract` |
| `src/ledger-account-contract-base.ts` | unchanged | shared base |
| `src/auth-witness-provider.ts` | unchanged | provider; now internal-only export |
| `src/clear-signing-entrypoint.ts` | unchanged | the reviewed seam |
| `src/provider.ts` | unchanged | **demoted to internal** (not root-exported) |
| `src/apdu.ts` | trimmed (paths moved out) | INS/SW/CAPS/wire — **internal** |
| `src/transport/types.ts` | from `transport.ts` | `LedgerTransport`, `AutoConfirmContext` |
| `src/transport/webhid.ts` | from `webhid-transport.ts` | + `createWebHidTransport` |
| `src/transport/node-hid.ts` | **NEW** | `createNodeHidTransport` over `@ledgerhq/hw-transport-node-hid` |
| `src/transport/speculos.ts` | from `speculos-transport.ts` | + `createSpeculosTransport` |
| `src/unsafe.ts` | unchanged | gated raw sign |
| `src/onboarding.ts`, `src/master-secret.ts`, `src/secret-cache.ts` | unchanged | reveal-or-reuse, used by `account.ts`; **internal** |
| `src/receive-address-verify.ts` | unchanged | fail-closed assert, used by `account.ts` |
| `src/deploy-context.ts`, `src/l4-manifest.ts`, `src/project-call-intent.ts`, `src/clear_signing_v0/*`, `src/oracle/*` | unchanged | manifest/oracle internals; **internal** |
| all `*.test.ts`, `*.integration.test.ts` | unchanged | move with their subjects; bun:test runs in-tree |
| `scripts/gen-*.ts` | unchanged | codegen for the generated CS tables (stay; they regenerate `src/clear_signing_v0/*`) |

The new `index.ts` re-exports **only** tier-1 symbols (≈ 12, down from 31). `LedgerProvider`,
`INS`, `SW`, `CLA`, `AzCall`, `AzManifestHeader`, `VersionInfo`, deploy-context encoders, the raw
secret-cache, `revealMasterSecret`/`revealOrReuseMasterSecret`, `deviceCacheKey` — all **stop**
being public; they are reachable only by the package's own modules.

### Moves OUT to `apps/demo-browser/src/session/`

These are not signer SDK — they orchestrate a PXE, a testnet token, and demo phases:

- `aztec-ledger-session.ts` (+ `.test.ts`, `.integration.test.ts`) — `AztecLedgerSession`,
  `dripUsdc`, `transferUsdc*`, `SubmitOptions`, `PhaseId`, `DEPLOY_PROFILE_BY_SCHEME`.
- `session-embedded-wallet.ts` — the PXE/wallet subclass (drags `@aztec/pxe`, `@aztec/wallets`).

This is the highest-friction move (the demo imports `AztecLedgerSession`, `PhaseId`, `SubmitResult`
from the package today — see `state.ts`, `OnboardPanel.tsx`, `TransferPanel.tsx`, `AccountPanel.tsx`).
The demo's imports flip from `@aztec-hwwallet-poc/adapter-ledger` to `aztec-ledger` (for the new
tier-1 API) + `./session/*` (for the orchestration it now owns). `connectLedger`/`createAccount`
should let `AztecLedgerSession.connect` shrink to "take the `LedgerAztecAccount`, register demo
contracts." If this re-wire balloons, fall back to **keeping `AztecLedgerSession` in the package
behind a `aztec-ledger/session` subpath** (open Q2) — but the DX-correct answer is: the published
signer SDK should not carry a PXE.

## 5. Phases

**Phase 0 — build harness + smoke (no behaviour change).** Add `tsdown` + the five entry stubs
that simply `export *` from current locations; wire the exports map at `dist/`; prove `bun run build`
emits JS+`.d.ts` and a throwaway external script can `import { connectLedger }`. Establishes the
publish-quality gate before any rename churn. Add the standalone consumer-smoke (§7) here, red.

**Phase 1 — rename + topology.** `git mv packages/adapter-ledger packages/aztec-ledger`; rename in
`package.json` → `aztec-ledger`; `@aztec/*` → peer; fix the workspace name everywhere. Create
`src/transport/`, move the three transport files in, split `paths.ts` out of `apdu.ts`. Keep the
old barrel temporarily re-exporting everything so nothing breaks mid-phase. Green: `bun test` in
the package.

**Phase 2 — errors.** Add `src/errors.ts`; replace every `throw new Error("…SW=0x…")` in
`provider.ts`/`unsafe.ts`/transports with typed errors carrying `{ op, sw }` / decoded reason
(§6). Tighten `*.test.ts` that asserted on string messages to assert on error type + code. Green.

**Phase 3 — the new public API.** Write `connect.ts` + `account.ts`; collapse the
version/caps/reveal/attest flow behind them; write the curated `index.ts`. Demote driver internals.
Green, and the consumer-smoke flips to passing against Speculos (gated).

**Phase 4 — node-hid transport.** Implement `createNodeHidTransport` mirroring `WebHidLedgerTransport`
(slice trailing SW, ignore `autoConfirm`, typed disconnect). Add a unit test with a fake inner
exchange (the real-device path is `describe.skipIf(!LEDGER_NODE_HID)`).

**Phase 5 — move the demo glue out + re-wire.** Move `aztec-ledger-session.ts` +
`session-embedded-wallet.ts` to `apps/demo-browser/src/session/`; rewrite the 6 demo files to the
new imports; thin `AztecLedgerSession.connect` onto `connectLedger`. Green: demo `tsc -b` + the
non-gated bun tests; one gated Speculos e2e if a runner is up.

**Phase 6 — README + docs.** Author `packages/aztec-ledger/README.md` with the three usage blocks
(§2), the error table, the `./unsafe`/attestation security notes, and a "private until Ledger Live"
banner. Update `CLAUDE.md` package pointers + `implementations-plan/index.md`.

## 6. Security & Adversarial Considerations

Publishing a *signing* SDK changes the threat model: the audience is now arbitrary dApp code that
imports `aztec-ledger`, plus anyone reading the published source. Adversaries: a **malicious or
compromised host/dApp** (the primary one — the device is the trust anchor, the host is not), a
**supply-chain attacker** targeting the published artifact, and a **passive log/telemetry observer**.

- **The `unsafe` surface stays gated and loud.** `unsafeSignOuterHash` signs an arbitrary digest
  with no manifest review beyond the device's blind-signing toggle. It MUST remain (a) on its own
  `./unsafe` subpath, never reachable from root (preserves AHW-097), (b) taking a raw
  `LedgerTransport` (never a method on a root object), (c) module-header-documented as dangerous.
  Adversarial test: assert `import('aztec-ledger')` has **no** key by which `unsafeSignOuterHash`
  or `SIGN_OUTER_HASH` is reachable (a barrel-leak regression guard, mirroring the existing
  `w3-api-shape.test.ts`). A blind-sign rejection from the device must surface as
  `LedgerBlindSigningDisabledError`, not a generic SW string.
- **Fail-closed firmware-mismatch handshake.** `connectLedger` runs GET_VERSION + GET_CAPS and
  **refuses** below `minVersion`, on absent `caps.clearSign`, or on a scheme whose capability bit
  is missing (`schnorr`→`grumpkin`, default→`ecdsaK1`). No silent downgrade, no "best effort."
  This is the place a stale/rogue app is caught before any key operation. Preserve the existing
  fail-closed default for **receive-address attestation**: `createAccount` attests on-device and
  rejects unless the device advertises `caps.attestAddress` AND the attested address byte-equals
  the host derivation (`assertDeviceAttestedAddress`, `LedgerAddressMismatchError`). Opt-out only
  via an explicit `attestReceiveAddress: false`. A malicious host that substitutes a receive
  address it controls is rejected — this property must survive the refactor verbatim, with a test.
- **No secret persistence.** The only secret the SDK ever holds host-side is the revealed
  viewing-key root (an `Fr`), and it must stay **memory-only** (AHW-048). The refactor must not
  introduce any `localStorage`/IndexedDB/disk write of the secret or its cache key. The raw
  `secret-cache` read/write primitives must remain **off the public API** (AHW-103) — only the
  onboarding layer touches them, and `account.ts` exposes the revealed secret to the caller exactly
  once (for `AccountManager`), never re-readable from a public cache accessor. Spend authority never
  leaves the device in any path; the reveal discloses *viewing*, not *spending* — keep that wording
  in the README so a consumer can't be socially-engineered into thinking the reveal is a key export.
- **No APDU-payload logging.** Audit the moved code for logging that could leak signing material or
  device state. Today `ConnectPanel`/`OnboardPanel` JSON-stringify `error.stack` to `console.error`
  — acceptable in a *demo*, but the **library** must never log APDU request/response bytes, the
  outer_hash, the revealed secret, or the pubkey at any level. The only sanctioned library log is
  `SpeculosTransport`'s `console.warn` on an `autoConfirm` throw (diagnostic, test-only transport,
  no payload) — keep it, document it. Add a lint/grep gate in the consumer-smoke that fails if
  `console.*` appears in non-Speculos `src/` outside `errors.ts`.
- **Supply chain (publish-quality even while private).** Keep `bunfig.toml` `minimumReleaseAge`
  (the new `@ledgerhq/hw-transport-node-hid` dep is the one fresh addition — pin it, let the 7-day
  gate apply, commit `bun.lock`). `sideEffects: false` so a tree-shaking consumer cannot be made to
  execute a transport it didn't import (defense against a node-hid native-module side effect
  landing in a browser bundle). When `private:true` is eventually lifted: trusted-publisher +
  `--provenance`, never a raw `NPM_TOKEN` (per global policy). Note that for now CI is **skipped**
  (owner-fixed) — call out in the README that the local validation gate (`bun test` + build +
  consumer-smoke) is the only gate until CI is enabled.
- **Constant-time comparisons** in `receive-address-verify.ts` and the entrypoint's `bytesEqual`
  must be preserved on move (they already avoid early-return; don't let a "cleanup" reintroduce a
  short-circuit `===`).

Audit asks (codex + opus, per protocol): "given only the published `dist/` + exports map, can a
malicious dApp reach a blind sign, read a persisted secret, or bypass receive-address attestation?"

## 7. Verification

- **Per-phase:** `bun test` in `packages/aztec-ledger` stays green (the existing parity/wire/
  negative suites are the safety net for "firmware/wire unchanged"). `bun run lint:all`.
- **Build gate (new, the publish-quality bar):** `bun run build` emits `dist/{index,unsafe,
  transport/webhid,transport/node-hid,transport/speculos}.{js,d.ts}`; assert no `.ts` import
  specifier survives in `dist/`, and that `@aztec/*` is **not** bundled (externalized to peers).
- **Standalone consumer-smoke (mandatory, the core DX proof):** a throwaway package *outside* the
  workspace (`/tmp/aztec-ledger-consumer-smoke/`) that `bun add`s the packed tarball
  (`bun pm pack`) and runs:
  1. `import { connectLedger, LedgerStatusError } from 'aztec-ledger'` — resolves with types.
  2. `import { createSpeculosTransport } from 'aztec-ledger/speculos'` — resolves.
  3. assert `import('aztec-ledger')` exposes no `unsafeSignOuterHash` (gating regression).
  4. **gated** `describe.skipIf(!SPECULOS)`: against a live Speculos, `connectLedger` →
     `device.capabilities`, then `createAccount({ autoConfirm })` resolves a deterministic
     `address` and `accountContract`. This is the end-to-end "third-party dev gets a usable Aztec
     account" assertion — the whole point of the package.
- **Demo regression:** `apps/demo-browser` `tsc -b` + `vite build` succeed against the new imports;
  one gated Speculos e2e (`onboard.e2e.ts`) still drives connect→derive→deploy.
- **Barrel-shape test:** port/extend `w3-api-shape.test.ts` to assert the new `index.ts` exports
  exactly the tier-1 set and nothing from the demoted-internals list.

## 8. Risks & open questions

1. **`core`'s published name (Q1).** `aztec-ledger` imports `packEcdsaSignature`, `Fr`,
   `AztecAddress`, `AuthWitness`, `ChainInfo` from `@aztec-hwwallet-poc/core`. While both are
   `private:true` and consumed only by the demo, `workspace:*` is fine. But a *publish-quality*
   `aztec-ledger` cannot depend on an unpublishable `@aztec-hwwallet-poc/*` name. Decide now:
   rename `core` → `aztec-ledger-core` (peer/dep) so the tarball is coherent, even though it stays
   private. (Owner fixed "core stays separate" — that's about *not merging*, not about its name.)
2. **Where does `AztecLedgerSession` live (Q2)?** DX-correct: out, in the demo (a signer SDK
   shouldn't bundle a PXE). Risk: the re-wire (6 demo files + thinning `connect`) is the biggest
   blast radius in the plan. Fallback: an `aztec-ledger/session` subpath that still carries
   `@aztec/pxe`+`@aztec/wallets` as *optional* peers. Recommend the move; gate the fallback on
   how cleanly `connectLedger`/`createAccount` absorb the reveal+attest+derive steps.
3. **`tsdown` vs `tsc`-emit + specifier rewrite (Q3).** The repo has never emitted JS. `tsdown`
   handles multi-entry ESM + `.d.ts` + externals in one pass, but it's a new dep (7-day gate
   applies) and must be verified to externalize `@aztec/*`/`@ledgerhq/*`. Alt: `tsc --build` then a
   tiny specifier-rewrite script — more moving parts, zero new runtime dep. Codex consult.
4. **node-hid in a browser bundle.** `@ledgerhq/hw-transport-node-hid` pulls native bindings; it
   must be import-isolated to the `./node-hid` subpath and never transitively reachable from root
   or `./webhid`. `sideEffects:false` + subpath isolation + a smoke assertion that a browser-target
   build of root never references `node-hid` mitigates this.
5. **Generated tables (`clear_signing_v0/*`, `oracle/golden-vectors.json`).** They're committed
   generated artifacts with `gen-*.ts` scripts. They must move with the package and the
   `gen:clear-signing-v0:check` script must still pass post-rename (it pins device/host wire
   parity — a silent drift here is a security regression, not a cosmetic one).
6. **`AZTEC_COIN_TYPE` is still a placeholder (`1666`).** A published package hard-coding an
   unregistered SLIP-44 coin type is a footgun; keep the env override and document it loudly in the
   README as "PoC placeholder, do not rely on the address being portable to a future registered
   coin type." Not a blocker for `private:true`, but a release blocker later.
7. **Peer-version pinning.** `@aztec/*` are pinned to exact `4.2.1`. As peers, a consumer on a
   different `@aztec` minor could mis-resolve. Pin the peer range deliberately (exact `4.2.1` is
   defensible for a fast-moving pre-1.0 ecosystem) and document the supported `@aztec` version in
   the README.
