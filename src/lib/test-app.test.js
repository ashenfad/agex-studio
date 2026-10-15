import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { describe, expect, it } from 'vitest'
import { appDigest, hasApp, readApp } from './app-files.js'
import { GRID_MAX, gridLayout } from './grid.js'
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
        const edited = appDigest(await readApp(ws))
        expect(edited).not.toBe(before)
        // an asset replaced by other bytes of the same size
        await ws.files.write('/workspace/app/img/logo.png', new Uint8Array([137, 80, 78, 72]))
        expect(appDigest(await readApp(ws))).not.toBe(edited)
        await ws.close()
    })
})

describe('test_app’s result', () => {
    it('lists logs and results, with screenshots attached as images', async () => {
        const out = await formatResults([
            { type: 'log', level: 'log', message: 'ready' },
            { type: 'eval', expr: '1 + 1', value: '2' },
            { type: 'read', selector: '#n', value: 'two' },
            { type: 'screenshot', data: 'iVBORw0KGgo=' },
        ])
        expect(out.text).toBe('[log] ready\neval 1 + 1 → 2\nread #n → two\nscreenshot 1: attached')
        expect(out.images).toEqual([{ data: 'iVBORw0KGgo=', format: 'png' }])
        expect(out.isError).toBe(false)
        expect((await formatResults([])).text).toMatch(/no console output/)
    })

    it('says when an eval threw', async () => {
        const out = await formatResults([{ type: 'eval', expr: 'boom()', value: null, error: 'ReferenceError: boom is not defined (in: boom())' }])
        expect(out.text).toBe('eval boom() threw: ReferenceError: boom is not defined (in: boom())')
    })

    it('tiles a grid’s frames into one image at the end, in order, labelled', async () => {
        /** @type {{ data: string, label: string }[][]} */
        const tiled = []
        const tile = async (/** @type {{ data: string, label: string }[]} */ frames) => {
            tiled.push(frames)
            return `TILE${tiled.length}`
        }
        const out = await formatResults(
            [
                { type: 'screenshot', data: 'A', grid: 'scenes', label: '1.5s title' },
                { type: 'eval', expr: 'seek(6)', value: true },
                { type: 'screenshot', data: 'ONE' },
                { type: 'screenshot', data: 'B', grid: 'scenes', label: '6s chart' },
                { type: 'screenshot', data: 'C', grid: 'mobile' },
            ],
            { tile },
        )
        expect(tiled).toEqual([
            [{ data: 'A', label: '1.5s title' }, { data: 'B', label: '6s chart' }],
            [{ data: 'C', label: '' }],
        ])
        expect(out.images).toEqual([
            { data: 'ONE', format: 'png' },
            { data: 'TILE1', format: 'png' },
            { data: 'TILE2', format: 'png' },
        ])
        expect(out.text).toBe(
            [
                'screenshot: grid scenes, frame 1 (1.5s title)',
                'eval seek(6) → true',
                'screenshot 1: attached',
                'screenshot: grid scenes, frame 2 (6s chart)',
                'screenshot: grid mobile, frame 1',
                'grid scenes: 2 frames (1 1.5s title · 2 6s chart), attached as image 2',
                'grid mobile: 1 frame (1), attached as image 3',
            ].join('\n'),
        )
    })

    it('holds a grid to its most frames, and shows the frames one by one when tiling fails', async () => {
        const many = Array.from({ length: GRID_MAX + 2 }, (_, i) => ({ type: 'screenshot', data: `F${i}`, grid: 'g' }))
        const full = await formatResults(many, { tile: async (frames) => `T${frames.length}` })
        expect(full.images).toEqual([{ data: `T${GRID_MAX}`, format: 'png' }])
        expect(full.text).toMatch(new RegExp(`grid g is full \\(${GRID_MAX} frames\\)`))
        const broken = await formatResults(many.slice(0, 2), {
            tile: async () => {
                throw new Error('no canvas')
            },
        })
        expect(broken.images.map((i) => i.data)).toEqual(['F0', 'F1'])
        expect(broken.text).toMatch(/couldn't be tiled \(no canvas\): its 2 frames attached one by one/)
    })
})

describe('a grid’s layout', () => {
    it('picks columns by count and keeps the image within bounds', () => {
        const hd = { width: 1920, height: 1080 }
        const columnsOf = (/** @type {number} */ n) => new Set(gridLayout(Array(n).fill(hd)).cells.map((c) => c.x)).size
        expect([1, 2, 4, 5, 9, 10, 12].map(columnsOf)).toEqual([1, 2, 2, 3, 3, 4, 4])
        for (const n of [1, 4, 12]) expect(gridLayout(Array(n).fill(hd)).width).toBeLessThanOrEqual(1600)
        const four = gridLayout(Array(4).fill(hd))
        // frames keep their shape, rows below rows, captions under frames
        expect(four.cells[0]).toMatchObject({ width: 640, height: 360 })
        expect(four.cells[2]?.y).toBeGreaterThan(/** @type {any} */ (four.cells[0]).captionY)
        expect(four.cells[0]?.captionY).toBe(/** @type {any} */ (four.cells[0]).y + 360)
    })

    it('makes a row as tall as its tallest frame', () => {
        const out = gridLayout([{ width: 1920, height: 1080 }, { width: 390, height: 844 }])
        expect(out.cells[0]?.captionY).toBe(out.cells[1]?.captionY)
        expect(out.cells[1]?.height).toBeGreaterThan(/** @type {any} */ (out.cells[0]).height)
    })
})
