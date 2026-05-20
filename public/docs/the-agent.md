# The agent

The studio's agent is a code-writing LLM running in a sandboxed
worker in your browser. You ask in plain language; it picks tools,
writes code, runs it, and replies in whatever shape fits (prose,
table, chart, interactive app). Examples below are representative
starting points — casual phrasing works fine.

## Code

Writes and runs TypeScript (or Python on Python sessions). Most
npm packages work via on-demand `import` on the TS kernel; Python
sessions ship with NumPy, pandas, SciPy, and scikit-learn
pre-bundled. The actual code is visible in the activity card
below each reply.

```
Compute the Collatz sequence starting at 27, and tell me how many
steps it takes to reach 1.
```

> [!NOTE]
> Code runs in a worker. No DOM, no other tabs, no files outside
> the studio.

## Tables and charts

Structured answers come back as inline sortable tables or
interactive Plotly charts, not described in prose.

```
Load this CSV and chart weekly signups, with a callout for the
biggest jump.
```

## File uploads and PDFs

Drag any file into the chat input. Uploads land in the agent's
workspace (visible in the Files drawer) and stay reachable for
the rest of the session. PDFs get an extra capability: the agent
can render pages as images and reason about them visually, not
just extracted text.

```
Render this paper and pull out the key claims with the figures
that support each.
```

## Web search

The agent can search the web via Perplexity's Sonar (routed
through your OpenRouter key). Multiple searches run in parallel
for multi-topic research.

```
Search for recent papers on diffusion model alignment and
summarize what each contributes.
```

> [!NOTE]
> Web search uses your OpenRouter credits like any other model
> call.

## Interactive apps

The most distinctive capability. The agent writes HTML/CSS/JS
into an `app/` folder; the preview pane on the right renders it
in a sandboxed iframe. Iterating is conversational — the agent
edits the same files and you see the change live. Apps survive
the session and can be published as standalone shareable links.

```
Build me a circus-themed flashcard game for 4th-grade
multiplication. Tracks correct/incorrect, awards "tickets" for
streaks.
```

## Calendars (offline, via .ics)

On Python sessions the agent reasons about calendar data using
[calgebra](https://github.com/ashenfad/calgebra). Upload an
`.ics` export and ask scheduling questions over it.

```
What 2-hour blocks of free time do I have this week?
```

> [!NOTE]
> Direct Google Calendar OAuth is not yet wired up — pending
> Google's app verification for the calendar scope.

## Google Drive (as a file source)

The Drive button in the chat input opens Google's file picker.
Selected files upload into the workspace using the `drive.file`
scope, which only grants access to the files you explicitly pick.
The studio never gets ongoing access to your Drive.

## What it can't (yet)

The agent can't authenticate to most external services on your
behalf. It can hit public URLs, search the web, and work with
files you bring in — but it can't log into Gmail, query your
private databases, or talk to OAuth-protected services beyond
the Drive picker. OAuth integrations are gated on each
provider's app verification.

## Other niceties

- Markdown in responses, including mermaid diagrams.
- LaTeX-style math typesetting.
- Reusable code in `helpers/` that survives across turns.
- Versioned history: every turn is a commit; undo to any prior
  point or fork to try a parallel direction.
