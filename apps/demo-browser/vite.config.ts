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

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const require = createRequire(import.meta.url);

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
  const parts = pkg.startsWith('@') ? pkg.split('/').slice(0, 2) : [pkg.split('/')[0]!];
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
  /* `require-corp` is the standard COEP for SharedArrayBuffer (bb-prover
   * needs it). The testnet RPC doesn't set Cross-Origin-Resource-Policy,
   * so direct cross-origin fetches get blocked. Solution (per codex
   * 019e69ef): route RPC through a same-origin /aztec proxy below. */
  'Cross-Origin-Embedder-Policy': 'require-corp',
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
        target: 'https://rpc.testnet.aztec-labs.com',
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
  ],
});
