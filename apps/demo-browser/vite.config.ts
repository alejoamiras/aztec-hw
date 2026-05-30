/**
 * Vite config for the M6 demo browser app.
 *
 * Cribbed from the working nulo-2 faucet + extension configs:
 *  - nodePolyfills with NO `include` filter (Buffer/global/process all on)
 *  - Alias `vite-plugin-node-polyfills/shims/buffer` to its absolute path
 *    so workspace packages (adapter-ledger, core) which don't directly
 *    depend on the polyfill plugin still resolve the inject correctly.
 *    Reference: nulo-2/packages/extension/vite.config.ts:60-69.
 *  - Alias `detect-node` to a shim returning false (forces pino to use
 *    the browser transport — without this, the node-polyfills `process`
 *    shim makes pino think it's in Node and worker-thread transport
 *    explodes with "window is not defined").
 *  - dedupe @aztec/noir-noirc_abi + @aztec/noir-acvm_js so the WASM
 *    instances live in a single module scope.
 *  - COOP/COEP headers for bb-prover's SharedArrayBuffer access.
 *
 * Vite proxy at /speculos → http://localhost:5001 (5000 is macOS AirPlay).
 */

import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const require = createRequire(import.meta.url);
const execAsync = promisify(exec);

/** POST /api/speculos/restart → SELF-HEALING Speculos reset for the demo UI's
 * "Reset device" button. Speculos's APDU connection dies when a host fetch
 * times out; the NBGL review stays painted but its callback has no consumer, so
 * pressing Both does nothing — a fresh container is the reliable reset.
 *
 * Previously this did `docker restart speculos-aztec-playwright`, which 500'd
 * whenever that exact container wasn't running (it's `--rm`, so it vanishes on
 * any stop, and nothing else creates it by that name). Instead we remove any
 * prior container and `docker run` a fresh one — idempotent, and it reloads the
 * latest-built `app.elf` so a device rebuild is picked up by clicking Reset. */
const SPECULOS_NAME = 'speculos-aztec-playwright';
const SPECULOS_IMAGE =
  'ghcr.io/ledgerhq/speculos@sha256:9b414c3bcaecb7638224156d36a702d66af812a0aa59ca203ce7b34cf4d590ca';
/* Elf dir resolved relative to this config (apps/demo-browser → ledger-app/bin)
 * so no absolute host path is baked into the repo. */
const SPECULOS_BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../ledger-app/bin');

function speculosResetPlugin(): Plugin {
  return {
    name: 'speculos-reset',
    configureServer(server) {
      server.middlewares.use('/api/speculos/restart', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const respond = (code: number, body: Record<string, unknown>) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          /* Remove any prior container (ignore "no such container"), then run a
           * fresh one on the demo's fixed ports + the latest elf. */
          await execAsync(`docker rm -f ${SPECULOS_NAME}`).catch(() => {});
          await execAsync(
            `docker run -d --rm --name ${SPECULOS_NAME} -p 5001:5000 -p 9999:9999 ` +
              `-v "${SPECULOS_BIN_DIR}:/app" ${SPECULOS_IMAGE} ` +
              `--display headless --model nanosp --apdu-port 9999 --api-port 5000 /app/app.elf`,
          );
          /* Poll the API until it answers (≤10s) rather than a fixed sleep. */
          const deadline = Date.now() + 10_000;
          let up = false;
          while (Date.now() < deadline) {
            try {
              const r = await fetch('http://localhost:5001/events?currentscreenonly=true');
              if (r.ok) {
                up = true;
                break;
              }
            } catch {
              /* not up yet */
            }
            await new Promise((r) => setTimeout(r, 400));
          }
          respond(up ? 200 : 500, { ok: up, container: SPECULOS_NAME });
        } catch (e) {
          respond(500, { ok: false, error: String(e) });
        }
      });
    },
  };
}

/** Redirect bb.js worker URL requests to their on-disk paths. bb.js spawns
 * workers via `new Worker(new URL('./main.worker.js', import.meta.url))`;
 * Vite's dep optimizer rewrites import.meta.url to .vite/deps/ but
 * doesn't copy the workers. Without this, deploy/proving hangs at
 * "The file does not exist at .vite/deps/main.worker.js". Lifted from
 * aztec-accelerator/packages/playground/vite.config.ts. */
