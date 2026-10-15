import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

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
const ECOSYSTEM = ['agex-ts', '@agex-ts/world', '@agex-ts/kvgit', '@agex-ts/termish']

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

export default defineConfig({
  plugins: [svelte(), entryPoints(), packageReadmes()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
