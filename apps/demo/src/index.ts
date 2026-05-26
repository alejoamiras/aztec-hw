/**
 * CLI demo — same IntentAuthWitnessProvider surface, three backends:
 *
 *   AZTEC_HW_TRANSPORT=fake       (default) Trezor-faithful fake transport
 *   AZTEC_HW_TRANSPORT=trezorlib  real trezor-firmware emulator via trezorlib bridge
 *   AZTEC_HW_TRANSPORT=ledger     Speculos-emulated custom Ledger BOLOS app
 *
 * What this proves end-to-end:
 *   - Both adapters consume the same `CallIntent` + emit the same `AuthWitness` shape.
 *   - The signature produced by either device verifies under Aztec's actual
 *     `Ecdsa.verifySignature` (barretenberg-backed — same code path as the in-circuit
 *     verifier).
 *   - The Ledger path is the L2 K1 baseline app (`ledger-app/`); the Trezor path
 *     uses `SignIdentity` with proto='gpg'.
 *
 * What this does NOT prove:
 *   - On-device intent verification (Trezor B.2 / Ledger L4 with Poseidon2).
 *   - Noir-circuit end-to-end (would need a deployed EcdsaKAccount on a PXE).
 */

import { Ecdsa, EcdsaSignature } from '@aztec/foundation/crypto/ecdsa';
import {
  AZTEC_COIN_TYPE,
  defaultAztecPath,
  LedgerEcdsaKAuthWitnessProvider,
  SpeculosTransport,
} from '@aztec-hwwallet-poc/adapter-ledger';
import {
  buildAztecIdentity,
  serializeIdentity,
  TrezorEcdsaKAuthWitnessProvider,
  TrezorlibSubprocessTransport,
  type TrezorTransport,
} from '@aztec-hwwallet-poc/adapter-trezor';
import {
  AztecAddress,
  type CallIntent,
  Fr,
  formatIntentForDevice,
  type IntentAuthWitnessProvider,
} from '@aztec-hwwallet-poc/core';
import { FakeTrezorTransport } from './fake-transport.ts';

type Backend = 'fake' | 'trezorlib' | 'ledger';

const ACCOUNT_INDEX = 0;
const BACKEND = (process.env.AZTEC_HW_TRANSPORT ?? 'fake') as Backend;
const TREZOR_PATH = process.env.TREZOR_PATH;
const SPECULOS_URL = process.env.SPECULOS_URL ?? 'http://localhost:5001';

const AZTEC_LEDGER_PATH = defaultAztecPath(0);

interface BackendHandle {
  readonly name: string;
  readonly provider: IntentAuthWitnessProvider & {
    getPublicKeyXY(): Promise<{ x: Uint8Array; y: Uint8Array }>;
  };
  readonly close?: () => Promise<void>;
  readonly setupHint?: string;
}

async function buildBackend(): Promise<BackendHandle> {
  switch (BACKEND) {
    case 'fake': {
      const transport: TrezorTransport = new FakeTrezorTransport();
      const provider = new TrezorEcdsaKAuthWitnessProvider(transport, {
        accountIndex: ACCOUNT_INDEX,
      });
      return { name: 'fake Trezor transport (in-process)', provider };
    }
    case 'trezorlib': {
      const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
      const transport = new TrezorlibSubprocessTransport({
        bridgePath: `${REPO_ROOT}/scripts/trezor-bridge/bridge.py`,
        pythonPath: `${REPO_ROOT}/scripts/trezor-bridge/venv/bin/python`,
        trezorPath: TREZOR_PATH,
      });
      const provider = new TrezorEcdsaKAuthWitnessProvider(transport, {
        accountIndex: ACCOUNT_INDEX,
      });
      return {
        name: 'trezorlib subprocess (real device or emulator)',
        provider,
        close: () => transport.close(),
      };
    }
    case 'ledger': {
      const transport = new SpeculosTransport({ baseUrl: SPECULOS_URL });
      const provider = new LedgerEcdsaKAuthWitnessProvider(transport, {
        bip32Path: AZTEC_LEDGER_PATH,
        signOptions: {
          // Auto-confirm the on-device blind-sign flow when run against Speculos.
          autoConfirm: async (ctx) => {
            await ctx.sleep(500);
            await ctx.press('both');
            for (let i = 0; i < 5; i++) {
              await ctx.sleep(280);
              await ctx.press('right');
            }
            await ctx.sleep(280);
            await ctx.press('both');
          },
        },
      });
      return {
        name: `Speculos Ledger app at ${SPECULOS_URL}`,
        provider,
        setupHint:
          'Run: docker run -d --rm --name speculos-aztec -p 5001:5000 -p 9999:9999 \\\n' +
          '  -v "$(pwd)/ledger-app/bin:/app" ghcr.io/ledgerhq/speculos:latest \\\n' +
          '  --display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf',
      };
    }
    default:
      throw new Error(
        `Unknown AZTEC_HW_TRANSPORT=${BACKEND}. Use 'fake', 'trezorlib', or 'ledger'.`,
      );
  }
}

