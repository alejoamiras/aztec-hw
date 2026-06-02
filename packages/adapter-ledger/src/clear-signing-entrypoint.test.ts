/**
 * Host unit tests for LedgerClearSigningEntrypoint's fail-closed policy (AHW-003/004).
 * `#assertClearSignPolicy` runs BEFORE any device call, so these need no Speculos.
 * The device flow (#clearSignOnDevice / #deploySignOnDevice / #consume stream-A-claim-B)
 * is exercised by the Speculos suite (b3-consumer-binding, provider.m8) + the on-chain
 * entrypoint proofs; the host gap this closes is "the guards had no unit test."
 */
import { describe, expect, test } from 'bun:test';
import {
  AccountFeePaymentMethodOptions,
  type DefaultAccountEntrypointOptions,
} from '@aztec/entrypoints/account';
import type { ChainInfo } from '@aztec/entrypoints/interfaces';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { GasSettings } from '@aztec/stdlib/gas';
import { ExecutionPayload } from '@aztec/stdlib/tx';
import { LedgerClearSigningEntrypoint } from './clear-signing-entrypoint.ts';
import type { DeployContext } from './deploy-context.ts';
import type { LedgerProvider } from './provider.ts';

const addr = AztecAddress.fromBigInt(1n);
const dev = {} as unknown as LedgerProvider; // guards throw before any device call
const gas = {} as unknown as GasSettings;
const chain = {} as unknown as ChainInfo;

function ep(): LedgerClearSigningEntrypoint {
  return new LedgerClearSigningEntrypoint(addr, dev, { bip32Path: [0] });
}
function emptyExec(): ExecutionPayload {
  return new ExecutionPayload([], [], []);
}
function txOpts(
  over: Partial<DefaultAccountEntrypointOptions> = {},
): DefaultAccountEntrypointOptions {
  return {
    txNonce: Fr.ZERO,
    cancellable: false,
    feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
    ...over,
  } as DefaultAccountEntrypointOptions;
}

describe('LedgerClearSigningEntrypoint — assertClearSignPolicy (AHW-003/004)', () => {
  test('rejects a tx payload carrying extra authWitnesses', async () => {
    const exec = emptyExec();
    (exec.authWitnesses as unknown[]).push({});
    await expect(ep().createTxExecutionRequest(exec, gas, chain, txOpts())).rejects.toThrow(
      /authWitnesses/,
    );
  });

  test('rejects a tx payload carrying capsules', async () => {
    const exec = emptyExec();
    (exec.capsules as unknown[]).push({});
    await expect(ep().createTxExecutionRequest(exec, gas, chain, txOpts())).rejects.toThrow(
      /capsules/,
    );
  });

  test('rejects a tx payload carrying extraHashedArgs', async () => {
    const exec = emptyExec();
    (exec.extraHashedArgs as unknown[]).push({});
    await expect(ep().createTxExecutionRequest(exec, gas, chain, txOpts())).rejects.toThrow(
      /extraHashedArgs/,
    );
  });

  test('rejects a non-EXTERNAL fee mode', async () => {
    await expect(
      ep().createTxExecutionRequest(
        emptyExec(),
        gas,
        chain,
        txOpts({ feePaymentMethodOptions: AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE }),
      ),
    ).rejects.toThrow(/fee mode is NOT clear-signed/);
  });

  test('rejects a cancellable deploy (deploy assumes non-cancellable)', async () => {
    const opts = {
      txNonce: Fr.ZERO,
      cancellable: true,
      feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
      ledgerDeployContext: {} as DeployContext,
    } as unknown as DefaultAccountEntrypointOptions;
    await expect(ep().wrapExecutionPayload(emptyExec(), chain, opts)).rejects.toThrow(
      /deploy requires cancellable=false/,
    );
  });

  test('rejects a non-cancellable tx — public-replay nullifier must not be strippable (AHW-049)', async () => {
    // Clean payload + EXTERNAL fee but cancellable=false: a host driving the entrypoint
    // directly must NOT get a device-approved public tx without the tx-nonce nullifier.
    // (post-impl codex HIGH: this was only enforced by the wallet default before.)
    await expect(
      ep().createTxExecutionRequest(emptyExec(), gas, chain, txOpts({ cancellable: false })),
    ).rejects.toThrow(/cancellable=true/);
  });
});
