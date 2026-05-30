/**
 * Host-parity for the device SchnorrAccount partial-address (M10 P5b). Builds
 * grumpkin_cli (same device .c) and checks `schnorr-partial` against the host
 * `computePartialAddress` of a real SchnorrAccount instance — proving the
 * 2-Fr-ctor args_hash + class_id/selector wiring matches Aztec.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SchnorrAccountContractArtifact } from '@aztec/accounts/schnorr';
import { Fr } from '@aztec/foundation/curves/bn254';
import { FunctionSelector, getAllFunctionAbis } from '@aztec/stdlib/abi';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import {
  computeContractClassId,
  computePartialAddress,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from '@aztec/stdlib/contract';
import { Fq, grumpkinMulGenerator, type Point } from './oracle/index.ts';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

let classIdHex = '';
let selectorU32 = 0n;

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`make failed:\n${res.stdout}\n${res.stderr}`);
}
function strip0x(s: string): string {
  return (s.startsWith('0x') ? s.slice(2) : s).padStart(64, '0');
}
function pointHex(p: Point): { x: string; y: string } {
  return { x: strip0x(p.x.toString()), y: strip0x(p.y.toString()) };
}
function devicePartial(px: string, py: string): string {
  const r = spawnSync(CLI, ['schnorr-partial', px, py, selectorU32.toString(), classIdHex], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`schnorr-partial failed:\n${r.stderr}`);
  return r.stdout.trim();
}
async function hostPartial(P: Point): Promise<string> {
  const instance = await getContractInstanceFromInstantiationParams(
    SchnorrAccountContractArtifact,
    {
      constructorArgs: [P.x, P.y],
      salt: new Fr(0n),
      deployer: AztecAddress.ZERO,
    },
  );
  return strip0x((await computePartialAddress(instance)).toString());
}

beforeAll(async () => {
  buildCli();
  const cls = await getContractClassFromArtifact(SchnorrAccountContractArtifact);
  classIdHex = strip0x((await computeContractClassId(cls)).toString());
  const ctor = getAllFunctionAbis(SchnorrAccountContractArtifact).find(
    (f) => f.name === 'constructor',
  );
  if (!ctor) throw new Error('no constructor abi');
  selectorU32 = (await FunctionSelector.fromNameAndParameters(ctor.name, ctor.parameters))
    .toField()
    .toBigInt();
});

describe('SchnorrAccount partial-address device parity', () => {
  test('class_id + selector match the pinned constants', () => {
    expect(classIdHex).toBe('1e86cb5f3581f982b9c2c2b8a45fc4d0dfdb93cdab87e6deee55ec69d7f19703');
    expect(selectorU32).toBe(3449235631n);
  });

  test('8 random Schnorr pubkeys: device partial == host computePartialAddress', async () => {
    for (let i = 0; i < 8; i++) {
      const P = await grumpkinMulGenerator(Fq.random());
      const ph = pointHex(P);
      expect(devicePartial(ph.x, ph.y)).toBe(await hostPartial(P));
    }
  });
});
