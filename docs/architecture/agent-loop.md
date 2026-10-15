# The agent loop

A turn, from the composer to the stored run. The loop itself is
agex-ts's (`Agent`, `Session`); this is what the studio gives it and
how it shows what comes back. The code is `ChatSession` in
`studio.svelte.js`, `model.js`, `primer.js` and `delegation.svelte.js`.

## A turn

`ChatSession.say(prompt)`:

1. Waits for a sync of the session in flight (`#held`), and refills
   the session's wakes (see Delegation).
2. Builds an `Agent` for this turn (`#agent`): the model from the
   settings, the primer, `settings: { thinking, maxTokens: 16000 }`,
   and `compaction: new Policy(foldBudget)` when the fold budget isn't
   0.
3. Opens an agex-ts `Session` over the workspace (`#session`): the
   session's inbox, its delegation helper, and the studio's tools
   beside the world's (`test_app`, and the `sessions` tool wrapped
   for the depth cap).
4. Streams the turn (`session.stream(prompt)`), applying each
   `TurnEvent` to `live` (`#apply`), the parts `LiveTurn.svelte`
   shows: text and thinking as their deltas arrive, each tool call
   with its result once it ends, delivered notes, a fold.
5. On `RunStarted`, writes the turn's undo point on the plane
   (`turns/<runId>`: the head it started from, and when) and the
   session's title and times (`meta`), at once, so the turn's own
   commits carry them.
6. When it ends: reads the record again (`reload`), drops the live
   view, notes whether the person saw it end (below), and tells the
   studio the session changed (`onMeta`, which refreshes the list and
   schedules a sync).

A turn that ends while the person isn't looking at its session (it
isn't the one shown, or the page's tab is hidden or its window
unfocused: `looking` in `status.js`) leaves the session `unseen`, and
`attention` too when the turn failed or was interrupted. Every turn
counts: the person's, a woken one, a resumed one. Both clear when the
person looks (`seen()`): on switching to the session with the page on
screen, or on the page coming back (`focus`, `visibilitychange`) with
it shown. They live in the page only, never stored.

A new `Agent` each turn costs nothing (an agent holds no state), and
means a change to the settings applies to the next turn.

`resume()` continues a run a provider error cut short; `abandon()`
closes it as it stands ("set aside by the person"). See
[errors-and-recovery.md](errors-and-recovery.md).

## Models

`buildModel(settings, { session })` returns an AI SDK model, which
agex-ts drives directly:

- **OpenRouter**: `createOpenRouter` with the key, `X-Title: agex
  studio`.
- **A custom endpoint, Anthropic-shaped** (a direct key, a local
  Meridian, a proxy): `createAnthropic` with the base URL (normalized
  to end in `/v1`) and `anthropic-dangerous-direct-browser-access`.
  For an endpoint other than `api.anthropic.com`, requests carry
  `x-session-affinity: agex-studio:<session>:<first tool_use id>`
  (`conversationKey`), so Meridian resumes one backing session per
  conversation and keeps its cache warm. The opening request goes
  untagged; a fold that rewrites the history starts a fresh key. An
  origin whose CORS refuses the header gets requests without it
  until reload (`sessionAffinityFetch`).
- **A custom endpoint, OpenAI-compatible**: `createOpenAICompatible`.
- **Scripted** (dev builds only): a `ScriptedProvider` reading
  `script`, which the driver fills.

