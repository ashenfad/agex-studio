// Export-bundle flow: the state machine behind the "Export Session"
// modal. Lifted out of SessionDrawer so the stage transitions live in
// one place and the pure formatting (filename, phase labels) is shared
// with the publish flow via bundle-format.js.
//
//   null                                              — closed
//   { stage: 'loading',  session }                    — reading stats
//   { stage: 'preview',  session, stats }
//   { stage: 'progress', session, stats, phase, done, total }
//   { stage: 'done',     session, stats, manifest, bytes }
//   { stage: 'error',    session, message }

import { exportBundle, getBundleStats } from './sessions.js'
import { bundleFilename } from './bundle-format.js'

export function createExportFlow() {
    let state = $state(null)

    /** Open the modal and read bundle stats for the preview. No-ops if a
     *  flow is already in progress. */
    async function start(session) {
        if (state) return
        state = { stage: 'loading', session }
        try {
            const stats = await getBundleStats(session.branch)
            state = { stage: 'preview', session, stats }
        } catch (err) {
            console.error('Failed to read bundle stats:', err)
            state = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    /** Closeable except mid-export (the bundle walk shouldn't be
     *  abandoned half-written). */
    function close() {
        if (state?.stage === 'progress') return
        state = null
    }

    /** Build the bundle and trigger the browser download. */
    async function confirm() {
        if (!state || state.stage !== 'preview') return
        const { session, stats } = state
        state = { stage: 'progress', session, stats, phase: 'walking', done: 0, total: 0 }
        try {
            const { bytes, manifest } = await exportBundle(session.branch, (p) => {
                if (state?.stage === 'progress') {
                    state = { ...state, phase: p.phase, done: p.done, total: p.total }
                }
            })
            state = { stage: 'done', session, stats, manifest, bytes }
            triggerDownload(session, manifest, bytes)
        } catch (err) {
            console.error('Failed to export bundle:', err)
            state = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function triggerDownload(session, manifest, bytes) {
        const label = (manifest.name || session.title || session.branch).trim() || session.branch
        const blob = new Blob([bytes], { type: 'application/zip' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = bundleFilename(label)
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
    }

    return {
        get state() { return state },
        start,
        close,
        confirm,
    }
}
