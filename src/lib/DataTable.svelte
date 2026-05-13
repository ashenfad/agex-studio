<script>
    /** @type {{ columns: string[], rows: any[][] }} */
    let { columns, rows } = $props()

    let sortCol = $state(null)
    let sortAsc = $state(true)

    let sortedRows = $derived.by(() => {
        if (sortCol === null) return rows
        const idx = columns.indexOf(sortCol)
        if (idx < 0) return rows
        return [...rows].sort((a, b) => {
            const va = a[idx], vb = b[idx]
            if (va == null && vb == null) return 0
            if (va == null) return 1
            if (vb == null) return -1
            if (typeof va === 'number' && typeof vb === 'number') {
                return sortAsc ? va - vb : vb - va
            }
            const sa = String(va), sb = String(vb)
            return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa)
        })
    })

    // Virtual scrolling for large tables
    const ROW_HEIGHT = 28
    const BUFFER = 10
    let scrollTop = $state(0)
    let containerHeight = $state(400)
    let container

    let totalHeight = $derived(sortedRows.length * ROW_HEIGHT)
    let startIdx = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER))
    let endIdx = $derived(Math.min(sortedRows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + BUFFER))
    let visibleRows = $derived(sortedRows.slice(startIdx, endIdx))
    let offsetY = $derived(startIdx * ROW_HEIGHT)

    // Only virtualize if table is large
    let useVirtual = $derived(rows.length > 200)

    function handleSort(col) {
        if (sortCol === col) {
            sortAsc = !sortAsc
        } else {
            sortCol = col
            sortAsc = true
        }
    }

    function handleScroll() {
        if (container) {
            scrollTop = container.scrollTop
        }
    }

    function isNumeric(colIdx) {
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
            if (rows[i][colIdx] != null && typeof rows[i][colIdx] !== 'number') return false
        }
        return true
    }
</script>

<div class="table-wrapper">
    <div class="row-count">{rows.length.toLocaleString()} rows</div>
    <div
        class="table-container"
        bind:this={container}
        bind:clientHeight={containerHeight}
        onscroll={useVirtual ? handleScroll : undefined}
    >
        <table>
            <thead>
                <tr>
                    {#each columns as col, i}
                        <th
                            class:numeric={isNumeric(i)}
                            onclick={() => handleSort(col)}
                        >
                            {col}
                            {#if sortCol === col}
                                <span class="sort-arrow">{sortAsc ? '▲' : '▼'}</span>
                            {/if}
                        </th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#if useVirtual}
                    <tr style="height: {offsetY}px" class="spacer"></tr>
                    {#each visibleRows as row}
                        <tr>
                            {#each row as cell, i}
                                <td class:numeric={isNumeric(i)}>{cell ?? ''}</td>
                            {/each}
                        </tr>
                    {/each}
                    <tr style="height: {Math.max(0, totalHeight - (endIdx * ROW_HEIGHT))}px" class="spacer"></tr>
                {:else}
                    {#each sortedRows as row}
                        <tr>
                            {#each row as cell, i}
                                <td class:numeric={isNumeric(i)}>{cell ?? ''}</td>
                            {/each}
                        </tr>
                    {/each}
                {/if}
            </tbody>
        </table>
    </div>
</div>

<style>
    /* Table styled to sit comfortably alongside cards / charts in
       a rich response. Key choices vs. the prior REPL-shaped look:
         - System sans-serif throughout (was monospace).
           `font-variant-numeric: tabular-nums` keeps numbers in
           visually-aligned columns without the debug aesthetic.
         - Sentence-case headers (was UPPERCASE + letter-spaced).
         - Soft surface-hover background on the wrapper, matching
           the StatCard / CalloutCard treatment.
         - 10px border-radius matching cards (was 6px).
         - Zebra striping dropped — at sans-serif weight, row
           borders give plenty of separation without the
           horizontal-band busyness.
         - Cell padding bumped for breathing room. */
    .table-wrapper {
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
    }

    .row-count {
        font-size: 0.72rem;
        color: var(--text-muted);
        padding: 0.45rem 0.85rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
    }

    .table-container {
        max-height: 400px;
        overflow: auto;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
        color: var(--text);
    }

    thead {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    th {
        background: var(--surface);
        color: var(--text-muted);
        font-weight: 600;
        font-size: 0.78rem;
        padding: 0.55rem 0.85rem;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        text-align: left;
    }

    th:hover {
        color: var(--text);
    }

    th.numeric {
        text-align: right;
    }

    .sort-arrow {
        font-size: 0.6rem;
        margin-left: 0.25rem;
        color: var(--accent);
    }

    td {
        padding: 0.45rem 0.85rem;
        border-bottom: 1px solid var(--border);
    }

    /* Drop the bottom border on the last row — the wrapper's
       border + the row-count divider already bound the table
       cleanly, and a trailing border looks unfinished. */
    tbody tr:last-child td {
        border-bottom: none;
    }

    td.numeric {
        text-align: right;
        white-space: nowrap;
    }

    /* Subtle row hover — gives a "data" feel without being noisy. */
    tbody tr:hover td {
        background: color-mix(in srgb, var(--accent) 6%, transparent);
    }

    tr.spacer {
        border: none;
    }
    tr.spacer:hover td {
        background: transparent;
    }
</style>
