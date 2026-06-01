/**
 * M12 P3 — cx_math spike MEASUREMENT harness (THROWAWAY).
 *
 * Drives the flag-gated INS_CXMATH_SPIKE (0x70) on a Speculos running the spike
 * build (`make … EXTRA_DEFINES=CX_MATH_SPIKE`) and prints the numbers that feed
 * cx-math-decision.md:
 *   1. CORRECTNESS — cx_bn_mod_mul vs native fr_mul/gk_fq_mul vs a BigInt
 *      reference, for BOTH custom 254-bit moduli (BN254 Fr AND Grumpkin Fq).
 *      This is the one thing Speculos settles definitively.
 *   2. LATENCY (relative, CRUDE) — wall-clock for N chained muls, cx_bn vs
 *      native, each field. EMULATED QEMU, NOT SE silicon → does NOT predict
 *      real-device latency (decision-doc caveat 2).
 *
 *   SPECULOS_URL=http://localhost:5001 bun ledger-app/tests/cxmath_spike/measure.ts
 */
const URL = process.env.SPECULOS_URL ?? 'http://localhost:5001';

const FR = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const FQ = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

const toBE32 = (x: bigint): number[] => {
  const out = new Array<number>(32).fill(0);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const fromBE = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
const hex = (b: number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

async function apdu(data: number[]): Promise<Uint8Array> {
  const lc = data.length;
  // CLA=e0 INS=70 P1=00 P2=00 Lc=<lc> data
  const frame = `e0700000${lc.toString(16).padStart(2, '0')}${hex(data)}`;
  const res = await fetch(`${URL}/apdu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: frame }),
  });
  const body = (await res.json()) as { data: string };
  const all = Uint8Array.from(Buffer.from(body.data, 'hex'));
  const sw = (all[all.length - 2] << 8) | all[all.length - 1];
  if (sw !== 0x9000) throw new Error(`spike APDU SW=${sw.toString(16)} (data=${frame})`);
  return all.slice(0, all.length - 2);
}

/** mode: 0=cx_bn Fr, 1=cx_bn Fq, 2=native Fr, 3=native Fq. */
const call = (mode: number, iters: number, a: bigint, b: bigint) =>
  apdu([mode, (iters >> 8) & 0xff, iters & 0xff, ...toBE32(a), ...toBE32(b)]);

const VECTORS: ReadonlyArray<readonly [string, bigint, bigint]> = [
  ['2·3', 2n, 3n],
  ['(p-1)²  [max, exercises reduction]', FR - 1n, FR - 1n],
  ['mid·mid', FR >> 1n, FQ >> 2n],
  [
    'pseudo-random',
    0x1f3c9a2b77e0481d55aa00ffeec3128844d9b6731021fe98ca5570e6b3a1c204n,
    0x0badf00dcafe1234567890abcdef00112233445566778899aabbccddeeff0011n,
  ],
];

async function correctness(): Promise<boolean> {
  console.log('\n=== CORRECTNESS (iters=1: result must equal a·b mod p) ===');
  let allOk = true;
  for (const [name, a, b] of VECTORS) {
    for (const [field, p, cxMode, natMode] of [
      ['Fr', FR, 0, 2],
      ['Fq', FQ, 1, 3],
    ] as const) {
      const ref = (a * b) % p;
      const cx = fromBE(await call(cxMode, 1, a, b));
      const nat = fromBE(await call(natMode, 1, a, b));
      const ok = cx === ref && nat === ref;
      allOk &&= ok;
      console.log(
        `  ${field}  ${name.padEnd(38)} cx_bn=${ok && cx === ref ? 'OK' : 'MISMATCH'} native=${nat === ref ? 'OK' : 'MISMATCH'}${ok ? '' : `\n      ref=${ref.toString(16)}\n      cx =${cx.toString(16)}\n      nat=${nat.toString(16)}`}`,
      );
    }
  }
  console.log(
    `  → ${allOk ? 'ALL VECTORS MATCH (cx_bn correct for both custom moduli)' : 'FAILURES ABOVE'}`,
  );
  return allOk;
}

async function latency(): Promise<void> {
  const ITERS = 4096;
  const REPEAT = 5;
  const [, a, b] = VECTORS[3];
  console.log(
    `\n=== LATENCY (CRUDE, EMULATED — NOT silicon): ${ITERS} chained muls, best of ${REPEAT} ===`,
  );
  for (const [label, mode] of [
    ['cx_bn Fr', 0],
    ['native Fr', 2],
    ['cx_bn Fq', 1],
    ['native Fq', 3],
  ] as const) {
    let best = Infinity;
    for (let r = 0; r < REPEAT; r++) {
      const t0 = performance.now();
      await call(mode, ITERS, a, b);
      best = Math.min(best, performance.now() - t0);
    }
    console.log(
      `  ${label.padEnd(12)} ${best.toFixed(1)} ms  (${(best / ITERS).toFixed(4)} ms/mul, incl. APDU overhead)`,
    );
  }
  console.log('  NOTE: Speculos = QEMU on x86; these do NOT predict Nano S+ SE cycles (caveat 2).');
}

const ok = await correctness();
await latency();
process.exit(ok ? 0 : 1);
