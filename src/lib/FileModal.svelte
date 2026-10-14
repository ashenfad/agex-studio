<script>
    /**
     * A file of the session's, opened to read: text highlighted,
     * Markdown rendered, an image shown; downloaded or deleted from here.
     */
    import { highlightCode } from './highlight.js'
    import { renderMarkdown } from './markdown.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, path: string, onClose: () => void }} */
    let { session, path, onClose } = $props()

    const ROOT = '/workspace'
    const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
    const TYPES = /** @type {Record<string, string>} */ ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })

    /** @type {{ text?: string, url?: string, failed?: string } | null} */
    let content = $state(null)
    let confirmingDelete = $state(false)

    $effect(() => {
        const ws = session.ws
        /** @type {string | null} */
        let url = null
        content = null
        void (async () => {
            try {
                const bytes = await /** @type {NonNullable<typeof ws>} */ (ws).files.read(`${ROOT}/${path}`)
                if (IMAGE.test(path)) {
                    const ext = /** @type {string} */ (path.split('.').at(-1)).toLowerCase()
                    url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: TYPES[ext] ?? 'application/octet-stream' }))
                    content = { url }
                } else {
                    content = { text: new TextDecoder().decode(bytes) }
                }
            } catch (e) {
                content = { failed: e instanceof Error ? e.message : String(e) }
            }
        })()
        return () => {
            if (url !== null) URL.revokeObjectURL(url)
        }
    })

    async function download() {
        if (session.ws === null) return
        const bytes = await session.ws.files.read(`${ROOT}/${path}`)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
        a.download = path.split('/').at(-1) ?? 'file'
        a.click()
        URL.revokeObjectURL(a.href)
    }

    async function remove() {
        if (session.ws === null) return
        await session.ws.files.remove(`${ROOT}/${path}`)
        await session.refreshFiles()
        onClose()
    }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal" role="dialog" aria-label={path} tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <header>
            <span class="path">{path}</span>
            <button onclick={download}>Download</button>
            {#if confirmingDelete}
                <button class="danger" onclick={remove}>Delete it</button>
                <button onclick={() => (confirmingDelete = false)}>Keep</button>
            {:else}
                <button class="danger" onclick={() => (confirmingDelete = true)} disabled={session.busy} title={session.busy ? 'A turn is running' : 'Delete this file'}>Delete…</button>
            {/if}
            <button class="close" onclick={onClose} aria-label="Close">✕</button>
        </header>
        <div class="content">
            {#if content === null}
                <p class="empty">Reading…</p>
            {:else if content.failed}
                <p class="empty">{content.failed}</p>
            {:else if content.url}
                <img src={content.url} alt={path} />
            {:else if /\.md$/i.test(path)}
                <div class="markdown">{@html renderMarkdown(content.text ?? '')}</div>
            {:else}
                <pre><code>{@html highlightCode(content.text ?? '', path)}</code></pre>
            {/if}
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 50%);
        /* the modal layer: above the drawer, the switch button, the pill */
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
    }
    .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        width: min(60rem, 100%);
        max-height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 10px 40px rgb(0 0 0 / 50%);
    }
    header {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        align-items: center;
        padding: 0.6rem 0.8rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
    }
    .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-mono);
        color: var(--text-muted);
    }
    header button {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        cursor: pointer;
    }
    header button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .danger {
        border-color: var(--error) !important;
        color: var(--error) !important;
    }
    .close {
        background: none !important;
        border: none !important;
    }
    .content {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0.8rem 1rem;
    }
    pre {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
    }
    img {
        max-width: 100%;
    }
    .empty {
        color: var(--text-muted);
    }
    @media (max-width: 768px) {
        .backdrop {
            padding: 0;
        }
        .modal {
            border-radius: 0;
            height: 100%;
        }
    }
</style>
