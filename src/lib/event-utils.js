/**
 * Shared utilities for event rendering.
 */

/**
 * Trim leading/trailing newlines from text.
 * @param {string} text
 * @returns {string}
 */
export function trim(text) {
    return (text || '').replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * Line-level diff between two arrays of lines using the LCS algorithm.
 *
 * Lines that appear in both (in their LCS order) become ``context``;
 * lines only in ``a`` are ``removed``; lines only in ``b`` are ``added``.
 * Result is in the order a reader expects (top-to-bottom of the merged
 * view), suitable for rendering as a unified-style diff.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type: string, text: string}>}
 */
function lineDiff(a, b) {
    const m = a.length
    const n = b.length
    // dp[i][j] = LCS length of a[..i] and b[..j].  Int32Array keeps it
    // tight; even pathological multi-thousand-line edits stay snappy.
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1
            } else {
                dp[i][j] = dp[i - 1][j] >= dp[i][j - 1]
                    ? dp[i - 1][j]
                    : dp[i][j - 1]
            }
        }
    }
    // Walk the table back from (m,n) to produce the diff in reverse,
    // then flip.  Tie-break favors adds during walk-back so the
    // reversed forward order presents removed-then-added (the
    // conventional "old-then-new" reading for a replacement).
    const out = []
    let i = m, j = n
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            out.push({ type: 'context', text: a[i - 1] })
            i--; j--
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            out.push({ type: 'removed', text: a[i - 1] })
            i--
        } else {
            out.push({ type: 'added', text: b[j - 1] })
            j--
        }
    }
    while (i > 0) {
        out.push({ type: 'removed', text: a[i - 1] })
        i--
    }
    while (j > 0) {
        out.push({ type: 'added', text: b[j - 1] })
        j--
    }
    return out.reverse()
}

/**
 * Compute a unified-style line diff between ``search`` and ``content``.
 *
 * For ``replace`` (the only operation post-retool), the result is an
 * LCS-based diff: shared lines render as ``context`` instead of being
 * shown twice.  This matters when an edit changes a small region inside
 * a larger anchor block — the unchanged lines stay as context and the
 * actual change pops visually.
 *
 * Legacy ``insert-after`` / ``insert-before`` operations may appear in
 * sessions persisted before the retool collapsed everything to
 * search+replace; we keep their original simple rendering.
 *
 * @param {string} search
 * @param {string} content
 * @param {string} operation - 'replace', 'insert-after', or 'insert-before'
 * @returns {Array<{type: string, text: string}>}
 */
export function computeDiff(search, content, operation) {
    const searchLines = trim(search).split('\n')
    const contentLines = trim(content).split('\n')
    if (operation === 'replace') {
        return lineDiff(searchLines, contentLines)
    }
    const lines = []
    if (operation === 'insert-after') {
        for (const l of searchLines) lines.push({ type: 'context', text: l })
        for (const l of contentLines) lines.push({ type: 'added', text: l })
    } else if (operation === 'insert-before') {
        for (const l of contentLines) lines.push({ type: 'added', text: l })
        for (const l of searchLines) lines.push({ type: 'context', text: l })
    }
    return lines
}

const TRUNCATE_LINES = 8
const TRUNCATE_CHARS = 500

/**
 * Truncate text to a limited number of lines/chars.
 * @param {string} text
 * @returns {{ display: string, truncated: boolean }}
 */
export function truncateText(text) {
    if (typeof text !== 'string') return { display: text, truncated: false }
    const lines = text.split('\n')
    if (lines.length <= TRUNCATE_LINES && text.length <= TRUNCATE_CHARS) {
        return { display: text, truncated: false }
    }
    let display = lines.slice(0, TRUNCATE_LINES).join('\n')
    if (display.length > TRUNCATE_CHARS) {
        display = display.slice(0, TRUNCATE_CHARS)
    }
    return { display: display + '…', truncated: true }
}

/**
 * Derive the title from a list of events (last action's title).
 * @param {Array} events
 * @returns {string}
 */
export function deriveTitle(events) {
    return [...events].reverse().find(e => e.type === 'action' && e.title)?.title || 'Activity'
}

/**
 * Split a rich response into segments: consecutive text parts merge, rich parts standalone.
 * @param {{ type: string, content?: string, parts?: Array }} content
 * @returns {Array<{ kind: string, content?: string, data?: object }>}
 */
export function segmentParts(content) {
    if (!content || content.type !== 'response') {
        return [{ kind: 'text', content: content?.content || '' }]
    }
    const segments = []
    let textBuf = []
    function flushText() {
        if (textBuf.length) {
            segments.push({ kind: 'text', content: textBuf.join('\n\n') })
            textBuf = []
        }
    }
    for (const part of content.parts) {
        if (part.type === 'text') {
            textBuf.push(part.content)
        } else {
            flushText()
            segments.push({ kind: part.type, data: part })
        }
    }
    flushText()
    return segments
}

/**
 * Group a flat list of chapter events into chat-like message groups.
 *
 * Returns an array of items, each one of:
 *   { kind: 'user', message: string }
 *   { kind: 'agent', content: object }     — rendered as markdown bubble
 *   { kind: 'activity', events: Array }    — action/output/error group
 *   { kind: 'chapter', name, message, events }
 *
 * @param {Array} events
 * @returns {Array}
 */
export function groupEventsForChat(events) {
    const groups = []
    let activityBuf = []

    function flushActivity() {
        if (activityBuf.length) {
            groups.push({ kind: 'activity', events: [...activityBuf] })
            activityBuf = []
        }
    }

    for (const evt of events) {
        if (evt.type === 'chaptering') {
            flushActivity()
            groups.push({ kind: 'chaptering', chapters: evt.chapters || [] })
        } else if (evt.type === 'task_start') {
            flushActivity()
            groups.push({ kind: 'user', message: evt.message })
        } else if (evt.type === 'success') {
            flushActivity()
            groups.push({ kind: 'agent', content: evt.result })
        } else if (evt.type === 'chapter') {
            flushActivity()
            groups.push({ kind: 'chapter', name: evt.name, message: evt.message, events: evt.events })
        } else {
            // action, output, error → accumulate into activity group
            activityBuf.push(evt)
        }
    }

    flushActivity()
    return groups
}
