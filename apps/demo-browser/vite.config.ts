/**
 * Vite config for the M6 demo browser app.
 *
 * Notable bits:
 *  - Vite proxy at /speculos → http://localhost:5000 so the Speculos HTTP
 *    REST API can be hit from the browser without CORS pain. WebHID path
 *    has no proxy — it goes through navigator.hid directly.
 *  - bb-prover WASM and worker bundling lessons cribbed from
 *    aztec-accelerator/packages/playground/vite.config.ts.
 *  - Targets ES2022 because the @aztec/foundation curves rely on bigint
 *    literals + top-level await.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      '/speculos': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/speculos/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    /* The PXE + prover modules touch top-level await and worker.js URLs;
     * leaving them out of Vite's pre-bundle avoids "Cannot use import
     * statement outside a module" runtime errors during first paint. */
    exclude: ['@aztec/pxe', '@aztec/bb-prover'],
  },
  /* Reasonably-large chunk warnings are fine — the bb-prover bundle is
   * several MB even minified. */
  esbuild: {
    target: 'es2022',
  },
});
