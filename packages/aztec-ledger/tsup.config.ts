import { defineConfig } from 'tsup';

/**
 * Build config for the publish-quality SDK: ESM + `.d.ts`, one output per public
 * entry (the root barrel + each subpath), so `dist/` mirrors the `exports` map.
 *
 * Externals are REGEXes, not bare names: the SDK imports ~29 DEEP `@aztec/*`
 * subpaths (e.g. `@aztec/aztec.js/account`, `@aztec/foundation/curves/bn254`),
 * and a bare-name external doesn't reliably cover subpaths — `/^@aztec\//` does.
 * The framework + Ledger transports + core stay external (peers/deps); only the
 * SDK's own modules are bundled/split. The `./node-hid` peer is loaded via a
 * variable-specifier dynamic import, so esbuild already leaves it external.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    advanced: 'src/advanced.ts',
    webhid: 'src/webhid.ts',
    'node-hid': 'src/node-hid.ts',
    speculos: 'src/speculos.ts',
    unsafe: 'src/unsafe.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [/^@aztec\//, /^@ledgerhq\//, /^@noble\//, '@alejoamiras/aztec-ledger-core'],
});
