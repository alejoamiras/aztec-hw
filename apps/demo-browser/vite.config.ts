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
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

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
    },
  },
  preview: {
    headers: COOP_COEP_HEADERS,
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
  ],
});
