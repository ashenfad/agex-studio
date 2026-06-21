// Relative-time formatting shared across the session UI. Two formatters
// with deliberately different tails:
//
//   formatDate    — session-row timestamps. Falls back to an absolute
//                   locale date once a session is older than a week,
//                   because "37d ago" is less useful than a real date
//                   for archival sessions.
//   relativeTime  — sync ledgers and the publish destination's
//                   "last published" line. Stays relative all the way
//                   out to years; never shows an absolute date.
//
// Both treat a missing / unparseable input as '' rather than throwing.

/** Session-row timestamp: relative for the first week, absolute after. */
export function formatDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (Number.isNaN(diff)) return ''
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
    return d.toLocaleDateString()
}

/** Coarse "X ago" that stays relative out to years. Days / months /
 *  years past the hour mark — fine-grained enough for "recently vs a
 *  while back" without ever falling back to an absolute date. */
export function relativeTime(iso) {
    try {
        const then = new Date(iso).getTime()
        if (Number.isNaN(then)) return ''
        const sec = Math.max(0, Math.floor((Date.now() - then) / 1000))
        if (sec < 60) return 'just now'
        const min = Math.floor(sec / 60)
        if (min < 60) return `${min}m ago`
        const hr = Math.floor(min / 60)
        if (hr < 24) return `${hr}h ago`
        const days = Math.floor(hr / 24)
        if (days < 30) return `${days}d ago`
        const months = Math.floor(days / 30)
        if (months < 12) return `${months}mo ago`
        return `${Math.floor(months / 12)}y ago`
    } catch {
        return ''
    }
}
