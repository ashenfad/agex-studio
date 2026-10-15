# The agent

The agent works in a workspace of its own: files under `/workspace`,
a shell, and TypeScript it runs in a sandboxed worker in your browser.
You ask in plain words; it does the work with its tools and says what
came of it. Each tool call shows in the chat, and you can open it to
see exactly what ran and what came back.

Everything it changes is versioned, so you can undo any turn (see
[Sessions](#sessions)).

## What it can do

| | What it does | Try saying |
| --- | --- | --- |
| Code | Writes and runs TypeScript. A package import loads from esm.sh, so most npm packages work. | *"How many steps does the Collatz sequence from 27 take to reach 1?"* |
| Files and the shell | Reads, writes and edits files, and uses a shell (`ls`, `cat`, `grep` and the like). | *"Tidy up the notes in notes/ into one file."* |
| Charts, tables, cards | Shows data in its reply: an interactive chart, a sortable table, a row of cards, an image. | *"Chart weekly signups from this CSV."* |
| Apps | Builds an interactive app under `app/`, which the preview beside the chat shows as it changes, and checks it by clicking through it. | *"Build a flashcard game for multiplication."* |
| Web search and pages | Searches the web, and reads a page to answer a question about it. *Needs an OpenRouter key.* | *"What changed in the latest Svelte release?"* |
| Images, speech, music | Makes pictures, spoken audio and music clips, for a reply or an app. *Needs an OpenRouter key.* | *"Make a pixel-art knight sprite for my game."* |
| PDFs | Reads a PDF's text, and renders pages as images to look at. | *"Summarize the tables in this report."* |
| Helper agents | Hands a judgment call over many items (classify, extract, summarize each) to helper agents its code calls like a function, many at once. | *"Classify these 200 reviews by sentiment."* |
| Delegates | Hands separable pieces of work to delegates that run alongside it (see below). | *"Have one delegate write the story and another the poem."* |

> [!NOTE]
> Web search, page reading and media run on your OpenRouter key and
> cost like any other model call, whichever model runs the agent. With
> an endpoint of your own and no OpenRouter key, the agent says so
> instead of using them.

## Giving it files

Attach them to your message: the **+** in the message box offers
**Upload from this device** and **From Google Drive** (when available),
and you can drop files on the chat or paste an image. They land in
`/workspace/uploads` at once, as one change you can undo, and show as
chips on the message, which names them to the agent when you send it.
The **Files** tab (beside **App**) adds files too, without naming them
in a message.

## While it works

- **Stop** (the send button, while it works) ends the turn. Delegates
  that turn asked stop too.
- **Typing while it works** queues a note, shown as *Queued* until the
  agent reads it with its next step (✕ takes it back till then). A note
  that comes after its last step starts the next turn instead; after a
  Stop, it goes back into the message box.
- Leaving the page while the agent (or a delegate) is working asks
  first: the work runs in the page, and leaving stops it.
- If the model's provider cuts a turn short, **Resume it** carries on
  where it stopped, or **Set it aside** leaves it as it is.

## Apps

The agent writes an app as files under `app/`: an `index.html`, with
its scripts and styles beside it. The **App** tab beside the
chat shows it live, and rebuilds when its files change; its ⤢ shows the
app alone, full screen (Esc to come back). The agent checks
its own work with a hidden copy of the app, clicking and reading it,
and with screenshots when the model takes images.

Apps keep their own saved data (what they store in `localStorage`),
per session. It stays with the session's app, and syncs with it if you
sync (see [Sessions](#sessions)).

### Apps that call an agent

An app can ask an agent to do something for it: summarize, rewrite,
classify, look something up. Each call runs on **the model of
whoever is using the app**, on their key. The preview's bar shows how
many calls the app has made this visit (**agent 3/20**). An app gets
20 calls a visit to begin with; **Allow 20 more** gives it another
20.

An app made in someone else's session (one you imported, or opened
from a published link) asks first: *"This app asks to use your
model…"*. You can allow it or not; an app you don't allow just can't
use the agent. Until you've allowed it in the preview, the agent's
own tests of that app (`test_app`) can't make its agent calls either.

## Delegates

For work that splits into independent pieces, the agent can hand
pieces to **delegates**: copies of the session that work on their own
and report back. It decides when to; you can also ask for it.

- The **strip above the message box** shows each delegate: what it is
  doing, and when it answers. Click one to read its conversation (read
  only), and **← back** to return.
- The agent can end its turn while delegates work. When their answers
  come in, the session picks up again on its own to read them and
  bring their work in: up to 10 times before you next write, and not
  after you stopped a turn.
- The session list shows **⑂** beside a session with delegates
  working or answers waiting.
- Delegates can have delegates of their own, two levels deep.
- If the page closes while a delegate works, the delegate stops. When
  you come back, the strip shows it as interrupted, and the next turn
  is told, so the agent can pick up what it left or ask again.

## What it can't do

The agent can reach public web pages and APIs your browser can, and
files you bring in. It can't sign in to your accounts or reach
private services on your behalf. Its code runs in a sandbox: no access
to this page, your other tabs, or files outside the studio.
