import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

/** `/run/` (a published session's link) is the studio too: a static
 *  host serves it from `run/index.html`, the same page. */
function runEntryPoint() {
  return {
    name: 'run-entry-point',
    closeBundle() {
      mkdirSync(resolve('dist', 'run'), { recursive: true })
      copyFileSync(resolve('dist', 'index.html'), resolve('dist', 'run', 'index.html'))
    },
  }
}

export default defineConfig({
  plugins: [svelte(), runEntryPoint()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
