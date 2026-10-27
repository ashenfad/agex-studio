import { describe, expect, it } from 'vitest'
import { answerFetch } from './app-fetch.js'
import { answerFromStandIns, matchStandIn, parseStandIns, standInsScript, standInsWorkerSources } from './stand-ins.js'

describe('parseStandIns', () => {
    it('takes origin and path, a method upper-cased, and json as its text with its type', () => {
        const { standIns, errors } = parseStandIns([
            { url: 'https://api.stripe.com/v1/prices', json: [{ id: 'p_1' }] },
            { url: 'https://api.example.com/items/', method: 'post', status: 201, headers: { 'X-Id': '7' }, body: 'made' },
            { url: 'https://api.example.com/gone', status: 204, body: 'ignored' },
        ])
        expect(errors).toEqual([])
        expect(standIns).toEqual([
            { url: 'https://api.stripe.com/v1/prices', method: null, status: 200, headers: { 'content-type': 'application/json' }, body: '[{"id":"p_1"}]' },
            { url: 'https://api.example.com/items/', method: 'POST', status: 201, headers: { 'X-Id': '7' }, body: 'made' },
            { url: 'https://api.example.com/gone', method: null, status: 204, headers: {}, body: null },
        ])
        // a content type of the agent's own is kept
        expect(parseStandIns([{ url: 'https://a.example/x', json: 1, headers: { 'Content-Type': 'application/vnd.api+json' } }]).standIns[0].headers).toEqual({ 'Content-Type': 'application/vnd.api+json' })
        expect(parseStandIns(undefined)).toEqual({ standIns: [], errors: [] })
    })

    it('names each mistake', () => {
        const { standIns, errors } = parseStandIns([
            { url: 'https://api.example.com/x?page=2', methd: 'GET' },
            { url: 'ftp://files.example.com/a', status: 99, body: 3 },
            { url: 'https://a.example/x', body: 'a', json: 'b', headers: { n: 1 } },
            'https://a.example/y',
        ])
        expect(standIns).toEqual([])
        expect(errors).toEqual([
            'standIns[0]: unknown key "methd" (expected "url", "method", "status", "headers", "body", "json")',
            'standIns[0].url: "https://api.example.com/x?page=2" has a query or fragment; give the origin and path, which any query matches',
            'standIns[1].url: "ftp://files.example.com/a" isn\'t https: or http:',
            'standIns[1].status: must be a status from 200 to 599; got 99',
            'standIns[1].body: must be a string (json takes any value); got number',
            'standIns[2].headers: must be an object of header names to strings; got object',
            'standIns[2]: give body or json, not both',
            'standIns[3]: must be an object like {"url": "https://api.example.com/v1/items", "json": [...]}; got string',
        ])
        expect(parseStandIns([{ url: 'https://a.example/x', headers: { 'bad header': 'x', 'X-Ok': 'a\nb' } }]).errors).toEqual([
            'standIns[0].headers: "bad header": "x" isn\'t a header a response can carry (a name is letters, digits and -, a value one line)',
            'standIns[0].headers: "X-Ok": "a\\nb" isn\'t a header a response can carry (a name is letters, digits and -, a value one line)',
        ])
        expect(parseStandIns({}).errors).toEqual(['standIns: must be a list of stand-ins; got object'])
        expect(parseStandIns(Array.from({ length: 51 }, () => ({ url: 'https://a.example/' }))).errors).toEqual(['standIns: at most 50; got 51'])
    })
})

