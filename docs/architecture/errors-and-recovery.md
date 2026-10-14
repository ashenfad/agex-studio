# Errors and recovery

What happens when something goes wrong, where it shows, and what the
person can do. The rule throughout: work already done is kept (every
tool call commits), a failure says what it was in plain words, and
nothing starts spending the person's key on its own after one.

## A turn

agex-ts ends a turn one of four ways, none of which throws:

| ending | cause | what the chat shows |
|---|---|---|
| `completed` | the model answered | the reply |
| `cancelled` | the person pressed Stop | the run, closed with a note; not an error |
| `failed` | an error, or `maxSteps` model calls | the run, closed with a note, and the error under it |
| `interrupted` | a provider error worth retrying | a banner: "The last turn was cut short by the model's provider", with **Resume it** and **Set it aside** |

**Resume it** (`ChatSession.resume`) continues the run in place;
**Set it aside** (`abandon`) closes it as it stands, with a note the
next turn's model reads. A turn that ends any way but `completed`
turns waking off until the person writes again (see Delegation below).

An error thrown around the turn (the session closed, a bad setting)
sets `session.error`, shown at the end of the chat. A tool's own
failure isn't the turn's: the tool's result says what went wrong (an
error result) and the model carries on with it, as with a `run_ts`
exception, a terminal command's exit code, or a refused argument.

With no model chosen, the composer is disabled and says to choose one
in settings; a visitor opening a published link still sees the session
and its app.

**Undo** (a message's ↶; its ✎ edit undoes too, and puts the message
back in the box) checks out where the turn began, a forward commit, so
it is itself undoable (**Redo**).

## The app

- **The page couldn't be built** (`buildAppHtml` threw, e.g. an
  esbuild failure for a worker): the preview says so instead of the
  app.
- **A resource failed to load** (an image, a script): the preview
  lists the last few under the app (`agex-iframe-resource-error`).
- **The app's own errors** reach `test_app`'s result through the
  console interceptor (`console.error`, `window.onerror`, unhandled
  rejections), so the agent sees them.
- **`test_app`**: a page whose bridge never comes up within 10
  seconds (most often a module that failed to evaluate) ends the call
  with an error naming that; a failing `assert` ends it with the
  assertion; `live: true` with no preview showing, or from a delegate,
  is refused with the reason. Oversized values are cut and say so
  (see [app-preview.md](app-preview.md)).
- **An app's agent task** rejects with a message the app can show: no
  model chosen, the person didn't allow it, the visit's calls are used
  up (the preview offers "Allow 20 more"), or the task failed.

## Sync

Each session's sync state shows as a glyph in the session list (↑
queued, ↻ syncing, ⚠ needs the person), with a ⚠ in the header while
any needs attention:

- **`diverged`**, changed on two devices: **Use the synced version**
  (this device's kept as its own session) or **Keep this device's**
  (written on top of the synced one). See
  [sessions-and-storage.md](sessions-and-storage.md).
- **`remote-gone`**, removed from the repo elsewhere while it (or its
  app data) changed here: **Sync it again** (pushed as new, app data
  with it) or **Delete here too**.
- **`error`**: the message (`describe`: a refused token, a missing
  permission, rate limiting, no network), with **Retry**.

A failure reaching the repo at all (`sync.problem`) shows above the
cloud sessions. A failed download leaves the session among the cloud
sessions to retry. "Delete everywhere" archives the app data first and
the session second, and undoes the first if the second fails, so a
failure leaves nothing half-deleted.

## Delegation

- **A delegate's turn** that doesn't complete answers `failed`, saying
  how; the parent reads it as any answer.
- **The depth cap**: at two levels, `sessions ask` is refused, telling
  the delegate to do the work itself.
- **Lost delegates**: delegates run in the page, so closing or
  reloading it stops them. While a turn or a delegate runs, leaving
  asks first. A session reopened with a delegate that never answered
  tells its next turn (the work is on its branch), shows it as
  interrupted in the strip, and starts nothing on its own.
- **Waking** stops after 10 woken turns since the person last wrote,
  or after a stopped or failed turn; the session then says the answers
  will be read when they next write.

## Publishing and links

- **Publishing** says what a refusal means (`gistError`): the token
  refused, no gist access, the bundle too large for a gist (publish it
  as it is now), or GitHub's own message. A gist that's gone is
  replaced by a new one, and the dialog says so.
- **A link that can't be opened** (a deleted gist, a malformed link)
  shows "The published session couldn't be opened: …" and leaves
  play mode.
- **An update check** that fails (offline, rate-limited) is tried
  again on a later visit; a gist that's gone simply offers nothing.

## The store

If IndexedDB can't be opened, the studio shows "The store couldn't
open" with the reason and does nothing else.
