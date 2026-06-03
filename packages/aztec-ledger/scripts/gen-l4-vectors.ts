/**
 * Generate L4 golden vectors from the pinned Aztec source.
 *
 * Pin: aztec-packages commit `2770bcb82d40323060c2f9c71aaf293b640efbef`
 * (matches `implementations-plan/hw-wallet-poc-ledger/l4-spec.md`).
 *
 * Output: `ledger-app/tests/golden_vectors/l4_outer_hashes.json`
 *
 * The device implementation (L4.1) verifies these vectors locally + on Speculos
 * before signing. The vectors here are the immutable parity reference — every
 * recomputation on-device must reproduce the `outer_hash` for the same inputs,
 * byte-for-byte.
 *
 * Run via: `bun run packages/aztec-ledger/scripts/gen-l4-vectors.ts`
 *
 * Aztec dependencies used:
 *   - `@aztec/foundation/crypto/poseidon` (`poseidon2HashWithSeparator`)
 *   - `@aztec/foundation/curves/bn254` (`Fr`)
 *   - `@aztec/stdlib/auth-witness` (`computeOuterAuthWitHash`)
 *
 * Domain separators (mirrored from `constants.gen.ts`, asserted at runtime
 * via Aztec exports so a future bump fails loudly):
 *   - SIGNATURE_PAYLOAD = 463525807
 *   - AUTHWIT_OUTER     = 3283595782
 *   - PUBLIC_CALLDATA   = 2760353947
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { computeOuterAuthWitHash } from '@aztec/stdlib/auth-witness';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

const AZTEC_PACKAGES_COMMIT = '2770bcb82d40323060c2f9c71aaf293b640efbef';
const APP_MAX_CALLS = 5;

const SIGNATURE_PAYLOAD = 463525807;
const AUTHWIT_OUTER = 3283595782;
const PUBLIC_CALLDATA = 2760353947;

interface EncodedCall {
  args_hash: Fr;
  function_selector: Fr;
  target_address: Fr;
  is_public: boolean;
  hide_msg_sender: boolean;
  is_static: boolean;
}

/** Canonical `FunctionCall.empty()` per `stdlib/src/abi/function_call.ts`. */
async function canonicalPaddingCall(): Promise<EncodedCall> {
  // computeCalldataHash([0]) per `yarn-project/stdlib/src/hash/hash.ts`.
  const calldataHash = await poseidon2HashWithSeparator([new Fr(0n)], PUBLIC_CALLDATA);
  return {
    args_hash: calldataHash,
    function_selector: new Fr(0n),
    target_address: new Fr(0n),
    is_public: true,
    hide_msg_sender: false,
    is_static: false,
  };
}

function callToFields(call: EncodedCall): Fr[] {
  return [
    call.args_hash,
    call.function_selector,
    call.target_address,
    new Fr(call.is_public ? 1n : 0n),
    new Fr(call.hide_msg_sender ? 1n : 0n),
    new Fr(call.is_static ? 1n : 0n),
  ];
}

async function computeInnerHash(realCalls: EncodedCall[], txNonce: Fr): Promise<Fr> {
  if (realCalls.length > APP_MAX_CALLS) {
    throw new Error(`too many real calls: ${realCalls.length} > ${APP_MAX_CALLS}`);
  }
  const padding = await canonicalPaddingCall();
  const padded: EncodedCall[] = [...realCalls];
  while (padded.length < APP_MAX_CALLS) padded.push(padding);
  const payloadFields = [...padded.flatMap(callToFields), txNonce];
  return poseidon2HashWithSeparator(payloadFields, SIGNATURE_PAYLOAD);
}

async function computeOuterHash(
  consumer: AztecAddress,
  chainId: Fr,
  protocolVersion: Fr,
  innerHash: Fr,
): Promise<Fr> {
  return computeOuterAuthWitHash(consumer, chainId, protocolVersion, innerHash);
}

function frHex(fr: Fr): string {
  return fr.toBuffer().toString('hex');
}

function addrHex(addr: AztecAddress): string {
  return addr.toField().toBuffer().toString('hex');
}

interface ScenarioInput {
  name: string;
  description: string;
  consumer: AztecAddress;
  chain_id: Fr;
  protocol_version: Fr;
  tx_nonce: Fr;
  real_calls: EncodedCall[];
}

