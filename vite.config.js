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
})