function bbWorkerPlugin(): Plugin {
  const workerFiles: Record<string, string> = {};
  return {
    name: 'bb-worker-redirect',
    configResolved(config) {
      try {
        const bbProverPath = require.resolve('@aztec/bb-prover');
        const bbRequire = createRequire(bbProverPath);
        const bbEntry = bbRequire.resolve('@aztec/bb.js');
        const bbRoot = bbEntry.slice(0, bbEntry.indexOf('@aztec/bb.js/') + '@aztec/bb.js/'.length);
        const bbBrowserDir = resolve(bbRoot, 'dest', 'browser', 'barretenberg_wasm');
        workerFiles['main.worker.js'] = resolve(
          bbBrowserDir,
          'barretenberg_wasm_main',
          'factory',
          'browser',
          'main.worker.js',
        );
        workerFiles['thread.worker.js'] = resolve(
          bbBrowserDir,
          'barretenberg_wasm_thread',
          'factory',
          'browser',
          'thread.worker.js',
        );
        config.logger.info(`[bb-worker-redirect] Workers in ${bbBrowserDir}`);
      } catch (err) {
        config.logger.warn(`[bb-worker-redirect] Could not resolve workers: ${err}`);
      }
    },
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next();
        for (const [filename, realPath] of Object.entries(workerFiles)) {
          if (req.url.includes(filename) && req.url.includes('.vite/deps')) {
            req.url = `/@fs/${realPath}`;
            break;
          }
        }
        next();
      });
    },
  };
}

/** Walk up to find a file inside a workspace dep, ignoring `exports`. */
function resolvePackageFile(pkg: string, file: string): string {
  const segments = pkg.split('/');
  const first = segments[0] ?? pkg;
  const parts = pkg.startsWith('@') ? segments.slice(0, 2) : [first];
  let dir = fileURLToPath(new URL('.', import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...parts, file);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Cannot find ${pkg}/${file} in any node_modules`);
}

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  /* `credentialless` gates SharedArrayBuffer for bb-prover BUT allows
   * cross-origin iframes (the Speculos web UI at localhost:5001 doesn't
   * set Cross-Origin-Resource-Policy, so `require-corp` would block the
   * iframe). The /aztec proxy below still works under credentialless. */
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
    proxy: {
      '/speculos': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/speculos/, ''),
      },
      /* Same-origin proxy for the Aztec testnet RPC. Without this, the
       * browser blocks cross-origin fetches under COEP=require-corp
       * (the RPC doesn't set CORP). Codex consult 019e69ef recommended
       * this over loosening COEP to `credentialless`. */
      '/aztec': {
        /* Switched off rpc.testnet.aztec-labs.com after observing
         * inclusion-detection lag during M7 demo prep — aztecscan was
         * already showing the tx as mined while our `getTxReceipt`
         * polls came back stale. beast-5 (aztlanlabs) tracks the chain
         * tip much closer in practice. */
        target: 'https://rpc.testnet.aztec.beast-5.aztlanlabs.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/aztec/, ''),
      },
    },
  },
  preview: {
    headers: COOP_COEP_HEADERS,
  },
  /* Exclude WASM-binding deps from Vite's pre-bundle. Vite copies the
   * JS into .vite/deps/ but doesn't drag the `_bg.wasm` files along —
   * fetches end up hitting the SPA fallback and the WASM loader chokes
   * on `<!doctype` magic bytes (surfaced via playwright network logging:
   * `[200 text/html] /node_modules/.vite/deps/noirc_abi_wasm_bg.wasm`).
   * Same fix as aztec-accelerator/packages/playground/vite.config.ts:85. */
  optimizeDeps: {
    exclude: ['@aztec/noir-acvm_js', '@aztec/noir-noirc_abi'],
  },
  resolve: {
    alias: [
      {
        find: 'vite-plugin-node-polyfills/shims/buffer',
        replacement: resolvePackageFile('vite-plugin-node-polyfills', 'shims/buffer/dist/index.js'),
      },
      {
        find: 'detect-node',
        replacement: fileURLToPath(new URL('./src/shims/detect-node.ts', import.meta.url)),
      },
    ],
    dedupe: ['@aztec/noir-noirc_abi', '@aztec/noir-acvm_js'],
  },
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
    react(),
    bbWorkerPlugin(),
    speculosResetPlugin(),
  ],
});
