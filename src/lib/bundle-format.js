// Pure formatting + decision helpers shared by the export and publish
// flows. Kept separate from the flow state machines so the fiddly bits
// — size-hint formatting, the .agex filename slug, and especially the
// PATCH-vs-POST / 404-fallback gist logic — are unit-testable without
// standing up a flow or mocking the network.

import { formatBytes } from './bytes.js'

/** Human label for an export/publish bundling phase. Unknown phases
 *  pass through verbatim (the progress UI shows them raw rather than
 *  hiding a phase we forgot to name). */
export function phaseLabel(phase) {
    switch (phase) {
        case 'walking': return 'Walking history'
        case 'packing-commits': return 'Packing commits'
        case 'packing-nodes': return 'Packing nodes'
        case 'packing-blobs': return 'Packing blobs'
        case 'finalizing': return 'Finalizing'
        default: return phase
    }
}

/** Estimated byte size for a publish shape from a sizes profile, or null
 *  when the profile is missing or doesn't cover the shape. Clamped at 0
 *  so a negative estimate never renders. */
export function shapeSize(estimates, shape) {
    if (!estimates) return null
    const v = {
        full: estimates.full,
        flat: estimates.flat,
        'flat-downsample': estimates.flatDownsampled,
        'flat-strip': estimates.flatStripped,
    }[shape]
    return v == null ? null : Math.max(0, v)
}

/** "· ~1.3 MB" suffix for a shape option; '' until estimates load (or
 *  when profiling failed — the options still work without numbers). */
export function publishSizeHint(estimates, shape) {
    const v = shapeSize(estimates, shape)
    return v == null ? '' : ` · ~${formatBytes(v)}`
}

/** Filesystem-safe `.agex` download name from a human label. Falls back
 *  to "session" when the label has no slug-able characters. */
export function bundleFilename(label) {
    const safe = String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'session'
    return `${safe}.agex`
}

/** Default publish destination. Update the prior gist (same share URL)
 *  only when this branch earned the mapping; an inherited (fresh-fork)
 *  mapping defaults to a new gist so we don't overwrite the parent's
 *  share URL. No prior gist → always 'new'. */
export function defaultPublishTarget(priorGist) {
    return priorGist && !priorGist.inherited ? 'existing' : 'new'
}

/** When an "update existing" publish 404-fell-back to a fresh gist, the
 *  prior gist id we tried to PATCH (so the done view can explain why the
 *  share URL changed); '' otherwise — including for an intentional "new
 *  gist" publish, which must never be mislabeled as a fallback. */
export function gistFallbackId(useExisting, priorGist, resultGistId) {
    return useExisting && priorGist && priorGist.gistId !== resultGistId
        ? priorGist.gistId
        : ''
}
