import { describe, expect, it } from 'vitest'
import { WHY_MAX, parseNeeds } from './app-needs.js'

const stripe = { name: 'STRIPE_KEY', origins: ['https://api.stripe.com'], in: 'header:Authorization', why: 'to look up prices' }

/** The errors for a manifest with one secret: `stripe` with `change`. */
const secretErrors = (change) => parseNeeds(JSON.stringify({ needs: { secrets: [{ ...stripe, ...change }] } })).errors

describe('an app’s needs', () => {
    it('are none without a file, or with no needs in it', () => {
        expect(parseNeeds(null)).toEqual({ needs: { model: false, secrets: [] }, errors: [] })
        expect(parseNeeds('{}')).toEqual({ needs: { model: false, secrets: [] }, errors: [] })
        expect(parseNeeds('{ "needs": {} }')).toEqual({ needs: { model: false, secrets: [] }, errors: [] })
    })

    it('are read and normalized', () => {
        const { needs, errors } = parseNeeds(JSON.stringify({
            needs: {
                model: true,
                secrets: [
                    { ...stripe, origins: ['https://API.Stripe.com:443/', 'https://api.stripe.com', 'https://files.stripe.com:8443'], why: '  to look up prices ' },
                    { name: 'X_2', origins: ['https://example.org'], in: 'header:X-Api-Key', why: 'search' },
                ],
            },
        }))
        expect(errors).toEqual([])
        expect(needs).toEqual({
            model: true,
            secrets: [
                { name: 'STRIPE_KEY', origins: ['https://api.stripe.com', 'https://files.stripe.com:8443'], header: 'Authorization', why: 'to look up prices' },
                { name: 'X_2', origins: ['https://example.org'], header: 'X-Api-Key', why: 'search' },
            ],
        })
    })

    it('are none when the file has a mistake, which is named', () => {
        const { needs, errors } = parseNeeds(JSON.stringify({ needs: { model: true, secrets: [stripe, { ...stripe, name: 'B', in: 'header:Cookie' }] } }))
        expect(needs).toEqual({ model: false, secrets: [] })
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatch(/^app\/agex\.json: needs\.secrets\[1\]\.in: /)
    })
})