Each is wrapped by `fittingImages` (`image-fit.js`): before a request
goes out, every image in it (a screenshot, what `view_image` read, an
upload) past 4 MB of base64 is re-encoded, as WebP (JPEG on white
where the browser can't write WebP), and scaled down until it fits,
its longest side at most 7680px: Anthropic refuses an image past 5 MB
of base64 or 8000px. The record keeps the image as it was; fitted
ones are cached by their data, so the history's aren't re-encoded with
each request. `test_app` screenshots are taken at 1× (`pixelRatio:
1`), whatever the screen's density.

`thinkingOf` passes the thinking setting (`off`, `low`, `medium`,
`high`) to agex-ts, which maps it per provider.

## What the chat shows

`Chat.svelte` renders the stored runs (`RunView.svelte`) and, while a
turn runs, the live one (`LiveTurn.svelte`). A run's parts are the
record's: `text`, `thinking`, `tool_call` and `tool_result`. A run's
first user message (`TurnOpening.svelte`, for the live turn and the
stored alike) is shown as the person's, except:

- one that delivered delegates' answers (a woken turn) shows each as
  an answer card (`deliveredAnswers`), with whatever the person said
  beside them;
- a delegate's first message, its brief, shows as "Task from
  <parent>: …" (`delegateTask`).

The live turn opens as the stored one will. A woken turn's opening is
the answers' delivery, which the inbox reports as it happens
(`onDelivered`); a delegate's runner tells the view open on it each
turn's prompt (`begin`, `opened`), and keeps it (`openings`) for a view
opened mid-turn.

Replies render markdown with `ui` artifacts spliced in where the reply
embeds them (see [code-and-tools.md](code-and-tools.md)). A link to a
workspace file, by its path (`[plan](/workspace/notes/plan.md)`, or
`notes/plan.md` relative to /workspace), renders as a file link
(`markdown.js` marks it with `data-ws-path`, the normalized path, and
renders one whose `..` climbs out of /workspace as its text alone);
`ReplyText` opens it in `FileModal`, as the file is now, checking the
attribute again on click (`fileLinkTarget`), since raw HTML can set it
too. A URL with a scheme, `//host/…`, `#…` and other root paths stay
ordinary links. The rewriting is opt-in, by `renderMarkdown`'s
`linkBase`: a reply's is /workspace, and a Markdown file's in
`FileModal` is its own folder, so its relative links open the files
beside it in the same viewer. Elsewhere (thinking, summaries, cards,
table cells) there's no viewer to open, and links stay ordinary.
A ```` ```mermaid ```` block renders as `<pre class="mermaid">` holding
its source; `ReplyText` draws it (`renderMermaidBlocks`, Mermaid loaded
once from a pinned jsDelivr URL, `securityLevel: 'strict'`) when the
reply isn't the live turn's streaming tail, so a half-written diagram
never shows as a parse error. One that doesn't parse shows its source
and a line saying why.

Only what the person said offers undo (and, for an ordinary message,
edit): not a delegate's task, not a turn the answers alone started
(undoing the turn before it takes that one too), and nothing in a
delegate's read-only view.

## Notes mid-turn

A message sent while a turn runs goes into the session's `Inbox`
(`inbox.put`) and is delivered with the turn's next tool result. Until
then it shows as *Queued* (`ChatSession.queued`), and `withdraw` takes it
back; once delivered (the `Delivered` event), it shows as the person's
bubble where it landed, and a stored run shows it the same way, read
back out of the tool result (`notesIn`, after the world's `splitNotes`).
The inbox belongs to the `ChatSession`, not the turn's agent, so it
outlives each turn: a note still waiting when a turn completes starts
the next turn, and after a stop or a failure it goes back into the
draft.

Files attach before sending (`ChatSession.attached`, added under
`uploads/` at once); the message names them on a first line,
`[attached: ["/workspace/uploads/a.csv", …]]` (`withAttachments`; a JSON
list, so any file name reads back whole), which the chat shows as
chips. Sending waits until every file attached is in.

## Folding

With a fold budget (`foldBudget`, 150,000 tokens by default; 0 turns
it off), agex-ts's `Policy` folds earlier turns into a summary once a
request would pass it. The world records each fold; the chat shows a
band after the last message a fold covers ("The conversation up to
here is folded into a summary for the model"), from `ws.compaction
.folds()`, and a `Compacted` event in the live view.

The composer's context meter (`ContextMeter.svelte`) shows
`session.context`: the next request's size in tokens against the
budget, muted, then amber past 60% and red past 90%. Between turns it
comes from agex-ts's `Session.context()`, measured as the policy
measures it (so the meter and the fold agree), read again after every
reload and once a turn ends; during a turn, from each `Usage` event
(the request just sent), and a `Compacted` event's after-size.

Its popover offers **Fold now** (`ChatSession.foldNow`, agex-ts's
`Session.fold()`): the fold the budget would make, made between turns
whatever the budget, and committed on its own. It's disabled while a
turn runs, after an interrupted turn, and with nothing new since the
last fold (`foldable`). Stop stops it (without the delegates a turn's
stop takes down); a message sent meanwhile waits for it; undo, redo
and deleting the session wait too.

## The primer

`primer(settings)` builds the system prompt per turn:

- the studio: the workspace, apps under `/workspace/app` (read the
  interactive-app skill, check with `test_app`; an app can call an
  agent of its own), `ui` for showing data, and how to reply;
- `web` and `media` when the settings hold an OpenRouter key, or a
  line saying they need one;
- `pdf`, and delegation with ws-git (separable work only; don't poll;
  read the diff, then merge or check out; `sessions published`);
- with vision off, how to check an app without screenshots.

The world appends its own tool instructions after it.

## Delegation

The agent hands separable work to delegates with the `sessions` tool:
forks of the session, each a dotted branch (`<session>.<name>`) that
runs its own turns in the page, on the person's model. The mechanics
(asking, forking, answers as notes) are the world's `Sessions` and
agex-ts's; `delegation.svelte.js` adds:

- **`StudioRunner`**, the runner the session's helper uses, in place
  of agex-ts's `Runner`. It opens the delegate's fork with the
  parent's settings, runs it with `untilSettled` (a turn, then woken
  turns while its own delegates are out, up to `DELEGATE_WAKES`, 3,
  unless the ask sets a budget), and streams each turn: to `doing`
  (the strip's "doing" line) and to the `ChatSession` open on the
  delegate, if one is (`observe` / `observed`). A delegate's first
  message is a brief from the mechanism, then the task.
- **The delegate's agent** is the parent's, with `maxToolCalls: 60`
  (`DELEGATE_TOOL_CALLS`). It has `test_app` in a hidden page of its
  own (`live` is refused), the `sessions` tool at its depth, and the
  parent's tool options (`view_image` when the model takes images,
  `agex`'s guide).
- **A depth cap**: `DEPTH_CAP`, 2. At that depth `sessions ask` is
  refused, saying to do the work itself (`studioSessionsTool`).
- **`sessions published`**: the published apps, from the store's
  `published/<slug>/<n>` tags (`renderPublished`).

Each `ChatSession` owns one `Sessions` helper for its workspace, so
its delegates outlive each turn's agent. Its job table is copied into
`jobs` and `unread` for the strip and the session list, polled while a
turn or a delegate runs.

**Waking.** When a delegate answers while the session is idle
(`helper.onAnswer`), `#maybeWake` runs a turn with no prompt
(`RunStream` with `wake: true`), which opens with the answers. It
waits for a sync of the session in flight, and doesn't run without a
model, after a stopped or failed turn, or once `WAKES` (10) woken turns
have run since the person last wrote; then the session shows a notice
that the answers will be read when they next write. Any message from
the person, a note mid-turn included, refills the wakes.

**Stopping and undoing.** Stopping a turn cancels the delegates it
asked (those started since the turn began); those of earlier turns go
on. Undoing a turn unsays the delegates asked since it started:
running ones are cancelled and unread answers dropped. Closing a
session cancels its delegates.

**Lost delegates.** Delegates run in the page, so closing or
reloading it stops them. The session records each delegate it asked
on its plane (`delegates/<name>`: when asked, and whether its answer
was read), committed as it changes. When a session opens, a record for
one of its own delegates (`<session>.…`) that never got its answer
means the page lost it: the next turn gets a mechanism note in the
inbox (its work is on its branch: diff it, merge what's useful, or ask
afresh), the strip shows it as interrupted, and the record is marked
so it is told once. Nothing starts a turn on its own. While a turn or
a delegate runs, leaving the page asks first (`Studio.working()`, a
`beforeunload` handler in `App.svelte`).
