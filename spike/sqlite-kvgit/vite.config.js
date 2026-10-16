import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
// The studio links kvgit from a sibling checkout, which vite only serves
// when allowed. SPIKE_KVGIT names another kvgit-ts package directory
// (a built one) to run against instead.
const kvgit = process.env.SPIKE_KVGIT
  ? realpathSync(resolve(process.env.SPIKE_KVGIT))
  : realpathSync(fileURLToPath(new URL('../../node_modules/@agex-ts/kvgit', import.meta.url)))

// Map each of the package's exports to its built file, so imports
// resolve to that directory wherever node resolution would have looked.
const exportsMap = JSON.parse(readFileSync(`${kvgit}/package.json`, 'utf-8')).exports
const alias = Object.entries(exportsMap).map(([sub, target]) => ({
  find: new RegExp(`^@agex-ts/kvgit${sub === '.' ? '' : sub.slice(1).replaceAll('/', '\\/')}$`),
  replacement: resolve(kvgit, target.browser ?? target.import),
}))

export default defineConfig({
  root: here,
  resolve: { alias },
  server: { fs: { allow: [here, fileURLToPath(new URL('../..', import.meta.url)), resolve(kvgit, '../..')] } },
  optimizeDeps: { exclude: ['wa-sqlite'] },
  logLevel: 'warn',
})
