<script>
    /**
     * One workspace file shown in a reply, by its kind: a chart, a
     * table, a row of cards, an image, sandboxed HTML, or text. Read
     * as the reply's run left it (`at`, the commit the next turn started
     * from; the files as they are now for the latest reply), and again
     * when the record is (an undo rewinds them).
     */
    import { artifactKind, looksLikePlotly } from '@agex-ts/world'
    import CardRow from './CardRow.svelte'
    import DataTable from './DataTable.svelte'
    import PlotlyChart from './PlotlyChart.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, path: string, name?: string, at?: string | null }} */
    let { session, path, name = '', at = null } = $props()

    const IMAGE_TYPES = /** @type {Record<string, string>} */ ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })

    const kind = $derived(artifactKind(path))
    const label = $derived(name || (path.split('/').at(-1) ?? path))

    /** The file's text, or for an image its object URL; null until read. */
    /** @type {{ text?: string, url?: string, missing?: true } | null} */
    let file = $state(null)
    /** What was read last, so a re-read that finds the same leaves the
     *  rendering alone. */
    let lastKey = ''

    $effect(() => {
        void session.filesStamp
        if (session.ws === null) return
        let dead = false
        // as the reply's run left it: a name reused later shows its
        // newer version only in the replies after
        const files = at === null ? Promise.resolve(session.ws) : session.viewAt(at)
        files
            .then((ws) => ws.files.read(path))
            .then((bytes) => {
                if (dead) return
                const key = `${bytes.length}:${digest(bytes)}`
                if (key === lastKey) return
                lastKey = key
                if (file?.url) URL.revokeObjectURL(file.url)
                if (kind === 'image') {
                    const ext = (path.split('.').at(-1) ?? '').toLowerCase()
                    file = { url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: IMAGE_TYPES[ext] ?? 'application/octet-stream' })) }
                } else {
                    file = { text: new TextDecoder().decode(bytes) }
                }
            })
            .catch(() => {
                if (dead) return
                lastKey = ''
                file = { missing: true }
            })
        return () => {
            dead = true
        }
    })

    $effect(() => () => {
        if (file?.url) URL.revokeObjectURL(file.url)
    })

    /** @param {Uint8Array} bytes */
    function digest(bytes) {
        let h = 0
        for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + (bytes[i] ?? 0)) | 0
        return h
    }

    /** The file's JSON, or undefined when it isn't JSON. */
    const parsed = $derived.by(() => {
        if (file?.text === undefined || !/\.json$/i.test(path)) return undefined
        try {
            return JSON.parse(file.text)
        } catch {
            return undefined
        }
    })

    /** A table artifact's rows, as `{columns, data, total}`. */
    const table = $derived(
        kind === 'table' && Array.isArray(parsed?.columns) && Array.isArray(parsed?.data)
            ? { columns: parsed.columns.map(String), rows: parsed.data, total: typeof parsed.total === 'number' ? parsed.total : parsed.data.length }
            : null,
    )

    // a theme for HTML that brings none, so it isn't dark on dark
    const PRELUDE = '<style>:root{color-scheme:dark}body{font-family:system-ui,sans-serif;margin:0.5rem;color:#ddd;background:transparent}</style>'
</script>

<div class="artifact">
    {#if file === null}
        <div class="muted">loading {label}…</div>
    {:else if file.missing}
        <div class="muted">{label}: {path} isn't in the workspace now</div>
    {:else if kind === 'image'}
        <img src={file.url} alt={label} title={path} />
    {:else if (kind === 'plotly' || kind === 'json') && looksLikePlotly(parsed)}
        <PlotlyChart figure={parsed} />
    {:else if table !== null}
        <DataTable columns={table.columns} rows={table.rows} />
        {#if table.total > table.rows.length}
            <div class="muted">showing {table.rows.length.toLocaleString()} of {table.total.toLocaleString()} rows</div>
        {/if}
    {:else if kind === 'cards' && Array.isArray(parsed?.items)}
        <CardRow items={parsed.items} />
    {:else if kind === 'html'}
        <iframe title={label} sandbox="allow-scripts" srcdoc={PRELUDE + file.text}></iframe>
    {:else if file.text !== undefined && kind !== 'binary'}
        <details open>
            <summary>{label}</summary>
            <pre>{file.text}</pre>
        </details>
    {:else}
        <div class="muted">{label}: {path}</div>
    {/if}
</div>

<style>
    .artifact {
        margin: 0.6rem 0;
    }
    img {
        display: block;
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid var(--border);
    }
    iframe {
        width: 100%;
        height: 320px;
        border: 1px solid var(--border);
        border-radius: 8px;
    }
    details summary {
        cursor: pointer;
        color: var(--text-muted);
        font-size: 0.75rem;
    }
    pre {
        max-height: 260px;
        overflow: auto;
        background: rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        padding: 0.5rem 0.7rem;
        font-size: 0.75rem;
        white-space: pre-wrap;
    }
    .muted {
        color: var(--text-muted);
        font-size: 0.8rem;
        margin-top: 0.3rem;
    }
</style>
