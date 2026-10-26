import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAppHtml, buildAppPage, ecosystemImports, reseedAppPage } from './app-html.js'
import ecosystem from 'virtual:ecosystem-packages'
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
    return { localStorage: win.localStorage, sessionStorage: win.sessionStorage, posted }
}

describe('a test page’s storage', () => {
    const blank = { 'app/index.html': '<html><head></head><body></body></html>' }

    it('reports both stores to the test, and never as the app’s storage', async () => {
        const page = await buildAppPage(blank, { workerSources: {}, appStorage: { seed: { a: '1' }, writeable: false, report: true } })
        const { localStorage, sessionStorage, posted } = runShim(page.html)
        localStorage.setItem('b', '2')
        sessionStorage.setItem('tab', 'x')
        expect(posted.map((m) => m.type)).toEqual(['agex-test-storage', 'agex-test-storage'])
        expect(posted.at(-1)).toEqual({ type: 'agex-test-storage', local: { a: '1', b: '2' }, session: { tab: 'x' } })
        // the report is a copy, and the stores show the app nothing extra
        posted.at(-1).local.a = 'changed'
        expect(localStorage.getItem('a')).toBe('1')
        expect(Object.keys(localStorage)).not.toContain('snapshot')
    })

    it('posts nothing without report, and a writeable page posts its storage as before', async () => {
        const quiet = runShim((await buildAppPage(blank, { workerSources: {}, appStorage: { writeable: false } })).html)
        quiet.localStorage.setItem('k', 'v')
        expect(quiet.posted).toEqual([])
        const live = runShim((await buildAppPage(blank, { workerSources: {}, appStorage: { writeable: true, report: true } })).html)
        live.localStorage.setItem('k', 'v')
        expect(live.posted).toEqual([{ type: 'agex-app-storage', data: { k: 'v' } }])
    })

    it('starts sessionStorage from its seed', async () => {
        const page = await buildAppPage(blank, { workerSources: {}, appStorage: { writeable: false, report: true, sessionSeed: { tab: '</script>' } } })
        expect(runShim(page.html).sessionStorage.getItem('tab')).toBe('</script>')
    })
})

describe('the control bridge', () => {
    it('says when the page’s document has loaded, after it says it is ready', async () => {
        const page = await buildAppPage(blank(), { workerSources: {} })
        const bridge = page.html.match(/<script type="module">[\s\S]*?installControlBridge\(window\);([\s\S]*?)<\/script>/)?.[1]
        expect(bridge).toMatch(/agex-bridge-ready[\s\S]*agex-page-loaded/)
        expect(bridge).toContain("addEventListener('load'")
    })
})

