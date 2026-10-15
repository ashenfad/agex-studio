# Sessions and storage

Where a session's state lives, how it rewinds and forks, and how it
leaves the browser: bundles, sync, and gists. The code is
`store.js`, `studio.svelte.js` (`Studio`), `session.svelte.js`
(`ChatSession`), `snapshot.js`, `distribution.svelte.js` (bundles and
gists), `bundle.js`, `sync.svelte.js`, `sync-connect.js`, `app-data.js`
and `gist.js`.

## The store

One world `Store` over one IndexedDB database, `agex-studio`
(`openStore()`): a kvgit v4 repository, values CBOR-encoded. A
**session is a branch**, named by its id. The studio names new ones
`s-<time>-<random>`; a dotted name (`<session>.<name>`) is a
delegate's, a task's or a ws-git stash's, and the session list leaves
those out. Everything a session holds is in its commits: its files
(`__file__…`, `__meta__…`), the conversation and folds the world and
agex-ts record, the cache, ws-git's state, and the studio's plane.

Device-level things live in `localStorage`, never in a session: the
settings (`agex-studio-settings`, keys included), the session last
looked at (`agex-studio-current`), the apps' data
(`agex-app:ts:<session>:<key>`), and small markers (when an app last
wrote, gist update checks).

## The studio's plane

`ws.plane("studio")` keys, committed with the session, so they rewind
with a checkout, come along on a fork and sync:

| key | holds |
|---|---|
| `meta` | `{title, createdAt, updatedAt, named?, titledAt?}`; the title comes from the first prompt, then the model's (`titles.js`: after the first exchange and every 5 of the person's turns, `titledAt` the count it was written at), until a rename sets `named` |
| `turns/<runId>` | `{before, at}`: the head a turn started from (its undo point, and where the run before it ended) and when |
| `source` | where an imported session came from: `{head}` of its bundle, and `gist` when opened from a link |
| `published` | the gist it was last published to: `{owner, id, slug, revision, shape, session, at}` |
| `delegates/<name>` | `{asked, done}`: a delegate it asked, and whether its answer was read |

A fork drops `source` and `published` (`settleFork` in `store.js`: a
fork is neither the import nor what was published).

## Undo and redo

`undo(runId)` checks out the turn's `before`. A world checkout is a
**forward** commit restoring that commit's keys, so history only
grows: the turns undone stay in the history, and `redo()` checks out
the head the undo left. Undoing also unsays the delegates asked since
(see [agent-loop.md](agent-loop.md)). A checkout restores the plane
too, so an undo past an import's first turn undoes its `source`.

## Forks

The session list's fork actions:

- **Fork** (`full`): `ws.fork`, a branch at the head; the conversation
  comes along, rebound to the child.
- **Fork with files only** (`fresh`): the files, no conversation.
- **Fork as it is now** (`compact`): a one-commit snapshot of the head
  (`snapshotBranch`), adopted as a new session. Much smaller; its
  earlier turns can't be undone.

The app's data is copied to a fork (`copyAppStorage`).

### Snapshots

`snapshotBranch(store, at, branch)` makes a branch from the root with
one commit holding what `at` holds, less what only makes sense with the
history behind it (`kept`): the cache (`__cache__/`), the agent's own
git (`__ws_git__`), and the undo points (`__plane__/studio/turns/`).

`Studio.adopt(branch, meta)` turns a branch made outside the world (a
snapshot, a bundle's commits) into a session: a full fork of it, so
the conversation becomes the new session's own, then the branch is
deleted.

## Bundles

A bundle (`.agex`, `bundle.js`) is a session as one file:

```
agex-bundle 1\n
{"format":1,"title":…,"head":…,"shape":"everything"|"current","commits":…,"exportedAt":…}\n
<a kvgit pack: gzip CBOR of the commits from the root>
```

The pack is the format sync pushes (kvgit's "Pack sync"). `everything`
carries the whole history; `current` is a snapshot. Importing applies
the pack to a dotted scratch branch and adopts it; opening a bundle
whose `head` an earlier import recorded (`source.head`) switches to
that session instead. A bundle never carries the app's data.

## Sync

With a repo and a token in the settings, sessions sync through a
private GitHub repo of the person's own (`sync.svelte.js`), each a
branch of it, by kvgit's `PackRemote`: one compressed pack per push,
one GraphQL request; the roster (every branch with its head and
title) is one query. `connectSync` finds the repo a token can write to
(a fine-grained token with Contents read and write); the repo needs a
first commit.

**When.** A session is pushed 4 seconds after it changes here (a turn,
an undo, a rename, files added: `Studio.onChanged`). Every session is
compared with the roster on arrival and when the page comes back into
view, at most every 5 minutes (`sweep`), and synced if it differs. A
sync pulls, then pushes, fast-forward only (`syncBranch`), one at a
time per browser (a Web Lock), never beside the session's turn or
fold: a sync that finds one waits to be scheduled again at its end,
and a turn asked for during a sync waits for it (the session's gate,
`gate.js`). A session open here takes in what was pulled
(`adoptPulled`: what is pending commits onto it, else it refreshes).
A new session that has never been used stays local; dotted branches
don't sync.

**Two devices.** When both moved, the session is `diverged` and the
person picks:

- **Use the synced version**: this device's version is kept as a
  session of its own ("… (this device)"), and the session moves to the
  synced head.
- **Keep this device's**: the synced head is merged in, this side
  taking every key either changed, and this device's commit is checked
  out on top, so the push is a fast-forward and the other device's work
  stays in the history.

**Elsewhere.** The repo's other sessions show as cloud sessions to
download. Delete asks "From this device" (it stays in the repo) or
"Everywhere" (into the repo's trash, `archived/<session>`, restorable
until emptied). A session archived on another device and unchanged
here (its app data too) is removed here on the next sweep; changed
here, it is marked `remote-gone`: sync it again, or delete it here.

**App data.** An app's storage syncs on its own branch,
`appdata/<session>` (`app-data.js`: one value, the bag and when it was
written), never in the session's history. It is committed about 10
seconds after the app writes, and with each session sync; the sweep
syncs it when its head differs. Two devices' writes settle on the
later (`at`). It is archived, restored and deleted with its session,
and never listed as a session.

## Gists and links

Publishing (`PublishDialog.svelte`, `Distribution.publish`, `gist.js`) puts
a session's bundle (as it is now, or with its history) in a **secret
gist** as one file, `<slug>.agex.b64`. Publishing again updates the
same gist (`PATCH`, keeping the file), so its links stay; a gist gone
or not the token's gets a new one. The token is the settings'
publishing token, else the sync token; it needs gist access.

Each publish also tags the commit published in the store,
`published/<slug>/<n>`, with the gist and its revision in the tag's
info; `sessions published` lists these. Store tags don't sync, so the
list is the publishing device's.

**Opening.** `/run/?gist=<owner>/<id>/<slug>` follows the gist's
latest revision; `…/<owner>/<id>/<revision>/<slug>` stays on one. The
studio opens without making a blank session, resolves the revision,
reads the raw file at it from gist.githubusercontent.com (no token),
imports it (`source.gist` records where from) and goes back to `/`.
Without a model chosen, a visitor still sees the conversation and the
app. Builds copy the page to `dist/run/index.html` for a static host.

**Updates.** Sessions opened from a link that follows the latest are
checked for a newer revision when the studio opens, each gist at most
every 12 hours; a newer one is offered in the session list. Opening it
imports the new version, and removes the old copy if nothing was done
in it since it was opened.
