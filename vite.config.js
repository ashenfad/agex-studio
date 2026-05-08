import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

/**
 * Copy ``dist/index.html`` to ``dist/run/index.html`` after the build.
 *
 * The SPA serves a published-artifact entry point at ``/run/?gist=...``
 * (see ``initSessionsFromUrl``).  Vite's dev server has SPA fallback,
 * so locally any path returns ``index.html`` and the route resolver
 * picks it up — but GitHub Pages (production) doesn't fall back.
 * Without a real file at ``/run/index.html`` the deployed shareable
 * URL 404s.  Building a real entry point under that path keeps the
 * status code correct (200, not 404) and doesn't require a multi-
 * entry Vite config — same bundle, two paths.
 */
function copyRunEntryPoint() {
  return {
    name: 'copy-run-entry-point',
    closeBundle() {
      const out = resolve('dist', 'run')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve('dist', 'index.html'), resolve(out, 'index.html'))
    },
  }
}

export default defineConfig({
  plugins: [svelte(), copyRunEntryPoint()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      // agex-ts's bundle has a Node-only chunk that imports
      // `createRequire` from `node:module` to optionally try
      // `worker_threads`. Browsers don't have `node:module`; the
      // import is static so vite's `__vite-browser-external` stub
      // doesn't satisfy it. Alias to a local no-op shim so the
      // static import resolves; agex-ts's try/catch handles the
      // runtime "no worker_threads here" case gracefully.
      // Remove once agex-ts publishes a browser-friendly bundle.
      module: resolve('./src/lib/_node-module-stub.js'),
    },
  },
})
