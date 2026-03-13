<script>
    import { readAppFiles, runQuery } from './agent.js'
    import { buildAppHtml, setLiveIframe } from './pyodide.js'
    import { onMount } from 'svelte'

    /** @type {{ refreshKey: number }} */
    let { refreshKey } = $props()

    let iframe = $state(null)
    let blobUrl = $state(null)
    let loading = $state(false)
    let error = $state('')

    async function loadPreview() {
        loading = true
        error = ''
        try {
            const appFiles = await readAppFiles()
            if (!appFiles || Object.keys(appFiles).length === 0) {
                error = 'No app files found'
                return
            }

            const html = buildAppHtml(appFiles)

            // Revoke previous blob
            if (blobUrl) URL.revokeObjectURL(blobUrl)
            blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        } catch (e) {
            error = e.message || String(e)
        } finally {
            loading = false
        }
    }

    // Handle query messages from the iframe
    function handleMessage(event) {
        if (!iframe || event.source !== iframe.contentWindow) return
        if (event.data?.type !== 'agex-query') return

        const { id, code, result } = event.data
        runQuery(code, result)
            .then(data => {
                iframe.contentWindow.postMessage({
                    type: 'agex-query-result',
                    id,
                    data,
                    error: null,
                }, '*')
            })
            .catch(err => {
                iframe.contentWindow.postMessage({
                    type: 'agex-query-result',
                    id,
                    data: null,
                    error: err.message || String(err),
                }, '*')
            })
    }

    onMount(() => {
        window.addEventListener('message', handleMessage)
        return () => {
            window.removeEventListener('message', handleMessage)
            setLiveIframe(null)
            if (blobUrl) URL.revokeObjectURL(blobUrl)
        }
    })

    // Register the live iframe with pyodide.js for live_app()
    $effect(() => {
        setLiveIframe(iframe)
    })

    // Reload when refreshKey changes
    $effect(() => {
        void refreshKey
        loadPreview()
    })
</script>

<div class="preview-panel">
    {#if loading}
        <div class="preview-notice"><span class="spinner"></span> Loading...</div>
    {:else if error}
        <div class="preview-notice error">{error}</div>
    {:else if blobUrl}
        <iframe
            bind:this={iframe}
            src={blobUrl}
            sandbox="allow-scripts allow-same-origin"
            title="App Preview"
        ></iframe>
    {/if}
</div>

<style>
    .preview-panel {
        height: 100%;
        overflow: hidden;
        background: var(--bg);
    }

    iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: white;
    }

    .preview-notice {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-muted);
        font-size: 0.85rem;
        gap: 0.5rem;
    }

    .preview-notice.error {
        color: var(--error);
    }

    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border);
        border-top-color: var(--text-muted);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

</style>
