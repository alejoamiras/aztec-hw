import { defineConfig } from 'tsup';

/**
 * Build for `@alejoamiras/aztec-ledger-core` — a single-entry, framework-agnostic
 * types package. ESM + `.d.ts`; the `@aztec/*` peers (incl. deep subpaths like
 * `@aztec/stdlib/auth-witness`) stay external via the `/^@aztec\//` regex.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [/^@aztec\//],
});