describe('matchStandIn', () => {
    const { standIns } = parseStandIns([
        { url: 'https://api.example.com/items', method: 'POST', body: 'made' },
        { url: 'https://api.example.com/items', body: 'listed' },
    ])
    it('matches origin and path whatever the query, and the method when it says one', () => {
        expect(matchStandIn(standIns, 'post', 'https://api.example.com/items?x=1')?.body).toBe('made')
        expect(matchStandIn(standIns, 'GET', 'https://api.example.com/items#top')?.body).toBe('listed')
        expect(matchStandIn(standIns, 'GET', 'https://api.example.com/items/1')).toBeNull()
        expect(matchStandIn(standIns, 'GET', 'http://api.example.com/items')).toBeNull()
        expect(matchStandIn(standIns, 'GET', 'not a url')).toBeNull()
    })

    it('prefers one that names the method, wherever it is in the list', () => {
        const { standIns: anyFirst } = parseStandIns([
            { url: 'https://api.example.com/items', body: 'listed' },
            { url: 'https://api.example.com/items', method: 'DELETE', status: 204 },
        ])
        expect(matchStandIn(anyFirst, 'DELETE', 'https://api.example.com/items')?.status).toBe(204)
        expect(matchStandIn(anyFirst, 'GET', 'https://api.example.com/items')?.body).toBe('listed')
    })
})

describe('answerFromStandIns', () => {
    const needs = { model: false, secrets: [{ name: 'STRIPE_KEY', origins: ['https://api.stripe.com'], header: 'Authorization', why: 'prices' }] }
    const { standIns } = parseStandIns([{ url: 'https://api.stripe.com/v1/prices', json: { echoed: 'stand-in-key-for-STRIPE_KEY' } }])
    const answer = (data) => answerFromStandIns(standIns, data, (ctx) => answerFetch(data, { needs, ...ctx }))
    const message = (over) => ({ type: 'agex-fetch', id: 'r1', url: 'https://api.stripe.com/v1/prices?limit=3', method: 'GET', headers: [['authorization', 'Bearer ${STRIPE_KEY}']], body: null, ...over })

    it('answers a request with a secret from its stand-in, saying so, and the key it carried is scrubbed', async () => {
        const reply = await answer(message())
        expect(reply).toMatchObject({ type: 'agex-fetch-result', id: 'r1', status: 200, error: null, note: '[stand-in] GET https://api.stripe.com/v1/prices?limit=3 (authorization: Bearer ${STRIPE_KEY}) → 200' })
        expect(JSON.parse(new TextDecoder().decode(reply.body))).toEqual({ echoed: '${STRIPE_KEY}' })
    })

    it('refuses a request fetch would, as it would be for real', async () => {
        const reply = await answer(message({ method: 'TRACE' }))
        expect(reply.error).toMatch(/^agex\.fetch: .*TRACE/i)
        expect(reply.note).toBe(`[stand-in] TRACE https://api.stripe.com/v1/prices?limit=3: refused: ${reply.error}`)
        expect(reply).not.toHaveProperty('status')
    })

    it('answers HEAD without a body', async () => {
        const reply = await answer(message({ method: 'HEAD' }))
        expect([reply.status, reply.body.length]).toEqual([200, 0])
    })

    it('refuses one no stand-in matches, and sends nothing', async () => {
        const reply = await answer(message({ url: 'https://api.stripe.com/v1/customers' }))
        expect(reply).toEqual({
            type: 'agex-fetch-result',
            id: 'r1',
            error: 'agex.fetch: no stand-in answers GET https://api.stripe.com/v1/customers; in a test with standIns, every request with a secret needs one, and none is sent',
            note: '[stand-in] GET https://api.stripe.com/v1/customers: none matches, refused',
        })
    })

    it('checks the request as for real first', async () => {
        const reply = await answer(message({ headers: [['x-key', '${STRIPE_KEY}']] }))
        expect(reply.error).toBe('agex.fetch: ${STRIPE_KEY} is in the x-key header; it goes in its Authorization header only, as app/agex.json declares')
        expect(reply.note).toBe(`[stand-in] GET https://api.stripe.com/v1/prices?limit=3: refused: ${reply.error}`)
    })
})

