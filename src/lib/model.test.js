import { describe, expect, it, vi } from 'vitest'
import {
    anthropicBaseUrl,
    buildModel,
    conversationKey,
    sessionAffinityFetch,
    thinkingOf,
    usesSessionAffinity,
} from './model.js'
import { DEFAULTS } from './settings.js'

const custom = (over = {}) => ({ ...DEFAULTS, accessMode: 'custom', wire: 'anthropic', baseUrl: 'http://localhost:3456', endpointModel: 'claude-sonnet-5', ...over })

const body = (messages) => JSON.stringify({ model: 'm', messages })

describe('the session affinity key', () => {
    it('goes to an Anthropic-shaped custom endpoint other than Anthropic', () => {
        expect(usesSessionAffinity(custom())).toBe(true)
        expect(usesSessionAffinity(custom({ baseUrl: 'https://api.anthropic.com' }))).toBe(false)
        expect(usesSessionAffinity(custom({ wire: 'openai' }))).toBe(false)
        expect(usesSessionAffinity({ ...DEFAULTS, accessMode: 'openrouter' })).toBe(false)
    })

    it('names the session and the conversation’s first tool_use, once there is one', () => {
        expect(conversationKey('main', body([{ role: 'user', content: 'hi' }]))).toBeNull()
        const later = body([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'x', input: {} }] },
        ])
        expect(conversationKey('main', later)).toBe('agex-studio:main:toolu_1')
        expect(conversationKey('main', 'not json')).toBeNull()
    })

    it('rides a request with one, and is dropped for an origin whose CORS refuses it', async () => {
        const tagged = body([{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] }])
        const seen = []
        const ok = vi.fn(async (_url, init) => {
            seen.push(init?.headers?.['x-session-affinity'] ?? null)
            return new Response('{}')
        })
        await sessionAffinityFetch('s', ok)('http://localhost:1/v1/messages', { method: 'POST', body: tagged })
        expect(seen).toEqual(['agex-studio:s:t1'])

        // a proxy that refuses the header fails like a network error
        const refusing = vi.fn(async (_url, init) => {
            if (init?.headers?.['x-session-affinity']) throw new TypeError('Failed to fetch')
            return new Response('{}')
        })
        const f = sessionAffinityFetch('s', refusing)
        await f('http://localhost:2/v1/messages', { method: 'POST', body: tagged })
        await f('http://localhost:2/v1/messages', { method: 'POST', body: tagged })
        // tagged, retried untagged, then untagged from the start
        expect(refusing.mock.calls.map(([, init]) => init?.headers?.['x-session-affinity'] ?? null)).toEqual([
            'agex-studio:s:t1',
            null,
            null,
        ])
    })
})

describe('the model', () => {
    it('takes an Anthropic endpoint’s root with or without /v1', () => {
        expect(anthropicBaseUrl('http://localhost:3456')).toBe('http://localhost:3456/v1')
        expect(anthropicBaseUrl('http://localhost:3456/v1/')).toBe('http://localhost:3456/v1')
    })

    it('is built for each service', () => {
        const or = buildModel({ ...DEFAULTS, routerKey: 'k', routerModel: 'meta/muse-spark-1.3-contributor' }, { session: 's' })
        expect(or.modelId).toBe('meta/muse-spark-1.3-contributor')
        expect(buildModel(custom(), { session: 's' }).provider).toMatch(/anthropic/)
        expect(buildModel(custom({ wire: 'openai', endpointModel: 'llama' }), { session: 's' }).modelId).toBe('llama')
        expect(() => buildModel({ ...DEFAULTS, accessMode: 'scripted' }, { session: 's' })).toThrow(/no model/)
    })

    it("sends each service its own key: the endpoint's to the endpoint, never the OpenRouter key", async () => {
        /** @type {Record<string, string>[]} */
        const sent = []
        const fetch = vi.fn(async (_url, init) => {
            sent.push(Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])))
            return new Response('{}', { status: 500 })
        })
        const call = (model) => model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).catch(() => {})
        const both = { routerKey: 'sk-or-ROUTER', endpointKey: 'ENDPOINT' }
        await call(buildModel(custom({ ...both, baseUrl: 'https://api.anthropic.com' }), { session: 's', fetch }))
        await call(buildModel(custom({ ...both, wire: 'openai', baseUrl: 'http://localhost:8080/v1' }), { session: 's', fetch }))
        await call(buildModel({ ...DEFAULTS, ...both, routerModel: 'x/y' }, { session: 's', fetch }))
        expect(sent[0]?.['x-api-key']).toBe('ENDPOINT')
        expect(sent[1]?.authorization).toBe('Bearer ENDPOINT')
        expect(sent[2]?.authorization).toBe('Bearer sk-or-ROUTER')
        expect(JSON.stringify(sent.slice(0, 2))).not.toContain('sk-or-ROUTER')
    })

    it("carries the model's provider routing to OpenRouter, and none when it's left to OpenRouter", async () => {
        /** @type {any[]} */
        const bodies = []
        const fetch = vi.fn(async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)))
            return new Response('{}', { status: 500 })
        })
        const call = (model) => model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).catch(() => {})
        const s = { ...DEFAULTS, routerKey: 'k', routerModel: 'x/y' }
        await call(buildModel(s, { session: 's', fetch }))
        await call(buildModel({ ...s, routerZdr: true, routerRouting: { 'x/y': { provider: 'p/fast', only: true, sort: null } } }, { session: 's', fetch }))
        expect(bodies[0].provider).toBeUndefined()
        expect(bodies[1].provider).toEqual({ order: ['p/fast'], allow_fallbacks: false, zdr: true })
    })

    it('maps thinking off to false', () => {
        expect(thinkingOf({ ...DEFAULTS, thinking: 'off' })).toBe(false)
        expect(thinkingOf({ ...DEFAULTS, thinking: 'high' })).toBe('high')
    })
})
