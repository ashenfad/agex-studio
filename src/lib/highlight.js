/**
 * Shared syntax highlighting with per-extension language detection.
 */

import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'

hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)

const EXT_MAP = {
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.json': 'json',
    '.css': 'css',
    '.html': 'xml',
    '.htm': 'xml',
    '.svg': 'xml',
    '.xml': 'xml',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sql': 'sql',
    '.svelte': 'xml',
}

function getExt(path) {
    const dot = path.lastIndexOf('.')
    return dot >= 0 ? path.slice(dot).toLowerCase() : ''
}

/**
 * Highlight code based on file path extension.
 * Falls back to unhighlighted escaped text for unknown extensions.
 */
export function highlightCode(code, path) {
    const lang = EXT_MAP[getExt(path || '')]
    if (lang) {
        return hljs.highlight(code, { language: lang }).value
    }
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Highlight Python code specifically (for agent code blocks).
 */
export function highlightPython(code) {
    return hljs.highlight(code, { language: 'python' }).value
}

/**
 * Highlight TypeScript code specifically (for agex-ts agent code blocks).
 */
export function highlightTypeScript(code) {
    return hljs.highlight(code, { language: 'typescript' }).value
}