describe('standInsScript', () => {
    /** The script run over a window whose own fetch records what reaches it. */
    function run(list) {
        const reached = []
        const win = { __agex_logs: [], fetch: (input) => (reached.push(String(input)), Promise.resolve(new Response('network'))) }
        const src = standInsScript(parseStandIns(list).standIns).trim()
        new Function('self', 'location', src.replace(/^<script>|<\/script>$/g, ''))(win, { href: 'https://apps.example/app/' })
        return { win, reached }
    }

    it('answers a request to a stand-in in place of the network, said in the console output', async () => {
        const { win, reached } = run([{ url: 'https://api.example.com/items', json: [1, 2] }, { url: 'https://api.example.com/items', method: 'DELETE', status: 204 }])
        const res = await win.fetch('https://api.example.com/items?page=1')
        expect([res.status, res.url, res.headers.get('content-type'), await res.json()]).toEqual([200, 'https://api.example.com/items?page=1', 'application/json', [1, 2]])
        expect((await win.fetch(new Request('https://api.example.com/items', { method: 'DELETE' }))).status).toBe(204)
        expect(await (await win.fetch('https://api.example.com/other')).text()).toBe('network')
        expect(reached).toEqual(['https://api.example.com/other'])
        expect(win.__agex_logs).toEqual([
            { level: 'info', message: '[stand-in] GET https://api.example.com/items?page=1 → 200' },
            { level: 'info', message: '[stand-in] DELETE https://api.example.com/items → 204' },
        ])
    })

    it('answers a worker’s requests too, ahead of its own code', async () => {
        const { standIns } = parseStandIns([{ url: 'https://api.example.com/items', body: 'from the stand-in' }])
        const sources = standInsWorkerSources({ 'sum.worker.js': 'self.done = self.fetch("https://api.example.com/items").then((r) => r.text())' }, standIns)
        const worker = { fetch: () => Promise.resolve(new Response('network')) }
        new Function('self', 'location', sources['sum.worker.js'])(worker, { href: 'blob:https://apps.example/1' })
        expect(await worker.done).toBe('from the stand-in')
        expect(standInsWorkerSources({ 'a.worker.js': 'x' }, [])).toEqual({ 'a.worker.js': 'x' })
    })

    it('rejects as fetch does when the signal is aborted before it answers', async () => {
        const { win } = run([{ url: 'https://api.example.com/items', body: 'listed' }])
        const before = new AbortController()
        before.abort()
        await expect(win.fetch('https://api.example.com/items', { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
        const during = new AbortController()
        const pending = win.fetch(new Request('https://api.example.com/items', { signal: during.signal }))
        during.abort(new Error('stopped'))
        await expect(pending).rejects.toThrow('stopped')
        // and neither was answered
        expect(win.__agex_logs).toEqual([])
    })

    it('refuses a request fetch would, and answers HEAD without a body', async () => {
        const { win, reached } = run([{ url: 'https://api.example.com/items', body: 'listed' }])
        await expect(win.fetch('https://api.example.com/items', { method: 'GET', body: 'x' })).rejects.toBeInstanceOf(TypeError)
        await expect(win.fetch('https://api.example.com/items', { method: 'TRACE' })).rejects.toBeInstanceOf(TypeError)
        const head = await win.fetch('https://api.example.com/items', { method: 'HEAD' })
        expect([head.status, await head.text()]).toEqual([200, ''])
        expect(reached).toEqual([])
        // a Request passed on to the network keeps its body
        const { win: other, reached: sent } = run([{ url: 'https://api.example.com/items', body: 'listed' }])
        const post = new Request('https://api.example.com/other', { method: 'POST', body: 'kept' })
        await other.fetch(post)
        expect([sent, post.bodyUsed]).toEqual([['[object Request]'], false])
    })

    it('is nothing without stand-ins, and keeps a `</script>` in a body from ending it', () => {
        expect(standInsScript([])).toBe('')
        const src = standInsScript(parseStandIns([{ url: 'https://a.example/x', body: '</script>' }]).standIns)
        expect(src.match(/<\/script>/g)).toHaveLength(1)
    })
})
