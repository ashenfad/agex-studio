import { describe, expect, it } from 'vitest'
import { buildAppHtml, buildAppPage, reseedAppPage } from './app-html.js'
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

/** Run a built page's storage shim against a bare window and return the
 *  `localStorage` it installs, with what it posts to the parent. */
function runShim(html) {
    const shim = html.match(/<script>\s*\(function\(\) \{\s*var __seed = [\s\S]*?<\/script>/)?.[0]
    const posted = []
    const win = { __agexPost: (msg) => posted.push(msg) }
    new Function('window', shim.replace(/^<script>|<\/script>$/g, ''))(win)
    return { localStorage: win.localStorage, posted }
}

describe('content with `$` patterns in it', () => {
    const tricky = '$$5 $& $` $\' $1'

    it('reaches the page as written: the storage seed', async () => {
        const page = await buildAppPage({ 'app/index.html': '<html><head></head><body></body></html>' }, { workerSources: {}, appStorage: { seed: { price: tricky } } })
        const { localStorage, posted } = runShim(page.html)
        expect(localStorage.getItem('price')).toBe(tricky)
        localStorage.setItem('other', 'x')
        expect(posted.at(-1).data.price).toBe(tricky)
    })

    it('reaches the page as written: a worker’s source', async () => {
        const html = await buildAppHtml(
            { 'app/index.html': '<html><head></head><body></body></html>', 'app/calc.worker.js': '' },
            { workerSources: { 'calc.worker.js': `self.x = "${tricky.replace(/'/g, "\\'")}"` } },
        )
        const json = html.match(/var S=(\{[\s\S]*?\});var U/)[1]
        expect(JSON.parse(json)['calc.worker.js']).toContain('$$5 $& $`')
    })

    it('reaches the page as written: an inlined stylesheet', async () => {
        const html = await buildAppHtml(
            { 'app/index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>', 'app/style.css': `.a::after { content: "${tricky.replace(/'/g, '')}" }` },
            { workerSources: {} },
        )
        expect(html).toContain(`content: "${tricky.replace(/'/g, '')}"`)
    })
})

describe('where the injected scripts go', () => {
    /** Where the console interceptor starts, in the built page. */
    const at = (html) => html.indexOf('window.__agexPost = function')

    it('just inside a <head> tag of any case, with attributes', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<!DOCTYPE html><HTML><HEAD lang="en"><title>t</title></HEAD><body></body></HTML>' }, { workerSources: {} })
        expect(html.startsWith('<!DOCTYPE html><HTML><HEAD lang="en">\n<script>')).toBe(true)
        expect(at(html)).toBeLessThan(html.indexOf('<title>'))
    })

    it('after the <html> tag when the page has no head, never before the doctype', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<!doctype html>\n<html lang="en"><body><header>h</header></body></html>' }, { workerSources: {} })
        expect(html.startsWith('<!doctype html>\n<html lang="en">\n<script>')).toBe(true)
        expect(at(html)).toBeLessThan(html.indexOf('<header>'))
    })

    it('after the doctype when the page has neither head nor html tag', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<!-- app -->\n<!DOCTYPE html>\n<body><p>hi</p></body>' }, { workerSources: {} })
        expect(html.startsWith('<!-- app -->\n<!DOCTYPE html>\n<script>')).toBe(true)
    })

    it('first, in a fragment with none of them', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<p>hi</p>' }, { workerSources: {} })
        expect(html.startsWith('\n<script>')).toBe(true)
        expect(html.endsWith('<p>hi</p>')).toBe(true)
    })
})

describe('the import map', () => {
    it('resolves htm’s subpaths, their dependencies through the map', async () => {
        const html = await buildAppHtml({ 'app/main.js': "import { html, render } from 'htm/preact'\nrender(html`<p>hi</p>`, document.body)" }, { workerSources: {} })
        const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports
        expect(imports['htm/']).toBe('https://esm.sh/*htm@3.1.1/')
        expect(imports.htm).toBe('https://esm.sh/htm@3.1.1')
        // no esm.sh copy of its own: htm is pinned
        expect(Object.keys(imports).filter((k) => k.startsWith('htm'))).toEqual(['htm', 'htm/'])
    })

    it('leaves a package’s Preact and React to the one pinned Preact', async () => {
        const html = await buildAppHtml(
            {
                'app/main.js': [
                    "import { signal } from '@preact/signals'",
                    "import { useState } from 'preact/hooks'",
                    "import { LineChart } from 'recharts'",
                    "import { Cell } from 'recharts/lib/component/Cell'",
                    'console.log(signal, useState, LineChart, Cell)',
                ].join('\n'),
            },
            { workerSources: {} },
        )
        const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports
        const shared = '?external=preact,react,react-dom'
        expect(imports['@preact/signals']).toBe(`https://esm.sh/@preact/signals${shared}`)
        expect(imports.recharts).toBe(`https://esm.sh/recharts${shared}`)
        expect(imports['recharts/lib/component/Cell']).toBe(`https://esm.sh/recharts/lib/component/Cell${shared}`)
        // what they leave bare comes to the pinned copy
        for (const spec of ['preact', 'react', 'react-dom', 'react/jsx-runtime']) {
            expect(imports[spec]).toMatch(/^https:\/\/esm\.sh\/preact@10\.25\.4(\/|$)/)
        }
        expect(imports.preact).toBe('https://esm.sh/preact@10.25.4')
        expect(imports['preact/hooks']).toBeUndefined()
    })
})

describe('Plotly', () => {
    const PLOTLY = /<script src="https:\/\/cdn\.plot\.ly\/plotly-[\d.]+\.min\.js"><\/script>/

    it('isn’t loaded by a page that doesn’t use it', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<html><head></head><body><div id="chart"></div><script type="module" src="./main.js"></script></body></html>', 'app/main.js': 'document.title = "plots"' }, { workerSources: {} })
        expect(html).not.toMatch(PLOTLY)
    })

    it('is loaded, ahead of the app’s scripts, when one of them names it', async () => {
        const html = await buildAppHtml(
            { 'app/index.html': '<html><head></head><body><div id="chart"></div><script type="module" src="./main.js"></script></body></html>', 'app/charts/bar.js': "export const draw = (el) => Plotly.newPlot(el, [{ type: 'bar', y: [1] }])", 'app/main.js': "import { draw } from './charts/bar.js'" },
            { workerSources: {} },
        )
        expect(html).toMatch(PLOTLY)
        expect(html.search(PLOTLY)).toBeLessThan(html.indexOf('<div id="chart">'))
    })

    it('is loaded when the page names it in an inline script', async () => {
        const html = await buildAppHtml({ 'app/index.html': '<html><head></head><body><script>window.Plotly.newPlot("c", [])</script></body></html>' }, { workerSources: {} })
        expect(html).toMatch(PLOTLY)
    })
})

describe('reseedAppPage', () => {
    it('swaps in the storage the app saved since its page was built, nothing else', async () => {
        const page = await buildAppPage({ 'app/index.html': '<html><head></head><body>"$$"</body></html>' }, { workerSources: {}, appStorage: { seed: { n: '1' }, writeable: true } })
        const again = reseedAppPage(page, { seed: { n: '2', note: '$$ $&' }, writeable: true })
        const { localStorage } = runShim(again.html)
        expect(localStorage.getItem('n')).toBe('2')
        expect(localStorage.getItem('note')).toBe('$$ $&')
        expect(again.html.replace(again.storageShim, '')).toBe(page.html.replace(page.storageShim, ''))
    })
})