function buildIntent(): CallIntent {
  const usdcContract = AztecAddress.fromBigInt(0xaabbccddee001122n);
  const recipient = AztecAddress.fromBigInt(0xabcdabcdabcdabcd_dead1234dead1234n);
  const accountConsumer = AztecAddress.fromBigInt(0xacc0_fac11_be3f_000111n);
  return {
    consumer: accountConsumer,
    chainInfo: { chainId: new Fr(1n), version: new Fr(1n) },
    calls: [
      {
        contractAddress: usdcContract,
        selector: new Fr(0xa9059cbbn),
        args: [new Fr(recipient.toBigInt()), new Fr(1_000_000n)],
        isPadding: false,
      },
    ],
    labels: {
      actionClass: 'transfer',
      amount: 1_000_000n,
      amountDecimals: 6,
      tokenSymbol: 'USDC',
      recipient: '0xabcdabcd…dead1234',
      contractLabel: 'USDC',
    },
  };
}

async function main(): Promise<void> {
  const backend = await buildBackend();
  console.log(`Aztec HW-wallet PoC — backend: ${backend.name}\n`);

  if (BACKEND === 'fake' || BACKEND === 'trezorlib') {
    const identity = buildAztecIdentity({ accountIndex: ACCOUNT_INDEX });
    console.log(`Trezor identity wire form: ${serializeIdentity(identity)}\n`);
  } else if (BACKEND === 'ledger') {
    console.log(`Ledger BIP-32 path: m/44'/${AZTEC_COIN_TYPE}'/0'/0/0\n`);
  }

  const intent = buildIntent();
  console.log('--- Intent visual (what the device will display) ---');
  console.log(formatIntentForDevice(intent));
  console.log('---');

  const aw = await backend.provider.createAuthWitFromIntent(intent);
  const { x, y } = await backend.provider.getPublicKeyXY();
  console.log('\nDevice public key (64B for EcdsaKAccount constructor):');
  console.log(`  x = 0x${Buffer.from(x).toString('hex')}`);
  console.log(`  y = 0x${Buffer.from(y).toString('hex')}\n`);

  const outerHashBytes = aw.requestHash.toBuffer();
  console.log(`Derived outer_hash: 0x${Buffer.from(outerHashBytes).toString('hex')}`);
  const sigBytes = Uint8Array.from(aw.witness.map((fr) => Number(fr.toBigInt())));
  console.log(`AuthWitness signature (r||s, 64B): 0x${Buffer.from(sigBytes).toString('hex')}\n`);

  const ecdsa = new Ecdsa('secp256k1');
  const sig = new EcdsaSignature(
    Buffer.from(sigBytes.slice(0, 32)),
    Buffer.from(sigBytes.slice(32, 64)),
    Buffer.from([0]),
  );
  const pubBytes = Buffer.concat([Buffer.from(x), Buffer.from(y)]);
  const ok = await ecdsa.verifySignature(outerHashBytes, pubBytes, sig);
  console.log(`Aztec K1 verifier (raw outer_hash.to_be_bytes() as msg): ${ok ? 'OK ✓' : 'FAIL ✗'}`);

  if (!ok) {
    console.error('\n❌ Signature did NOT verify. This is a real correctness bug.');
    process.exit(1);
  }

  console.log('\n--- Demo passed ---');
  console.log(`Backend: ${backend.name}.`);
  console.log("Adapter pipeline verified against Aztec's own TS verifier (barretenberg).");

  if (BACKEND === 'fake' && backend.setupHint) {
    console.log('\nNext: try a real backend.');
  }
  if (backend.setupHint && BACKEND !== 'fake') {
    console.log(`\nSetup hint for this backend:\n${backend.setupHint}`);
  }

  await backend.close?.();
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});