describe('a mistake in app/agex.json', () => {
    it('is invalid JSON, with the parser’s message', () => {
        const { errors } = parseNeeds('{ "needs": ')
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatch(/^app\/agex\.json: invalid JSON: ./)
    })

    it('is a file or needs that isn’t an object', () => {
        expect(parseNeeds('[]').errors).toEqual(['app/agex.json: the file must be an object, like { "needs": { "model": true } }; got a list'])
        expect(parseNeeds('{ "needs": true }').errors).toEqual(['app/agex.json: needs: must be an object, like { "model": true }; got true'])
        expect(parseNeeds('{ "needs": { "model": "yes" } }').errors).toEqual(['app/agex.json: needs.model: must be true or false; got "yes"'])
        expect(parseNeeds('{ "needs": { "secrets": {} } }').errors).toEqual(['app/agex.json: needs.secrets: must be a list of secrets; got an object'])
        expect(parseNeeds('{ "needs": { "secrets": ["STRIPE_KEY"] } }').errors).toEqual([
            'app/agex.json: needs.secrets[0]: must be an object with name, origins, in and why; got "STRIPE_KEY"',
        ])
    })

    it('is an unknown key, anywhere, named', () => {
        const { errors } = parseNeeds(JSON.stringify({ need: {}, needs: { modle: true, secrets: [{ ...stripe, orgins: [] }] } }))
        expect(errors).toEqual([
            'app/agex.json: unknown key "need" (expected "needs")',
            'app/agex.json: needs: unknown key "modle" (expected "model", "secrets")',
            'app/agex.json: needs.secrets[0]: unknown key "orgins" (expected "name", "origins", "in", "why")',
        ])
    })

    it('is a missing part of a secret', () => {
        const { errors } = parseNeeds(JSON.stringify({ needs: { secrets: [{}] } }))
        expect(errors).toEqual([
            'app/agex.json: needs.secrets[0].name: is missing; name the secret, like "STRIPE_KEY"',
            'app/agex.json: needs.secrets[0].origins: is missing; list the origins the secret may go to, like ["https://api.example.com"]',
            'app/agex.json: needs.secrets[0].in: is missing; say which request header the secret goes in, like "header:Authorization"',
            'app/agex.json: needs.secrets[0].why: is missing; say what the app uses the key for, like "to look up prices"',
        ])
    })

    it('is a name that isn’t upper case, or is declared twice', () => {
        expect(secretErrors({ name: 'stripe-key' })).toEqual([
            'app/agex.json: needs.secrets[0].name: "stripe-key" must be upper-case letters, digits and _, starting with a letter, like "STRIPE_KEY"',
        ])
        expect(secretErrors({ name: '1KEY' })[0]).toMatch(/like "KEY"$/)
        expect(secretErrors({ name: 7 })[0]).toMatch(/name: must be a string, like "STRIPE_KEY"; got 7$/)
        const twice = parseNeeds(JSON.stringify({ needs: { secrets: [stripe, stripe] } })).errors
        expect(twice).toEqual(['app/agex.json: needs.secrets[1].name: "STRIPE_KEY" is declared twice; give each secret its own name'])
    })

    it('is an origin with more than the origin', () => {
        expect(secretErrors({ origins: ['https://api.stripe.com', 'https://api.stripe.com/v1'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[1]: "https://api.stripe.com/v1" has a path; give the origin alone ("https://api.stripe.com")',
        ])
        expect(secretErrors({ origins: ['https://api.stripe.com/?a=1#x'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[0]: "https://api.stripe.com/?a=1#x" has a query and a fragment; give the origin alone ("https://api.stripe.com")',
        ])
        expect(secretErrors({ origins: ['https://api.stripe.com?'] })[0]).toMatch(/has a query/)
        expect(secretErrors({ origins: ['https://me:pw@api.stripe.com'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[0]: "https://me:pw@api.stripe.com" has credentials; give the origin alone ("https://api.stripe.com") and the key as the secret',
        ])
        expect(secretErrors({ origins: ['https://@api.stripe.com'] })[0]).toMatch(/has credentials/)
    })

    it('is an origin that isn’t https, or isn’t an origin', () => {
        expect(secretErrors({ origins: ['http://api.stripe.com'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[0]: "http://api.stripe.com" is http:; a secret goes over https: only ("https://api.stripe.com")',
        ])
        expect(secretErrors({ origins: ['http://localhost:8080'] })[0]).toMatch(/is http:; a secret goes over https: only/)
        expect(secretErrors({ origins: ['api.stripe.com'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[0]: "api.stripe.com" isn\'t an origin; give the scheme and host, like "https://api.stripe.com"',
        ])
        expect(secretErrors({ origins: ['api.stripe.com:443'] })[0]).toMatch(/like "https:\/\/api\.stripe\.com:443"$/)
        expect(secretErrors({ origins: ['https:api.stripe.com'] })[0]).toMatch(/like "https:\/\/api\.stripe\.com"$/)
        expect(secretErrors({ origins: ['wss://api.stripe.com'] })[0]).toMatch(/isn't an https: origin/)
        expect(secretErrors({ origins: [42] })[0]).toMatch(/origins\[0\]: must be a string/)
    })

    it('is a wildcard', () => {
        expect(secretErrors({ origins: ['https://*.stripe.com'] })).toEqual([
            'app/agex.json: needs.secrets[0].origins[0]: "https://*.stripe.com" has a wildcard; list each origin the secret may go to, like "https://api.example.com"',
        ])
    })

    it('is origins that are no list, or an empty one', () => {
        expect(secretErrors({ origins: 'https://api.stripe.com' })).toEqual([
            'app/agex.json: needs.secrets[0].origins: must be a list of origins, like ["https://api.stripe.com"]; got "https://api.stripe.com"',
        ])
        expect(secretErrors({ origins: [] })[0]).toMatch(/origins: is empty/)
    })

    it('is the studio’s own origin, or its apps’', () => {
        for (const origin of ['https://agex.studio', 'https://apps.agex.studio', 'https://www.agex.studio:8443']) {
            expect(secretErrors({ origins: [origin] })).toEqual([
                `app/agex.json: needs.secrets[0].origins[0]: "${origin}" is the studio's own; a secret never goes to the studio or its apps`,
            ])
        }
        // and wherever the studio runs
        const text = JSON.stringify({ needs: { secrets: [{ ...stripe, origins: ['https://studio.test:4173'] }] } })
        expect(parseNeeds(text, { studioOrigins: ['https://studio.test:4173'] }).errors[0]).toMatch(/is the studio's own/)
        expect(parseNeeds(text).errors).toEqual([])
    })

    it('is a place other than a header', () => {
        expect(secretErrors({ in: 'query:key' })).toEqual([
            'app/agex.json: needs.secrets[0].in: "query:key": a secret goes in one request header only, never a URL, query or body; write "header:<Name>", like "header:Authorization"',
        ])
        expect(secretErrors({ in: 'Authorization' })[0]).toMatch(/write "header:<Name>"/)
        expect(secretErrors({ in: 'header: Authorization' })).toEqual([
            'app/agex.json: needs.secrets[0].in: "header: Authorization": " Authorization" isn\'t a header name (letters, digits and -, no spaces); write it like "header:Authorization"',
        ])
        expect(secretErrors({ in: 'header:' })[0]).toMatch(/"" isn't a header name/)
    })

    it('is a header the browser keeps, or one that describes the request', () => {
        for (const header of ['Host', 'Cookie', 'content-length', 'Origin', 'Referer', 'Sec-Fetch-Site', 'Proxy-Authorization']) {
            expect(secretErrors({ in: `header:${header}` })).toEqual([
                `app/agex.json: needs.secrets[0].in: "header:${header}": the browser sets ${header} itself and a page can't, so a secret can't go there; use the header the service reads its key from, like "header:Authorization"`,
            ])
        }
        for (const header of ['Content-Type', 'Accept', 'X-HTTP-Method-Override']) {
            expect(secretErrors({ in: `header:${header}` })[0]).toMatch(`${header} describes the request`)
        }
        for (const header of ['Authorization', 'X-Api-Key', 'Api-Key', 'x-goog-api-key']) {
            expect(secretErrors({ in: `header:${header}` })).toEqual([])
        }
    })

    it('is a why that is empty, or long', () => {
        expect(secretErrors({ why: '  ' })).toEqual([
            'app/agex.json: needs.secrets[0].why: is empty; say what the app uses the key for, like "to look up prices"',
        ])
        expect(secretErrors({ why: 'x'.repeat(WHY_MAX) })).toEqual([])
        expect(secretErrors({ why: 'x'.repeat(WHY_MAX + 1) })[0]).toMatch(`is ${WHY_MAX + 1} characters; keep it to ${WHY_MAX} or fewer`)
    })

    it('is listed with every other', () => {
        const { errors } = parseNeeds(JSON.stringify({
            needs: { model: 1, secrets: [{ ...stripe, name: 'a', origins: ['http://x.com', 'https://y.com/z'], in: 'header:Host', why: '' }] },
        }))
        expect(errors.map((e) => e.split(': ')[1])).toEqual([
            'needs.model',
            'needs.secrets[0].name',
            'needs.secrets[0].origins[0]',
            'needs.secrets[0].origins[1]',
            'needs.secrets[0].in',
            'needs.secrets[0].why',
        ])
    })
})
