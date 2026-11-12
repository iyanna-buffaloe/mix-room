import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  entryPoints: ['separation', 'mixes', 'mix-cleanup'].map(name => fileURLToPath(new URL(`../netlify/functions/${name}.mjs`, import.meta.url))),
  outdir: fileURLToPath(new URL('../.separation-functions', import.meta.url)),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@netlify/blobs'],
  // Some SDK dependencies still use CommonJS Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
console.log('Built server-only separation and private-library functions.')
