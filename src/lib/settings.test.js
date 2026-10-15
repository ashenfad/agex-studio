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
        const stop = settingsStore.subscribe((s) => seen.push(s.routerModel))
        updateSettings({ routerModel: 'meta/muse-spark-1.3-contributor' })
        stop()
        expect(seen).toEqual(['google/gemini-3.8-flash', 'meta/muse-spark-1.3-contributor'])
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).routerModel).toBe('meta/muse-spark-1.3-contributor')
    })

    it('say when a model can be reached', async () => {
        const { DEFAULTS, isConfigured } = await import('./settings.js')
        expect(isConfigured(DEFAULTS)).toBe(false)
        expect(isConfigured({ ...DEFAULTS, routerKey: 'k' })).toBe(true)
        expect(isConfigured({ ...DEFAULTS, accessMode: 'custom', baseUrl: 'http://localhost:3456' })).toBe(false)
        expect(isConfigured({ ...DEFAULTS, accessMode: 'custom', baseUrl: 'http://localhost:3456', endpointModel: 'local' })).toBe(true)
        expect(isConfigured({ ...DEFAULTS, accessMode: 'scripted' })).toBe(true)
    })

    it('move a saved apiKey to the key for its service, an OpenRouter one never to an endpoint', async () => {
        const { DEFAULTS, migrate } = await import('./settings.js')
        const saved = (over) => ({ ...DEFAULTS, ...over })
        expect(migrate(saved({ accessMode: 'openrouter', apiKey: 'sk-or-v1-abc' }))).toMatchObject({ routerKey: 'sk-or-v1-abc', endpointKey: '' })
        // left behind when the service changed: an OpenRouter key stays OpenRouter's
        expect(migrate(saved({ accessMode: 'custom', apiKey: 'sk-or-v1-abc' }))).toMatchObject({ routerKey: 'sk-or-v1-abc', endpointKey: '' })
        expect(migrate(saved({ accessMode: 'custom', apiKey: 'local-secret' }))).toMatchObject({ routerKey: '', endpointKey: 'local-secret' })
        expect(migrate(saved({ accessMode: 'openrouter', apiKey: 'old', routerKey: 'new' })).routerKey).toBe('new')
        expect(migrate(saved({ apiKey: 'x' }))).not.toHaveProperty('apiKey')
    })

    it('read saved settings with one apiKey as two keys', async () => {
        localStorage.setItem('agex-studio-settings', JSON.stringify({ accessMode: 'custom', baseUrl: 'http://localhost:3456', apiKey: 'sk-or-v1-abc', model: 'm' }))
        const { getSettings } = await import('./settings.js')
        expect(getSettings()).toMatchObject({ routerKey: 'sk-or-v1-abc', endpointKey: '' })
    })

    it('move a saved model to the model of its service', async () => {
        const { DEFAULTS, migrate } = await import('./settings.js')
        const saved = (over) => ({ ...DEFAULTS, ...over })
        expect(migrate(saved({ accessMode: 'openrouter', model: 'anthropic/claude-sonnet-5' }))).toMatchObject({ routerModel: 'anthropic/claude-sonnet-5', endpointModel: '' })
        expect(migrate(saved({ accessMode: 'custom', model: 'claude-local' }))).toMatchObject({ routerModel: DEFAULTS.routerModel, endpointModel: 'claude-local' })
        expect(migrate(saved({ model: 'x' }))).not.toHaveProperty('model')
    })
})

