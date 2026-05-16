# Numerical & data work

You have two libraries for working with structured data, both lazy-loaded:
fetched only on first `import`, cached for the rest of the worker
lifetime. First use of either pays one network fetch (~100 KB Arquero,
~300 KB Apache Arrow); subsequent uses are zero-cost.

| Need | Reach for |
| --- | --- |
| Tabular transforms (filter, group-by, aggregate, join) | `arquero` |
| Cross-language data exchange, columnar buffers | `apache-arrow` |

Both render directly in chat when returned from `taskSuccess` — see the
"Response shape" section of your task primer for the part-shape table.

## Arquero

Tidyverse / dplyr-style chained transforms. Column types inferred from
input; output methods (`.objects()`, `.array()`) materialize results.

```ts
import { from, op } from 'arquero'

const dt = from([
  { city: 'NYC', sales: 100 },
  { city: 'NYC', sales: 250 },
  { city: 'LA',  sales: 180 },
])

const summary = dt
  .groupby('city')
  .rollup({ total: op.sum('sales'), n: op.count() })
  .objects()
// → [{ city: 'NYC', total: 350, n: 2 }, { city: 'LA', total: 180, n: 1 }]
```

To return a table that renders in chat, build a `{ columns, rows }` shape:

```ts
const result = dt.groupby('city').rollup({ total: op.sum('sales') })
taskSuccess([
  "Sales by city:",
  { columns: result.columnNames(), rows: result.objects().map(r => Object.values(r)) },
])
```

### Arquero gotcha — table expressions are not closures

Arquero parses callbacks **as strings** at runtime to push them into its
internal expression language. They look like JS but **don't capture
outer scope.** This is the most common mistake:

```ts
// ❌ FAILS — `threshold` isn't in Arquero's scope, expression error
const threshold = 100
dt.filter(d => d.sales > threshold)

// ✅ Pass parameters explicitly through `params(...)`:
dt.params({ threshold }).filter((d, $) => d.sales > $.threshold)
```

Same pattern applies to `derive`, `rollup`, and any other
expression-accepting method. When in doubt, inline the literal value or
use `params`.

### Aggregator namespace

Aggregators live under `op` (sometimes seen as `aq.op`). Common ones:

```ts
op.sum('col')      op.mean('col')      op.median('col')
op.count()         op.distinct('col')  op.values('col')
op.min('col')      op.max('col')       op.stdev('col')
```

Full list: see Arquero docs for `op`. If you guess a name and get
"undefined function," check the docs.

### Arquero gotcha — `loadCSV` vs `fromCSV`

Easy to confuse. Different functions, different inputs:

| Function | Input | Use when |
| --- | --- | --- |
| `fromCSV(text, opts?)` | a CSV string already in memory | parsing CSV you read from VFS or constructed in code |
| `loadCSV(url, opts?)` | a URL string | fetching a CSV from the network |

**For VFS files: read the bytes yourself, then `fromCSV` the text.**
`loadCSV` will treat your CSV string as a URL and try to `fetch` it,
which silently fails and pollutes the console.

```ts
// ✅ Read from VFS, parse as text:
const text = await fs.readText('data/sales.csv')
const dt = fromCSV(text)

// ❌ Treats `text` as a URL and tries to fetch it:
const dt = loadCSV(text)
```

`fromJSON` / `loadJSON` and `fromArrow` / `loadArrow` follow the same
pattern.

### Arquero gotcha — row count is a method

`dt.numRows()` is a method, not a property. Same for `dt.numCols()`,
`dt.columnNames()`, `dt.objects()`, etc. Forgetting the parens returns
the function reference, leading to confusing errors downstream.

```ts
const n = dt.numRows()      // ✅ number
const n = dt.numRows        // ❌ function reference
```

## Apache Arrow

Use Arrow when you need cross-language data exchange (reading
Arrow IPC files, working with columnar buffers from elsewhere) or when
you're handling data large enough that columnar storage matters. For
in-memory transforms over small / medium data, prefer Arquero — its API
is friendlier and its size cost is much smaller.

```ts
import { tableFromArrays } from 'apache-arrow'

const tbl = tableFromArrays({
  city: ['NYC', 'LA', 'SF'],
  sales: [350, 180, 220],
})

// Convert to Arquero for transformations:
import { from } from 'arquero'
const dt = from(tbl.toArray())
```

Reading Arrow IPC bytes from VFS:

```ts
import { tableFromIPC } from 'apache-arrow'
const bytes = await fs.read('data/sales.arrow')
const tbl = tableFromIPC(bytes)
```

## Returning charts inline

Plotly figure JSON renders directly without any worker-side dependency
— construct the object literal in your code and pass it to `taskSuccess`:

```ts
taskSuccess([
  "Sales trend:",
  {
    data: [{ x: ['NYC', 'LA', 'SF'], y: [350, 180, 220], type: 'bar' }],
    layout: { title: 'Sales by City' },
  },
])
```

The `{ data, layout }` shape is the standard Plotly figure spec. See the
"Response shape" section of your task primer for the recognized chart /
table / text shapes.
