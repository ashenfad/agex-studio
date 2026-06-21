// Publish-to-gist flow: the state machine behind the "Publish to Gist"
// modal. Mirrors the export flow — bundling reuses `exportBundle` so the
// artifact is byte-for-byte identical — but terminates in a shared gist
// URL instead of a file download.
//
//   null                                                 — closed
//   { stage: 'options',   session, estimates, shape }    — ts shape choice
//   { stage: 'bundling',  session, phase, done, total }  — building bytes
//   { stage: 'preview',   session, manifest, bytes, ack, priorGist, target }
//   { stage: 'uploading', session, manifest, bytes }     — POST/PATCH in flight
//   { stage: 'done',      session, result, fallbackFromGistId }
//   { stage: 'error',     session, message }
//
// The PATCH-vs-POST and 404-fallback decisions live in bundle-format.js
// (defaultPublishTarget / gistFallbackId) so they can be tested directly.

import { get } from 'svelte/store'

import {
    exportBundle,
    profilePublishSizes,
    getSessionGistInfo,
    setSessionGistInfo,
} from './sessions.js'
import { publishGistBundle, GistPublishError } from './gist-publish.js'
import { settingsStore, updateSettings } from './settings.js'
import { defaultPublishTarget, gistFallbackId } from './bundle-format.js'

export function createPublishFlow() {
    let state = $state(null)

    /** Start publishing. ts sessions get a shape-choice stage first
     *  (full history vs tip snapshot, image treatment) with approximate
     *  per-shape sizes; py goes straight to bundling. No-ops if a flow is
     *  already open. */
    async function start(session) {
        if (state) return
        if (session.kernel === 'ts') {
            state = {
                stage: 'options',
                session,
                estimates: null,
                shape: get(settingsStore).publishShape || 'full',
            }
            try {
                const sized = await profilePublishSizes(session.branch)
                if (state?.stage === 'options' && state.session === session) {
                    state = { ...state, estimates: sized?.estimates ?? null }
                }
            } catch (err) {
                // Estimates are a nicety — the options still work without
                // numbers next to them.
                console.warn('publish size profile failed:', err)
            }
            return
        }
        await bundle(session, 'full')
    }

    /** Options stage confirmed: remember the shape, then bundle. */
    async function proceed() {
        if (state?.stage !== 'options') return
        const { session, shape } = state
        updateSettings({ publishShape: shape })
        await bundle(session, shape)
    }

    async function bundle(session, shape) {
        state = { stage: 'bundling', session, phase: 'walking', done: 0, total: 0 }
        try {
            const { bytes, manifest } = await exportBundle(session.branch, (p) => {
                if (state?.stage === 'bundling') {
                    state = { ...state, phase: p.phase, done: p.done, total: p.total }
                }
            }, { shape })
            // Look up any existing gist mapping for this branch. When
            // present, this publish PATCHes that gist (preserving the
            // share URL) instead of creating a new one.
            //
            // We do NOT special-case `session.external`: the localStorage
            // mapping is only ever written by *this* user's prior
            // publishes (setSessionGistInfo runs from confirm's success
            // branch), so it can't point at the original publisher's
            // gist — if it exists it's a gist we own, and PATCH is
            // correct. The "imported session" hint in the preview still
            // surfaces when there's no prior publish.
            const priorGist = getSessionGistInfo(session.branch)
            state = {
                stage: 'preview',
                session,
                manifest,
                bytes,
                ack: false,
                priorGist,
                target: defaultPublishTarget(priorGist),
            }
        } catch (err) {
            console.error('Failed to bundle for publish:', err)
            state = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    /** Closeable except mid-bundle / mid-upload. */
    function close() {
        if (state?.stage === 'bundling' || state?.stage === 'uploading') return
        state = null
    }

    async function confirm() {
        if (!state || state.stage !== 'preview' || !state.ack) return
        const { session, manifest, bytes, priorGist, target } = state
        // Only PATCH the prior gist when the user chose "update existing".
        // A "new" choice (or no prior gist) POSTs a fresh one.
        const useExisting = target === 'existing' && !!priorGist
        const pat = get(settingsStore).githubPat || ''
        if (!pat) {
            state = {
                stage: 'error',
                session,
                message: 'No GitHub Personal Access Token in Settings. Add one with the gist scope and try again.',
            }
            return
        }
        state = { stage: 'uploading', session, manifest, bytes }
        try {
            const result = await publishGistBundle({
                pat,
                bytes,
                manifest,
                // Name → gist filename slug + first line of gist
                // description, capped for github.com's list view.
                name: (session.name || session.title || '').slice(0, 100),
                // Optional second line, from the per-session description.
                description: (session.description || '').slice(0, 300),
                // When set, PATCH the prior gist (preserving the share
                // URL); publishGistBundle falls back to POST if it was
                // deleted out from under us. Empty for a "new gist" choice.
                existingGistId: useExisting ? priorGist.gistId : '',
                existingSlug: useExisting ? priorGist.slug : '',
            })
            // Persist the (possibly new) mapping for future updates. After
            // a 404-fallback the gistId/slug differ from priorGist;
            // setSessionGistInfo records whatever the publish landed.
            setSessionGistInfo(session.branch, {
                gistId: result.gistId,
                slug: result.slug,
                lastPublishedAt: new Date().toISOString(),
            })
            state = {
                stage: 'done',
                session,
                result,
                fallbackFromGistId: gistFallbackId(useExisting, priorGist, result.gistId),
            }
        } catch (err) {
            console.error('Publish failed:', err)
            const message = err instanceof GistPublishError
                ? err.message
                : (err.message || String(err))
            state = { stage: 'error', session, message }
        }
    }

    return {
        get state() { return state },
        start,
        proceed,
        close,
        confirm,
    }
}