function blank() {
    return { 'app/index.html': '<html><head></head><body></body></html>' }
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
        // a subpath built at run time comes through the prefix, which
        // carries the option in its path
        expect(imports['recharts/']).toBe('https://esm.sh/recharts@latest&external=preact,react,react-dom/')
        expect(imports['@preact/signals/']).toBe('https://esm.sh/@preact/signals@latest&external=preact,react,react-dom/')
        // what they leave bare comes to the pinned copy
        for (const spec of ['preact', 'react', 'react-dom', 'react/jsx-runtime']) {
            expect(imports[spec]).toMatch(/^https:\/\/esm\.sh\/preact@10\.25\.4(\/|$)/)
        }
        expect(imports.preact).toBe('https://esm.sh/preact@10.25.4')
        expect(imports['preact/hooks']).toBeUndefined()
    })

    it('gives an app agex-ts and its packages at the studio’s versions, one copy of each', async () => {
        const installed = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf-8'))
        const html = await buildAppHtml(
            {
                'app/main.js': [
                    "import { Agent } from 'agex-ts'",
                    "import { Store } from '@agex-ts/world'",
                    "import { Memory } from '@agex-ts/kvgit/backends/memory'",
                    'console.log(Agent, Store, Memory)',
                ].join('\n'),
            },
            { workerSources: {} },
        )
        const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports
        const agex = installed('agex-ts').version
        const world = installed('@agex-ts/world').version
        const kvgit = installed('@agex-ts/kvgit').version
        expect(imports['agex-ts']).toBe(`https://esm.sh/agex-ts@${agex}?external=@agex-ts/kvgit,@agex-ts/kvsql,@agex-ts/termish,@agex-ts/world`)
        expect(imports['@agex-ts/world']).toBe(`https://esm.sh/@agex-ts/world@${world}?external=@agex-ts/kvgit,@agex-ts/kvsql,@agex-ts/termish,agex-ts`)
        expect(imports['@agex-ts/kvgit/backends/memory']).toBe(
            `https://esm.sh/@agex-ts/kvgit@${kvgit}/backends/memory?external=@agex-ts/kvsql,@agex-ts/termish,@agex-ts/world,agex-ts`,
        )
        // every subpath a package exports, and no esm.sh copy of its own
        for (const name of ['agex-ts', '@agex-ts/world', '@agex-ts/kvgit', '@agex-ts/termish', '@agex-ts/kvsql']) {
            const { version, exports } = installed(name)
            expect(ecosystem[name]).toEqual({ version, subpaths: Object.keys(exports).filter((k) => k !== '.').map((k) => k.slice(2)) })
            for (const sub of ecosystem[name].subpaths) expect(imports[`${name}/${sub}`]).toContain(`${name}@${version}/${sub}?external=`)
            expect(imports[`${name}/`]).toBeUndefined()
        }
    })

    it('leaves out a package from its own externals, so its chunks stay its own', () => {
        const imports = ecosystemImports({ a: { version: '1.0.0', subpaths: ['x'] }, b: { version: '2.0.0', subpaths: [] } })
        expect(imports).toEqual({
            a: 'https://esm.sh/a@1.0.0?external=b',
            'a/x': 'https://esm.sh/a@1.0.0/x?external=b',
            b: 'https://esm.sh/b@2.0.0?external=a',
        })
    })

    it('adds the option to the ones a specifier already asks for', async () => {
        const html = await buildAppHtml(
            {
                'app/main.js': [
                    "import worker from 'monaco-editor?worker'",
                    "import { BarChart } from 'recharts@2.10.0/lib'",
                    'console.log(worker, BarChart)',
                ].join('\n'),
            },
            { workerSources: {} },
        )
        const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports
        expect(imports['monaco-editor?worker']).toBe('https://esm.sh/monaco-editor?worker&external=preact,react,react-dom')
        expect(imports['monaco-editor']).toBe('https://esm.sh/monaco-editor?external=preact,react,react-dom')
        expect(imports['monaco-editor/']).toBe('https://esm.sh/monaco-editor@latest&external=preact,react,react-dom/')
        // a version written in the specifier is kept in the prefix
        expect(imports['recharts@2.10.0/']).toBe('https://esm.sh/recharts@2.10.0&external=preact,react,react-dom/')
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

/** Run a built page's host bridge against a bare window: the `agex` it
 *  installs, what it posts to the studio, and a way to answer. */
function runBridge(html) {
    const src = html.match(/<script>\s*\/\/ getCacheValue[\s\S]*?<\/script>/)?.[0]
    const listeners = new Set()
    const posted = []
    const win = {
        addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
        removeEventListener: (type, fn) => listeners.delete(fn),
        __agexPost: (msg) => (posted.push(msg), true),
    }
    new Function('window', src.replace(/^<script>|<\/script>$/g, ''))(win)
    const send = (data) => {
        for (const fn of [...listeners]) fn({ data })
    }
    return { agex: win.agex, posted, send, listeners }
}

describe('agex.model() in the app', () => {
    const blank = { 'app/index.html': '<html><head></head><body></body></html>' }
    const messages = [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]
    const reply = { kind: 'Reply', message: { id: 'r', role: 'assistant', parts: [{ kind: 'text', text: 'hello' }] } }
    const tick = () => new Promise((r) => setTimeout(r, 0))

    it('streams one model call through the studio, its events as they come', async () => {
        const { agex, posted, send, listeners } = runBridge((await buildAppPage(blank, { workerSources: {} })).html)
        const model = agex.model()
        expect(model.name).toBe('agex-studio:viewer')
        const events = []
        const done = (async () => {
            for await (const e of model.stream(messages, [], { maxTokens: 100 })) events.push(e)
        })()
        await tick()
        expect(posted).toEqual([{ type: 'agex-model', id: posted[0].id, messages, tools: [], settings: { maxTokens: 100 } }])
        const id = posted[0].id
        send({ type: 'agex-model-event', id: 'another', event: { kind: 'TextDelta', text: 'no' } })
        send({ type: 'agex-model-event', id, event: { kind: 'TextDelta', text: 'he' } })
        await tick()
        expect(events).toEqual([{ kind: 'TextDelta', text: 'he' }])
        send({ type: 'agex-model-event', id, event: reply })
        send({ type: 'agex-model-end', id, error: null })
        await done
        expect(events).toEqual([{ kind: 'TextDelta', text: 'he' }, reply])
        expect(listeners.size).toBe(0)
        expect(posted).toHaveLength(1)
    })

    it('rejects with the failure, which transient and describe read as the viewer’s provider did', async () => {
        const { agex, posted, send } = runBridge((await buildAppPage(blank, { workerSources: {} })).html)
        const model = agex.model()
        const failed = (async () => {
            for await (const _ of model.stream(messages, [], {})) void _
        })().catch((e) => e)
        await tick()
        send({ type: 'agex-model-end', id: posted[0].id, error: { name: 'Error', message: 'overloaded', transient: true, describe: 'the model provider failed (529): overloaded' } })
        const e = await failed
        expect(e.message).toBe('overloaded')
        expect(model.transient(e)).toBe(true)
        expect(model.describe(e)).toBe('the model provider failed (529): overloaded')
        expect(model.transient(new Error('other'))).toBe(false)
        expect(model.describe(new Error('other'))).toBeNull()
    })

    it('stops the call in the studio when the signal aborts, or the agent leaves early', async () => {
        const { agex, posted, send, listeners } = runBridge((await buildAppPage(blank, { workerSources: {} })).html)
        const model = agex.model()
        const stop = new AbortController()
        const stopped = (async () => {
            for await (const _ of model.stream(messages, [], {}, { signal: stop.signal })) void _
        })().catch((e) => e)
        await tick()
        stop.abort()
        expect((await stopped).name).toBe('AbortError')
        expect(posted.at(-1)).toEqual({ type: 'agex-model-cancel', id: posted[0].id })
        expect(listeners.size).toBe(0)

        const it = model.stream(messages, [], {})[Symbol.asyncIterator]()
        const first = it.next()
        await tick()
        const id = posted.at(-1).id
        send({ type: 'agex-model-event', id, event: { kind: 'TextDelta', text: 'he' } })
        expect((await first).value).toEqual({ kind: 'TextDelta', text: 'he' })
        await it.return()
        expect(posted.at(-1)).toEqual({ type: 'agex-model-cancel', id })

        // aborted already: nothing is sent
        const count = posted.length
        const gone = new AbortController()
        gone.abort()
        const e = await model.stream(messages, [], {}, { signal: gone.signal }).next().catch((err) => err)
        expect(e.name).toBe('AbortError')
        expect(posted).toHaveLength(count)
    })
})

describe('agex.kvStore() in the app', () => {
    it('sends each call to the studio as a kv call on its store, and answers with the reply', async () => {
        const { agex, posted, send } = runBridge((await buildAppPage(blank(), { workerSources: {} })).html)
        const kv = agex.kvStore('world')
        const answer = (value) => send({ type: 'agex-db-result', id: posted.at(-1).id, value, error: null })

        const got = kv.get('k')
        expect(posted.at(-1)).toMatchObject({ type: 'agex-db', op: 'kv', args: ['get', { key: 'k', store: 'world' }] })
        answer(new Uint8Array([1]))
        expect(await got).toEqual(new Uint8Array([1]))

        const many = kv.getMany(new Set(['a', 'b']))
        expect(posted.at(-1).args).toEqual(['getMany', { keys: ['a', 'b'], store: 'world' }])
        answer([['a', new Uint8Array([2])]])
        expect(await many).toEqual(new Map([['a', new Uint8Array([2])]]))

        const swapped = kv.casMany(new Map([['h', null]]), new Map([['h', new Uint8Array([3])]]))
        expect(posted.at(-1).args).toEqual(['casMany', { expected: [['h', null]], writes: [['h', new Uint8Array([3])]], removes: [], store: 'world' }])
        answer(true)
        expect(await swapped).toBe(true)

        const keys = []
        const listing = (async () => {
            for await (const k of kv.keys('p:')) keys.push(k)
        })()
        await new Promise((r) => setTimeout(r, 0))
        expect(posted.at(-1).args).toEqual(['keys', { prefix: 'p:', store: 'world' }])
        answer(['p:1', 'p:2'])
        await listing
        expect(keys).toEqual(['p:1', 'p:2'])
    })

    it('is the default store without a name, and refuses an empty one', async () => {
        const { agex, posted } = runBridge((await buildAppPage(blank(), { workerSources: {} })).html)
        void agex.kvStore().clear()
        expect(posted.at(-1).args).toEqual(['clear', { store: 'default' }])
        expect(() => agex.kvStore('')).toThrow('non-empty string')
    })
})

describe('agex.busy', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('returns the promise it was given, and posts the work in flight as it changes', async () => {
        const { agex, posted } = runBridge((await buildAppPage(blank(), { workerSources: {} })).html)
        let finish
        const work = new Promise((resolve) => (finish = resolve))
        expect(agex.busy(work)).toBe(work)
        expect(posted).toEqual([{ type: 'agex-busy', busy: 1 }])
        finish('done')
        expect(await work).toBe('done')
        await settle()
        expect(posted.at(-1)).toEqual({ type: 'agex-busy', busy: 0 })
    })

    it('counts overlapping work, a rejection settling it as a resolve does', async () => {
        const { agex, posted } = runBridge((await buildAppPage(blank(), { workerSources: {} })).html)
        let fail
        let finish
        const failing = agex.busy(new Promise((_, reject) => (fail = reject)))
        agex.busy(new Promise((resolve) => (finish = resolve)))
        expect(posted.map((m) => m.busy)).toEqual([1, 2])
        fail(new Error('turn failed'))
        await expect(failing).rejects.toThrow('turn failed')
        await settle()
        expect(posted.map((m) => m.busy)).toEqual([1, 2, 1])
        finish()
        await settle()
        expect(posted.map((m) => m.busy)).toEqual([1, 2, 1, 0])
    })
})
