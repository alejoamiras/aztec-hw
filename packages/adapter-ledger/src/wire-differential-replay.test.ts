/**
 * M12 P2 — BIDIRECTIONAL Speculos differential-replay gate (codex final-review
 * Major + design-review Critical/High). The anti-false-negative oracle check for
 * the off-device libFuzzer harness in `ledger-app/tests/wire_host/`.
 *
 * WHY: a clean fuzz campaign only proves the HOST harness is robust. It proves
 * nothing about the DEVICE unless the harness's accept/reject decision is faithful
 * to the real firmware. The dangerous false-negative class is "host harness
 * REJECTS, device ACCEPTS" — a real device accept-bug that hides because the
 * harness rejected the input first and never crashed. This gate replays a
 * STRATIFIED reject reservoir (+ the coverage corpus + crafted valid seeds)
 * through BOTH:
 *   (a) the off-device oracle — `replay_<target>`, which links the SAME compiled
 *       handler `.c` the fuzzer measured (run_one), printing `<name> <sw>`; and
 *   (b) the real device firmware on Speculos (the freshly-built bin/app.elf),
 * and asserts the SWs agree by class. Bidirectional = rejects AND accepts.
 *
 * Faithfulness (codex):
 *  - begin_authwit resets the session unconditionally → replay it directly.
 *  - begin_deploy requires L4_IDLE → ABORT (0x08, l4_session_reset) before each.
 *  - append_call reads only {state, call_count, calls_received, consumer}; the
 *    fuzz harness seeds {HEADER_PARSED, 1, 0, consumer=0x0C…}. A real BEGIN_AUTHWIT
 *    with call_count=1 + consumer=0x0C… reproduces that EXACTLY → exact-SW match.
 *  - deploy is a PARSE-ONLY seam (Option X): a parse-reject must equal the device
 *    SW exactly; a parse-accept (oracle 0x9000) maps to the device running the
 *    binding tail → {0x9000, PUBKEY_HASH_MISMATCH 0x6F0F, ADDRESS_MISMATCH 0x6F0E}
 *    (a random parse-valid input fails the device's own pkh/addr check → 0x6F0F).
 *
 * PREREQ (this gate is NOT in CI — run locally):
 *   make -C ledger-app/tests/wire_host replay-all
 *   # harvest a reservoir (optional but recommended — else corpus-only):
 *   for t in authwit append deploy; do
 *     WIRE_RESERVOIR=ledger-app/tests/wire_host/reservoir/$t \
 *       ledger-app/tests/wire_host/fuzz_$([ $t = deploy ] && echo deploy_parse || echo $t) \
 *       -runs=1000000 -max_len=255 ledger-app/tests/wire_host/corpus/$t; done
 *   # Speculos running the CURRENT build on $SPECULOS_URL, then:
 *   SPECULOS_URL=http://localhost:5001 bun test packages/adapter-ledger/src/wire-differential-replay.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AZTEC_COIN_TYPE_HARDENED, CURVE_ID, INS, MANIFEST_VERSION, PATH_SCHEME } from './apdu.ts';
import { SpeculosTransport } from './speculos-transport.ts';

const SPECULOS_URL = process.env.SPECULOS_URL;
const WIRE_HOST = join(import.meta.dir, '../../../ledger-app/tests/wire_host');

const FR = 32;
const SW_OK = 0x9000;
const SW_DEPLOY_PUBKEY_HASH_MISMATCH = 0x6f0f;
const SW_DEPLOY_ADDRESS_MISMATCH = 0x6f0e;
/* After a parse-accept the device runs the binding tail; for a non-device-valid
 * input it fails its own pkh/addr equality → 0x6F0F (or 0x6F0E). A truly device-
 * valid seed would give 0x9000. SWO_UNKNOWN / 0x6F01 are internal-fault SWs and
 * are deliberately EXCLUDED (their appearance on Speculos = a real finding). */
const DEPLOY_ACCEPT_BUCKET = new Set([
  SW_OK,
  SW_DEPLOY_PUBKEY_HASH_MISMATCH,
  SW_DEPLOY_ADDRESS_MISMATCH,
]);

const hex = (n: number): string => `0x${n.toString(16).padStart(4, '0')}`;

/* The device can only receive a one-byte Lc (≤255) and the oracle's run_one caps
 * at WIRE_MAX_LC=255 internally — so for an input file >255 bytes (a stale
 * pre-255-cap corpus entry) BOTH must see the same first 255 bytes. Clamp the
 * device-sent body to match what the oracle measured. */
function lcClamp(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.subarray(0, 255));
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** A canonical Fr (BE value < the BN254 Fr modulus r). `fill` MUST be ≤ 0x2f so the
 * top byte stays below r's 0x30 — that alone guarantees < r. */
function canonicalFr(fill: number): number[] {
  return Array<number>(FR).fill(fill);
}

/** Consumer matching the fuzz harness's canonical seed (0x0C…, top byte < 0x30). */
const CONSUMER_0C = canonicalFr(0x0c);

/** Minimal VALID BEGIN_AUTHWIT body: m/44'/AZTEC'/0'/0/0, given consumer + call_count.
 * Field order mirrors begin_authwit.c: version|curve|scheme|len|path|consumer|
 * chain_id|protocol_version|tx_nonce|call_count. */
