# The agent

The studio's agent is a code-writing LLM running in a sandboxed
worker in your browser. You ask in plain language; it picks tools,
writes code, runs it, and replies in whatever shape fits (prose,
table, chart, interactive app). The actual code is visible in the
activity card below each reply.

## At a glance

| Capability | What it does | Try saying |
| --- | --- | --- |
| Code | Writes and runs TypeScript (or Python on Py sessions); most npm packages work via on-demand `import`; Python sessions ship with NumPy, pandas, SciPy, scikit-learn. | *"Compute the Collatz sequence from 27 and tell me how many steps to reach 1."* |
| Tables and charts | Structured answers come back as inline sortable tables or interactive Plotly charts, not described in prose. | *"Load this CSV and chart weekly signups, with a callout for the biggest jump."* |
| File uploads and PDFs | Drag any file into the chat input. Uploads land in the workspace (visible in the Files drawer). PDFs get rendered as images so the agent can reason visually, not just over extracted text. | *"Render this paper and pull out the key claims with the figures that support each."* |
| Web search | Perplexity's Sonar via your OpenRouter key; multiple searches run in parallel for multi-topic research. | *"Recent papers on diffusion model alignment, summarize each."* |
| Calendars | On Python sessions, reasons over `.ics` exports for scheduling questions. | *"What 2-hour blocks of free time do I have this week?"* |
| Google Drive | The Drive button in the chat input opens Google's file picker; selected files upload into the workspace using the `drive.file` scope (only files you explicitly pick). | *(click the Drive button)* |

> [!NOTE]
> Web search consumes your OpenRouter credits like any other model
> call. Code runs in a worker. No DOM, no other tabs, no files
> outside the studio.

## Interactive apps

The most distinctive capability. The agent writes HTML/CSS/JS into
an `app/` folder; the preview pane on the right renders it in a
sandboxed iframe. Iterating is conversational — the agent edits
the same files and you see the change live. Apps survive the
session and can be published as standalone shareable links.

```
Build me a circus-themed flashcard game for 4th-grade
multiplication. Tracks correct/incorrect, awards "tickets" for
streaks.
```

## What it can't (yet)

The agent can't authenticate to most external services on your
behalf. It can hit public URLs, search the web, and work with
files you bring in — but it can't log into Gmail, query your
private databases, or talk to OAuth-protected services beyond the
Drive picker. Direct Google Calendar OAuth in particular is
pending Google's app verification for the calendar scope; for
now, `.ics` exports are the path. OAuth integrations are gated on
each provider's verification process.

## Other niceties

- Markdown in responses, including mermaid diagrams.
- LaTeX-style math typesetting.
- Reusable code in `helpers/` that survives across turns.
- Versioned history: every turn is a commit; undo to any prior
  point or fork to try a parallel direction.
