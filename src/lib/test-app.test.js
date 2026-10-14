import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { describe, expect, it } from 'vitest'
import { appDigest, hasApp, readApp } from './app-files.js'
import { formatResults } from './test-app.js'

describe('the app’s files', () => {
    it('are read by app/ path, text apart from binary, with a fingerprint that follows them', async () => {
        const ws = await (await Store.open(new Memory())).open('s')
        expect(hasApp(await readApp(ws))).toBe(false)
        await ws.files.write('/workspace/app/index.html', '<div id="app"></div>')
        await ws.files.write('/workspace/app/img/logo.png', new Uint8Array([137, 80, 78, 71]))
        await ws.files.write('/workspace/notes.md', 'not the app')
        const app = await readApp(ws)
        expect(Object.keys(app.files)).toEqual(['app/index.html'])
        expect(Object.keys(app.binaries)).toEqual(['app/img/logo.png'])
        expect(hasApp(app)).toBe(true)
        const before = appDigest(app)
        await ws.files.write('/workspace/app/index.html', '<div id="app">!</div>')
        expect(appDigest(await readApp(ws))).not.toBe(before)
        await ws.close()
    })
})

describe('test_app’s result', () => {
    it('lists logs and results, with screenshots attached as images', () => {
        const out = formatResults([
            { type: 'log', level: 'log', message: 'ready' },
            { type: 'eval', expr: '1 + 1', value: '2' },
            { type: 'read', selector: '#n', value: 'two' },
            { type: 'screenshot', data: 'iVBORw0KGgo=' },
        ])
        expect(out.text).toBe('[log] ready\neval 1 + 1 → 2\nread #n → two\nscreenshot 1: attached')
        expect(out.images).toEqual([{ data: 'iVBORw0KGgo=', format: 'png' }])
        expect(out.isError).toBe(false)
        expect(formatResults([]).text).toMatch(/no console output/)
    })
})