function validAuthwitBody(consumer: number[], callCount: number): Uint8Array {
  const path = [0x8000002c, AZTEC_COIN_TYPE_HARDENED >>> 0, 0x80000000, 0x00000000, 0x00000000];
  return Uint8Array.from([
    MANIFEST_VERSION,
    CURVE_ID.SECP256K1,
    PATH_SCHEME.DEFAULT,
    path.length,
    ...path.flatMap(u32be),
    ...consumer,
    ...canonicalFr(0x01), // chain_id
    ...canonicalFr(0x01), // protocol_version
    ...canonicalFr(0x01), // tx_nonce
    callCount,
  ]);
}

/** All replay inputs for a target: coverage corpus ∪ harvested reject reservoir. */
function listInputs(subdir: string): string[] {
  const files: string[] = [];
  for (const base of ['corpus', 'reservoir']) {
    const d = join(WIRE_HOST, base, subdir);
    if (existsSync(d)) for (const f of readdirSync(d)) files.push(join(d, f));
  }
  return files;
}

/** Off-device oracle SW per input, via the compiled replay binary (zip by index —
 * the binary prints one line per argv file, in order). */
function oracleSWs(binary: string, files: string[]): Map<string, number> {
  const bin = join(WIRE_HOST, binary);
  if (!existsSync(bin)) {
    throw new Error(
      `replay oracle not built: ${bin}\n  run: make -C ledger-app/tests/wire_host replay-all`,
    );
  }
  const out = spawnSync(bin, files, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`${binary} exited ${out.status}: ${out.stderr}`);
  const lines = out.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== files.length) {
    throw new Error(`${binary}: ${lines.length} SW lines for ${files.length} inputs`);
  }
  const map = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    map.set(files[i], Number.parseInt(lines[i].trim().split(/\s+/)[1], 16));
  }
  return map;
}

describe.skipIf(!SPECULOS_URL)(
  'M12 P2 — bidirectional differential-replay (host oracle vs device firmware)',
  () => {
    const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL ?? 'http://localhost:5001' });
    const send = async (ins: number, data: Uint8Array): Promise<number> => {
      const r = await transport.send({ ins: ins as never, p1: 0, p2: 0, data });
      return Number(r.sw);
    };
    const abortReset = () => send(INS.ABORT, new Uint8Array(0));

    test('begin_authwit — oracle SW === device SW (exact), incl. a crafted valid accept', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'wdr-aw-'));
      const seed = join(tmp, 'seed_valid_authwit.bin');
      writeFileSync(seed, validAuthwitBody(CONSUMER_0C, 1));
      const files = [...listInputs('authwit'), seed];

      const oracle = oracleSWs('replay_authwit', files);
      const divergences: string[] = [];
      let accepts = 0;
      for (const f of files) {
        const dev = await send(INS.BEGIN_AUTHWIT, lcClamp(readFileSync(f))); // self-resets
        const exp = oracle.get(f) ?? -1;
        if (dev !== exp) divergences.push(`${f}: oracle=${hex(exp)} device=${hex(dev)}`);
        if (dev === SW_OK) accepts++;
      }
      expect(divergences).toEqual([]);
      expect(accepts).toBeGreaterThan(0); // the crafted valid seed must be accepted by both
    }, 180_000);

    test('begin_deploy parse-seam — parse-reject exact; parse-accept → device binding bucket', async () => {
      const files = listInputs('deploy');
      const oracle = oracleSWs('replay_deploy_parse', files);
      const divergences: string[] = [];
      let parseAccepts = 0;
      for (const f of files) {
        await abortReset();
        const dev = await send(INS.BEGIN_DEPLOY_ACCOUNT, lcClamp(readFileSync(f)));
        const exp = oracle.get(f) ?? -1;
        if (exp === SW_OK) {
          parseAccepts++;
          if (!DEPLOY_ACCEPT_BUCKET.has(dev)) {
            divergences.push(`${f}: seam ACCEPT but device=${hex(dev)} ∉ {9000,6f0f,6f0e}`);
          }
        } else if (dev !== exp) {
          divergences.push(`${f}: oracle=${hex(exp)} device=${hex(dev)}`);
        }
      }
      expect(divergences).toEqual([]);
      expect(parseAccepts).toBeGreaterThan(0); // the deploy corpus contains parse-accepted inputs
    }, 300_000);

    test('append_call — oracle SW === device SW (exact), with session prep matching the harness seed', async () => {
      const files = listInputs('append');
      const oracle = oracleSWs('replay_append_call', files);
      const divergences: string[] = [];
      for (const f of files) {
        await abortReset();
        const prep = await send(INS.BEGIN_AUTHWIT, validAuthwitBody(CONSUMER_0C, 1));
        if (prep !== SW_OK) throw new Error(`append prep BEGIN_AUTHWIT failed: ${hex(prep)}`);
        const dev = await send(INS.APPEND_CALL, lcClamp(readFileSync(f)));
        const exp = oracle.get(f) ?? -1;
        if (dev !== exp) divergences.push(`${f}: oracle=${hex(exp)} device=${hex(dev)}`);
      }
      expect(divergences).toEqual([]);
    }, 300_000);
  },
);
