# Sessions and workspace

A *session* is the studio's unit of conversation, history, and
workspace. Open the sessions drawer (left-rail icon) to see the
list. Everything below — undo, forking, exporting, publishing —
operates on whichever session is currently active.

## The mental model

Each session is a versioned branch. Every turn you take (your
message + the agent's reply, including any files it wrote) is a
commit on that branch. Switching sessions switches workspaces:
different files, different chat history, different agent memory.
Nothing is shared between sessions unless you explicitly export
or publish.

This is closer to a git repo than to a ChatGPT thread. You can
rewind, you can fork, you can throw a branch away. The history is
real history.

## Undo

The most useful trick in the studio. Hover any prior turn in the
chat scroll and you'll see an **undo** button (tooltip: *Undo
from here*). Click it and the session rewinds to that point: the
workspace files revert, the agent forgets later turns, the chat
trims back.

Good for: an agent reply went sideways and you want to rephrase;
a code change broke something and you want the previous state
back; you're experimenting and want a clean baseline without
losing the work that led up to it. If you want to keep the
current state *and* explore an alternate path, fork first, then
undo on the fork.

## Fork

Two flavors, both in the active session's row menu:

- **Fork** copies the current session — files, history,
  agent memory — into a brand-new branch. Useful when you want to
  try an alternate direction without losing the current thread.
- **Fork (fresh chat)** copies only the files, not the chat. The
  agent starts with the same workspace but no memory of how it
  got there. Useful when a session's history has grown long and
  you want a clean chat against the same files.

Forks are full sessions in their own right. Rename them, delete
them, publish them independently.

## Files and the workspace

Every session has a virtual filesystem. Open the **Files** drawer
(folder icon at the top-right of the chat) to browse it. Files
land here three ways:

- Drag-and-drop into the chat input (any file type).
- The Google Drive picker (button in the chat input).
- The agent writing them as part of its work (code, generated
  data, app scaffolds, helper modules).

The workspace persists across turns. The agent can read anything
in it on later turns without you re-attaching. Common patterns:

- **`/app/`** — interactive apps the agent builds. The preview
  pane renders whatever's here in a sandboxed iframe.
- **`/helpers/`** — reusable functions the agent factors out
  during a session. They survive across turns and become part of
  the agent's toolkit for the rest of the conversation.
- **anywhere else** — your uploads, the agent's working notes,
  generated outputs. Organize however you like.

## Naming and metadata

A brand-new session shows up as "New Chat." After the first turn,
the drawer label updates to whatever the agent named its last
action — a rough auto-title that tracks where the conversation is
going. The session-settings action (gear icon on the session row)
lets you override that with a curated title and an optional
description; once set, your title sticks regardless of later
agent actions.

Worth setting if you plan to come back to a session or share it
(curated titles also flow into published-gist comments and the
gallery-submission prefill). Not worth setting for throwaway
scratch work — the auto-title is usually descriptive enough.

## Export, import, purge

- **Export** writes the session to a `.agex` bundle (a single
  binary file) that you can save to disk. Bundles include the
  full event log and workspace; they're a complete snapshot.
- **Import** ingests a bundle into your studio as a new session.
  If you already have a session for the same branch, the import
  deduplicates rather than creating a copy.
- **Delete** removes one session. **Purge all data** (at the
  bottom of the drawer) wipes every session, every file, and
  every setting from this browser. Both are permanent locally,
  though previously-exported bundles or published gists are
  unaffected.

## Active turn protection

While the agent is working, navigating away triggers the browser's
"Leave site?" prompt. Active-turn work hasn't been committed yet;
the prompt stops you from losing it by accident.

## Sessions and sharing

Publishing a session pushes a bundle to a secret GitHub gist
under your account — your gist, not any agex.studio server. See
[Sharing & gallery](#sharing) for the publishing flow, share URLs
(play vs showcase), gallery submission, and what gets included in
a bundle.