async function emitScenario(scenario: ScenarioInput) {
  const inner_hash = await computeInnerHash(scenario.real_calls, scenario.tx_nonce);
  const outer_hash = await computeOuterHash(
    scenario.consumer,
    scenario.chain_id,
    scenario.protocol_version,
    inner_hash,
  );
  return {
    name: scenario.name,
    description: scenario.description,
    inputs: {
      consumer_hex: addrHex(scenario.consumer),
      chain_id_hex: frHex(scenario.chain_id),
      protocol_version_hex: frHex(scenario.protocol_version),
      tx_nonce_hex: frHex(scenario.tx_nonce),
      real_calls: scenario.real_calls.map((c) => ({
        args_hash_hex: frHex(c.args_hash),
        function_selector_hex: frHex(c.function_selector),
        target_address_hex: frHex(c.target_address),
        is_public: c.is_public,
        hide_msg_sender: c.hide_msg_sender,
        is_static: c.is_static,
      })),
    },
    expected: {
      inner_hash_hex: frHex(inner_hash),
      outer_hash_hex: frHex(outer_hash),
    },
  };
}

async function main() {
  const padding = await canonicalPaddingCall();
  const consumer = AztecAddress.fromBigInt(0xacc0_dead_beef_cafen);
  const chainId = new Fr(1n);
  const protocolVersion = new Fr(1n);
  const txNonce = new Fr(0x42n);
  const scenarios: ScenarioInput[] = [
    {
      name: 'zero-calls',
      description: 'Empty manifest — five canonical padding calls, tx_nonce=0x42.',
      consumer,
      chain_id: chainId,
      protocol_version: protocolVersion,
      tx_nonce: txNonce,
      real_calls: [],
    },
    {
      name: 'one-private-call',
      description: 'Single private transfer call, four padding slots.',
      consumer,
      chain_id: chainId,
      protocol_version: protocolVersion,
      tx_nonce: new Fr(0x1n),
      real_calls: [
        {
          args_hash: new Fr(0xa11cen),
          function_selector: new Fr(0xa9059cbbn), // ERC-20 transfer selector
          target_address: AztecAddress.fromBigInt(0xaabbccddee001122n).toField(),
          is_public: false,
          hide_msg_sender: false,
          is_static: false,
        },
      ],
    },
    {
      name: 'two-public-calls-static-mode',
      description: 'Two public calls, second is static — exercises flag bits.',
      consumer: AztecAddress.fromBigInt(0xacc0_fac11n),
      chain_id: new Fr(31337n),
      protocol_version: new Fr(7n),
      tx_nonce: new Fr(0xdeadbeefn),
      real_calls: [
        {
          args_hash: new Fr(0x1234_5678n),
          function_selector: new Fr(0xa9059cbbn),
          target_address: AztecAddress.fromBigInt(0x1111_2222_3333n).toField(),
          is_public: true,
          hide_msg_sender: false,
          is_static: false,
        },
        {
          args_hash: new Fr(0x9abcdefn),
          function_selector: new Fr(0x70a08231n), // balanceOf
          target_address: AztecAddress.fromBigInt(0xc0_ffee_c0_ffeen).toField(),
          is_public: true,
          hide_msg_sender: true,
          is_static: true,
        },
      ],
    },
    {
      name: 'five-calls-max',
      description: 'APP_MAX_CALLS=5 fully populated, no padding synthesis.',
      consumer,
      chain_id: chainId,
      protocol_version: protocolVersion,
      tx_nonce: new Fr(0xff_ff_ffn),
      real_calls: Array.from({ length: APP_MAX_CALLS }, (_, i) => ({
        args_hash: new Fr(BigInt(i + 1)),
        function_selector: new Fr(BigInt(0x1000_0000 + i)),
        target_address: AztecAddress.fromBigInt(BigInt(0xa000 + i)).toField(),
        is_public: i % 2 === 0,
        hide_msg_sender: false,
        is_static: i === APP_MAX_CALLS - 1,
      })),
    },
  ];

  const out = {
    _meta: {
      aztec_packages_commit: AZTEC_PACKAGES_COMMIT,
      app_max_calls: APP_MAX_CALLS,
      domain_separators: {
        SIGNATURE_PAYLOAD,
        AUTHWIT_OUTER,
        PUBLIC_CALLDATA,
      },
      canonical_padding_call: {
        args_hash_hex: frHex(padding.args_hash),
        function_selector_hex: frHex(padding.function_selector),
        target_address_hex: frHex(padding.target_address),
        is_public: padding.is_public,
        hide_msg_sender: padding.hide_msg_sender,
        is_static: padding.is_static,
      },
      poseidon2_separator_smoke: {
        zero_hex: frHex(await poseidon2Hash([])),
        one_hex: frHex(await poseidon2Hash([new Fr(1n)])),
        domain_zero_hex: frHex(await poseidon2HashWithSeparator([], 0)),
        domain_sigpayload_zero_hex: frHex(await poseidon2HashWithSeparator([], SIGNATURE_PAYLOAD)),
      },
    },
    scenarios: await Promise.all(scenarios.map(emitScenario)),
  };

  const outDir = join(__dirname, '../../../ledger-app/tests/golden_vectors');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'l4_outer_hashes.json');
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${out.scenarios.length} scenarios to ${outPath}`);
}

main().catch((err) => {
  console.error('vector gen failed:', err);
  process.exit(1);
});
