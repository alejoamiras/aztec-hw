/**
 * Real Trezor transport via a Python `trezorlib` subprocess bridge.
 *
 * Why subprocess: stock `TrezorConnect.requestLogin` hides `ecdsaCurveName` and hardcodes
 * `identity.index = 0` (codex review #4). Python `trezorlib.misc.sign_identity` is the
 * lowest official surface that exposes the full SignIdentity protobuf for Aztec K1.
 * A pure-JS @trezor/transport+@trezor/protobuf client is the alternative (Phase A.7+).
 *
 * Bridge protocol: line-delimited JSON over stdin/stdout to `scripts/trezor-bridge/bridge.py`.
 * Each request → exactly one response. Errors come back as `{ok: false, error}` JSON.
 *
 * Default target: trezor-firmware emulator at `udp:127.0.0.1:21324` (override via the
 * `TREZOR_PATH` env var passed through to the Python child).
 *
 * Run `scripts/trezor-bridge/setup.sh` once to install trezorlib into a project-local
 * venv before using this transport.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { IdentityType } from './identity.ts';
import type { TrezorSignedIdentity, TrezorTransport } from './transport.ts';

/** stdio: ['pipe', 'pipe', 'inherit'] → writable stdin, readable stdout, null stderr. */
type BridgeProc = ChildProcessByStdio<Writable, Readable, null>;

export interface TrezorlibSubprocessOptions {
  /**
   * Path to `bridge.py`. Default: resolves `scripts/trezor-bridge/bridge.py` relative
   * to the current working directory (suitable for running from the PoC repo root).
   */
  readonly bridgePath?: string;
  /**
   * Path to the Python interpreter that has `trezorlib` installed. Default: resolves
   * `scripts/trezor-bridge/venv/bin/python` relative to cwd.
   */
  readonly pythonPath?: string;
  /**
   * Optional `TREZOR_PATH` env override (e.g. `udp:127.0.0.1:21324` for emulator,
   * `usb` for autodetect, `bridge:` for trezord). Defaults to the emulator.
   */
  readonly trezorPath?: string;
}

interface SignIdentityResponse {
  ok: true;
  compressed_public_key_hex: string;
  signature_hex: string;
}

interface ErrorResponse {
  ok: false;
  error: string;
  traceback?: string;
}

export class TrezorlibSubprocessTransport implements TrezorTransport {
  private proc?: BridgeProc;
  private stdoutBuffer = '';
  private pendingResolvers: Array<(line: string) => void> = [];
  private readonly bridgePath: string;
  private readonly pythonPath: string;
  private readonly trezorPath?: string;

  constructor(opts: TrezorlibSubprocessOptions = {}) {
    const cwd = process.cwd();
    this.bridgePath = opts.bridgePath ?? resolve(cwd, 'scripts/trezor-bridge/bridge.py');
    this.pythonPath = opts.pythonPath ?? resolve(cwd, 'scripts/trezor-bridge/venv/bin/python');
    this.trezorPath = opts.trezorPath;
  }

  async signIdentity(args: {
    identity: IdentityType;
    ecdsaCurve: 'secp256k1' | 'nist256p1';
    challengeHidden: Uint8Array;
    challengeVisual: string;
  }): Promise<TrezorSignedIdentity> {
    const proc = this.ensureStarted();
    const req = {
      op: 'sign_identity',
      identity: {
        proto: args.identity.proto,
        user: args.identity.user,
        host: args.identity.host,
        port: args.identity.port,
        path: args.identity.path,
        index: args.identity.index,
      },
      ecdsa_curve: args.ecdsaCurve,
      challenge_hidden_hex: Buffer.from(args.challengeHidden).toString('hex'),
      challenge_visual: args.challengeVisual,
    };
    const resp = await this.call<SignIdentityResponse | ErrorResponse>(proc, req);
    if (!resp.ok) {
      throw new Error(`trezorlib bridge: ${resp.error}`);
    }
    const compressed = hexToBytes(resp.compressed_public_key_hex);
    const signature = hexToBytes(resp.signature_hex);
    return { compressedPublicKey: compressed, signature };
  }

  async ping(): Promise<boolean> {
    const proc = this.ensureStarted();
    const resp = await this.call<{ ok: true; pong: boolean } | ErrorResponse>(proc, { op: 'ping' });
    return resp.ok && resp.pong === true;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin.end();
    return new Promise((res) => {
      // biome-ignore lint/style/noNonNullAssertion: just checked above
      this.proc!.once('exit', () => res());
      setTimeout(() => {
        this.proc?.kill();
        res();
      }, 2000);
    });
  }

  private ensureStarted(): BridgeProc {
    if (this.proc) return this.proc;
    if (!existsSync(this.bridgePath)) {
      throw new Error(`trezorlib bridge not found at ${this.bridgePath}`);
    }
    if (!existsSync(this.pythonPath)) {
      throw new Error(
        `Python interpreter not found at ${this.pythonPath}. ` +
          'Run scripts/trezor-bridge/setup.sh to create the venv.',
      );
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.trezorPath) env.TREZOR_PATH = this.trezorPath;

    const proc = spawn(this.pythonPath, [this.bridgePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });
    proc.on('error', (err) => {
      throw new Error(`trezorlib bridge spawn failed: ${err.message}`);
    });
    proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        // Drain any pending resolvers with a failure response.
        for (const resolver of this.pendingResolvers) {
          resolver(
            JSON.stringify({ ok: false, error: `bridge exited (code=${code}, signal=${signal})` }),
          );
        }
        this.pendingResolvers = [];
      }
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let nl = this.stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.stdoutBuffer.slice(0, nl);
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        const resolver = this.pendingResolvers.shift();
        if (resolver) resolver(line);
        // Otherwise: unsolicited line — log? drop silently for now.
        nl = this.stdoutBuffer.indexOf('\n');
      }
    });
    this.proc = proc;
    return proc;
  }

  private call<T>(proc: BridgeProc, req: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pendingResolvers.push((line) => {
        try {
          resolve(JSON.parse(line) as T);
        } catch (e) {
          reject(new Error(`bad JSON from bridge: ${(e as Error).message} (line: ${line})`));
        }
      });
      proc.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`bad hex length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`bad hex byte at ${i}: ${hex.slice(i * 2, i * 2 + 2)}`);
    }
    // biome-ignore lint/style/noNonNullAssertion: i < out.length
    out[i] = byte!;
  }
  return out;
}
