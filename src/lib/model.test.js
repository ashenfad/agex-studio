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

const custom = (over = {}) => ({ ...DEFAULTS, accessMode: 'custom', wire: 'anthropic', baseUrl: 'http://localhost:3456', model: 'claude-sonnet-5', ...over })

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
        const or = buildModel({ ...DEFAULTS, apiKey: 'k', model: 'meta/muse-spark-1.3-contributor' }, { session: 's' })
        expect(or.modelId).toBe('meta/muse-spark-1.3-contributor')
        expect(buildModel(custom(), { session: 's' }).provider).toMatch(/anthropic/)
        expect(buildModel(custom({ wire: 'openai', model: 'llama' }), { session: 's' }).modelId).toBe('llama')
        expect(() => buildModel({ ...DEFAULTS, accessMode: 'scripted' }, { session: 's' })).toThrow(/no model/)
    })

    it('maps thinking off to false', () => {
        expect(thinkingOf({ ...DEFAULTS, thinking: 'off' })).toBe(false)
        expect(thinkingOf({ ...DEFAULTS, thinking: 'high' })).toBe('high')
    })
})
