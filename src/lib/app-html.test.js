import { describe, expect, it } from 'vitest'
import { buildAppHtml, buildAppPage } from './app-html.js'
import { assetToken } from './app-assets.js'

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

describe('an app’s assets', () => {
    it('are carried once each, the page naming them by token', async () => {
        const page = await buildAppPage(
            {
                'app/index.html': '<html><head></head><body><audio src="vo.wav"></audio><img src="./logo.png"></body></html>',
                'app/style.css': ".hero { background: url('logo.png') }",
                'app/data.csv': 'a,b',
            },
            { workerSources: {}, appBinaries: { 'app/vo.wav': new Uint8Array([1, 2, 3]), 'app/logo.png': new Uint8Array([4, 5]) } },
        )
        expect(page.assets.map((a) => a.type)).toEqual(['audio/wav', 'image/png', 'text/csv'])
        expect(page.html).toContain(`<audio src="${assetToken(0)}">`)
        expect(page.html).toContain(`<img src="${assetToken(1)}">`)
        // the data file is fetchable: it's in the map the fetch patch reads
        expect(page.html).toContain(`"data.csv":"${assetToken(2)}"`)
        expect(page.html).not.toContain('AQID') // vo.wav's bytes, as base64
    })
})
