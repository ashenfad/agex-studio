import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { build as buildExtension, zip } from './extension/build.mjs'
import { EXTENSION_DOWNLOAD } from './extension/src/protocol.js'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const extension = JSON.parse(readFileSync('./extension/manifest.json', 'utf-8'))

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

/** The browser extension's download (`EXTENSION_DOWNLOAD`): its site
 *  build, zipped as one folder to load unpacked. A build writes it into
 *  `dist`; the dev server builds it afresh for each request. */
function extensionDownload() {
  const file = () => zip(buildExtension('site'), 'agex-studio')
  return {
    name: 'extension-download',
    configureServer(server) {
      server.middlewares.use(EXTENSION_DOWNLOAD, (_req, res) => {
        res.setHeader('Content-Type', 'application/zip')
        res.end(file())
      })
    },
    closeBundle() {
      mkdirSync(resolve('dist', dirname(EXTENSION_DOWNLOAD.slice(1))), { recursive: true })
      writeFileSync(resolve('dist', EXTENSION_DOWNLOAD.slice(1)), file())
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

/** `virtual:ecosystem-packages`: each ecosystem package's version and
 *  the subpaths its `exports` offer, read from disk when the studio is
 *  built, for the import map that gives an app these same versions. */
function ecosystemPackages() {
  const id = 'virtual:ecosystem-packages'
  return {
    name: 'ecosystem-packages',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loaded) {
      if (loaded !== `\0${id}`) return null
      const out = {}
      for (const name of ECOSYSTEM) {
        const { version, exports = {} } = JSON.parse(readFileSync(resolve('node_modules', name, 'package.json'), 'utf-8'))
        const subpaths = Object.keys(exports)
          .filter((key) => key !== '.' && key !== './package.json' && !key.includes('*'))
          .map((key) => key.slice(2))
        out[name] = { version, subpaths }
      }
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
  plugins: [svelte(), entryPoints(), extensionDownload(), packageReadmes(), ecosystemPackages()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __EXTENSION_VERSION__: JSON.stringify(extension.version),
  },
  // SQLite finds its .wasm beside its own module (`new URL('sqlite3.wasm',
  // import.meta.url)`). Pre-bundled into the dev server's deps folder it
  // looks there and gets the page instead; served from its package, it
  // finds the file. A build copies the .wasm as an asset either way.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  // and the dev server serves that file only from a directory it allows.
  // The extension's builds aren't the studio's source: one written (by
  // its tests, or for the download) reloads nothing.
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), sqliteDir()] },
    watch: { ignored: ['**/extension/dist/**'] },
  },
})
