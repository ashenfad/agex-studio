# Sessions

A **session** is one conversation and its workspace: its files, its
apps, and the full history of both. The session list is on the left;
fold it away and back with the panel button at the top left, or ⌘B
(Ctrl+B). Each session keeps to itself: different files, a different
conversation.

## The mental model

A session is closer to a git repository than to a chat thread. Every
change (a tool call that writes, a turn's end) is a commit in its
history. That's what makes undo, forks and sync work: the history is
real history.

## New sessions and names

**+ New session** starts an empty one. Its first message names it at
first; then the model names it from the conversation, after the first
exchange and again every few turns, so the name follows the work. Name
it yourself (double-click its name in the list, or in its **⋯**
dialog) and that name stays.

Hover a session in the list for its tools: **⑂** forks it (with its
conversation), and **⋯** opens its dialog: its name, the other forks,
export, publish and delete.

## Undo and redo

Hover one of your messages for its tools. **Undo** (↶) goes back to
where that turn began: the files, the conversation, the folds, all of
it. **Edit** (✎) does the same and puts your message back in the box,
its files attached again, to change and send anew. **Redo** brings it
all back, until the next turn.

Undo doesn't erase history: it's a new commit restoring the earlier
state. Delegates asked since that turn are stopped, and answers they
haven't delivered are dropped.

## Forks

**⑂** beside a session, or **Fork** in its **⋯** dialog:

- **With its conversation** (what **⑂** does): a copy with everything,
  to try another direction without losing this one.
- **Its files only**: the same files, a fresh conversation.
- **As it is now**: the files and the conversation as they are,
  without the history behind them. Much smaller, but its earlier
  turns can't be undone.

A fork is a session like any other: rename it, delete it, publish it.

## Files

The **Files** tab (beside **App**, right of the chat) shows the
session's files as a tree. Open one to read it (text, Markdown or an image), **Download**
it, or **Delete** it. **Upload** and **From Drive** add files under
`uploads/`.

Some places matter:

- `app/` is the session's app, shown in the preview.
- `ui/` holds the charts, tables and cards in the agent's replies.

## Long conversations

Past the fold limit in Settings, the earlier part of a conversation
is folded into a summary for the model, so it keeps working within
its context. The chat still shows everything; a band marks where the
fold is.

## Bundles: export and import

**Export** (in the session's **⋯** dialog) saves it as a `.agex` file:

- **As it is now**: its files and conversation, without the history.
  Smaller.
- **With its history**: every commit, so each turn can still be undone
  after import.

**Import…** (beside **+ New session**) opens a `.agex` file as a new
session. Importing the same bundle again goes to the copy you already
have.

A bundle holds the session's files and conversation. It doesn't hold
your settings or keys, or the data its app saved.

## Deleting

**Delete…** in the **⋯** dialog removes a session from this browser,
for good. With sync on, a synced session asks:

- **From this device**: it stays in your sync repo, and shows under
  *In the sync repo* to download again.
- **Everywhere**: it goes to your sync repo's trash, on every device,
  and can be restored until the trash is emptied.

## Syncing across devices

Sync keeps your sessions in a **private GitHub repository of your
own**, so you can work on them from another browser or device. There's
no agex.studio server in between.

### Connecting

In **⚙ Settings → Sync**:

1. **Make a private repo** on GitHub, and tick "Add a README" (the
   repo needs a first commit).
2. **Make a fine-grained token** with access to only that repo, and
   the permission *Contents: read and write*.
3. **Paste the token** and click **Connect**. If the token can reach
   several repos, pick the one to sync through.

**Disconnect** forgets the repo on this device only; the repo and its
sessions stay.

### What syncs, and when

- A session is pushed a few seconds after it changes here, and every
  session is checked against the repo when the studio opens and when
  you come back to it.
- Sessions you've used sync. A brand-new, untouched session stays
  local until its first message, and delegates' work stays with the
  session that asked for it.
- An app's saved data syncs beside its session. If an app is open
  when newer data arrives from another device, the preview offers
  **Reload the app** rather than changing it under you. If two devices
  both wrote, the later write wins.

In the session list, **↑** means a sync is queued, **↻** that it's
running, and **⚠** that a session needs you.

### When a session changed on two devices

Sync never merges silently. If a session changed on both devices
before they synced, its row says so, with two choices:

- **Use the synced version**: this device's version is kept as a
  session of its own, named "… (this device)".
- **Keep this device's**: your version is written on top of the
  synced one; the other device's work stays in the history.

### Sessions in the repo, and the trash

- **In the sync repo** lists sessions there that aren't on this
  device, each with **Download**.
- **Trash** lists sessions deleted everywhere: **Restore** brings one
  back; **Empty the trash…** deletes them for good, on every device.
- A session moved to the trash on another device leaves this one
  too, unless it has changed here since; then its row asks: **Sync it
  again** or **Delete here too**.
