# The agent

The studio's agent is a code-writing LLM operating inside a sandbox
in your browser. You ask for things in plain language; it figures
out which combination of tools to reach for, writes code, runs it,
and replies with whatever shape fits the answer best (prose, a
table, a chart, a fully interactive app).

This page is a survey of what's available. Examples are
representative, not prescriptive. The agent picks tools by reading
your message, so casual phrasing works fine.

## Code

The most basic capability. The agent writes TypeScript (or Python,
if you're on a Python session) and runs it inside a sandboxed Web
Worker. Results come back as the response, with the actual code
visible in the activity card below the message.

```
Compute the Collatz sequence starting at 27, and tell me how many
steps it takes to reach 1.
```

Most npm packages work out of the box on the TS kernel. The agent
can `import` from `'lodash'`, `'d3'`, `'dayjs'`, etc. — the
sandbox routes bare imports through esm.sh on demand. On the
Python kernel, the standard data-science stack is pre-bundled
(NumPy, pandas, SciPy, scikit-learn).

> [!NOTE]
> The agent's code runs in a worker, not in your tab's main
> thread. It can't reach the DOM, your browser tabs, or your
> files outside the studio.

## Tables and charts

When the answer is structured data, the agent returns it as a real
inline table or Plotly chart instead of describing it in prose.
Tables are sortable; charts are interactive (zoom, hover, etc.).

```
Load this CSV and chart weekly signups, with a callout for the
biggest jump.
```

Drop the CSV into the chat input first (or write your own data
into the message). The agent will pick a chart shape that fits the
data; if you'd rather see something specific, just say so.

## File uploads

Drag any file into the chat input to upload it. The file lands in
the agent's workspace and becomes addressable for the rest of the
session. CSVs, JSON, images, PDFs, binary formats: all work.

```
What's in this dataset?
```

Files are visible in the Files drawer (top-right folder icon) once
uploaded. The agent can also write its own files back to the
workspace as part of working on a task.

## PDFs

PDFs get a slightly richer treatment: the agent can render
individual pages as images and reason about their visual content,
not just the extracted text. Useful for papers with figures,
diagrams, layout-dependent content.

```
Render this paper and pull out the key claims along with the
figures that support each.
```

Default cap is 20 pages per render call; the agent can pass
explicit page indices for longer documents.

## Web search

When the agent needs current information, it can search the web
via Perplexity's Sonar (routed through your OpenRouter key).
Multiple independent searches can run in parallel — useful for
multi-topic research where the agent fans out and combines
results.

```
Search for recent papers on diffusion model alignment and
summarize what each contributes.
```

> [!NOTE]
> Web search uses your OpenRouter credits like any other model
> call. Deep multi-step searches cost more than a single query.

## Interactive apps

The most distinctive capability. The agent can write HTML/CSS/JS
into a special `app/` folder; the preview pane on the right
(visible automatically once `app/` files exist) renders them in a
sandboxed iframe. The agent can also script the app to test that
it works before responding.

```
Build me a circus-themed flashcard game for 4th-grade
multiplication. Tracks correct/incorrect, awards "tickets" for
streaks.
```

Apps survive the session: refreshing the page or coming back later
keeps the latest version. Iterating is conversational ("make the
tickets glow when you earn one") — the agent edits the same files
and you see the change live.

Apps can be published as standalone shareable links. See
[Sharing & gallery](#sharing--gallery) when that page lands.

## Calendars (offline, via .ics)

On Python sessions, the agent can reason about calendar data
using [calgebra](https://github.com/ashenfad/calgebra) — an
interval-algebra library for queries about your time. For now,
calendar work goes through `.ics` files: drop an export (most
calendars can produce one) into the chat and ask scheduling
questions over it.

```
What 2-hour blocks of free time do I have this week, and what
events are pinning the schedule on Tuesday morning?
```

> [!NOTE]
> Direct Google Calendar OAuth is not currently wired up. The
> studio is awaiting Google's app verification for the calendar
> scope; once that lands, you'll be able to connect a Google
> account in Settings for live calendar access without ICS
> exports in between.

## Google Drive (as a file source)

You can pick files from your Google Drive to bring into the
agent's workspace via the Drive button in the chat input's
attach menu. This uses the `drive.file` scope, which limits
access to only the specific files you select through the
picker. The studio never gets ongoing access to your Drive.

```
Make me a chart from this spreadsheet
```  *(after picking a sheet from Drive)*

## What it can't do (yet)

The biggest current limitation is that the agent can't
authenticate to most external services on your behalf. It can:

- Hit public web pages (via search).
- Query public APIs at known URLs.
- Work with whatever you bring it (file uploads, Drive picks,
  ICS exports, etc.).

It *cannot* currently:

- Log into your Gmail / Slack / Notion / etc.
- Query your private databases or APIs.
- Talk to OAuth-protected services beyond the Drive picker.

OAuth integrations for sensitive scopes (Google Calendar,
others as they become useful) are gated on app verification
with each provider. Until those land, the studio's model is:
bring your data in (files, exports, public URLs), let the
agent work on it locally.

## Things that aren't features per se

A handful of capabilities are baked deep enough they read as just
"how the agent works":

- **Markdown** in responses (with mermaid diagrams via
  ` ```mermaid ` blocks).
- **Mathematical typesetting** through LaTeX-style fences for
  formulas.
- **Reusable code in `helpers/`**. The agent can write modules
  to a `helpers/` folder and import them in later turns of the
  same session.
- **Versioned history**. Every turn is a commit. You can undo
  back to any prior message; you can fork the session to try a
  parallel direction.

For the workspace mechanics (sessions, forks, files, history),
see *Sessions & workspace* when that page lands.

## Trying it

The honest way to learn what the agent can do is to ask it for
something specific and see how it answers. The examples above
work as starting points; the more concrete your ask, the more
likely the response shape is interesting.
