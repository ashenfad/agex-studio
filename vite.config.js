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

export default defineConfig({
  plugins: [svelte(), entryPoints()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
