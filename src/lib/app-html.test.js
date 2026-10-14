import { describe, expect, it } from 'vitest'
import { buildAppHtml } from './app-html.js'

/** The import map's keys, from a built page. */
const importMap = (html) => Object.keys(JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '{}').imports ?? {})

describe('an app with a main script and no page', () => {
    it('gets a page that loads it, its imports resolved as any app’s', async () => {
        const html = await buildAppHtml(
            {
                'app/main.js': "import { x } from './helper.js'\nimport { Bar } from 'recharts'\nconsole.log(x, Bar)",
                'app/helper.js': 'export const x = 1',
            },
            { workerSources: {} },
        )
        const keys = importMap(html)
        expect(keys).toContain('__app/main.js')
        expect(keys).toContain('__app/helper.js')
        expect(keys).toContain('recharts')
        expect(html).toContain('<div id="app"></div>')
    })
})
