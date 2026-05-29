/**
 * M8 Phase 6d host-parity for the device deploy authwit outer_hash.
 *
 * The self-paid deploy authwit = the account entrypoint wrapping one
 * `sponsor_unconditionally()` call (PRIVATE, 0 args) to the sponsor FPC. The
 * device's `az_deploy_compute_outer_hash` must reproduce the exact hash the
 * real @aztec `DefaultAccountEntrypoint.wrapExecutionPayload` produces.
 *
 * The reference is computed OFFLINE from the genuine entrypoint (a stub auth
 * provider captures the outer_hash it would sign) with a FIXED txNonce — no
 * PXE/node. That same fixed nonce is what the host must pin into the deploy
 * (feeEntrypointOptions.txNonce) and pass to the device, so the recompute
 * matches. This is the ground-truth oracle for the device function.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import {
  AccountFeePaymentMethodOptions,
  DefaultAccountEntrypoint,
} from '@aztec/entrypoints/account';
import { Fr } from '@aztec/foundation/curves/bn254';
import { FunctionSelector } from '@aztec/stdlib/abi';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';
import { AztecAddress } from '@aztec/stdlib/aztec-address';

const HOST_DIR = join(__dirname, '../../..', 'ledger-app', 'tests', 'grumpkin_host');
const CLI = join(HOST_DIR, 'grumpkin_cli');

function buildCli(): void {
  const res = spawnSync('make', [], { cwd: HOST_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`make failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

const hex32 = (f: Fr): string => f.toBuffer().toString('hex');

/** Reference: the real @aztec deploy authwit outer_hash, computed offline. */
async function referenceDeployOuterHash(args: {
  account: AztecAddress;
  fpc: AztecAddress;
  txNonce: Fr;
  chainId: Fr;
  version: Fr;
}): Promise<string> {
  let captured: Fr | undefined;
  const stubAuth = {
    createAuthWit: async (h: Fr | Buffer): Promise<AuthWitness> => {
      captured = h instanceof Fr ? h : Fr.fromBuffer(h);
      return {} as unknown as AuthWitness;
    },
  };
  const sponsorExec = await new SponsoredFeePaymentMethod(args.fpc).getExecutionPayload();
  const ep = new DefaultAccountEntrypoint(args.account, stubAuth as never);
  await ep.wrapExecutionPayload(sponsorExec, { chainId: args.chainId, version: args.version }, {
    txNonce: args.txNonce,
    feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
    cancellable: false,
  } as never);
  if (!captured) throw new Error('reference: entrypoint did not produce an authwit hash');
  return captured.toString().slice(2);
}

function deviceDeployOuterHash(args: {
  account: AztecAddress;
  fpc: AztecAddress;
  txNonce: Fr;
  chainId: Fr;
  version: Fr;
  selector: number;
}): string {
  const res = spawnSync(
    CLI,
    [
      'deploy-outer-hash',
      hex32(args.account.toField()),
      hex32(args.chainId),
      hex32(args.version),
      hex32(args.txNonce),
      hex32(args.fpc.toField()),
      String(args.selector),
    ],
    { encoding: 'utf-8' },
  );
  if (res.status !== 0) {
    throw new Error(`cli deploy-outer-hash failed (status ${res.status}):\n${res.stderr}`);
  }
  return res.stdout.trim();
}

let sponsorSelector = 0;

beforeAll(async () => {
  buildCli();
  /* sponsor_unconditionally() selector as a u32 — the device gets this from the
   * manifest deploy profile (sponsor_selector_u32). */
  const sel = await FunctionSelector.fromSignature('sponsor_unconditionally()');
  sponsorSelector = Number(BigInt(sel.toString()));
});

describe('deploy authwit outer_hash — device vs real @aztec entrypoint', () => {
  test('sponsor selector matches the deploy-profile pin (0x23d77f89)', () => {
    expect(sponsorSelector).toBe(0x23d77f89);
  });

  test('16 random (account, fpc, nonce, chain, version) vectors match byte-exact', async () => {
    for (let i = 0; i < 16; i++) {
      const account = await AztecAddress.fromField(Fr.random());
      const fpc = await AztecAddress.fromField(Fr.random());
      const txNonce = Fr.random();
      const chainId = new Fr(BigInt(1 + i));
      const version = new Fr(BigInt(1000 + i));
      const ref = await referenceDeployOuterHash({ account, fpc, txNonce, chainId, version });
      const dev = deviceDeployOuterHash({
        account,
        fpc,
        txNonce,
        chainId,
        version,
        selector: sponsorSelector,
      });
      expect(dev).toBe(ref);
    }
  });
});
