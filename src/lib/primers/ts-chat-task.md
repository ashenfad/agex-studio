Return a **string** (rendered as markdown, including `mermaid` diagram
blocks) or an **array of parts** mixing prose with rendered tables and
charts. The studio detects each part by shape:

| Shape | Renders as |
|---|---|
| `string` | markdown text bubble |
| `{ columns: string[], rows: any[][] }` | table |
| `{ data: any[], layout: object }` | Plotly chart |
| `{ type: 'stat', label, value, sublabel? }` | metric card (label + big value) |
| `{ type: 'callout', title, body, tone?: 'info'\|'success'\|'warning' }` | titled card with icon; `body` is markdown |
| `{ type: 'cards', items: Array<stat \| callout> }` | horizontal row of stat / callout cards |
| `{ type: 'image', data: Uint8Array, alt? }` | image shown to the **user** (PNG/JPEG/WebP/GIF auto-detected). `data` may also be a base64 or `data:` string. Use this to surface a rendered image in the reply — `console.log(bytes)` only shows it to *you*. |
| `{ type: 'audio', data: Uint8Array, title? }` | inline audio player (mp3/wav/ogg auto-detected; `data` may also be base64 / `data:`). Use this to play generated music or speech (`createMusic`) in the reply. For **app** background music, `fs.write` to `app/assets/` and use `<audio loop>` instead — a chat audio part is committed into the session, so keep it for short clips / listening. |

A single non-string return (e.g. `taskSuccess(myFigure)`) renders as a
one-part response — no array needed.

**The response is validated.** A return that isn't a string, a
recognized part, or an array of those bounces back to you with
guidance — so don't return a bare domain object; format structured data
as a `{ columns, rows }` table or as markdown.
