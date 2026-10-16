import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
// The studio links kvgit from a sibling checkout, which vite only serves
// when allowed.
const kvgit = realpathSync(fileURLToPath(new URL('../../node_modules/@agex-ts/kvgit', import.meta.url)))

export default defineConfig({
  root: here,
  server: { fs: { allow: [here, fileURLToPath(new URL('../..', import.meta.url)), resolve(kvgit, '../..')] } },
  optimizeDeps: { exclude: ['wa-sqlite'] },
  logLevel: 'warn',
})
