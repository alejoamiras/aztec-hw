# Round 5 — codex privacy/metadata (candidates, UNVALIDATED; codex read-only, transcribed)

5 net-new (3 LOW, 2 INFO). Codex pre-deduped: #1 adjacent to AHW-048/064 (not dup); #2-5 no overlap claimed.

## CP-1 · LOW · HOST · OURS — Pre-reveal stable account/device identifier via cache-key pubkey
`onboarding.ts:59-74`, `get_public_key.c:55-66` (GET_PUBLIC_KEY is non-confirmed), `OnboardPanel.tsx:63-74`. `deviceCacheKey()` uses the full K1 `x||y` pubkey as a cache key; an origin can harvest a stable `(seed,path)` pseudonym after a mere connect (before any viewing-key reveal), enumerate account indices, and link ECDSA/Schnorr at the same path. Fix: stop using approval-free pubkeys as persistent cache IDs; per-tab random handle or fresh reveal. Overlap: adjacent AHW-048 (sessionStorage) + AHW-064 (path gate), not dup.

## CP-2 · LOW · HOST · MIXED — WebHID reconnect fingerprints "Ledger present + Aztec app open"
`webhid-transport.ts:53-63`, `@ledgerhq/hw-transport-webhid` create/reuse, `ConnectPanel.tsx:39-52`, `provider.ts:42-49`, `dispatcher.c:68-87`. Once the origin has HID permission, `TransportWebHID.create()` silently reuses an authorized Ledger, learns the model from `productId`, and the demo probes custom `GET_VERSION` — success/failure distinguishes "Aztec app answering" from other/no app. Origin-scoped (not cross-origin), but a revisit/app-usage fingerprint. Fix: prefer `request()` / privacy mode; disclose that Connect reveals Ledger/app presence.

## CP-3 · LOW · HOST · OURS — Default browser console logs account/contract/tx metadata
`@aztec/wallets browser.ts:24-27`, foundation pino-logger, pxe.ts logging, `aztec-ledger-session.ts:284-295,618`. The demo supplies no quiet logger → Aztec's browser logger defaults to `info` → console logs the registered account address + contract addrs/class-ids on connect, tx hashes + sim metadata on send. Not a secret leak, but a second activity channel. Fix: pass a silent/warn-only logger; scrub addresses/tx hashes from info.

## CP-4 · INFO · DESIGN · OURS — Hidden third-party RPC in the default Vite demo path
`ConnectPanel.tsx:16-21,110-117`, `vite.config.ts:185-197`. UI shows `/aztec`, but Vite proxies to `https://rpc.testnet.aztec.beast-5.aztlanlabs.xyz`; that operator sees IP/session metadata, node polling, registered public function signatures, public-call sims, submitted txs/hashes. Private proving stays local; NO path sends the master secret. Fix: surface the real operator URL, default blank/self-hosted, document what the node sees.

## CP-5 · INFO · TEST · OURS — Failure/test/emulator diagnostics persist wallet metadata
`@aztec/stdlib simulation_error.ts`, pxe.ts, the demo panels' catch-logs, the Playwright harness (mirrors console/page errors + success metadata to stdout), `app_main.c:39-48` (PRINTF of APDU headers + malformed raw bytes). Error paths dump name/message/stack; a `SimulationError` stack can carry serialized `txRequest`/scopes. CI doesn't run these Playwright files by default → mainly dev/test leakage, but makes metadata durable. Fix: sanitize browser error logging; don't print addresses/tx hashes in tests by default; keep PRINTF debug-only.

## Negatives (confirm sound)
- No direct app-name APDU leak (`handler_get_app_name` exists but the dispatcher never exposes it; fingerprint is via custom-INS success/failure, not a literal "Aztec" query).
- No analytics/telemetry/CDN/error-reporting beacons in `apps/demo-browser` (grep clean; index.html local-only).
- Browser wallet/PXE are `ephemeral: true`; no extra IndexedDB/localStorage secret persistence beyond AHW-048.
- Explorer leakage opt-in only, `rel="noreferrer"` (StatusBar.tsx:170-178).
- No NEW protocol-level timing leak beyond AHW-029/048.
