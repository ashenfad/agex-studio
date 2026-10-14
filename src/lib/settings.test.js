import { beforeEach, describe, expect, it, vi } from 'vitest'

// an in-memory localStorage: Node's own global (Node 22+) has none of
// the methods without a backing file
beforeEach(() => {
    const items = new Map()
    vi.stubGlobal('localStorage', {
        getItem: (k) => items.get(k) ?? null,
        setItem: (k, v) => items.set(k, String(v)),
        clear: () => items.clear(),
    })
    vi.resetModules()
})

describe('settings', () => {
    it('start from the defaults, persist an update, and tell subscribers', async () => {
        const { getSettings, settingsStore, updateSettings, STORAGE_KEY } = await import('./settings.js')
        expect(getSettings().accessMode).toBe('openrouter')
        const seen = []
        const stop = settingsStore.subscribe((s) => seen.push(s.model))
        updateSettings({ model: 'meta/muse-spark-1.3-contributor' })
        stop()
        expect(seen).toEqual(['google/gemini-3.8-flash', 'meta/muse-spark-1.3-contributor'])
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).model).toBe('meta/muse-spark-1.3-contributor')
    })

    it('say when a model can be reached', async () => {
        const { DEFAULTS, isConfigured } = await import('./settings.js')
        expect(isConfigured(DEFAULTS)).toBe(false)
        expect(isConfigured({ ...DEFAULTS, apiKey: 'k' })).toBe(true)
        expect(isConfigured({ ...DEFAULTS, accessMode: 'custom', baseUrl: 'http://localhost:3456' })).toBe(true)
        expect(isConfigured({ ...DEFAULTS, accessMode: 'scripted' })).toBe(true)
    })
})
