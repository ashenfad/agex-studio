import { copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

/** `/run/` (a published session's link) and `/docs/` (the help pages)
 *  are the studio's page too: a static host serves each from its own
 *  `index.html`, the same page, which looks at its path. */
function entryPoints() {
  return {
    name: 'entry-points',
    closeBundle() {
      for (const dir of ['run', 'docs']) {
        mkdirSync(resolve('dist', dir), { recursive: true })
        copyFileSync(resolve('dist', 'index.html'), resolve('dist', dir, 'index.html'))
      }
    },
  }
}

/** The packages the studio is built from, whose READMEs the
 *  agex-ecosystem skill carries. */
const ECOSYSTEM = ['agex-ts', '@agex-ts/world', '@agex-ts/kvgit', '@agex-ts/termish', '@agex-ts/kvsql']

/** `virtual:package-readmes`: the studio's README and each ecosystem
 *  package's, with its version, read from disk when the studio is
 *  built (a package's `exports` don't offer its README to an import). */
function packageReadmes() {
  const id = 'virtual:package-readmes'
  return {
    name: 'package-readmes',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loaded) {
      if (loaded !== `\0${id}`) return null
      const read = (dir) => ({
        version: JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')).version,
        readme: readFileSync(resolve(dir, 'README.md'), 'utf-8'),
      })
      const out = { 'agex-studio': read('.') }
      for (const name of ECOSYSTEM) out[name] = read(resolve('node_modules', name))
      return `export default ${JSON.stringify(out)}`
    },
  }
}

/** The directory of the SQLite build kvsql runs, wherever kvsql's own
 *  dependencies are installed (outside this checkout, for a linked one). */
function sqliteDir() {
  const fromKvsql = createRequire(resolve('node_modules/@agex-ts/kvsql/package.json'))
  return realpathSync(dirname(fromKvsql.resolve('@sqlite.org/sqlite-wasm/package.json')))
}

export default defineConfig({
  plugins: [svelte(), entryPoints(), packageReadmes()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // SQLite finds its .wasm beside its own module (`new URL('sqlite3.wasm',
  // import.meta.url)`). Pre-bundled into the dev server's deps folder it
  // looks there and gets the page instead; served from its package, it
  // finds the file. A build copies the .wasm as an asset either way.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  // and the dev server serves that file only from a directory it allows
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), sqliteDir()] },
  },
})
