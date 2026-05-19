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

/**
 * Mirror of ``copyRunEntryPoint`` for the gallery page. ``/gallery/``
 * is an additional SPA entry point — App.svelte detects the path and
 * renders the gallery component instead of the chat shell. Same
 * bundle, three real paths (``/``, ``/run/``, ``/gallery/``).
 */
function copyGalleryEntryPoint() {
  return {
    name: 'copy-gallery-entry-point',
    closeBundle() {
      const out = resolve('dist', 'gallery')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve('dist', 'index.html'), resolve(out, 'index.html'))
    },
  }
}

/**
 * Mirror of the other entry-point copiers, for the /docs/ help
 * pages. App.svelte route-detects on mount and renders the Docs
 * component instead of the editor. Same bundle, same trick.
 */
function copyDocsEntryPoint() {
  return {
    name: 'copy-docs-entry-point',
    closeBundle() {
      const out = resolve('dist', 'docs')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve('dist', 'index.html'), resolve(out, 'index.html'))
    },
  }
}

export default defineConfig({
  plugins: [svelte(), copyRunEntryPoint(), copyGalleryEntryPoint(), copyDocsEntryPoint()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // ⚠ REMOVE BEFORE PUBLISHING: this entire `server` block exists
  // only because the agex-ts packages are consumed via
  // `file:../agex-ts/...`, putting their dist files in a sibling
  // checkout outside Vite's default fs.allow root. Once `agex-ts`
  // (and its sub-packages) are on npm, those file: deps get bumped
  // to versioned ranges, the package files land under
  // `node_modules/`, and this `server.fs.allow` becomes dead config.
  // Drop the whole block as part of that migration.
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    // agex-runtime-worker spawns its worker via
    // `new Worker(new URL('./worker.js', import.meta.url))` from
    // inside its own dist. Vite's pre-bundling rewrites
    // `import.meta.url` to point at `node_modules/.vite/deps/`,
    // where `worker.js` doesn't exist — the worker fails to load
    // with `worker failed during boot: undefined` (ErrorEvent has
    // no message for a script-load 404 in workers). Excluding the
    // package keeps Vite serving it from its original dist path,
    // where `worker.js` and its chunk live alongside `index.js`.
    exclude: ['agex-runtime-worker'],
  },
})
