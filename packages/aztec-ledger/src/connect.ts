/**
 * `connectLedger` — the headline convenience entry point.
 *
 * Wraps an opened transport, runs the MANDATORY connect handshake (so it FAILS
 * CLOSED if the firmware is incompatible), and hands back a {@link LedgerConnection}
 * that mints the Aztec `AccountContract`(s) you wire into your wallet/PXE. The
 * account contracts remain usable directly — this is ergonomic sugar over them.
 */
import { LedgerEcdsaKAccountContract } from './account-contract.ts';
import { defaultAztecPath } from './apdu.ts';
import type { ClearSignPreflight } from './clear-signing-entrypoint.ts';
import { assertDeviceCompatible, REQUIRED_CAPS_BASE } from './connect-handshake.ts';
import { LedgerProvider, type SignOuterHashOptions, type VersionInfo } from './provider.ts';
import { LedgerSchnorrAccountContract } from './schnorr-account-contract.ts';
import type { LedgerTransport } from './transport.ts';

/** Signature scheme for a Ledger-backed Aztec account. */
export type AccountScheme = 'ecdsa' | 'schnorr';

export interface ConnectLedgerOptions {
  /** An opened transport — from `./webhid`, `./node-hid`, or `./speculos`. */
  readonly transport: LedgerTransport;
  /** Default Speculos auto-confirm (test only); real transports ignore it. */
  readonly signOptions?: SignOuterHashOptions;
  /** Default optional clear-sign preflight hook (the consumer's registry). */
  readonly preflight?: ClearSignPreflight;
}

export interface CreateAccountOptions {
  /** `'ecdsa'` (secp256k1, default) or `'schnorr'` (Grumpkin). */
  readonly scheme?: AccountScheme;
  /** BIP-32 account index (default 0). Each index is a distinct account. */
  readonly accountIndex?: number;
  /** Deploy salt (defaults to `Fr.ZERO` inside the account flow). */
  readonly salt?: Uint8Array | bigint;
  /** Per-account override of the connection's defaults. */
  readonly signOptions?: SignOuterHashOptions;
  readonly preflight?: ClearSignPreflight;
}

/**
 * A verified Ledger connection. Returned by {@link connectLedger} only AFTER the
 * version+caps handshake passes, so holding one means the device is compatible
 * (the scheme-specific curve cap is re-checked per account on first device use).
 */
export class LedgerConnection {
  constructor(
    private readonly transport: LedgerTransport,
    /** Probed device app version (within the supported range). */
    readonly version: VersionInfo,
    /** Probed device capability bitmask. */
    readonly caps: number,
    private readonly defaults: Pick<ConnectLedgerOptions, 'signOptions' | 'preflight'> = {},
  ) {}

  /** Build a Ledger-backed `AccountContract` for the given scheme + index. */
  createAccount(
    opts: CreateAccountOptions = {},
  ): LedgerEcdsaKAccountContract | LedgerSchnorrAccountContract {
    const base = {
      bip32Path: defaultAztecPath(opts.accountIndex ?? 0),
      signOptions: opts.signOptions ?? this.defaults.signOptions,
      preflight: opts.preflight ?? this.defaults.preflight,
      ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
    };
    // The Schnorr contract sets curveId=GRUMPKIN + profileId=1 itself; ECDSA-K
    // defaults to secp256k1 — so we only pick the class here.
    return (opts.scheme ?? 'ecdsa') === 'schnorr'
      ? new LedgerSchnorrAccountContract(this.transport, base)
      : new LedgerEcdsaKAccountContract(this.transport, base);
  }
}

/**
 * Open a verified connection to a Ledger running the Aztec app. Runs the mandatory
 * handshake (version range + base caps) and throws (fails closed) if the firmware
 * is incompatible — so a returned {@link LedgerConnection} is known-good.
 */
export async function connectLedger(options: ConnectLedgerOptions): Promise<LedgerConnection> {
  const { version, caps } = await assertDeviceCompatible(
    new LedgerProvider(options.transport),
    REQUIRED_CAPS_BASE,
  );
  return new LedgerConnection(options.transport, version, caps, {
    signOptions: options.signOptions,
    preflight: options.preflight,
  });
}
