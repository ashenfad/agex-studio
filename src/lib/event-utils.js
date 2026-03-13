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
 * Compute a simple diff between search and content based on operation type.
 * @param {string} search
 * @param {string} content
 * @param {string} operation - 'replace', 'insert-after', or 'insert-before'
 * @returns {Array<{type: string, text: string}>}
 */
export function computeDiff(search, content, operation) {
    const searchLines = trim(search).split('\n')
    const contentLines = trim(content).split('\n')
    const lines = []
    if (operation === 'replace') {
        for (const l of searchLines) lines.push({ type: 'removed', text: l })
        for (const l of contentLines) lines.push({ type: 'added', text: l })
    } else if (operation === 'insert-after') {
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
